"""The replay's Verifier process (R §2.2-2.3, §7): follows the chain, checks V1-V8, streams the results to the UI
(WebSocket, port 8789) and saves them. The Driver reads GET /result on the same port before it stops the chain.

    python verifier/replay_verify.py replay/week-2025-10-13 [--bars bars.json] [--rpc http://127.0.0.1:8545]
                                     [--port 8789] [--out results.json] [--timeout 600]
Exit code 0 when V1-V8 all pass.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corrfi_verifier.replay import Verifier  # noqa: E402

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Hub:
    """A minimal WebSocket broadcaster (text frames only) and GET /result, standard library only."""

    def __init__(self, port: int):
        self.clients: list[socket.socket] = []
        self.history: list[bytes] = []
        self.result: dict | None = None
        self.lock = threading.Lock()
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", port))
        self.srv.listen(8)
        threading.Thread(target=self._accept, daemon=True).start()

    @staticmethod
    def _frame(text: str) -> bytes:
        b = text.encode("utf-8")
        n = len(b)
        head = bytes([0x81, n]) if n < 126 else bytes([0x81, 126]) + n.to_bytes(2, "big") if n < 65536 else bytes([0x81, 127]) + n.to_bytes(8, "big")
        return head + b

    def _accept(self):
        while True:
            conn, _ = self.srv.accept()
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket):
        req = b""
        while b"\r\n\r\n" not in req:
            chunk = conn.recv(4096)
            if not chunk:
                return conn.close()
            req += chunk
        head = req.split(b"\r\n\r\n")[0].decode("latin-1")
        lines = head.split("\r\n")
        headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
        if "sec-websocket-key" in headers:
            accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + GUID).encode()).digest()).decode()
            conn.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         f"Sec-WebSocket-Accept: {accept}\r\n\r\n".encode())
            with self.lock:
                for h in self.history:
                    conn.sendall(h)
                self.clients.append(conn)
            return
        body = json.dumps(self.result or {"done": False}).encode()
        conn.sendall(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\naccess-control-allow-origin: *\r\n"
                     + f"content-length: {len(body)}\r\nconnection: close\r\n\r\n".encode() + body)
        conn.close()

    def send(self, obj: dict):
        f = self._frame(json.dumps(obj))
        with self.lock:
            self.history.append(f)
            for c in list(self.clients):
                try:
                    c.sendall(f)
                except OSError:
                    self.clients.remove(c)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("week")
    ap.add_argument("--bars", default="bars.json")
    ap.add_argument("--rpc", default="http://127.0.0.1:8545")
    ap.add_argument("--port", type=int, default=8789)
    ap.add_argument("--out")
    ap.add_argument("--timeout", type=float, default=600)
    a = ap.parse_args()
    hub = Hub(a.port)
    # wait for the chain (the Driver starts it)
    t_start = time.monotonic()
    v = None
    while v is None:
        try:
            v = Verifier(Path(a.week), a.rpc, a.bars, emit=lambda item: hub.send({"type": "item", **item}))
        except (OSError, RuntimeError):
            if time.monotonic() - t_start > a.timeout:
                raise
            time.sleep(0.2)
    hub.send({"type": "verifier_ready", "week": v.manifest["week"], "bars": a.bars})
    while not v.poll():
        if time.monotonic() - t_start > a.timeout:
            break
        time.sleep(0.05)
    s = v.summary()
    s["done"] = v.done
    s["pass"] = v.done and all(i["pass"] for i in s["items"].values())
    hub.result = s
    hub.send({"type": "summary", **s})
    out = Path(a.out) if a.out else Path(a.week) / "runs" / f"verify-{a.bars.replace('.json', '')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(s, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({k: s[k] for k in ("pass", "items", "v1", "golden")}, indent=1))
    time.sleep(float(__import__("os").environ.get("VERIFY_LINGER", "3")))  # let the Driver / UI read the result
    return 0 if s["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
