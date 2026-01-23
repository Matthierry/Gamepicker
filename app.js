const LEAGUES = [
  { code: "E0", name: "Premier League" },
  { code: "E1", name: "Championship" },
  { code: "E2", name: "League 1" },
  { code: "E3", name: "League 2" }
];

const leagueSelect = document.getElementById("leagueSelect");
const fixtureSelect = document.getElementById("fixtureSelect");
const windowSelect = document.getElementById("windowSelect");
const generateBtn = document.getElementById("generateBtn");
const statusEl = document.getElementById("status");
const tablesEl = document.getElementById("tables");

let fixturesIndex = null;
let leagueMatchesCache = new Map();

const numberFormatter = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "N/A";
  }
  return numberFormatter.format(value);
}

function formatInteger(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "0";
  }
  return String(Math.round(value));
}

function toDate(value) {
  return value ? new Date(value) : null;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function clearTables() {
  tablesEl.innerHTML = "";
}

function createOption(value, label, disabled = false) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  option.disabled = disabled;
  return option;
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }
  return response.json();
}

function getAvailableLeagues(fixturesByLeague) {
  return LEAGUES.map((league) => {
    const fixtures = fixturesByLeague[league.code] || [];
    return { ...league, hasFixtures: fixtures.length > 0 };
  });
}

function selectDefaultLeague(available) {
  const firstAvailable = available.find((league) => league.hasFixtures);
  return firstAvailable ? firstAvailable.code : "";
}

function populateLeagueOptions(availableLeagues, selectedCode) {
  leagueSelect.innerHTML = "";
  availableLeagues.forEach((league) => {
    const option = createOption(
      league.code,
      league.name,
      !league.hasFixtures
    );
    leagueSelect.appendChild(option);
  });
  leagueSelect.value = selectedCode;
}

function populateFixtureOptions(fixtures, selectedId) {
  fixtureSelect.innerHTML = "";
  if (!fixtures || fixtures.length === 0) {
    fixtureSelect.appendChild(createOption("", "No Fixtures Available", true));
    fixtureSelect.value = "";
    fixtureSelect.disabled = true;
    return;
  }
  fixtures.forEach((fixture) => {
    const label = `${fixture.dateISO} • ${fixture.homeTeam} vs ${fixture.awayTeam}`;
    fixtureSelect.appendChild(createOption(fixture.id, label));
  });
  fixtureSelect.disabled = false;
  fixtureSelect.value = selectedId || fixtures[0].id;
}

function getSelectedFixture(fixtures) {
  return fixtures.find((fixture) => fixture.id === fixtureSelect.value);
}

function filterMatches(matches, fixtureDateISO, windowDays) {
  const fixtureDate = toDate(fixtureDateISO);
  if (!fixtureDate) {
    return [];
  }
  const windowStart = new Date(fixtureDate);
  windowStart.setDate(windowStart.getDate() - windowDays);
  return matches.filter((match) => {
    const matchDate = toDate(match.dateISO);
    return matchDate && matchDate >= windowStart && matchDate < fixtureDate;
  });
}

function computeAggregates(matches, { homeTeam, awayTeam } = {}) {
  const metrics = {
    FTHG: { sum: 0, count: 0 },
    HS: { sum: 0, count: 0 },
    HST: { sum: 0, count: 0 },
    FTAG: { sum: 0, count: 0 },
    AS: { sum: 0, count: 0 },
    AST: { sum: 0, count: 0 },
    AvgH: { sum: 0, count: 0 },
    AvgD: { sum: 0, count: 0 },
    AvgA: { sum: 0, count: 0 },
    AvgOver25: { sum: 0, count: 0 },
    AvgUnder25: { sum: 0, count: 0 }
  };

  let gamesPlayed = 0;
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let under25 = 0;

  matches.forEach((match) => {
    if (homeTeam && match.HomeTeam !== homeTeam) {
      return;
    }
    if (awayTeam && match.AwayTeam !== awayTeam) {
      return;
    }
    gamesPlayed += 1;
    if (match.FTR === "H") homeWin += 1;
    if (match.FTR === "D") draw += 1;
    if (match.FTR === "A") awayWin += 1;
    const totalGoals = (match.FTHG ?? 0) + (match.FTAG ?? 0);
    if (totalGoals > 2.5) over25 += 1;
    if (totalGoals < 2.5) under25 += 1;

    Object.keys(metrics).forEach((key) => {
      const value = match[key];
      if (value === null || value === undefined || Number.isNaN(value)) {
        return;
      }
      metrics[key].sum += value;
      metrics[key].count += 1;
    });
  });

  return {
    averages: Object.fromEntries(
      Object.entries(metrics).map(([key, { sum, count }]) => [
        key,
        count > 0 ? sum / count : null
      ])
    ),
    totals: {
      gamesPlayed,
      homeWin,
      draw,
      awayWin,
      over25,
      under25
    }
  };
}

