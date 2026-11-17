import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerMessage } from "@games/protocol";
import { decode, encode, HEARTBEAT_INTERVAL_MS, LIMITS } from "@games/protocol";
import { Hub, type HubOptions } from "@games/relay-core";
import { WebSocket, WebSocketServer } from "ws";

export interface RelayOptions {
  /** 0 picks a random free port. */
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  allowedGames?: string[];
  maxConnectionsPerIp?: number;
  /**
   * Take the client IP from the last X-Forwarded-For entry (the one your proxy appended; earlier
   * entries are client-controlled). Only behind exactly one proxy you control.
   */
  trustProxy?: boolean;
  hub?: HubOptions;
}

export interface RunningRelay {
  port: number;
  hub: Hub;
  close(): Promise<void>;
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function startRelay(options: RelayOptions = {}): Promise<RunningRelay> {
  const hub = new Hub({
    ...options.hub,
    ...(options.allowedGames && { allowedGames: options.allowedGames }),
  });
  const maxPerIp = options.maxConnectionsPerIp ?? 32;
  const origins = options.allowedOrigins ?? [];
  const perIp = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  const http = createServer((req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(hub.stats()));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxMessageBytes,
    perMessageDeflate: false,
  });

  function clientIp(req: IncomingMessage): string {
    if (options.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const last = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)
        ?.split(",")
        .at(-1)
        ?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  http.on("upgrade", (req, socket, head) => {
    const path = req.url?.split("?")[0];
    if (path !== "/ws") return reject(socket, "404 Not Found");
    const origin = req.headers.origin;
    if (origins.length > 0 && origin !== undefined && !origins.includes(origin)) {
      return reject(socket, "403 Forbidden");
    }
    const ip = clientIp(req);
    if ((perIp.get(ip) ?? 0) >= maxPerIp) return reject(socket, "429 Too Many Requests");
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    // Released on the raw socket, not the WebSocket: `ws` aborts bad handshakes without calling
    // the upgrade callback, and the slot would leak.
    socket.once("close", () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = {
        send(message: ServerMessage) {
          if (ws.readyState === WebSocket.OPEN) ws.send(encode(message));
        },
        close() {
          ws.close();
        },
        get bufferedAmount() {
          return ws.bufferedAmount;
        },
      };
      const session = hub.connect(connection);
      alive.set(ws, true);

      let closed = false;
      const onGone = () => {
        if (closed) return;
        closed = true;
        session.disconnected();
      };
      ws.on("close", onGone);
      ws.on("error", onGone);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("message", (data, isBinary) => {
        const message = isBinary ? undefined : decode(data.toString());
        if (message === undefined) {
          connection.send({ t: "error", code: "bad-message", message: "invalid frame" });
          return;
        }
        // One client's message must never take the process down.
        try {
          session.receive(message);
        } catch (error) {
          console.error("relay: dropped connection after error", error);
          ws.terminate();
        }
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, options.host, () => resolve());
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  return {
    port,
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        hub.close();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
