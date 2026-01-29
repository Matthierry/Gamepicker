# Gamepicker

A zero-cost static site that surfaces upcoming English league fixtures and generates form/odds breakdowns from historical CSV data. The site is hosted with GitHub Pages and uses a scheduled GitHub Actions workflow to build JSON data for the frontend.

## Local setup

1. Run the data build (requires Node.js 18+):
   ```bash
   node scripts/build-data.mjs
   ```
2. Serve the site locally:
   ```bash
   python3 -m http.server
   ```
3. Open `http://localhost:8000` in your browser.

## UI smoke test

Run the Playwright-based mobile smoke test (requires Playwright browsers installed):

```bash
node scripts/ui-smoke.mjs
```

## Data pipeline

- `scripts/build-data.mjs` downloads the fixtures CSV plus current and previous season CSVs for leagues E0-E3.
- Raw CSVs are stored in `data/raw`.
- Normalized match data is written to `data/league_matches/{league}.json`.
- Upcoming fixtures are written to `data/fixtures_index.json`.
- The GitHub Actions workflow `.github/workflows/build-data.yml` runs every 6 hours and on manual dispatch, committing updated JSON/CSV data back to the repo.

## Table computations

For a selected fixture (league, home team, away team, fixture date) and window size (60/90/120/150 days):

- The historical pool is the combined previous + current season CSVs for the league.
- Matches are filtered to `fixtureDate - windowDays <= matchDate < fixtureDate`.
- Home table uses matches where `HomeTeam == selected home team`.
- Away table uses matches where `AwayTeam == selected away team`.
- League tables use all matches for the league in the window.

### Metrics

Each table reports:

- Averages: `FTHG`, `HS`, `HST`, `FTAG`, `AS`, `AST`, `AvgH`, `AvgD`, `AvgA`, `Avg>2.5`, `Avg<2.5`
- Totals: `Games Played`, `Home Win`, `Draw`, `Away Win`, `Over 2.5`, `Under 2.5`

Odds fields ignore `null` values when averaging.

### Combined league average

The combined table includes the same match-level averages as the other tables and adds three extra columns:

- **Combined Goals/Team** = mean of `[FTHG, FTAG]` across all league matches in the window.
- **Combined Shots/Team** = mean of `[HS, AS]`.
- **Combined SOT/Team** = mean of `[HST, AST]`.

These fields represent per-team values independent of home/away splits.

## League mappings

- E0 = Premier League
- E1 = Championship
- E2 = League 1
- E3 = League 2