function computeLeagueCombined(matches) {
  let combinedGoalsSum = 0;
  let combinedGoalsCount = 0;
  let combinedShotsSum = 0;
  let combinedShotsCount = 0;
  let combinedSotSum = 0;
  let combinedSotCount = 0;

  matches.forEach((match) => {
    if (match.FTHG !== null && match.FTHG !== undefined) {
      combinedGoalsSum += match.FTHG;
      combinedGoalsCount += 1;
    }
    if (match.FTAG !== null && match.FTAG !== undefined) {
      combinedGoalsSum += match.FTAG;
      combinedGoalsCount += 1;
    }
    if (match.HS !== null && match.HS !== undefined) {
      combinedShotsSum += match.HS;
      combinedShotsCount += 1;
    }
    if (match.AS !== null && match.AS !== undefined) {
      combinedShotsSum += match.AS;
      combinedShotsCount += 1;
    }
    if (match.HST !== null && match.HST !== undefined) {
      combinedSotSum += match.HST;
      combinedSotCount += 1;
    }
    if (match.AST !== null && match.AST !== undefined) {
      combinedSotSum += match.AST;
      combinedSotCount += 1;
    }
  });

  return {
    combinedGoals: combinedGoalsCount ? combinedGoalsSum / combinedGoalsCount : null,
    combinedShots: combinedShotsCount ? combinedShotsSum / combinedShotsCount : null,
    combinedSot: combinedSotCount ? combinedSotSum / combinedSotCount : null
  };
}

