import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data");
const RAW_DIR = path.join(DATA_DIR, "raw");
const LEAGUE_DIR = path.join(DATA_DIR, "league_matches");

const LEAGUES = {
  E0: "Premier League",
  E1: "Championship",
  E2: "League 1",
  E3: "League 2"
};

const FIXTURES_URL = "https://www.football-data.co.uk/fixtures.csv";
const OFFLINE_DATA = process.env.OFFLINE_DATA === "1";

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

const SEASONS = [
  { code: "2526", label: "current" },
  { code: "2425", label: "previous" }
];

const LEAGUE_URLS = Object.keys(LEAGUES).flatMap((league) =>
  SEASONS.map((season) => ({
    league,
    season: season.code,
    url: `https://www.football-data.co.uk/mmz4281/${season.code}/${league}.csv`
  }))
);

await mkdir(RAW_DIR, { recursive: true });
await mkdir(LEAGUE_DIR, { recursive: true });

function parseCSV(text) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  const rows = [];
  let headers = null;

  lines.forEach((line) => {
    if (!line.trim()) {
      return;
    }
    const fields = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    fields.push(current);

    if (!headers) {
      headers = fields.map((field, index) => {
        const trimmed = field.trim();
        return index === 0 ? trimmed.replace(/^\uFEFF/, "") : trimmed;
      });
      return;
    }

    const row = {};
    headers.forEach((header, index) => {
      row[header] = fields[index] ? fields[index].trim() : "";
    });
    rows.push(row);
  });

  return rows;
}

function parseDateToISO(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  const datePart = trimmed.split(" ")[0];
  const parts = datePart.split(/[\/.-]/).filter(Boolean);
  if (parts.length < 3) return null;
  const [first, second, third] = parts;
  let day = first;
  let month = second;
  let yearRaw = third;
  if (first.length === 4) {
    yearRaw = first;
    month = second;
    day = third;
  }
  let year = Number(yearRaw);
  if (Number.isNaN(year)) return null;
  if (year < 100) {
    year += 2000;
  }
  const dayNum = Number(day);
  const monthNum = Number(month);
  if (!dayNum || !monthNum) return null;
  const iso = new Date(Date.UTC(year, monthNum - 1, dayNum));
  if (Number.isNaN(iso.getTime())) return null;
  return iso.toISOString().slice(0, 10);
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isNaN(num) ? null : num;
}

const LEAGUE_CODE_ALIASES = {
  ENG1: "E0",
  ENG2: "E1",
  ENG3: "E2",
  ENG4: "E3",
  EPL: "E0",
  CHAMP: "E1",
  "LEAGUE 1": "E2",
  "LEAGUE1": "E2",
  "LEAGUE 2": "E3",
  "LEAGUE2": "E3",
  "PREMIER LEAGUE": "E0",
  CHAMPIONSHIP: "E1"
};

function normalizeLeagueCode(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase();
  if (!normalized) return null;
  return LEAGUE_CODE_ALIASES[normalized] || normalized;
}

function buildHeaderMap(headers) {
  const map = new Map();
  headers.forEach((header) => {
    map.set(header.toLowerCase(), header);
  });
  return map;
}

function resolveHeader(headerMap, candidates) {
  for (const candidate of candidates) {
    const resolved = headerMap.get(candidate.toLowerCase());
    if (resolved) return resolved;
  }
  return null;
}

function readRowValue(row, header) {
  if (!header) return "";
  return row[header];
}

function findOddsHeader(headers, { includes, fallback }) {
  const lowered = headers.map((header) => header.toLowerCase());
  const index = lowered.findIndex((header) =>
    includes.every((token) => header.includes(token))
  );
  if (index >= 0) {
    return headers[index];
  }
  return headers.find((header) => header.toLowerCase() === fallback.toLowerCase());
}

function looksLikeCSV(text, contentType) {
  const loweredType = (contentType || "").toLowerCase();
  const sample = text.slice(0, 200).toLowerCase();
  if (loweredType.includes("text/html")) {
    return false;
  }
  if (sample.includes("<html") || sample.includes("<!doctype")) {
    return false;
  }
  return sample.includes(",") || sample.includes("div");
}

async function readOfflineCSV(name) {
  const filePath = path.join(RAW_DIR, name);
  const content = await readFile(filePath, "utf8");
  console.log(`[offline] loaded ${name} (${content.length} chars)`);
  return content;
}

