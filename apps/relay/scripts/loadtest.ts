/**
 * Load test for the relay. Starts the built relay as a separate process, fills it with rooms of
 * real WebSocket clients, plays for a while, and reports the relay's memory, CPU and latency.
 *
 *   pnpm --filter @games/relay build
 *   pnpm --filter @games/relay loadtest -- --rooms 1000 --players 4
 *   pnpm --filter @games/relay loadtest -- --mode realtime --rooms 100 --players 8
 *   pnpm --filter @games/relay loadtest -- --url wss://relay.example/ws --rooms 200   (a deployed relay)
 *
 * With --url the relay is not started here, so only latency and throughput are reported; read
 * memory and CPU on the server. Linux only for the process figures (/proc).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "@games/protocol";
import { WebSocket } from "ws";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "turn" },
    rooms: { type: "string", default: "100" },
    players: { type: "string", default: "4" },
    /** turn: average ms between moves in one room. */
    "move-ms": { type: "string", default: "5000" },
    /** turn: size of the game state the host checkpoints on every move. */
    "state-bytes": { type: "string", default: "8192" },
    /** realtime: snapshots and inputs per second. */
    hz: { type: "string", default: "20" },
    /** realtime: size of one snapshot. */
    "snapshot-bytes": { type: "string", default: "1024" },
    seconds: { type: "string", default: "20" },
    url: { type: "string" },
    port: { type: "string", default: "16767" },
  },
});
const mode = values.mode === "realtime" ? "realtime" : "turn";
const rooms = Number(values.rooms);
const players = Number(values.players);
const moveMs = Number(values["move-ms"]);
const stateBytes = Number(values["state-bytes"]);
const hz = Number(values.hz);
const snapshotBytes = Number(values["snapshot-bytes"]);
const seconds = Number(values.seconds);
const port = Number(values.port);

// -- the relay under test --------------------------------------------------------

let relay: ChildProcess | undefined;
let url = values.url;
if (!url) {
  relay = spawn(process.execPath, [new URL("../dist/main.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MAX_CONN_PER_IP: "10000000" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  url = `ws://127.0.0.1:${port}/ws`;
  await new Promise((r) => setTimeout(r, 500));
}
const pid = relay?.pid;

const rssMb = () => {
  if (!pid) return Number.NaN;
  const line = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/);
  return Number(line?.[1] ?? 0) / 1024;
};
/** CPU seconds the relay has used so far (user + system). */
const cpuSeconds = () => {
  if (!pid) return Number.NaN;
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
  return (Number(fields[11]) + Number(fields[12])) / 100;
};

// -- clients ---------------------------------------------------------------------

/** A JSON value of roughly `bytes` encoded size, shaped like game state (many small objects). */
const blob = (bytes: number) =>
  Array.from({ length: Math.max(1, Math.round(bytes / 40)) }, (_, i) => ({
    id: i,
    c: "red",
    v: i % 13,
    o: "p123456",
  }));
const state = blob(stateBytes);
const view = blob(stateBytes / 2);
const snapshot = blob(snapshotBytes);

const latencies: number[] = [];
let received = 0;
let receivedBytes = 0;
let errors = 0;
let measuring = false;
// One source address holds about 28,000 connections to one port; spread over several.
let opened = 0;
const localAddress = () => `127.0.0.${1 + Math.floor(opened++ / 20_000)}`;

interface Peer {
  ws: WebSocket;
  code: string;
}

function connect(first: object, onMessage: (m: Record<string, unknown>) => void): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const local = values.url ? {} : { localAddress: localAddress() };
    const ws = new WebSocket(url as string, { perMessageDeflate: false, ...local });
    ws.on("open", () => ws.send(JSON.stringify(first)));
    ws.on("error", (e) => {
      errors++;
      reject(e);
    });
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (measuring) {
        received++;
        receivedBytes += (data as Buffer).length;
      }
      if (m.t === "welcome") resolve({ ws, code: (m.room as { code: string }).code });
      else if (m.t === "error") errors++;
      else onMessage(m);
    });
  });
}

const timers: NodeJS.Timeout[] = [];

