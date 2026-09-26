"""R §7: the replay's verification items V1-V8, from the data files and the chain only (events and eth_call).

The Verifier shares no code with the Driver or the price engine: amounts and fair values are recomputed with this
package's fixed-point port (V3, V5, V6) and with 50-digit arithmetic straight from the formulas (V2)."""
from __future__ import annotations

import json
import time
from pathlib import Path

import mpmath

from . import fixedpoint as fp
from .chain import Rpc, call, event_table, logs, signed, words
from .keccak import keccak256

ROOT = Path(__file__).resolve().parents[2]
WAD = 10**18
DELTA = 300
U = 10**6


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class Verifier:
    def __init__(self, week_dir: Path, rpc_url: str, bars_file: str = "bars.json", emit=lambda item: None):
        self.dir = Path(week_dir)
        rd = lambda f: json.loads((self.dir / f).read_text(encoding="utf-8"))
        self.bars, self.calib, self.sched = rd(bars_file), rd("calib.json"), rd("schedule.json")
        self.manifest, self.addr = rd("manifest.json"), rd("addresses.json")
        self.bars_file = bars_file
        self.rpc = Rpc(rpc_url)
        self.emit = emit
        self.table = event_table("CorrFiHub.sol:CorrFiHub", "CorrFiRouter.sol:CorrFiRouter", "CorrFiVault.sol:CorrFiVault",
                                 "CorrFiEngine.sol:CorrFiEngine", "SwapVM.sol:SwapVM")
        p = self.addr["protocol"]
        self.hub, self.router, self.lens, self.usdc, self.aqua = (p["hub"], p["router"], p["lens"], p["usdc"], p["aqua"])
        m = self.addr["market"]
        self.mid, self.vault, self.long, self.short = m["id"], m["vault"], m["longToken"], m["shortToken"]
        self.maker = self.addr["accounts"]["maker"]
        self.t0, self.n, self.n_min = self.bars["obsStart"], self.bars["n"], self.bars["nMin"]
        self.points = {p["t"]: p for p in self.bars["points"]}
        self.sA, self.sB = int(self.calib["sA"]), int(self.calib["sB"])
        self.sAB, self.sA2, self.sB2 = int(self.calib["sAB"]), int(self.calib["sA2"]), int(self.calib["sB2"])
        self.table_sigma = [int(x) for x in self.calib["sigmaTable"]]
        self.cH, self.lam = int(self.calib["cH"]), int(self.calib["lambda"])
        self.results: dict[str, dict] = {}
        # protocol constants from the chain (not assumed): h_floor, c_O, g
        self.h_floor = call(self.rpc, self.hub, "hFloor()", [], [])[0]
        prm = call(self.rpc, self.router, "params()", [], [])
        self.c_o, self.grace = prm[0], prm[1]
        self.fail: dict[str, list] = {f"V{i}": [] for i in range(1, 9)}
        self.count = {f"V{i}": 0 for i in range(1, 9)}
        self.last_block = 0
        # running state for V6 (reports) and V4 (golden table)
        self.acc = (0, 0, 0, 0)  # c, va, vb, n_valid after `processed`
        self.processed = 0
        self.confirmed, self.p_prev = 0, fp.fair_value(0, 0, 0, 0, self.n, self.sAB, self.sA2, self.sB2)
        self.sig2 = fp.sigma_bar2_init(int(self.calib["sigma0"]))
        self.golden = list(self.sched["golden"])
        self.golden_i = 1  # row 0 is the initial state
        self.q4 = None
        self.trade_specs = [t for t in self.sched["trades"]]
        self.payouts: dict[str, int] = {}
        self.finalized = None
        self.done = False

    # ---- helpers
    def at(self, block: int, to: str, sig: str, types=(), values=()) -> list[int]:
        return call(self.rpc, to, sig, list(types), list(values), block)

    def state(self, block: int) -> dict:
        nl, ns, _ = self.at(block, self.vault, "custodyOf(address)", ["address"], [self.maker])[:3]
        sup_l = self.at(block, self.long, "totalSupply()")[0]
        sup_s = self.at(block, self.short, "totalSupply()")[0]
        coll = self.at(block, self.vault, "collateral()")[0]
        usdc_v = self.at(block, self.usdc, "balanceOf(address)", ["address"], [self.vault])[0]
        l_in_v = self.at(block, self.long, "balanceOf(address)", ["address"], [self.vault])[0]
        s_in_v = self.at(block, self.short, "balanceOf(address)", ["address"], [self.vault])[0]
        fin = self.at(block, self.vault, "finalized()")[0]
        o_l = self.at(block, self.aqua, "rawBalances(address,address,bytes32,address)", ["address", "address", "bytes32", "address"],
                      [self.maker, self.router, self.addr["orders"]["longHash"], self.long])[0]
        o_s = self.at(block, self.aqua, "rawBalances(address,address,bytes32,address)", ["address", "address", "bytes32", "address"],
                      [self.maker, self.router, self.addr["orders"]["shortHash"], self.short])[0]
        return {"nl": nl, "ns": ns, "q": nl - ns, "supL": sup_l, "supS": sup_s, "coll": coll, "usdcV": usdc_v,
                "lInV": l_in_v, "sInV": s_in_v, "finalized": bool(fin), "orderL": o_l, "orderS": o_s}

    def ok(self, v: str, cond: bool, detail: str):
        self.count[v] += 1
        if not cond:
            self.fail[v].append(detail)
        self.emit({"item": v, "ok": cond, "detail": detail, "checked": self.count[v], "failures": len(self.fail[v])})

    # ---- V4 at a block (A1 before settlement, A2, A5)
    def v4(self, block: int, label: str) -> dict:
        s = self.state(block)
        a1 = s["finalized"] or (s["supL"] == s["supS"] == s["coll"] == s["usdcV"])
        a2 = s["nl"] == 0 or s["ns"] == 0
        a5 = s["lInV"] == s["nl"] and s["sInV"] == s["ns"] and s["orderL"] == 0 and s["orderS"] == 0
        self.ok("V4", a1 and a2 and a5, f"{label} @{block}: A1 {a1} A2 {a2} A5 {a5} "
                                        f"(nl {s['nl']} ns {s['ns']} L in vault {s['lInV']} S in vault {s['sInV']} "
                                        f"orders {s['orderL']}/{s['orderS']} supply {s['supL']}/{s['supS']} coll {s['coll']} usdc {s['usdcV']})")
        return s

    def golden_check(self, block: int, event: str):
        if self.bars_file != "bars.json" or self.golden_i >= len(self.golden):
            return
        row = self.golden[self.golden_i]
        if row["after"] != event:
            return
        s = self.state(block)
        exp = {k: _golden_value(row[k], self.q4 or 0) for k in ("q", "nl", "ns", "collateral", "supply")}
        got = {"q": s["q"], "nl": s["nl"], "ns": s["ns"], "collateral": s["coll"], "supply": s["supL"]}
        self.ok("V4", exp == got, f"golden {event}: expected {exp} got {got}")
        self.golden_i += 1

    # ---- event handlers
    def on_point(self, e: dict):
        p = self.points.get(e["t"])
        good = p is not None and int(p["pA"]) == e["pA"] and int(p["pB"]) == e["pB"] and p["validA"] == e["validA"] and p["validB"] == e["validB"]
        self.ok("V1", good, f"point t={e['t']}")

    def _bars_between(self, k0: int, k1: int):
        c, va, vb, nv = self.acc
        cs_a, cs_b = 4 * self.sA, 4 * self.sB
        for k in range(k0 + 1, k1 + 1):
            a, b = self.points[self.t0 + (k - 1) * DELTA], self.points[self.t0 + k * DELTA]
            if a["validA"] and a["validB"] and b["validA"] and b["validB"]:
                ra = fp.winsorize(fp.log_ratio(int(a["pA"]), int(b["pA"])), cs_a)
                rb = fp.winsorize(fp.log_ratio(int(a["pB"]), int(b["pB"])), cs_b)
                c, va, vb = fp.accumulate(c, va, vb, ra, rb)
                nv += 1
        self.acc = (c, va, vb, nv)

    def on_report(self, e: dict):
        k = e["k"]
        self._bars_between(self.processed, k)
        self.processed = k
        c, va, vb, _ = self.acc
        p = fp.fair_value(c, va, vb, k, self.n, self.sAB, self.sA2, self.sB2)
        h = fp.h0(fp.tau(k, self.n), self.table_sigma, self.cH, self.h_floor)
        self.sig2 = fp.sigma_bar2_update(self.sig2, p - self.p_prev, k - self.confirmed, self.lam)
        good = p == e["pFair"] and h == e["h0"] and self.sig2 == e["sig2"]
        self.ok("V6", good, f"report k={k}: pFair {p == e['pFair']} h0 {h == e['h0']} sig2 {self.sig2 == e['sig2']}")
        self.confirmed, self.p_prev = k, p
        self.v4(e["_block"], f"step k={k}")

    def on_trade(self, cs: dict, sw: dict):
        block = cs["_block"]
        before = self.state(block - 1)
        tb = int(self.rpc.call("eth_getBlockByNumber", [hex(block), False])["timestamp"], 16)
        spec = next((t for t in self.trade_specs if t["op"] == "trade" and t["k"] == self.confirmed and not t.get("_seen")), None)
        if spec is None:
            self.ok("V5", False, f"unexpected trade at k={self.confirmed}")
            return
        spec["_seen"] = True
        side = 0 if spec["side"] == "long" else 1
        is_buy, exact_in, amount = spec["isBuy"], spec["exactIn"], int(spec["amount"])
        cfg = self.sched["maker"]["config"]
        curve = fp.Curve(cs["pFair"], cs["h"], cs["hmin"], int(cfg["kq"]), int(cfg["qMaxMarket"]))
        q0, d = before["q"], cs["dir"]
        if d == 1:
            exp = (amount, fp.qty_d1_exact_in(curve, q0, amount)) if exact_in else (fp.pay_d1(curve, q0, amount), amount)
        elif d == 2:
            exp = (amount, fp.receive_d2(curve, q0, amount)) if exact_in else (fp.qty_d2_exact_out(curve, q0, amount), amount)
        elif d == 3:
            exp = (amount, fp.qty_d3_exact_in(curve, q0, amount)) if exact_in else (fp.pay_d3(curve, q0, amount), amount)
        else:
            exp = (amount, fp.receive_d4(curve, q0, amount)) if exact_in else (fp.qty_d4_exact_out(curve, q0, amount), amount)
        got = (sw["amountIn"], sw["amountOut"])
        taker = self.addr["accounts"][spec["actor"]].lower()
        # the breakdown and the standard quote on the state before the trade, at the trade's block time
        order = self.addr["orders"]["long" if side == 0 else "short"]
        o = [order["maker"], int(order["traits"]), order["data"]]
        ov = {"time": hex(tb), "number": hex(block)}
        bd = words(self.rpc.eth_call(self.lens, keccak256(b"breakdown((address,uint256,bytes),uint8,uint8,bool,bool,uint256,uint256)")[:4]
                                     + _enc_breakdown(o, self.mid, side, is_buy, exact_in, amount, int(self.sched["toleranceWad"])), block - 1, ov))
        token_a = "0x" + bytes.fromhex(order["data"][2:])[:20].hex()
        a_to_b = (token_a == self.usdc.lower()) if is_buy else (token_a != self.usdc.lower())
        flags = (1 if exact_in else 0) | 0x40 | (0x80 if a_to_b else 0)
        traits = b"\0" * 20 + flags.to_bytes(2, "big")
        qt = self.rpc.call("eth_call", [{"to": self.router, "from": taker, "data": "0x" + (keccak256(b"quote((address,uint256,bytes),uint256,bytes)")[:4]
                           + _enc_quote(o, amount, traits)).hex()}, hex(block - 1), {}, ov])
        qw = words(bytes.fromhex(qt[2:]))
        exp_q = spec.get("expect", {})
        q1q2 = (cs["q1"], cs["q2"])
        exp_q1q2 = (int(exp_q["q1"]), int(exp_q["q2"])) if exp_q.get("q2") not in (None, "Q4") else (int(exp_q.get("q1", 0)), cs["q2"])
        good = (exp == got and (bd[2], bd[3]) == got and (qw[0], qw[1]) == got and sw["taker"].lower() == taker
                and q1q2 == exp_q1q2 and d == exp_q.get("dir", d))
        self.ok("V5", good, f"{spec['id']}: formula {exp == got}, breakdown {(bd[2], bd[3]) == got}, quote {(qw[0], qw[1]) == got}, "
                            f"taker {sw['taker'].lower() == taker}, Q1/Q2 {q1q2 == exp_q1q2}")
        # V6 at trade time: T-1..T-4 held and h_O from the age
        age = max(0, tb - (self.t0 + self.confirmed * DELTA)) if tb > self.t0 else 0
        q = self.at(block - 1, self.hub, "quoteState(uint8)", ["uint8"], [self.mid])
        h0_now, invalid = q[1], q[5]
        ho = fp.h_o(age, self.sig2, self.c_o)
        conds = age <= DELTA + self.grace and q[3] == q[4] and invalid <= (self.n - self.n_min) // 2 and cs["hmin"] == h0_now + ho
        self.ok("V6", conds, f"{spec['id']}: age {age}s, T-1 {q[3] == q[4]}, invalid {invalid}, h_O {cs['hmin'] == h0_now + ho}")
        if spec["id"] == "S4":
            self.q4 = cs["q1"] + cs["q2"]
        self.v4(block, f"after {spec['id']}")
        self.golden_check(block, spec["id"])

    def on_vault_op(self, e: dict):
        if e["_name"] == "Minted" and e["account"].lower() == self.addr["accounts"]["A"].lower():
            self.v4(e["_block"], "after S0a")
            self.golden_check(e["_block"], "S0a")
        elif e["_name"] == "Burned" and e["account"].lower() == self.addr["accounts"]["A"].lower():
            self.v4(e["_block"], "after S3b")
            self.golden_check(e["_block"], "S3b")

    def on_finalized(self, e: dict):
        self.finalized = e
        # V3: the fixed-point port over every bar = the chain's accumulator and Long_T
        pa = [int(p["pA"]) if p["validA"] else None for p in self.bars["points"]]
        pb = [int(p["pB"]) if p["validB"] else None for p in self.bars["points"]]
        lt, void, c, va, vb, nv = fp.settle_from_prices(pa, pb, self.sA, self.sB, 4, self.n_min)
        s = self.at(e["_block"], self.hub, "settlement(uint8)", ["uint8"], [self.mid])
        chain = (s[3], signed(s[4]), s[5], s[6])
        self.ok("V3", (nv, c, va, vb) == chain and lt == e["longT"] and void == e["isVoid"],
                f"C, V_A, V_B, n_valid {(nv, c, va, vb) == chain}; Long_T {lt} vs {e['longT']}")
        # V2: 50 digits from the formulas (independent of the integer implementation)
        mpmath.mp.dps = 50
        ca, cb = mpmath.mpf(4 * self.sA) / WAD, mpmath.mpf(4 * self.sB) / WAD
        C = VA = VB = mpmath.mpf(0)
        n_valid = 0
        for k in range(1, self.n + 1):
            a0, a1, b0, b1 = pa[k - 1], pa[k], pb[k - 1], pb[k]
            if None in (a0, a1, b0, b1):
                continue
            ra = max(-ca, min(ca, mpmath.log(mpmath.mpf(a1) / a0)))
            rb = max(-cb, min(cb, mpmath.log(mpmath.mpf(b1) / b0)))
            C, VA, VB, n_valid = C + ra * rb, VA + ra * ra, VB + rb * rb, n_valid + 1
        hp = mpmath.mpf("0.5") if n_valid < self.n_min or VA == 0 or VB == 0 else (C / mpmath.sqrt(VA * VB) + 1) / 2
        diff = abs(hp - mpmath.mpf(e["longT"]) / WAD)
        self.results["V2"] = {"longT_hp": mpmath.nstr(hp, 20), "diff": mpmath.nstr(diff, 3)}
        self.ok("V2", diff <= mpmath.mpf("1e-9"), f"|Long_T(50 digits) - Long_T(chain)| = {mpmath.nstr(diff, 3)}")

    def on_payout(self, e: dict):
        who = next((k for k, v in self.addr["accounts"].items() if v.lower() == e["account" if "account" in e else "maker"].lower()), "?")
        l, s = (e["longAmount"], e["shortAmount"])
        exp = fp.payout(l, s, self.finalized["longT"])
        self.payouts[who] = e["payout"]
        self.ok("V3", exp == e["payout"], f"payout {who}: {e['payout']} = floor(qL L) + floor(qS (1-L)) {exp}")
        if e["_name"] == "DepositClaimed":
            self.finish(e["_block"])

    # ---- the end: V4 after redemptions, V7, V8
    def finish(self, block: int):
        s = self.state(block)
        held = self.finalized and self.at(self.finalized["_block"], self.usdc, "balanceOf(address)", ["address"], [self.vault])[0]
        total = sum(self.payouts.values())
        dust = held - total if held else None
        self.ok("V4", held is not None and 0 <= dust < 4 and s["usdcV"] == dust,
                f"payouts {total} <= collateral {held}; dust {dust} units (< 4) = the vault's USDC {s['usdcV']}")
        self.v7()
        ref = self.manifest.get("reference" if self.bars_file == "bars.json" else "referenceVoid")
        blk = self.rpc.call("eth_getBlockByNumber", ["latest", False])
        if ref:
            same = blk["stateRoot"] == ref["stateRoot"] and str(self.finalized["longT"]) == ref["longT"] and \
                {k: str(v) for k, v in self.payouts.items()} == ref["payouts"]
            self.ok("V8", same, f"state root {blk['stateRoot'][:18]}.. vs reference {ref['stateRoot'][:18]}..; Long_T and payouts")
        else:
            self.ok("V8", False, "no reference in manifest.json (run the reference first)")
        self.results["stateRoot"] = blk["stateRoot"]
        self.results["longT"] = str(self.finalized["longT"])
        self.done = True

    def v7(self):
        build = json.loads((ROOT / "contracts" / "build-manifest.json").read_text(encoding="utf-8"))
        if keccak256(canonical(build)).hex() != self.manifest["contracts"]["buildManifestKeccak256"][2:]:
            self.ok("V7", False, "contracts/build-manifest.json differs from the one recorded in manifest.json")
        for t in self.addr["creationTxs"]:
            c = build["contracts"][t["name"]]
            tx = self.rpc.call("eth_getTransactionByHash", [t["hash"]])
            data = bytes.fromhex(tx["input"][2:])
            body = data[32:] if t["type"] == "CREATE2" else data
            self.ok("V7", "0x" + keccak256(body[:c["creationSize"]]).hex() == c["creationLinked"], f"replay creation {t['name']}")
        base = ROOT / "deployments" / "base-sepolia.broadcast.json"
        if base.exists():
            for t in json.loads(base.read_text(encoding="utf-8"))["transactions"]:
                c = build["contracts"].get(t["contractName"])
                if not c or not t["transactionType"].startswith("CREATE"):
                    continue
                data = bytes.fromhex(t["transaction"]["input"][2:])
                body = data[32:] if t["transactionType"] == "CREATE2" else data
                self.ok("V7", "0x" + keccak256(body[:c["creationSize"]]).hex() == c["creationLinked"], f"Base Sepolia creation {t['contractName']}")
        else:
            self.results["V7_base_sepolia"] = "pending: deployments/base-sepolia.broadcast.json does not exist yet (S08)"

    # ---- following the chain
    def poll(self) -> bool:
        # Read only settled blocks: a block below the latest one, or the latest once no new block has come for
        # 300 ms. Reading the newest block while the next one is being mined gave an inconsistent state (S11).
        latest = int(self.rpc.call("eth_blockNumber"), 16)
        now = time.monotonic()
        if latest != getattr(self, "_seen", None):
            self._seen, self._seen_at = latest, now
        upto = latest if now - self._seen_at >= 0.3 else latest - 1
        if upto <= self.last_block:
            return self.done
        evs = logs(self.rpc, self.table, self.last_block + 1, upto)
        self.last_block = upto
        pending_cs = None
        for e in evs:
            name, a = e["_name"], e["_address"]
            if name == "PointPosted" and a == self.hub.lower():
                self.on_point(e)
            elif name == "ReportAccepted" and a == self.hub.lower():
                self.on_report(e)
            elif name == "CorrSwap" and a == self.router.lower():
                pending_cs = e
            elif name == "Swapped" and a == self.router.lower() and pending_cs:
                self.on_trade(pending_cs, e)
                pending_cs = None
            elif name in ("Minted", "Burned") and a == self.vault.lower():
                self.on_vault_op(e)
            elif name == "Finalized" and a == self.vault.lower():
                self.on_finalized(e)
            elif name in ("Redeemed", "DepositClaimed") and a == self.vault.lower():
                self.on_payout(e)
        return self.done

    def summary(self) -> dict:
        # V1 also covers the market's parameters and the cutoff
        cs = self.at("latest", self.hub, "marketParams(uint8)", ["uint8"], [self.mid])
        v1_params = signed(cs[0]) == 4 * self.sA and signed(cs[1]) == 4 * self.sB and self.calib["cutoffExclusive"] <= self.t0 \
            and self.calib["maxBarOpenTime"] < self.t0
        posted = self.count["V1"]
        return {
            "week": self.manifest["week"], "bars": self.bars_file,
            "items": {v: {"pass": not self.fail[v] and self.count[v] > 0 and (v != "V1" or (posted == self.n + 1 and v1_params)),
                          "checked": self.count[v], "failures": self.fail[v][:5]} for v in self.fail},
            "v1": {"points": posted, "expected": self.n + 1, "parameters": v1_params},
            "golden": {"rows": self.golden_i - 1, "of": len(self.golden) - 1} if self.bars_file == "bars.json" else "VOID scenario",
            **self.results,
        }


def _golden_value(expr: str, q4: int) -> int:
    """The golden table's entries: an integer, or an integer plus / minus Q4 (\"650000000+Q4\", \"-150000000-Q4\")."""
    e = expr.replace("Q4", "")
    if e.endswith("+"):
        return int(e[:-1]) + q4
    if e.endswith("-"):
        return int(e[:-1]) - q4
    return int(e)


def _enc_breakdown(o, mid, side, is_buy, exact_in, amount, delta) -> bytes:
    from .chain import encode
    return encode([["address", "uint256", "bytes"], "uint8", "uint8", "bool", "bool", "uint256", "uint256"],
                  [o, mid, side, is_buy, exact_in, amount, delta])


def _enc_quote(o, amount, traits) -> bytes:
    from .chain import encode
    return encode([["address", "uint256", "bytes"], "uint256", "bytes"], [o, amount, traits])
