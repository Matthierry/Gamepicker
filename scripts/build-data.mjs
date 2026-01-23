import { mkdir, writeFile } from "node:fs/promises";
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
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
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
      headers = fields.map((field) => field.trim());
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

  const parts = trimmed.split(/[\/.-]/).filter(Boolean);
  if (parts.length < 3) return null;
  const [day, month, yearRaw] = parts;
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

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function writeRawFile(name, content) {
  const filePath = path.join(RAW_DIR, name);
  await writeFile(filePath, content, "utf8");
}

function normalizeMatch(row, headers, oddsHeaders) {
  const dateISO = parseDateToISO(row.Date || row.date);
  if (!dateISO) return null;

  return {
    dateISO,
    Div: row.Div || row.div || null,
    HomeTeam: row.HomeTeam || row.Home || null,
    AwayTeam: row.AwayTeam || row.Away || null,
    FTHG: toNumber(row.FTHG),
    FTAG: toNumber(row.FTAG),
    HS: toNumber(row.HS),
    HST: toNumber(row.HST),
    AS: toNumber(row.AS),
    AST: toNumber(row.AST),
    FTR: row.FTR || null,
    AvgH: toNumber(row.AvgH),
    AvgD: toNumber(row.AvgD),
    AvgA: toNumber(row.AvgA),
    AvgOver25: toNumber(row[oddsHeaders.over]),
    AvgUnder25: toNumber(row[oddsHeaders.under])
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

  for (const league of Object.keys(LEAGUES)) {
    leagueRows[league] = [];
  }

  for (const entry of LEAGUE_URLS) {
    const csvText = await download(entry.url);
    await writeRawFile(`${entry.league}_${entry.season}.csv`, csvText);
    const rows = parseCSV(csvText);
    if (rows.length === 0) continue;
    const headers = Object.keys(rows[0]);
    const oddsHeaders = buildOddsHeaders(headers);

    rows.forEach((row) => {
      if (row.Div && !LEAGUES[row.Div]) {
        return;
      }
      const normalized = normalizeMatch(row, headers, oddsHeaders);
      if (!normalized) return;
      const league = normalized.Div || entry.league;
      if (!LEAGUES[league]) return;
      leagueRows[league].push(normalized);
    });
  }

  for (const [league, matches] of Object.entries(leagueRows)) {
    const filePath = path.join(LEAGUE_DIR, `${league}.json`);
    await writeFile(filePath, JSON.stringify(matches, null, 2));
  }
}

async function buildFixturesIndex() {
  const csvText = await download(FIXTURES_URL);
  await writeRawFile("fixtures.csv", csvText);
  const rows = parseCSV(csvText);

  const fixturesByLeague = {};
  Object.keys(LEAGUES).forEach((league) => {
    fixturesByLeague[league] = [];
  });

  rows.forEach((row) => {
    const league = row.Div || row.div;
    if (!LEAGUES[league]) return;
    const dateISO = parseDateToISO(row.Date || row.date);
    if (!dateISO) return;
    const homeTeam = row.HomeTeam || row.Home;
    const awayTeam = row.AwayTeam || row.Away;
    if (!homeTeam || !awayTeam) return;
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
  });

  Object.keys(fixturesByLeague).forEach((league) => {
    fixturesByLeague[league].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  });

  const filePath = path.join(DATA_DIR, "fixtures_index.json");
  await writeFile(filePath, JSON.stringify(fixturesByLeague, null, 2));
}

try {
  await buildFixturesIndex();
  await buildLeagueData();
  console.log("Data build complete.");
} catch (error) {
  console.error("Data build failed:", error);
  process.exit(1);
}