function buildTableCard(title, rows, columns, note) {
  const card = document.createElement("div");
  card.className = "table-card";

  const heading = document.createElement("h2");
  heading.textContent = title;
  card.appendChild(heading);

  if (!rows || rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No matches found for this window.";
    card.appendChild(empty);
    return card;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  columns.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col.label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach((col) => {
      const td = document.createElement("td");
      const value = row[col.key];
      td.textContent = col.format === "int" ? formatInteger(value) : formatNumber(value);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  wrapper.appendChild(table);
  card.appendChild(wrapper);

  if (note) {
    const noteEl = document.createElement("p");
    noteEl.className = "note";
    noteEl.textContent = note;
    card.appendChild(noteEl);
  }

  return card;
}

function buildRowsFromAggregates(aggregates) {
  return [{
    FTHG: aggregates.averages.FTHG,
    HS: aggregates.averages.HS,
    HST: aggregates.averages.HST,
    FTAG: aggregates.averages.FTAG,
    AS: aggregates.averages.AS,
    AST: aggregates.averages.AST,
    gamesPlayed: aggregates.totals.gamesPlayed,
    homeWin: aggregates.totals.homeWin,
    draw: aggregates.totals.draw,
    awayWin: aggregates.totals.awayWin,
    over25: aggregates.totals.over25,
    under25: aggregates.totals.under25,
    AvgH: aggregates.averages.AvgH,
    AvgD: aggregates.averages.AvgD,
    AvgA: aggregates.averages.AvgA,
    AvgOver25: aggregates.averages.AvgOver25,
    AvgUnder25: aggregates.averages.AvgUnder25
  }];
}

function getBaseColumns() {
  return [
    { key: "FTHG", label: "Avg FTHG" },
    { key: "HS", label: "Avg HS" },
    { key: "HST", label: "Avg HST" },
    { key: "FTAG", label: "Avg FTAG" },
    { key: "AS", label: "Avg AS" },
    { key: "AST", label: "Avg AST" },
    { key: "gamesPlayed", label: "Games", format: "int" },
    { key: "homeWin", label: "Home Win", format: "int" },
    { key: "draw", label: "Draw", format: "int" },
    { key: "awayWin", label: "Away Win", format: "int" },
    { key: "over25", label: "Over 2.5", format: "int" },
    { key: "under25", label: "Under 2.5", format: "int" },
    { key: "AvgH", label: "AvgH" },
    { key: "AvgD", label: "AvgD" },
    { key: "AvgA", label: "AvgA" },
    { key: "AvgOver25", label: "Avg >2.5" },
    { key: "AvgUnder25", label: "Avg <2.5" }
  ];
}

function renderTables({ homeAgg, awayAgg, leagueAgg, leagueAwayAgg, combinedAgg, combinedExtras }) {
  clearTables();
  const baseColumns = getBaseColumns();

  tablesEl.appendChild(
    buildTableCard("Home Team Form", buildRowsFromAggregates(homeAgg), baseColumns)
  );

  tablesEl.appendChild(
    buildTableCard("Away Team Form", buildRowsFromAggregates(awayAgg), baseColumns)
  );

  tablesEl.appendChild(
    buildTableCard("League Home Average", buildRowsFromAggregates(leagueAgg), baseColumns)
  );

  tablesEl.appendChild(
    buildTableCard("League Away Average", buildRowsFromAggregates(leagueAwayAgg), baseColumns)
  );

  const combinedColumns = [
    ...baseColumns,
    { key: "combinedGoals", label: "Combined Goals/Team" },
    { key: "combinedShots", label: "Combined Shots/Team" },
    { key: "combinedSot", label: "Combined SOT/Team" }
  ];
  const combinedRows = buildRowsFromAggregates(combinedAgg).map((row) => ({
    ...row,
    combinedGoals: combinedExtras.combinedGoals,
    combinedShots: combinedExtras.combinedShots,
    combinedSot: combinedExtras.combinedSot
  }));

  tablesEl.appendChild(
    buildTableCard(
      "League Combined Average",
      combinedRows,
      combinedColumns,
      "Combined metrics flatten home/away values per team."
    )
  );
}

async function loadLeagueMatches(leagueCode) {
  if (leagueMatchesCache.has(leagueCode)) {
    return leagueMatchesCache.get(leagueCode);
  }
  const data = await fetchJson(`data/league_matches/${leagueCode}.json`);
  leagueMatchesCache.set(leagueCode, data);
  return data;
}

async function generateBreakdown() {
  const leagueCode = leagueSelect.value;
  if (!leagueCode || !fixturesIndex) {
    return;
  }

  const fixtures = fixturesIndex[leagueCode] || [];
  const selectedFixture = getSelectedFixture(fixtures);
  if (!selectedFixture) {
    setStatus("Select a fixture to continue.");
    return;
  }

  setStatus("Calculating averages...");
  const leagueMatches = await loadLeagueMatches(leagueCode);
  const windowDays = Number(windowSelect.value);
  const matchesInWindow = filterMatches(leagueMatches, selectedFixture.dateISO, windowDays);

  const homeAgg = computeAggregates(matchesInWindow, { homeTeam: selectedFixture.homeTeam });
  const awayAgg = computeAggregates(matchesInWindow, { awayTeam: selectedFixture.awayTeam });
  const leagueAgg = computeAggregates(matchesInWindow);
  const leagueAwayAgg = computeAggregates(matchesInWindow);
  const combinedAgg = computeAggregates(matchesInWindow);
  const combinedExtras = computeLeagueCombined(matchesInWindow);

  if (matchesInWindow.length === 0) {
    setStatus("No matches found in this lookback window. Showing empty tables.");
  } else {
    setStatus(`Using ${matchesInWindow.length} matches from the historical pool.`);
  }

  renderTables({
    homeAgg,
    awayAgg,
    leagueAgg,
    leagueAwayAgg,
    combinedAgg,
    combinedExtras
  });
}

function handleLeagueChange() {
  const fixtures = fixturesIndex[leagueSelect.value] || [];
  populateFixtureOptions(fixtures);
  generateBreakdown();
}

async function init() {
  setStatus("Loading fixtures...");
  try {
    fixturesIndex = await fetchJson("data/fixtures_index.json");
  } catch (error) {
    setStatus("Failed to load fixtures data.");
    console.error(error);
    return;
  }

  const availableLeagues = getAvailableLeagues(fixturesIndex);
  const selectedLeague = selectDefaultLeague(availableLeagues);

  if (!selectedLeague) {
    setStatus("No Fixtures Available");
    leagueSelect.innerHTML = "";
    fixtureSelect.innerHTML = "";
    fixtureSelect.disabled = true;
    generateBtn.disabled = true;
    return;
  }

  populateLeagueOptions(availableLeagues, selectedLeague);
  const fixtures = fixturesIndex[selectedLeague] || [];
  populateFixtureOptions(fixtures);

  setStatus("Select options to view the breakdown.");

  leagueSelect.addEventListener("change", handleLeagueChange);
  fixtureSelect.addEventListener("change", generateBreakdown);
  windowSelect.addEventListener("change", generateBreakdown);
  generateBtn.addEventListener("click", generateBreakdown);

  await generateBreakdown();
}

init();
