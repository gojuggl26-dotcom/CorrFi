// The replay's price engine (R §5.4): a separate process that knows calib.json (parameters from before obsStart), the
// hub address and its own key — never bars.json. The Driver POSTs the bars of each step; the engine accumulates them
// with the contract's fixed-point arithmetic (the production engine's code) and returns the signed report.
//   node replay/engine-server.ts <calib.json> <addresses.json> [--port 8788]
//   POST /bars {"points":[{"k","t","pA","pB","validA","validB"}...]}  -> {"marketId","k","pFair","h0","signature"}
//   GET /health
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Address } from "viem";
import { type Deployment, signReport } from "../src/chain.ts";
import { type AccState, type ChainPoint, crank, type MarketParams, reportFor } from "../src/market.ts";
import { account } from "./chain.ts";

const [calibPath, addrPath] = process.argv.slice(2);
if (!calibPath || !addrPath) throw new Error("usage: engine-server.ts <calib.json> <addresses.json> [--port 8788]");
const pi = process.argv.indexOf("--port");
const port = pi > 0 ? Number(process.argv[pi + 1]) : 8788;
const calib = JSON.parse(readFileSync(calibPath, "utf8"));
const addr = JSON.parse(readFileSync(addrPath, "utf8"));
const H_FLOOR = 5n * 10n ** 15n; // protocol constant (M §8.1; Deploy.s.sol)
const B = (x: string) => BigInt(x);
const m: MarketParams = {
  id: addr.market.id,
  obsStart: calib.obsStart,
  obsEnd: calib.obsStart + calib.tenorDays * 86_400,
  n: calib.tenorDays * 288,
  nMin: Math.ceil((calib.tenorDays * 288 * 99) / 100),
  csA: 4n * B(calib.sA),
  csB: 4n * B(calib.sB),
  sAB: B(calib.sAB),
  sA2: B(calib.sA2),
  sB2: B(calib.sB2),
  sigmaTable: calib.sigmaTable.map(B),
  cH: B(calib.cH),
  lambda: B(calib.lambda),
  hFloor: H_FLOOR,
};
const dep: Deployment = { chainId: 84532, hub: addr.protocol.hub as Address } as Deployment;
const key = account("engine");
const points = new Map<number, ChainPoint>();
let acc: AccState = { processed: 0, nValid: 0, c: 0n, va: 0n, vb: 0n };
let reports = 0;

const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, processed: acc.processed, reports });
  if (req.method !== "POST" || req.url !== "/bars") return send(404, { error: "not found" });
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const { points: ps } = JSON.parse(body) as { points: { t: number; pA: string; pB: string; validA: boolean; validB: boolean }[] };
    for (const p of ps) points.set(p.t, { pA: B(p.pA), pB: B(p.pB), posted: true, validA: p.validA, validB: p.validB });
    // time is not needed: the grace exit never applies while the reporter posts (the report carries no time)
    acc = crank(m, acc, (t) => points.get(t), m.n, 0);
    const { report, problem } = reportFor(m, acc);
    if (!report) return send(422, { error: problem, k: acc.processed });
    const signature = await signReport(key, dep, report);
    reports += 1;
    send(200, { ...report, signature, nValid: acc.nValid, c: acc.c, va: acc.va, vb: acc.vb });
  } catch (e) {
    send(500, { error: (e as Error).message });
  }
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ ev: "engine_ready", port, market: m.id, obsStart: m.obsStart })));
