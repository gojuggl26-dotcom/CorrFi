// A minimal WebSocket server that only broadcasts text frames (RFC 6455, no extensions) — the Driver's frames to the
// demo UI (R §2.3: port 8787). Incoming frames are ignored; a send to a dead client never stops the Driver (R §8.3).
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  })()]);
  return Buffer.concat([head, payload]);
}

export interface Broadcaster {
  send: (obj: unknown) => void;
  clients: () => number;
  close: () => Promise<void>;
  /** The latest message, replayed to a client that connects late (the UI keeps the last state, R §8.3). */
  last: () => string | undefined;
}

export function broadcaster(port: number): Promise<Broadcaster> {
  const sockets = new Set<Socket>();
  const history: string[] = [];
  const server: Server = createServer((_, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("websocket only");
  });
  server.on("upgrade", (req, socket: Socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") return socket.destroy();
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    for (const h of history) socket.write(frame(h)); // catch up (frames are small)
    socket.on("data", (d: Buffer) => {
      if ((d[0] & 0x0f) === 0x8) socket.end(); // close frame
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        send: (obj) => {
          const text = JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));
          history.push(text);
          const f = frame(text);
          for (const s of sockets) {
            try {
              s.write(f);
            } catch {
              sockets.delete(s);
            }
          }
        },
        clients: () => sockets.size,
        last: () => history[history.length - 1],
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      }),
    );
  });
}
