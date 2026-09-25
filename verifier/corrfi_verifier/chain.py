"""Minimal JSON-RPC and ABI helpers for the replay Verifier (standard library only; R §2.1-4: the Verifier shares no
code with the Driver). Only the types the checks need: uint/int/bool/address/bytes32 words, dynamic `bytes`, and
tuples of those. Event layouts come from the compiled ABIs in contracts/out (the contracts' own interface)."""
from __future__ import annotations

import json
import urllib.request
from pathlib import Path

from .keccak import keccak256

ROOT = Path(__file__).resolve().parents[2]


class Rpc:
    def __init__(self, url: str):
        self.url, self._id = url, 0

    def call(self, method: str, params: list | None = None):
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or []}).encode()
        req = urllib.request.Request(self.url, body, {"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read())
        if "error" in j:
            raise RuntimeError(f"{method}: {j['error']}")
        return j["result"]

    def eth_call(self, to: str, data: bytes, block="latest", overrides: dict | None = None) -> bytes:
        tag = block if isinstance(block, str) else hex(block)
        params = [{"to": to, "data": "0x" + data.hex()}, tag]
        if overrides:
            params += [{}, overrides]
        return bytes.fromhex(self.call("eth_call", params)[2:])


# ---- ABI -------------------------------------------------------------------------------------------------------

def selector(signature: str) -> bytes:
    return keccak256(signature.encode())[:4]


def _word(t: str, v) -> bytes:
    if t == "address":
        return int(v, 16).to_bytes(32, "big")
    if t == "bool":
        return (1 if v else 0).to_bytes(32, "big")
    if t == "bytes32":
        return bytes.fromhex(v[2:]) if isinstance(v, str) else v
    if t.startswith("int"):
        return (v % (1 << 256)).to_bytes(32, "big")
    return int(v).to_bytes(32, "big")  # uint*


def encode(types: list, values: list) -> bytes:
    """ABI-encode a list of types: str (static word or 'bytes') or list (a tuple of such)."""
    head, tail = b"", b""
    size = 32 * len(types)
    for t, v in zip(types, values):
        if t == "bytes":
            data = bytes.fromhex(v[2:]) if isinstance(v, str) else v
            head += (size + len(tail)).to_bytes(32, "big")
            tail += len(data).to_bytes(32, "big") + data + b"\0" * (-len(data) % 32)
        elif isinstance(t, list):
            enc = encode(t, v)
            if "bytes" in t:
                head += (size + len(tail)).to_bytes(32, "big")
                tail += enc
            else:
                head += enc  # a static tuple is inline (not used with a size != 32 here)
        else:
            head += _word(t, v)
    return head + tail


def words(data: bytes) -> list[int]:
    return [int.from_bytes(data[i:i + 32], "big") for i in range(0, len(data), 32)]


def signed(x: int) -> int:
    return x - (1 << 256) if x >> 255 else x


def call(rpc: Rpc, to: str, signature: str, types: list, values: list, block="latest", overrides=None) -> list[int]:
    return words(rpc.eth_call(to, selector(signature) + encode(types, values), block, overrides))


# ---- events ----------------------------------------------------------------------------------------------------

def _canonical_type(i: dict) -> str:
    if i["type"].startswith("tuple"):
        inner = ",".join(_canonical_type(c) for c in i["components"])
        return f"({inner}){i['type'][5:]}"
    return i["type"]


def event_table(*artifacts: str) -> dict[bytes, dict]:
    """topic0 -> {name, inputs} from contracts/out/<file>/<name>.json."""
    table = {}
    for a in artifacts:
        file, name = a.split(":")
        abi = json.loads((ROOT / "contracts" / "out" / file / f"{name}.json").read_text(encoding="utf-8"))["abi"]
        for e in abi:
            if e["type"] != "event":
                continue
            sig = f"{e['name']}({','.join(_canonical_type(i) for i in e['inputs'])})"
            table[keccak256(sig.encode())] = {"name": e["name"], "inputs": e["inputs"]}
    return table


def decode_log(table: dict, log: dict) -> dict | None:
    topics = [bytes.fromhex(t[2:]) for t in log["topics"]]
    if not topics or topics[0] not in table:
        return None
    ev = table[topics[0]]
    data = words(bytes.fromhex(log["data"][2:]))
    out, ti, di = {"_name": ev["name"], "_address": log["address"].lower(), "_block": int(log["blockNumber"], 16),
                   "_tx": log["transactionHash"], "_index": int(log["logIndex"], 16)}, 1, 0
    for i in ev["inputs"]:
        if i["indexed"]:
            raw = int.from_bytes(topics[ti], "big")
            ti += 1
        elif i["type"].startswith("tuple") or i["type"] in ("bytes", "string") or i["type"].endswith("]"):
            out[i["name"]] = None  # dynamic data is not needed by the checks
            di += 1
            continue
        else:
            raw = data[di]
            di += 1
        t = i["type"]
        out[i["name"]] = (f"0x{raw:040x}" if t == "address" else bool(raw) if t == "bool"
                          else signed(raw) if t.startswith("int") else f"0x{raw:064x}" if t == "bytes32" else raw)
    return out


def logs(rpc: Rpc, table: dict, from_block: int, to_block: int) -> list[dict]:
    raw = rpc.call("eth_getLogs", [{"fromBlock": hex(from_block), "toBlock": hex(to_block)}])
    out = [decode_log(table, l) for l in raw]
    return sorted((e for e in out if e), key=lambda e: (e["_block"], e["_index"]))
