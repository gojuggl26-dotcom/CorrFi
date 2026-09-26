// Headless check of the replay page (R §8, AC1): opens replay.html at 1920x1080, waits for READY, presses START,
// waits for the Verifier's verdict and saves screenshots. The Driver (--wait-start), the Verifier and the page server
// must already run.   node scripts/replay-smoke.ts <out dir> [url]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] ?? "replay-smoke";
const url = process.argv[3] ?? "http://127.0.0.1:5173/replay.html";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => document.body.dataset.status === "ready", undefined, { timeout: 120_000 });
await page.screenshot({ path: join(out, "0-ready.png") });
const t0 = Date.now();
await page.click("#start");
const shots = [[20_000, "1-phaseA"], [55_000, "2-phaseA"], [92_000, "3-phaseB"]] as const;
for (const [at, name] of shots) {
  await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
  await page.screenshot({ path: join(out, `${name}.png`) });
}
await page.waitForFunction(() => (document.getElementById("verdict")?.textContent ?? "") !== "", undefined, { timeout: 180_000 });
const toVerdict = Date.now() - t0;
const verdict = await page.textContent("#verdict");
await page.screenshot({ path: join(out, "4-verified.png") });
console.log(JSON.stringify({ startToVerdictMs: toVerdict, verdict, pageErrors: errors }));
await browser.close();
