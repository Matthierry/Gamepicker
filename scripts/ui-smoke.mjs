import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium, devices } from "playwright";

const PORT = Number(process.env.PORT || 8000);
const BASE_URL = `http://localhost:${PORT}`;
const OUTPUT_DIR = path.resolve("artifacts/ui-smoke");

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const response = await fetch(url, { method: "HEAD" });
        if (response.ok) {
          resolve();
          return;
        }
      } catch (error) {
        // Ignore until timeout.
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

async function run() {
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const server = spawn("python3", ["-m", "http.server", String(PORT)], {
    stdio: "ignore"
  });

  try {
    await waitForServer(BASE_URL);
    const iphone = devices["iPhone 14 Pro Max"];
    const browser = await chromium.launch();
    const context = await browser.newContext({
      ...iphone,
      viewport: { width: 430, height: 932 }
    });
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const fixtureSelect = document.querySelector("#fixtureSelect");
      return fixtureSelect && fixtureSelect.options.length > 1;
    });

    await page.click("#generateBtn");
    await page.waitForSelector(".table-card table");

    const hasData = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll(".table-card table"))
        .filter((table) => !table.classList.contains("matrix-table"));
      return tables.some((table) => Array.from(table.querySelectorAll("td")).some((td) => {
        const text = td.textContent || "";
        return /\d/.test(text) && td.dataset.label;
      }));
    });

    if (!hasData) {
      throw new Error("No numeric table values found in stacked tables.");
    }

    const controls = await page.waitForSelector(".controls");
    await controls.screenshot({ path: path.join(OUTPUT_DIR, "controls.png") });

    const firstCard = await page.waitForSelector(".table-card");
    await firstCard.screenshot({ path: path.join(OUTPUT_DIR, "stacked-stat-card.png") });

    const predictionsCard = await page.waitForSelector(".predictions .table-card");
    await predictionsCard.screenshot({ path: path.join(OUTPUT_DIR, "predictions-metrics.png") });

    const matrixWrapper = await page.waitForSelector(".matrix-wrapper");
    await matrixWrapper.screenshot({ path: path.join(OUTPUT_DIR, "correct-score-matrix.png") });

    await browser.close();
  } finally {
    server.kill("SIGTERM");
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
