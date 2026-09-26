// Browser smoke test of the swap screen on a local Anvil (not part of CI): deploys, creates the 7D market from the
// calib fixture, opens the maker's books, reports three bars, serves the UI with a dev account, and drives it in
// Chromium: quote -> execute -> positions, then a T-2 stop. Screenshots go to the directory given as argument.
//   node scripts/smoke.ts <out-dir>
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { testUsdcAbi } from "../../engine/src/abi.ts";
import { createMarket, marketInputFromCalib } from "../../engine/src/createMarket.ts";
import { MakerOps, MVP_CONFIG } from "../../engine/src/maker.ts";
import { Reporter } from "../../engine/src/reporter.ts";
import { FixtureSource } from "../../engine/test/anvil/fixtureSource.ts";
import { ROOT, startChain } from "../../engine/test/anvil/harness.ts";

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), "corrfi-smoke-"));
mkdirSync(out, { recursive: true });
const T0 = 1_789_689_600;
const U = 10n ** 6n;
const c = await startChain({ genesis: T0 - 3600 });
const shots: string[] = [];
try {
  await c.setTime(T0 - 240);
  await createMarket(c.pc, c.wallet("owner"), c.account("engine"), c.dep, marketInputFromCalib(join(ROOT, "vectors", "calib_7d_20260918.json")));
  for (const [who, amt] of [["maker", 200_000n], ["taker", 20_000n]] as const) {
    await c.pc.waitForTransactionReceipt({ hash: await c.wallet("owner").writeContract({ address: c.dep.usdc, abi: testUsdcAbi, functionName: "mint", args: [c.account(who).address, amt * U] }) });
  }
  const maker = new MakerOps(c.pc, c.wallet("maker"), c.dep);
  await maker.setConfig(MVP_CONFIG);
  await maker.open(0, 1, 55_000n * U, 105_000n * U);
  const reporter = new Reporter({ pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source: new FixtureSource(), now: c.now, log: () => {} });
  for (let k = 0; k <= 2; ++k) {
    await c.setTime(T0 + k * 300 + 10);
    await reporter.tick();
  }
  await c.setTime(T0 + 2 * 300 + 40);

  const pub = mkdtempSync(join(tmpdir(), "corrfi-ui-"));
  const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(join(pub, "config.json"), json({ chainId: c.dep.chainId, chainName: "Anvil (local)", rpcUrl: c.rpc, deployment: c.dep, defaultMaker: c.account("maker").address, devAccount: c.account("taker").address }));
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), publicDir: pub, server: { port: 5199, strictPort: true }, logLevel: "error" });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (e) => console.log("page error:", e.message));
    await page.goto("http://localhost:5199/trade.html");
    await page.getByText("Average price").waitFor({ timeout: 30_000 });
    await page.click("#connect");
    await page.locator("#account").filter({ hasText: "0x" }).waitFor();
    await page.locator("#status.ok").waitFor({ timeout: 15_000 });
    const s1 = join(out, "1-quote.png");
    await page.screenshot({ path: s1, fullPage: true });
    shots.push(s1);
    await page.click("#execute");
    await page.locator("#result").filter({ hasText: "Filled" }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const s2 = join(out, "2-filled.png");
    await page.screenshot({ path: s2, fullPage: true });
    shots.push(s2);
    // the reporter stops: after t_k + Δ + g the screen shows the stop and disables execution
    await c.setTime(T0 + 2 * 300 + 361);
    await page.fill("#amount", "999");
    await page.locator("#status.stop").waitFor({ timeout: 15_000 });
    const s3 = join(out, "3-stopped.png");
    await page.screenshot({ path: s3, fullPage: true });
    shots.push(s3);
    console.log(JSON.stringify({ ok: true, shots, execDisabled: await page.locator("#execute").isDisabled(), status: await page.locator("#status").textContent() }));
  } finally {
    await browser.close();
    await server.close();
  }
} finally {
  c.stop();
}
