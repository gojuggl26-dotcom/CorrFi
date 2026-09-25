// Operator: create a market from calib.json (data/make_calib.py) with the signed initial report.
//   RPC_URL, DEPLOYMENT, OWNER_KEY (hub owner), ENGINE_KEY (price engine)    node bin/create-market.ts calib.json
import { createMarket, marketInputFromCalib } from "../src/createMarket.ts";
import { setup } from "./common.ts";

const { pc, dep, wallet, account } = setup();
const calib = process.argv[2];
if (!calib) throw new Error("usage: create-market.ts <calib.json>");
const r = await createMarket(pc, wallet("OWNER_KEY"), account("ENGINE_KEY"), dep, marketInputFromCalib(calib));
console.log(JSON.stringify({ marketId: r.id, pFair0: r.pFair0.toString(), h00: r.h00.toString(), tx: r.hash }));