async function downloadCSV(url, { name, label }) {
  if (OFFLINE_DATA) {
    return readOfflineCSV(name);
  }

  const response = await fetch(url, { headers: REQUEST_HEADERS });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const preview = text.slice(0, 200).replace(/\s+/g, " ");
  console.log(
    `[download] ${label} status=${response.status} content-type=${contentType} preview="${preview}"`
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  if (!looksLikeCSV(text, contentType)) {
    throw new Error(
      `Unexpected response for ${url}. content-type=${contentType} preview="${preview}"`
    );
  }
  return text;
}

async function writeRawFile(name, content) {
  const filePath = path.join(RAW_DIR, name);
  await writeFile(filePath, content, "utf8");
}

function normalizeMatch(row, headerMap, oddsHeaders) {
  const dateISO = parseDateToISO(
    readRowValue(row, headerMap.date) || readRowValue(row, headerMap.matchDate)
  );
  if (!dateISO) return null;

  return {
    dateISO,
    Div: readRowValue(row, headerMap.league) || null,
    HomeTeam:
      readRowValue(row, headerMap.homeTeam) ||
      readRowValue(row, headerMap.home),
    AwayTeam:
      readRowValue(row, headerMap.awayTeam) ||
      readRowValue(row, headerMap.away),
    FTHG: toNumber(readRowValue(row, headerMap.fthg)),
    FTAG: toNumber(readRowValue(row, headerMap.ftag)),
    HS: toNumber(readRowValue(row, headerMap.hs)),
    HST: toNumber(readRowValue(row, headerMap.hst)),
    AS: toNumber(readRowValue(row, headerMap.as)),
    AST: toNumber(readRowValue(row, headerMap.ast)),
    FTR: readRowValue(row, headerMap.ftr) || null,
    AvgH: toNumber(readRowValue(row, headerMap.avgH)),
    AvgD: toNumber(readRowValue(row, headerMap.avgD)),
    AvgA: toNumber(readRowValue(row, headerMap.avgA)),
    AvgOver25: toNumber(readRowValue(row, oddsHeaders.over)),
    AvgUnder25: toNumber(readRowValue(row, oddsHeaders.under))
  };
}

function buildOddsHeaders(headers) {
  const overHeader = findOddsHeader(headers, {
    includes: ["avg", ">", "2.5"],
    fallback: "AvgO2.5"
  });
  const underHeader = findOddsHeader(headers, {
    includes: ["avg", "<", "2.5"],
    fallback: "AvgU2.5"
  });
  return { over: overHeader, under: underHeader };
}

async function buildLeagueData() {
  const leagueRows = {};
  const leagueSummary = {};

  for (const league of Object.keys(LEAGUES)) {
    leagueRows[league] = [];
    leagueSummary[league] = { rows: 0, kept: 0 };
  }

  for (const entry of LEAGUE_URLS) {
    const rawName = `${entry.league}_${entry.season}.csv`;
    const csvText = await downloadCSV(entry.url, {
      name: rawName,
      label: `league ${entry.league} ${entry.season}`
    });
    await writeRawFile(rawName, csvText);
    const rows = parseCSV(csvText);
    console.log(
      `[league] ${entry.league} ${entry.season} rows=${rows.length}`
    );
    if (rows.length === 0) continue;
    const headers = Object.keys(rows[0]);
    const headerMap = buildHeaderMap(headers);
    const resolvedHeaders = {
      league: resolveHeader(headerMap, ["Div", "League", "Division"]),
      date: resolveHeader(headerMap, ["Date"]),
      matchDate: resolveHeader(headerMap, ["MatchDate"]),
      homeTeam: resolveHeader(headerMap, ["HomeTeam"]),
      home: resolveHeader(headerMap, ["Home"]),
      awayTeam: resolveHeader(headerMap, ["AwayTeam"]),
      away: resolveHeader(headerMap, ["Away"]),
      fthg: resolveHeader(headerMap, ["FTHG"]),
      ftag: resolveHeader(headerMap, ["FTAG"]),
      hs: resolveHeader(headerMap, ["HS"]),
      hst: resolveHeader(headerMap, ["HST"]),
      as: resolveHeader(headerMap, ["AS"]),
      ast: resolveHeader(headerMap, ["AST"]),
      ftr: resolveHeader(headerMap, ["FTR"]),
      avgH: resolveHeader(headerMap, ["AvgH"]),
      avgD: resolveHeader(headerMap, ["AvgD"]),
      avgA: resolveHeader(headerMap, ["AvgA"])
    };
    const oddsHeaders = buildOddsHeaders(headers);
    leagueSummary[entry.league].rows += rows.length;

    rows.forEach((row) => {
      const rawLeague = readRowValue(row, resolvedHeaders.league);
      const leagueCode = normalizeLeagueCode(rawLeague);
      if (leagueCode && !LEAGUES[leagueCode]) {
        return;
      }
      const normalized = normalizeMatch(row, resolvedHeaders, oddsHeaders);
      if (!normalized) return;
      const league = leagueCode || entry.league;
      if (!LEAGUES[league]) return;
      normalized.Div = league;
      leagueRows[league].push(normalized);
      leagueSummary[league].kept += 1;
    });
  }

  Object.entries(leagueSummary).forEach(([league, summary]) => {
    console.log(
      `[league] ${league} totalRows=${summary.rows} kept=${summary.kept}`
    );
  });

  for (const [league, matches] of Object.entries(leagueRows)) {
    const filePath = path.join(LEAGUE_DIR, `${league}.json`);
    await writeFile(filePath, JSON.stringify(matches, null, 2));
  }

  const totalMatches = Object.values(leagueRows).reduce(
    (sum, matches) => sum + matches.length,
    0
  );
  if (totalMatches === 0) {
    throw new Error(
      "No league matches were parsed. Check download status, headers, and date parsing."
    );
  }
}

async function buildFixturesIndex() {
  const csvText = await downloadCSV(FIXTURES_URL, {
    name: "fixtures.csv",
    label: "fixtures"
  });
  await writeRawFile("fixtures.csv", csvText);
  const rows = parseCSV(csvText);
  console.log(`[fixtures] rows=${rows.length}`);
  if (rows.length === 0) {
    throw new Error("Fixtures CSV returned 0 rows.");
  }
  const headers = Object.keys(rows[0]);
  console.log(`[fixtures] headers=${headers.join(", ")}`);
  const headerMap = buildHeaderMap(headers);
  const resolvedHeaders = {
    league: resolveHeader(headerMap, ["Div", "League", "Division"]),
    date: resolveHeader(headerMap, ["Date"]),
    homeTeam: resolveHeader(headerMap, ["HomeTeam"]),
    home: resolveHeader(headerMap, ["Home"]),
    awayTeam: resolveHeader(headerMap, ["AwayTeam"]),
    away: resolveHeader(headerMap, ["Away"])
  };
  const leagueValues = new Set();
  let parsedDateSample = null;
  for (const row of rows) {
    const rawLeague = readRowValue(row, resolvedHeaders.league);
    if (rawLeague) {
      leagueValues.add(rawLeague.trim());
    }
    if (!parsedDateSample) {
      const rawDate = readRowValue(row, resolvedHeaders.date);
      const parsedDate = parseDateToISO(rawDate);
      if (rawDate && parsedDate) {
        parsedDateSample = `${rawDate} -> ${parsedDate}`;
      }
    }
  }
  console.log(
    `[fixtures] leagueField=${resolvedHeaders.league || "unknown"} values=${[
      ...leagueValues
    ]
      .slice(0, 15)
      .join(", ")}`
  );
  if (parsedDateSample) {
    console.log(`[fixtures] dateSample=${parsedDateSample}`);
  }

  const fixturesByLeague = {};
  Object.keys(LEAGUES).forEach((league) => {
    fixturesByLeague[league] = [];
  });
  const fixturesSummary = {
    total: rows.length,
    missingLeague: 0,
    missingDate: 0,
    missingTeams: 0,
    kept: 0
  };

  rows.forEach((row) => {
    const rawLeague = readRowValue(row, resolvedHeaders.league);
    const league = normalizeLeagueCode(rawLeague);
    if (!league || !LEAGUES[league]) {
      fixturesSummary.missingLeague += 1;
      return;
    }
    const rawDate = readRowValue(row, resolvedHeaders.date);
    const dateISO = parseDateToISO(rawDate);
    if (!dateISO) {
      fixturesSummary.missingDate += 1;
      return;
    }
    const homeTeam =
      readRowValue(row, resolvedHeaders.homeTeam) ||
      readRowValue(row, resolvedHeaders.home);
    const awayTeam =
      readRowValue(row, resolvedHeaders.awayTeam) ||
      readRowValue(row, resolvedHeaders.away);
    if (!homeTeam || !awayTeam) {
      fixturesSummary.missingTeams += 1;
      return;
    }
    const id = `${league}-${dateISO}-${homeTeam}-${awayTeam}`
      .replace(/\s+/g, "-")
      .toLowerCase();
    fixturesByLeague[league].push({
      id,
      league,
      dateISO,
      homeTeam,
      awayTeam
    });
    fixturesSummary.kept += 1;
  });

  Object.keys(fixturesByLeague).forEach((league) => {
    fixturesByLeague[league].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  });

  const filePath = path.join(DATA_DIR, "fixtures_index.json");
  await writeFile(filePath, JSON.stringify(fixturesByLeague, null, 2));
  console.log(
    `[fixtures] summary total=${fixturesSummary.total} kept=${fixturesSummary.kept} missingLeague=${fixturesSummary.missingLeague} missingDate=${fixturesSummary.missingDate} missingTeams=${fixturesSummary.missingTeams}`
  );

  const totalFixtures = Object.values(fixturesByLeague).reduce(
    (sum, fixtures) => sum + fixtures.length,
    0
  );
  if (totalFixtures === 0) {
    throw new Error(
      "No fixtures were parsed. Check league mapping, headers, and date parsing."
    );
  }
}

try {
  await buildFixturesIndex();
  await buildLeagueData();
  console.log("Data build complete.");
} catch (error) {
  console.error("Data build failed:", error);
  process.exit(1);
}