async function openRoom(): Promise<void> {
  let seq = 0;
  const base = { v: PROTOCOL_VERSION, game: "loadtest", gameVersion: 1, name: "bot" };
  const onPeerMessage = (m: Record<string, unknown>) => {
    // A view or snapshot from the host carries the time the triggering message was sent.
    const d = m.d as { ts?: number } | undefined;
    if (m.t === "msg" && d?.ts && measuring) latencies.push(performance.now() - d.ts);
  };
  const host = await connect({ t: "create", mode, maxPeers: players, ...base }, (m) => {
    if (m.t !== "msg" || mode !== "turn") return;
    // A player moved: checkpoint the new state and send everyone their view, like the runtime.
    const ts = (m.d as { ts: number }).ts;
    seq += 1;
    const out = [{ to: "all", d: { k: "view", ts, v: view } }];
    host.ws.send(JSON.stringify({ t: "commit", epoch: 1, seq, state, out }));
  });
  const guests: Peer[] = [];
  for (let i = 1; i < players; i++) {
    guests.push(await connect({ t: "join", code: host.code, ...base }, onPeerMessage));
  }

  if (mode === "turn") {
    if (guests.length === 0) return;
    const tick = () => {
      const mover = guests[Math.floor(Math.random() * guests.length)] as Peer;
      mover.ws.send(
        JSON.stringify({ t: "send", to: "host", d: { k: "act", ts: performance.now() } }),
      );
      timers.push(setTimeout(tick, moveMs * (0.5 + Math.random())));
    };
    timers.push(setTimeout(tick, Math.random() * moveMs));
  } else {
    const every = 1000 / hz;
    const start = Math.random() * every;
    timers.push(
      setTimeout(() => {
        timers.push(
          setInterval(() => {
            const d = { k: "snap", ts: performance.now(), s: snapshot };
            host.ws.send(JSON.stringify({ t: "send", to: "all", ch: "volatile", d }));
            for (const g of guests) {
              const input = { k: "in", x: 0.5, y: 0.5, fire: true };
              g.ws.send(JSON.stringify({ t: "send", to: "host", ch: "volatile", d: input }));
            }
          }, every),
        );
        // Periodic checkpoint, as the real-time runtime would do.
        timers.push(
          setInterval(() => {
            seq += 1;
            host.ws.send(JSON.stringify({ t: "commit", epoch: 1, seq, state, out: [] }));
          }, 1000),
        );
      }, start),
    );
  }
}

// -- run ---------------------------------------------------------------------------

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? Number.NaN;
const fmt = (n: number, digits = 1) => (Number.isNaN(n) ? "n/a" : n.toFixed(digits));

const rssEmpty = rssMb();
const t0 = performance.now();
const batch = 50;
for (let i = 0; i < rooms; i += batch) {
  await Promise.all(Array.from({ length: Math.min(batch, rooms - i) }, openRoom));
}
const connectSeconds = (performance.now() - t0) / 1000;
await new Promise((r) => setTimeout(r, 2000));

const cpu0 = cpuSeconds();
measuring = true;
let rssPeak = rssMb();
const sampler = setInterval(() => {
  rssPeak = Math.max(rssPeak, rssMb());
}, 500);
await new Promise((r) => setTimeout(r, seconds * 1000));
measuring = false;
clearInterval(sampler);
const cpuUsed = cpuSeconds() - cpu0;
for (const t of timers) clearTimeout(t);

latencies.sort((a, b) => a - b);
const sockets = rooms * players;
const report = {
  mode,
  rooms,
  players,
  sockets,
  ...(mode === "turn"
    ? { moveEveryMs: moveMs, stateBytes: JSON.stringify(state).length }
    : { hz, snapshotBytes: JSON.stringify(snapshot).length }),
  connectSeconds: fmt(connectSeconds),
  relayRssMbEmpty: fmt(rssEmpty, 0),
  relayRssMbPeak: fmt(rssPeak, 0),
  kbPerSocket: fmt(((rssPeak - rssEmpty) * 1024) / sockets),
  relayCpuPercentOfOneCore: fmt((cpuUsed / seconds) * 100),
  messagesPerSecond: fmt(received / seconds, 0),
  mbitPerSecondOut: fmt((receivedBytes * 8) / seconds / 1e6, 2),
  latencyMsP50: fmt(quantile(latencies, 0.5)),
  latencyMsP95: fmt(quantile(latencies, 0.95)),
  latencyMsP99: fmt(quantile(latencies, 0.99)),
  samples: latencies.length,
  errors,
};
console.log(JSON.stringify(report));
relay?.kill("SIGTERM");
process.exit(0);
