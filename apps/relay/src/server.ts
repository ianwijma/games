import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerMessage } from "@games/protocol";
import { decode, encode, HEARTBEAT_INTERVAL_MS, LIMITS } from "@games/protocol";
import { Hub, type HubOptions, systemClock } from "@games/relay-core";
import { WebSocket, WebSocketServer } from "ws";
import {
  errorText,
  loadState,
  setAsideRejected,
  stringifySnapshot,
  writeStateAtomic,
  writeStateAtomicSync,
} from "./persistence";

export interface RelayOptions {
  /** 0 picks a random free port. */
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  allowedGames?: string[];
  maxConnectionsPerIp?: number;
  /**
   * Read the client IP verbatim from this request header (for example `cf-connecting-ip`). Only
   * safe when every request reaches the relay through a proxy that sets the header, because a
   * client can send it too. Takes precedence over `trustProxy`.
   */
  clientIpHeader?: string;
  /**
   * Number of proxies you control in front of the relay, each appending to X-Forwarded-For. The
   * client IP is the entry that many places from the right; entries further left are
   * client-controlled. 0 (the default) uses the socket address.
   */
  trustProxy?: number;
  hub?: HubOptions;
  /**
   * Where to keep the state that survives a restart. Unset: nothing is read or written and no
   * timers run. Only this file and its `.tmp` / `.rejected` siblings are touched, so the root
   * filesystem can stay read-only when this points into a mounted volume.
   */
  stateFile?: string;
  /** How often to check whether the state changed and write it. Default 5000. */
  snapshotIntervalMs?: number;
  /** Where log lines go. Default: console. */
  log?: (level: "info" | "error", message: string) => void;
}

/** Figures for the last state file written; also served on `/healthz`. */
export interface SnapshotInfo {
  /** Epoch ms (wall clock) the write finished. */
  savedAt: number;
  bytes: number;
  /** Total time spent turning the rooms into JSON. The periodic snapshot spreads it over slices. */
  serializeMs: number;
  /** The longest the event loop was held up at once while doing so. */
  maxBlockMs: number;
  writeMs: number;
  rooms: number;
}

export interface RunningRelay {
  port: number;
  hub: Hub;
  /**
   * With a state file: stops accepting, writes a final snapshot, then shuts down. Rejects (after
   * shutting down anyway) if that write fails. Without one it just shuts down.
   */
  close(options?: CloseOptions): Promise<void>;
  /** Writes a snapshot now, whether or not anything changed. Resolves once it is durable. */
  saveNow(): Promise<void>;
  /** The last successful write, or null (also null when persistence is off). */
  snapshotInfo(): SnapshotInfo | null;
}

export interface CloseOptions {
  /** For tests only: shut down without the final snapshot, as a crash would. */
  skipSnapshot?: boolean;
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
  const log =
    options.log ??
    ((level: "info" | "error", message: string) =>
      level === "error" ? console.error(message) : console.log(message));

  // -- persistence -----------------------------------------------------------------
  const stateFile = options.stateFile || undefined;
  const intervalMs = options.snapshotIntervalMs ?? 5000;
  if (stateFile && (!Number.isInteger(intervalMs) || intervalMs <= 0)) {
    throw new Error(`snapshotIntervalMs must be a positive integer: ${intervalMs}`);
  }
  /** Set once close() starts: no new connections, no messages, nothing changes the snapshot. */
  let closing = false;
  let lastSavedRevision = -1;
  let lastInfo: SnapshotInfo | null = null;
  /** The write in flight, if any. Writes never overlap (they share one temp file). */
  let writing: Promise<void> | null = null;

  if (stateFile) {
    const loaded = loadState(stateFile);
    let refusal: string | undefined;
    if (loaded.status === "missing") {
      log("info", `relay: no state file at ${stateFile}, starting empty`);
    } else if (loaded.status === "error") {
      refusal = loaded.reason;
    } else {
      const result = hub.restore(loaded.data);
      if (result.ok) {
        const age = Math.max(
          0,
          ((options.hub?.clock ?? systemClock).now() - result.savedAt) / 1000,
        );
        log(
          "info",
          `relay: restored ${result.rooms} rooms (${result.expired} expired during downtime), snapshot ${age.toFixed(0)}s old`,
        );
        if (result.skipped.length > 0) {
          log(
            "error",
            `relay: left out ${result.skipped.length} rooms from the state file: ${result.skipped.slice(0, 20).join("; ")}`,
          );
        }
      } else refusal = result.reason;
    }
    if (refusal !== undefined) {
      const moved = setAsideRejected(stateFile);
      log(
        "error",
        `relay: ignoring state file: ${refusal}, starting empty${moved ? ` (kept as ${stateFile}.rejected)` : ""}`,
      );
    }
  }

  /** Takes the snapshot and serialises it in one go. Used at shutdown, when nothing else is running. */
  function capture() {
    const t0 = performance.now();
    const revision = hub.revision;
    const snapshot = hub.snapshot();
    const json = JSON.stringify(snapshot);
    const serializeMs = performance.now() - t0;
    return {
      json,
      revision,
      rooms: snapshot.rooms.length,
      serializeMs,
      maxBlockMs: serializeMs,
    };
  }

