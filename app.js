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
const percentFormatter = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});
const EPS = 0.0001;

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

function formatIntegerOrNA(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "N/A";
  }
  return String(Math.round(value));
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "N/A";
  }
  return `${percentFormatter.format(value * 100)}%`;
}

function formatDateDMY(dateISO) {
  if (!dateISO) {
    return "";
  }
  const [year, month, day] = dateISO.split("-");
  if (!year || !month || !day) {
    return dateISO;
  }
  return `${day}/${month}/${year}`;
}

function safeDiv(numerator, denominator) {
  const safeNumerator = isValidNumber(numerator) ? numerator : 0;
  const safeDenominator = isValidNumber(denominator) ? denominator : 0;
  return safeNumerator / Math.max(safeDenominator, EPS);
}

function clampNonNeg(value) {
  if (!isValidNumber(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function applyDeviationControl(xGoalsByForm, goalsVAvg) {
  const base = isValidNumber(xGoalsByForm) ? xGoalsByForm : 0;
  const delta = isValidNumber(goalsVAvg) ? goalsVAvg : 0;
  let multiplier = 1;

  if (delta >= 2.0) multiplier = 0.75;
  else if (delta >= 1.75) multiplier = 0.8;
  else if (delta >= 1.5) multiplier = 0.85;
  else if (delta >= 1.25) multiplier = 0.9;
  else if (delta >= 1.0) multiplier = 0.9;
  else if (delta >= 0.75) multiplier = 0.95;
  else if (delta >= 0.5) multiplier = 0.975;
  else if (delta >= 0.25) multiplier = 0.99;
  else if (delta <= -2.0) multiplier = 1.25;
  else if (delta <= -1.75) multiplier = 1.2;
  else if (delta <= -1.5) multiplier = 1.15;
  else if (delta <= -1.25) multiplier = 1.1;
  else if (delta <= -1.0) multiplier = 1.1;
  else if (delta <= -0.75) multiplier = 1.05;
  else if (delta <= -0.5) multiplier = 1.025;
  else if (delta <= -0.25) multiplier = 1.01;

  return clampNonNeg(base * multiplier);
}

function poissonProbabilities(lambda, maxGoals = 9) {
  const safeLambda = clampNonNeg(lambda);
  const probs = [];
  let cumulative = 0;

  let current = Math.exp(-safeLambda);
  probs.push(current);
  cumulative += current;

  for (let k = 1; k <= maxGoals; k += 1) {
    current *= safeLambda / k;
    probs.push(current);
    cumulative += current;
  }

  const probs9Plus = Math.max(0, 1 - cumulative);
  return { probs, probs9Plus };
}

function buildCorrectScoreGrid(homeProbs, awayProbs, home9Plus, away9Plus) {
  const size = homeProbs.length;
  const grid = [];
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let i = 0; i <= size; i += 1) {
    const row = [];
    const homeProb = i === size ? home9Plus : homeProbs[i];
    for (let j = 0; j <= size; j += 1) {
      const awayProb = j === size ? away9Plus : awayProbs[j];
      const value = homeProb * awayProb;
      row.push(value);
      if (i > j) homeWin += value;
      else if (i === j) draw += value;
      else awayWin += value;
    }
    grid.push(row);
  }

  return {
    grid,
    homeWin,
    draw,
    awayWin
  };
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
    const label = `${fixture.homeTeam} vs ${fixture.awayTeam} - ${formatDateDMY(fixture.dateISO)}`;
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

function isValidNumber(value) {
  return value !== null && value !== undefined && !Number.isNaN(value);
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
    if (isValidNumber(match.FTHG) && isValidNumber(match.FTAG)) {
      const totalGoals = match.FTHG + match.FTAG;
      if (totalGoals > 2.5) over25 += 1;
      if (totalGoals < 2.5) under25 += 1;
    }

    Object.keys(metrics).forEach((key) => {
      const value = match[key];
      if (!isValidNumber(value)) {
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
    if (isValidNumber(match.FTHG)) {
      combinedGoalsSum += match.FTHG;
      combinedGoalsCount += 1;
    }
    if (isValidNumber(match.FTAG)) {
      combinedGoalsSum += match.FTAG;
      combinedGoalsCount += 1;
    }
    if (isValidNumber(match.HS)) {
      combinedShotsSum += match.HS;
      combinedShotsCount += 1;
    }
    if (isValidNumber(match.AS)) {
      combinedShotsSum += match.AS;
      combinedShotsCount += 1;
    }
    if (isValidNumber(match.HST)) {
      combinedSotSum += match.HST;
      combinedSotCount += 1;
    }
    if (isValidNumber(match.AST)) {
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

function computeLeagueAwayAverages(aggregates) {
  return {
    averages: {
      ...aggregates.averages,
      FTHG: aggregates.averages.FTAG,
      HS: aggregates.averages.AS,
      HST: aggregates.averages.AST,
      FTAG: aggregates.averages.FTHG,
      AS: aggregates.averages.HS,
      AST: aggregates.averages.HST
    },
    totals: { ...aggregates.totals }
  };
}

function computeCombinedAverages(matches, baseAggregates) {
  const combined = computeLeagueCombined(matches);
  return {
    averages: {
      ...baseAggregates.averages,
      FTHG: combined.combinedGoals,
      FTAG: combined.combinedGoals,
      HS: combined.combinedShots,
      AS: combined.combinedShots,
      HST: combined.combinedSot,
      AST: combined.combinedSot
    },
    totals: { ...baseAggregates.totals },
    combined
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
      td.dataset.label = col.label;
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

function formatRowValue(row, key) {
  const value = row[key];
  if (row.format === "int") {
    return formatInteger(value);
  }
  if (row.format === "percent") {
    return formatPercent(value);
  }
  return formatNumber(value);
}

function buildFormGridCard({ title, subtitle, rows, headerLabels = { home: "HOME", stat: "STAT", away: "AWAY" } }) {
  const card = document.createElement("div");
  card.className = "table-card";

  const heading = document.createElement("h2");
  heading.textContent = title;
  card.appendChild(heading);

  if (subtitle) {
    const subtitleEl = document.createElement("p");
    subtitleEl.className = "form-subtitle";
    subtitleEl.textContent = subtitle;
    card.appendChild(subtitleEl);
  }

  const grid = document.createElement("div");
  grid.className = "form-grid";

  const headerRow = document.createElement("div");
  headerRow.className = "form-row form-header";

  const headerHome = document.createElement("div");
  headerHome.className = "form-home";
  headerHome.textContent = headerLabels.home;
  headerRow.appendChild(headerHome);

  const headerTitle = document.createElement("div");
  headerTitle.className = "form-title";
  headerTitle.textContent = headerLabels.stat;
  headerRow.appendChild(headerTitle);

  const headerAway = document.createElement("div");
  headerAway.className = "form-away";
  headerAway.textContent = headerLabels.away;
  headerRow.appendChild(headerAway);

  grid.appendChild(headerRow);

  rows.forEach((row) => {
    const rowEl = document.createElement("div");
    rowEl.className = "form-row";

    const homeValue = document.createElement("div");
    homeValue.className = "form-home";
    homeValue.textContent = formatRowValue(row, "home");
    rowEl.appendChild(homeValue);

    const title = document.createElement("div");
    title.className = "form-title";
    title.textContent = row.title;
    rowEl.appendChild(title);

    const awayValue = document.createElement("div");
    awayValue.className = "form-away";
    awayValue.textContent = formatRowValue(row, "away");
    rowEl.appendChild(awayValue);

    grid.appendChild(rowEl);
  });

  card.appendChild(grid);
  return card;
}

function buildFormComparisonCard(homeAgg, awayAgg) {
  const rows = [
    { title: "Goals For", home: homeAgg.averages.FTHG, away: awayAgg.averages.FTAG, format: "number" },
    { title: "Shots For", home: homeAgg.averages.HS, away: awayAgg.averages.AS, format: "number" },
    { title: "Shots On Target For", home: homeAgg.averages.HST, away: awayAgg.averages.AST, format: "number" },
    { title: "Goals Against", home: homeAgg.averages.FTAG, away: awayAgg.averages.FTHG, format: "number" },
    { title: "Shots Against", home: homeAgg.averages.AS, away: awayAgg.averages.HS, format: "number" },
    { title: "Shots On Target Against", home: homeAgg.averages.AST, away: awayAgg.averages.HST, format: "number" },
    { title: "Games Played", home: homeAgg.totals.gamesPlayed, away: awayAgg.totals.gamesPlayed, format: "int" },
    { title: "Games Won", home: homeAgg.totals.homeWin, away: awayAgg.totals.awayWin, format: "int" },
    { title: "Games Drawn", home: homeAgg.totals.draw, away: awayAgg.totals.draw, format: "int" },
    { title: "Games Lost", home: homeAgg.totals.awayWin, away: awayAgg.totals.homeWin, format: "int" },
    { title: "Games Over 2.5", home: homeAgg.totals.over25, away: awayAgg.totals.over25, format: "int" },
    { title: "Games Under 2.5", home: homeAgg.totals.under25, away: awayAgg.totals.under25, format: "int" }
  ];

  return buildFormGridCard({
    title: "FORM",
    subtitle: "Form reflects each team in their relevant home/away context only (e.g. home form excludes their away matches).",
    rows
  });
}

function buildLeagueAveragesCard(leagueAgg) {
  const rows = [
    { title: "Goals For", home: leagueAgg.averages.FTHG, away: leagueAgg.averages.FTAG, format: "number" },
    { title: "Shots For", home: leagueAgg.averages.HS, away: leagueAgg.averages.AS, format: "number" },
    { title: "Shots On Target For", home: leagueAgg.averages.HST, away: leagueAgg.averages.AST, format: "number" },
    { title: "Goals Against", home: leagueAgg.averages.FTAG, away: leagueAgg.averages.FTHG, format: "number" },
    { title: "Shots Against", home: leagueAgg.averages.AS, away: leagueAgg.averages.HS, format: "number" },
    { title: "Shots On Target Against", home: leagueAgg.averages.AST, away: leagueAgg.averages.HST, format: "number" },
    { title: "Games Played", home: leagueAgg.totals.gamesPlayed, away: leagueAgg.totals.gamesPlayed, format: "int" },
    { title: "Games Won", home: leagueAgg.totals.homeWin, away: leagueAgg.totals.awayWin, format: "int" },
    { title: "Games Drawn", home: leagueAgg.totals.draw, away: leagueAgg.totals.draw, format: "int" },
    { title: "Games Lost", home: leagueAgg.totals.awayWin, away: leagueAgg.totals.homeWin, format: "int" },
    { title: "Games Over 2.5", home: leagueAgg.totals.over25, away: leagueAgg.totals.over25, format: "int" },
    { title: "Games Under 2.5", home: leagueAgg.totals.under25, away: leagueAgg.totals.under25, format: "int" }
  ];

  return buildFormGridCard({
    title: "LEAGUE AVERAGES",
    rows
  });
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

function buildPredictionRows(predictions) {
  return [
    { label: "Attack Score (Goals)", home: predictions.HomeAttackScore, away: predictions.AwayAttackScore },
    { label: "Defence Score (Goals)", home: predictions.HomeDefenceScore, away: predictions.AwayDefenceScore },
    { label: "xG (Goals Model)", home: predictions.Home_xG_Goals, away: predictions.Away_xG_Goals },
    { label: "xShots", home: predictions.Home_xShots, away: predictions.Away_xShots },
    { label: "xSOT", home: predictions.Home_xSOT, away: predictions.Away_xSOT },
    { label: "Goals/Shot For", home: predictions.HomeGoalsPerShotFor, away: predictions.AwayGoalsPerShotFor },
    { label: "Goals/SOT For", home: predictions.HomeGoalsPerSOTFor, away: predictions.AwayGoalsPerSOTFor },
    { label: "Goals/Shot Against", home: predictions.HomeGoalsPerShotAgainst, away: predictions.AwayGoalsPerShotAgainst },
    { label: "Goals/SOT Against", home: predictions.HomeGoalsPerSOTAgainst, away: predictions.AwayGoalsPerSOTAgainst },
    { label: "Goals from xShots", home: predictions.HomeGoalsBy_xShots, away: predictions.AwayGoalsBy_xShots },
    { label: "Goals from xSOT", home: predictions.HomeGoalsBy_xSOT, away: predictions.AwayGoalsBy_xSOT },
    { label: "Weighted xGoals (Form)", home: predictions.Home_xGoalsByForm, away: predictions.Away_xGoalsByForm },
    { label: "Goals vs League Avg", home: predictions.HGoals_v_Avg, away: predictions.AGoals_v_Avg },
    { label: "Deviation-Controlled λ", home: predictions.HGoalsFormDevi, away: predictions.AGoalsFormDevi }
  ];
}

function buildPredictionTable(predictions) {
  const rows = buildPredictionRows(predictions).map((row) => ({
    title: row.label,
    home: row.home,
    away: row.away,
    format: "number"
  }));

  return buildFormGridCard({
    title: "Scores & Expected Outputs",
    rows
  });
}

function buildPoissonTable(title, probs, probs9Plus) {
  const card = document.createElement("div");
  card.className = "table-card";
  const heading = document.createElement("h2");
  heading.textContent = title;
  card.appendChild(heading);

  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  ["Goals", "Probability"].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  probs.forEach((value, index) => {
    const tr = document.createElement("tr");
    const goalsCell = document.createElement("td");
    goalsCell.textContent = String(index);
    goalsCell.dataset.label = "Goals";
    tr.appendChild(goalsCell);

    const probCell = document.createElement("td");
    probCell.textContent = formatPercent(value);
    probCell.dataset.label = "Probability";
    tr.appendChild(probCell);
    tbody.appendChild(tr);
  });

  const plusRow = document.createElement("tr");
  const plusLabel = document.createElement("td");
  plusLabel.textContent = "9+";
  plusLabel.dataset.label = "Goals";
  plusRow.appendChild(plusLabel);
  const plusValue = document.createElement("td");
  plusValue.textContent = formatPercent(probs9Plus);
  plusValue.dataset.label = "Probability";
  plusRow.appendChild(plusValue);
  tbody.appendChild(plusRow);

  table.appendChild(tbody);
  wrapper.appendChild(table);
  card.appendChild(wrapper);
  return card;
}

function buildGoalProbabilitiesCard(predictions) {
  const rows = predictions.homePoisson.probs.map((value, index) => ({
    title: String(index),
    home: value,
    away: predictions.awayPoisson.probs[index],
    format: "percent"
  }));

  rows.push({
    title: "9+",
    home: predictions.homePoisson.probs9Plus,
    away: predictions.awayPoisson.probs9Plus,
    format: "percent"
  });

  return buildFormGridCard({
    title: "Goal Probabilities",
    rows,
    headerLabels: { home: "HOME", stat: "GOALS", away: "AWAY" }
  });
}

function buildCorrectScoreTable(predictions) {
  const card = document.createElement("div");
  card.className = "table-card correct-score-card";
  const heading = document.createElement("h2");
  heading.textContent = "Correct Score Matrix";
  card.appendChild(heading);

  const wrapper = document.createElement("div");
  wrapper.className = "table-wrapper matrix-wrapper";
  const table = document.createElement("table");
  table.classList.add("matrix-table");
  const columnLabels = Array.from({ length: 10 }, (_, index) => String(index)).concat("9+");
  const gridValues = predictions.correctScoreGrid.grid.flat().filter((value) => value > 0);
  const maxValue = gridValues.length ? Math.max(...gridValues) : 0;

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const emptyCell = document.createElement("th");
  emptyCell.textContent = "Home \\ Away";
  headerRow.appendChild(emptyCell);
  for (let i = 0; i <= 9; i += 1) {
    const th = document.createElement("th");
    th.textContent = String(i);
    headerRow.appendChild(th);
  }
  const plusTh = document.createElement("th");
  plusTh.textContent = "9+";
  headerRow.appendChild(plusTh);
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const heatCells = [];
  predictions.correctScoreGrid.grid.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    const rowLabel = document.createElement("td");
    rowLabel.textContent = rowIndex === 10 ? "9+" : String(rowIndex);
    rowLabel.className = "metric-label";
    rowLabel.dataset.label = "Home Goals";
    tr.appendChild(rowLabel);
    row.forEach((value, colIndex) => {
      const td = document.createElement("td");
      const span = document.createElement("span");
      span.textContent = formatPercent(value);
      td.appendChild(span);
      td.classList.add("heat-cell");
      const intensity = maxValue ? value / maxValue : 0;
      td.style.setProperty("--heat", intensity.toFixed(4));
      if (intensity > 0.65) {
        td.classList.add("heat-darktext");
      }
      td.dataset.label = `Away ${columnLabels[colIndex]}`;
      heatCells.push({ value, td });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrapper.appendChild(table);
  card.appendChild(wrapper);

  heatCells
    .filter((cell) => cell.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .forEach((cell, index) => {
      const rank = index + 1;
      cell.td.classList.add("top-score");
      cell.td.dataset.rank = String(rank);
      const badge = document.createElement("span");
      badge.className = "rank-badge";
      badge.textContent = `#${rank}`;
      cell.td.appendChild(badge);
    });
  return card;
}

function computeSummaryMarkets(grid) {
  const maxIndex = grid.length - 1;
  const goalValue = (index) => (index === maxIndex ? 10 : index);
  const totals = {
    over15: 0,
    under15: 0,
    over25: 0,
    under25: 0,
    over35: 0,
    under35: 0,
    bttsYes: 0
  };

  grid.forEach((row, homeIndex) => {
    row.forEach((value, awayIndex) => {
      const totalGoals = goalValue(homeIndex) + goalValue(awayIndex);
      if (totalGoals > 1.5) totals.over15 += value;
      else totals.under15 += value;
      if (totalGoals > 2.5) totals.over25 += value;
      else totals.under25 += value;
      if (totalGoals > 3.5) totals.over35 += value;
      else totals.under35 += value;
      if (goalValue(homeIndex) >= 1 && goalValue(awayIndex) >= 1) {
        totals.bttsYes += value;
      }
    });
  });

  totals.bttsNo = Math.max(0, 1 - totals.bttsYes);
  return totals;
}

function computePredictions(homeAgg, awayAgg, leagueAgg) {
  const avg = (source, key) => (isValidNumber(source.averages[key]) ? source.averages[key] : 0);

  const LeagueAvgHomeGoals = avg(leagueAgg, "FTHG");
  const LeagueAvgAwayGoals = avg(leagueAgg, "FTAG");
  const LeagueAvgHomeShots = avg(leagueAgg, "HS");
  const LeagueAvgAwayShots = avg(leagueAgg, "AS");
  const LeagueAvgHomeSOT = avg(leagueAgg, "HST");
  const LeagueAvgAwaySOT = avg(leagueAgg, "AST");

  const AvgHomeFTHG = avg(homeAgg, "FTHG");
  const AvgHomeFTAG = avg(homeAgg, "FTAG");
  const AvgHomeHS = avg(homeAgg, "HS");
  const AvgHomeAS = avg(homeAgg, "AS");
  const AvgHomeHST = avg(homeAgg, "HST");
  const AvgHomeAST = avg(homeAgg, "AST");

  const AvgAwayFTHG = avg(awayAgg, "FTHG");
  const AvgAwayFTAG = avg(awayAgg, "FTAG");
  const AvgAwayHS = avg(awayAgg, "HS");
  const AvgAwayAS = avg(awayAgg, "AS");
  const AvgAwayHST = avg(awayAgg, "HST");
  const AvgAwayAST = avg(awayAgg, "AST");

  const HomeAttackScore = safeDiv(AvgHomeFTHG, LeagueAvgHomeGoals);
  const HomeDefenceScore = safeDiv(AvgHomeFTAG, LeagueAvgAwayGoals);
  const AwayAttackScore = safeDiv(AvgAwayFTAG, LeagueAvgAwayGoals);
  const AwayDefenceScore = safeDiv(AvgAwayFTHG, LeagueAvgHomeGoals);

  const Home_xG_Goals = HomeAttackScore * AwayDefenceScore * LeagueAvgHomeGoals;
  const Away_xG_Goals = AwayAttackScore * HomeDefenceScore * LeagueAvgAwayGoals;

  const HomeShotsForScore = safeDiv(AvgHomeHS, LeagueAvgHomeShots);
  const HomeShotsAgainstScore = safeDiv(AvgHomeAS, LeagueAvgAwayShots);
  const AwayShotsForScore = safeDiv(AvgAwayAS, LeagueAvgAwayShots);
  const AwayShotsAgainstScore = safeDiv(AvgAwayHS, LeagueAvgHomeShots);

  const Home_xShots = HomeShotsForScore * AwayShotsAgainstScore * LeagueAvgHomeShots;
  const Away_xShots = AwayShotsForScore * HomeShotsAgainstScore * LeagueAvgAwayShots;

  const HomeGoalsPerShotFor = safeDiv(AvgHomeFTHG, AvgHomeHS);
  const HomeGoalsPerSOTFor = safeDiv(AvgHomeFTHG, AvgHomeHST);
  const HomeGoalsPerShotAgainst = safeDiv(AvgHomeFTAG, AvgHomeAS);
  const HomeGoalsPerSOTAgainst = safeDiv(AvgHomeFTAG, AvgHomeAST);

  const AwayGoalsPerShotFor = safeDiv(AvgAwayFTAG, AvgAwayAS);
  const AwayGoalsPerSOTFor = safeDiv(AvgAwayFTAG, AvgAwayAST);
  const AwayGoalsPerShotAgainst = safeDiv(AvgAwayFTHG, AvgAwayHS);
  const AwayGoalsPerSOTAgainst = safeDiv(AvgAwayFTHG, AvgAwayHST);

  const HomeSOTForScore = safeDiv(AvgHomeHST, LeagueAvgHomeSOT);
  const HomeSOTAgainstScore = safeDiv(AvgHomeAST, LeagueAvgAwaySOT);
  const AwaySOTForScore = safeDiv(AvgAwayAST, LeagueAvgAwaySOT);
  const AwaySOTAgainstScore = safeDiv(AvgAwayHST, LeagueAvgHomeSOT);

  const Home_xSOT = HomeSOTForScore * AwaySOTAgainstScore * LeagueAvgHomeSOT;
  const Away_xSOT = AwaySOTForScore * HomeSOTAgainstScore * LeagueAvgAwaySOT;

  const HomeGoalsBy_xShots = Home_xShots * AwayGoalsPerShotAgainst;
  const AwayGoalsBy_xShots = Away_xShots * HomeGoalsPerShotAgainst;

  const HomeGoalsBy_xSOT = Home_xSOT * AwayGoalsPerSOTAgainst;
  const AwayGoalsBy_xSOT = Away_xSOT * HomeGoalsPerSOTAgainst;

  const Home_xGoalsByForm = 0.5 * Home_xG_Goals + 0.25 * HomeGoalsBy_xShots + 0.25 * HomeGoalsBy_xSOT;
  const Away_xGoalsByForm = 0.5 * Away_xG_Goals + 0.25 * AwayGoalsBy_xShots + 0.25 * AwayGoalsBy_xSOT;

  const HGoals_v_Avg = Home_xGoalsByForm - LeagueAvgHomeGoals;
  const AGoals_v_Avg = Away_xGoalsByForm - LeagueAvgAwayGoals;

  const HGoalsFormDevi = applyDeviationControl(Home_xGoalsByForm, HGoals_v_Avg);
  const AGoalsFormDevi = applyDeviationControl(Away_xGoalsByForm, AGoals_v_Avg);

  const homePoisson = poissonProbabilities(HGoalsFormDevi);
  const awayPoisson = poissonProbabilities(AGoalsFormDevi);
  const correctScoreGrid = buildCorrectScoreGrid(
    homePoisson.probs,
    awayPoisson.probs,
    homePoisson.probs9Plus,
    awayPoisson.probs9Plus
  );
  const summaryMarkets = computeSummaryMarkets(correctScoreGrid.grid);

  return {
    HomeAttackScore,
    HomeDefenceScore,
    AwayAttackScore,
    AwayDefenceScore,
    Home_xG_Goals,
    Away_xG_Goals,
    Home_xShots,
    Away_xShots,
    Home_xSOT,
    Away_xSOT,
    HomeGoalsPerShotFor,
    HomeGoalsPerSOTFor,
    HomeGoalsPerShotAgainst,
    HomeGoalsPerSOTAgainst,
    AwayGoalsPerShotFor,
    AwayGoalsPerSOTFor,
    AwayGoalsPerShotAgainst,
    AwayGoalsPerSOTAgainst,
    HomeGoalsBy_xShots,
    AwayGoalsBy_xShots,
    HomeGoalsBy_xSOT,
    AwayGoalsBy_xSOT,
    Home_xGoalsByForm,
    Away_xGoalsByForm,
    HGoals_v_Avg,
    AGoals_v_Avg,
    HGoalsFormDevi,
    AGoalsFormDevi,
    homePoisson,
    awayPoisson,
    correctScoreGrid,
    ...summaryMarkets
  };
}

function buildBarRow({ label, value, suffix = "", emphasis = false }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const row = document.createElement("div");
  row.className = `summary-row${emphasis ? " summary-row--emphasis" : ""}`;
  row.setAttribute("aria-label", `${label} ${formatPercent(clamped)}${suffix}`);

  const labelEl = document.createElement("div");
  labelEl.className = "summary-row-label";
  labelEl.textContent = label;

  const barWrap = document.createElement("div");
  barWrap.className = "summary-bar-wrap";
  const barFill = document.createElement("div");
  barFill.className = "summary-bar-fill";
  barFill.style.width = `${(clamped * 100).toFixed(1)}%`;
  barWrap.appendChild(barFill);

  const valueEl = document.createElement("div");
  valueEl.className = "summary-row-value";
  valueEl.textContent = `${formatPercent(clamped)}${suffix}`;

  row.append(labelEl, barWrap, valueEl);
  return row;
}

function buildTotalGoalsDistribution(homePoisson, awayPoisson) {
  const homeProbs = [...homePoisson.probs, homePoisson.probs9Plus];
  const awayProbs = [...awayPoisson.probs, awayPoisson.probs9Plus];
  const totalLength = homeProbs.length + awayProbs.length - 1;
  const totals = Array.from({ length: totalLength }, () => 0);

  homeProbs.forEach((homeValue, homeIndex) => {
    awayProbs.forEach((awayValue, awayIndex) => {
      totals[homeIndex + awayIndex] += homeValue * awayValue;
    });
  });

  return totals;
}

function buildSummaryCard(predictions) {
  const card = document.createElement("div");
  card.className = "table-card summary-card";

  const heading = document.createElement("h2");
  heading.textContent = "Summary";
  card.appendChild(heading);

  const groups = document.createElement("div");
  groups.className = "summary-groups";

  const outcomeGroup = document.createElement("div");
  outcomeGroup.className = "summary-group";

  const outcomeTitle = document.createElement("h3");
  outcomeTitle.className = "summary-group-title";
  outcomeTitle.textContent = "Outcome";
  outcomeGroup.appendChild(outcomeTitle);

  const outcomeRows = document.createElement("div");
  outcomeRows.className = "summary-rows";
  const outcomeValues = [
    { label: "Home Win", value: predictions.correctScoreGrid.homeWin },
    { label: "Draw", value: predictions.correctScoreGrid.draw },
    { label: "Away Win", value: predictions.correctScoreGrid.awayWin }
  ];
  const topOutcome = Math.max(...outcomeValues.map((item) => item.value));
  outcomeValues.forEach((item) => {
    outcomeRows.appendChild(
      buildBarRow({
        label: item.label,
        value: item.value,
        emphasis: item.value === topOutcome
      })
    );
  });
  outcomeGroup.appendChild(outcomeRows);

  const totalGoalsGroup = document.createElement("div");
  totalGoalsGroup.className = "summary-group";

  const goalsTitle = document.createElement("h3");
  goalsTitle.className = "summary-group-title";
  goalsTitle.textContent = "Total Goals";
  totalGoalsGroup.appendChild(goalsTitle);

  const totalGoalsRows = document.createElement("div");
  totalGoalsRows.className = "summary-rows";
  const totals = buildTotalGoalsDistribution(predictions.homePoisson, predictions.awayPoisson);
  const total0 = totals[0] || 0;
  const total1 = totals[1] || 0;
  const total2 = totals[2] || 0;
  const total3 = totals[3] || 0;
  const over15 = Math.max(0, 1 - (total0 + total1));
  const under15 = Math.max(0, 1 - over15);
  const over25 = Math.max(0, 1 - (total0 + total1 + total2));
  const under25 = Math.max(0, 1 - over25);
  const over35 = Math.max(0, 1 - (total0 + total1 + total2 + total3));
  const under35 = Math.max(0, 1 - over35);

  totalGoalsRows.append(
    buildBarRow({ label: "Over 1.5", value: over15 }),
    buildBarRow({ label: "Under 1.5", value: under15 }),
    buildBarRow({ label: "Over 2.5", value: over25 }),
    buildBarRow({ label: "Under 2.5", value: under25 }),
    buildBarRow({ label: "Over 3.5", value: over35 }),
    buildBarRow({ label: "Under 3.5", value: under35 })
  );
  totalGoalsGroup.appendChild(totalGoalsRows);

  const bttsGroup = document.createElement("div");
  bttsGroup.className = "summary-group";

  const bttsTitle = document.createElement("h3");
  bttsTitle.className = "summary-group-title";
  bttsTitle.textContent = "BTTS";
  bttsGroup.appendChild(bttsTitle);

  const bttsRows = document.createElement("div");
  bttsRows.className = "summary-rows";
  const grid = predictions.correctScoreGrid.grid;
  const row0 = grid[0]?.reduce((sum, value) => sum + value, 0) || 0;
  const col0 = grid.reduce((sum, row) => sum + (row[0] || 0), 0);
  const cell00 = grid[0]?.[0] || 0;
  const bttsNo = Math.max(0, row0 + col0 - cell00);
  const bttsYes = Math.max(0, 1 - bttsNo);

  bttsRows.append(
    buildBarRow({ label: "Yes", value: bttsYes }),
    buildBarRow({ label: "No", value: bttsNo })
  );
  bttsGroup.appendChild(bttsRows);

  const groupDivider = () => {
    const divider = document.createElement("div");
    divider.className = "summary-divider";
    return divider;
  };

  groups.append(outcomeGroup, groupDivider(), totalGoalsGroup, groupDivider(), bttsGroup);
  card.appendChild(groups);

  return card;
}

function renderPredictions(predictions) {
  const section = document.createElement("section");
  section.className = "predictions";

  const heading = document.createElement("h2");
  heading.className = "section-title";
  heading.textContent = "Predictions";
  section.appendChild(heading);

  const cards = document.createElement("div");
  cards.className = "tables";
  cards.appendChild(buildSummaryCard(predictions));
  cards.appendChild(buildPredictionTable(predictions));
  cards.appendChild(buildGoalProbabilitiesCard(predictions));
  cards.appendChild(buildCorrectScoreTable(predictions));
  section.appendChild(cards);
  return section;
}

function renderTables({ homeAgg, awayAgg, leagueAgg }) {
  clearTables();

  const predictions = computePredictions(homeAgg, awayAgg, leagueAgg);
  tablesEl.appendChild(renderPredictions(predictions));

  tablesEl.appendChild(
    buildFormComparisonCard(homeAgg, awayAgg)
  );

  tablesEl.appendChild(
    buildLeagueAveragesCard(leagueAgg)
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

  if (matchesInWindow.length === 0) {
    setStatus("No matches found in this lookback window. Showing empty tables.");
  } else {
    setStatus(`Using ${matchesInWindow.length} matches from the historical pool.`);
  }

  renderTables({
    homeAgg,
    awayAgg,
    leagueAgg
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