  /** The same result as `capture`, without holding the event loop: used while players are connected. */
  async function captureInSlices(): Promise<ReturnType<typeof capture>> {
    const t0 = performance.now();
    const revision = hub.revision;
    const snapshot = hub.snapshot();
    const copyMs = performance.now() - t0;
    const { json, totalMs, maxBlockMs } = await stringifySnapshot(snapshot);
    return {
      json,
      revision,
      rooms: snapshot.rooms.length,
      serializeMs: copyMs + totalMs,
      maxBlockMs: Math.max(copyMs, maxBlockMs),
    };
  }

  function record(c: ReturnType<typeof capture>, writeMs: number) {
    lastSavedRevision = c.revision;
    lastInfo = {
      savedAt: Date.now(),
      bytes: Buffer.byteLength(c.json),
      serializeMs: c.serializeMs,
      maxBlockMs: c.maxBlockMs,
      writeMs,
      rooms: c.rooms,
    };
  }

  /** One asynchronous write. Rejects on failure and leaves the saved revision untouched. */
  function writeSnapshot(): Promise<void> {
    const file = stateFile as string;
    const run = (async () => {
      const c = await captureInSlices();
      const t0 = performance.now();
      await writeStateAtomic(file, c.json);
      record(c, performance.now() - t0);
    })();
    const tracked = run.then(
      () => {
        if (writing === tracked) writing = null;
      },
      () => {
        if (writing === tracked) writing = null;
      },
    );
    writing = tracked;
    return run;
  }

  const snapshotTimer = stateFile
    ? setInterval(() => {
        if (closing || writing || hub.revision === lastSavedRevision) return;
        writeSnapshot().catch((error) =>
          log("error", `relay: snapshot write failed, will retry: ${errorText(error)}`),
        );
      }, intervalMs)
    : undefined;
  snapshotTimer?.unref();

  const http = createServer((req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stateFile ? { ...hub.stats(), snapshot: lastInfo } : hub.stats()));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxMessageBytes,
    perMessageDeflate: false,
  });

  const ipHeader = options.clientIpHeader?.toLowerCase();
  const hops = options.trustProxy ?? 0;
  if (!Number.isInteger(hops) || hops < 0) throw new Error(`trustProxy must be >= 0: ${hops}`);

  function clientIp(req: IncomingMessage): string {
    if (ipHeader) {
      const value = req.headers[ipHeader];
      const ip = (Array.isArray(value) ? value[0] : value)?.trim();
      if (ip) return ip;
    }
    if (hops > 0) {
      // Node joins repeated X-Forwarded-For headers with ", ", so this is one list.
      const forwarded = req.headers["x-forwarded-for"];
      const entries = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Fewer entries than proxies means the request skipped the chain; trust none of them.
      const ip = entries.at(-hops);
      if (ip && entries.length >= hops) return ip;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  http.on("upgrade", (req, socket, head) => {
    if (closing) return reject(socket, "503 Service Unavailable");
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
      if (closing) return ws.terminate();
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
        if (closing) return; // shutting down: the hub is about to be discarded
        session.disconnected();
      };
      ws.on("close", onGone);
      ws.on("error", onGone);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("message", (data, isBinary) => {
        if (closing) return;
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
    http.once("error", (error) => {
      // Never started: stop the timers, so a relay that could not bind does not touch the file.
      clearInterval(heartbeat);
      if (snapshotTimer) clearInterval(snapshotTimer);
      hub.close();
      reject(error);
    });
    http.listen(options.port ?? 0, options.host, () => resolve());
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  async function saveNow(): Promise<void> {
    if (!stateFile) return;
    if (closing) throw new Error("relay is closing");
    // Wait for the periodic write so the two never share the temp file.
    while (writing) await writing;
    await writeSnapshot();
  }

  let closePromise: Promise<void> | undefined;

  async function close(closeOptions: CloseOptions = {}): Promise<void> {
    // 1. Stop accepting. From here no message changes the hub and no new socket can join.
    closing = stateFile !== undefined;
    clearInterval(heartbeat);
    if (snapshotTimer) clearInterval(snapshotTimer);
    // 2. Snapshot and serialise in this same tick, before any socket is touched.
    let final: ReturnType<typeof capture> | undefined;
    let failure: unknown;
    if (stateFile && !closeOptions.skipSnapshot) {
      try {
        final = capture();
      } catch (error) {
        failure = error;
      }
    }
    // 3. Drop the sockets. Their close events are ignored (see onGone).
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    // 4. Let an in-flight periodic write finish, so it cannot rename over the final file.
    while (writing) await writing;
    if (final && stateFile) {
      const t0 = performance.now();
      try {
        writeStateAtomicSync(stateFile, final.json);
        record(final, performance.now() - t0);
      } catch (error) {
        failure = error;
      }
    }
    // 5. Only now discard the rooms and stop listening.
    hub.close();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
    if (failure !== undefined) {
      throw new Error(`final snapshot failed: ${errorText(failure)}`);
    }
  }

  return {
    port,
    hub,
    close: (closeOptions) => {
      closePromise ??= close(closeOptions);
      return closePromise;
    },
    saveNow,
    snapshotInfo: () => lastInfo,
  };
}
