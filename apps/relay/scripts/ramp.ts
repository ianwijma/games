/**
 * Ramp test for the relay: keeps adding rooms of real WebSocket clients, step by step, until the
 * relay stops coping, and prints one line per step. Finds the breaking point; `loadtest.ts`
 * measures a fixed load.
 *
 *   npm run build -w @games/relay
 *   npm run ramp -w @games/relay                      (turn-based rooms, a move every 5 s)
 *   npm run ramp -w @games/relay -- --move-ms 0       (idle connections only)
 *   npm run ramp -w @games/relay -- --url wss://relay.example/ws --step 50
 *
 * Each step runs in its own client process, so the clients are not the bottleneck. Stops when
 * connections fail, p99 latency passes --max-p99, the relay dies, or --max-rooms is reached.
 * Linux only for the relay's memory and CPU figures (/proc).
 */
import { type ChildProcess, fork, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "@games/protocol";
import { WebSocket } from "ws";

// Some runners pass a literal "--" through; drop it so the options still parse.
const argv = process.argv.slice(2).filter((a) => a !== "--");
const { values } = parseArgs({
  args: argv,
  options: {
    /** Rooms added per step. */
    step: { type: "string", default: "1000" },
    players: { type: "string", default: "4" },
    /** Average ms between moves in one room. 0 means no moves: idle connections. */
    "move-ms": { type: "string", default: "5000" },
    "state-bytes": { type: "string", default: "8192" },
    /** Seconds to measure after each step. */
    hold: { type: "string", default: "10" },
    "max-rooms": { type: "string", default: "40000" },
    "max-p99": { type: "string", default: "1000" },
    url: { type: "string" },
    port: { type: "string", default: "16767" },
    // Set by the parent for a client process.
    worker: { type: "string" },
  },
});
const step = Number(values.step);
const players = Number(values.players);
const moveMs = Number(values["move-ms"]);
const stateBytes = Number(values["state-bytes"]);
const hold = Number(values.hold);
const maxRooms = Number(values["max-rooms"]);
const maxP99 = Number(values["max-p99"]);
const port = Number(values.port);

interface Report {
  opened: number;
  failed: number;
  dropped: number;
  errors: Record<string, number>;
  latencies: number[];
  bytes: number;
}

if (values.worker !== undefined) await worker(Number(values.worker));
else await parent();

// -- one step's clients ------------------------------------------------------------

async function worker(index: number): Promise<void> {
  const url = values.url ?? `ws://127.0.0.1:${port}/ws`;
  // One source address holds about 28,000 connections to one port; give each step its own.
  const local = values.url
    ? {}
    : { localAddress: `127.0.${1 + Math.floor(index / 250)}.${1 + (index % 250)}` };
  const blob = (bytes: number) =>
    Array.from({ length: Math.max(1, Math.round(bytes / 40)) }, (_, i) => ({
      id: i,
      c: "red",
      v: i % 13,
      o: "p123456",
    }));
  const state = blob(stateBytes);
  const view = blob(stateBytes / 2);
  const base = { v: PROTOCOL_VERSION, game: "loadtest", gameVersion: 1, name: "bot" };

  let report: Report = { opened: 0, failed: 0, dropped: 0, errors: {}, latencies: [], bytes: 0 };
  const note = (reason: string) => {
    report.errors[reason] = (report.errors[reason] ?? 0) + 1;
  };

  /** Resolves with the socket and room code, or null if it did not get a seat within 20 s. */
  const connect = (first: object, onMessage: (m: Record<string, unknown>) => void) =>
    new Promise<{ ws: WebSocket; code: string } | null>((resolve) => {
      let seated = false;
      let gaveUp = false;
      const ws = new WebSocket(url, {
        perMessageDeflate: false,
        handshakeTimeout: 20_000,
        ...local,
      });
      const giveUp = (reason: string) => {
        if (seated || gaveUp) return;
        gaveUp = true;
        report.failed++;
        note(reason);
        ws.terminate();
        resolve(null);
      };
      const timer = setTimeout(() => giveUp("no seat within 20 s"), 20_000);
      ws.on("open", () => ws.send(JSON.stringify(first)));
      ws.on("error", (e) => giveUp((e as NodeJS.ErrnoException).code ?? e.message));
      ws.on("close", () => {
        clearTimeout(timer);
        if (gaveUp) return;
        if (seated) report.dropped++;
        else giveUp("closed before a seat");
      });
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString()) as Record<string, unknown>;
        report.bytes += (data as Buffer).length;
        if (m.t === "welcome") {
          clearTimeout(timer);
          seated = true;
          report.opened++;
          resolve({ ws, code: (m.room as { code: string }).code });
        } else if (m.t === "error") giveUp(`relay: ${String(m.code)}`);
        else onMessage(m);
      });
    });

  async function openRoom(): Promise<void> {
    let seq = 0;
    const host = await connect({ t: "create", mode: "turn", maxPeers: players, ...base }, (m) => {
      if (m.t !== "msg") return;
      const ts = (m.d as { ts: number }).ts;
      seq += 1;
      const out = [{ to: "all", d: { k: "view", ts, v: view } }];
      host?.ws.send(JSON.stringify({ t: "commit", epoch: 1, seq, state, out }));
    });
    if (!host) return;
    const guests: WebSocket[] = [];
    for (let i = 1; i < players; i++) {
      const guest = await connect({ t: "join", code: host.code, ...base }, (m) => {
        const d = m.d as { ts?: number } | undefined;
        // Date.now, not performance.now: the timestamp crosses processes only in the same worker,
        // but wall time keeps the unit obvious.
        if (m.t === "msg" && d?.ts) report.latencies.push(Date.now() - d.ts);
      });
      if (guest) guests.push(guest.ws);
    }
    if (moveMs <= 0 || guests.length === 0) return;
    const tick = () => {
      const mover = guests[Math.floor(Math.random() * guests.length)] as WebSocket;
      if (mover.readyState === WebSocket.OPEN) {
        mover.send(JSON.stringify({ t: "send", to: "host", d: { k: "act", ts: Date.now() } }));
      }
      setTimeout(tick, moveMs * (0.5 + Math.random()));
    };
    setTimeout(tick, Math.random() * moveMs);
  }

  const flush = (id: number) => {
    process.send?.({ id, ...report });
    report = { opened: 0, failed: 0, dropped: 0, errors: {}, latencies: [], bytes: 0 };
  };
  process.on("message", (id) => flush(id as number));
  const batch = 25;
  for (let i = 0; i < step; i += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, step - i) }, openRoom));
  }
  flush(0);
}

// -- the ramp ----------------------------------------------------------------------

async function parent(): Promise<void> {
  let relay: ChildProcess | undefined;
  let relayDead = false;
  if (!values.url) {
    relay = spawn(process.execPath, [new URL("../dist/main.js", import.meta.url).pathname], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "0.0.0.0",
        MAX_CONN_PER_IP: "10000000",
        MAX_ROOMS: String(maxRooms + step),
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    relay.on("exit", () => {
      relayDead = true;
    });
    await new Promise((r) => setTimeout(r, 500));
  }
  const pid = relay?.pid;
  const rssMb = () => {
    if (!pid || relayDead) return Number.NaN;
    return Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1]) / 1024;
  };
  const cpuSeconds = () => {
    if (!pid || relayDead) return Number.NaN;
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
    return (Number(fields[11]) + Number(fields[12])) / 100;
  };
  const fmt = (n: number, d = 0) => (Number.isNaN(n) ? "n/a" : n.toFixed(d));

  const workers: ChildProcess[] = [];
  const stop = (why: string) => {
    console.log(`\nstopped: ${why}`);
    for (const w of workers) w.kill("SIGKILL");
    relay?.kill("SIGKILL");
    process.exit(0);
  };
  let sockets = 0;
  console.log(
    `step ${step} rooms x ${players} players, ${moveMs > 0 ? `a move per room every ${moveMs} ms` : "idle"}, ${stateBytes} B state`,
  );
  console.log(
    "rooms\tsockets\tconnect_s\trss_mb\tcpu_%\tmbit_out\tp50_ms\tp99_ms\tfailed\tdropped",
  );

  // Each request to a client process carries an id; the reply repeats it. 0 is "finished connecting".
  const waiting = new Map<string, (r: Report | null) => void>();
  let nextId = 1;
  const reply = (index: number, id: number) =>
    new Promise<Report | null>((resolve) => waiting.set(`${index}:${id}`, resolve));
  const ask = (index: number) => {
    const id = nextId++;
    workers[index]?.send(id);
    return reply(index, id);
  };

  for (let n = 0; (n + 1) * step <= maxRooms; n++) {
    const t0 = performance.now();
    const w = fork(new URL(import.meta.url).pathname, [...argv, "--worker", String(n)]);
    workers.push(w);
    w.on("message", (m) => {
      const r = m as Report & { id: number };
      waiting.get(`${n}:${r.id}`)?.(r);
      waiting.delete(`${n}:${r.id}`);
    });
    w.on("exit", () => {
      for (const [key, resolve] of waiting) if (key.startsWith(`${n}:`)) resolve(null);
    });
    const errors: Record<string, number> = {};
    let failed = 0;
    let dropped = 0;
    const absorb = (r: Report | null) => {
      if (!r) return;
      failed += r.failed;
      dropped += r.dropped;
      sockets += r.opened - r.dropped;
      for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] ?? 0) + v;
    };
    const connected = await reply(n, 0);
    if (!connected) stop(`client process for step ${n + 1} died`);
    absorb(connected);
    const connectSeconds = (performance.now() - t0) / 1000;

    // Reset every client's counters, then measure everything connected for `hold` seconds.
    for (const r of await Promise.all(workers.map((_, i) => ask(i)))) absorb(r);
    const cpu0 = cpuSeconds();
    await new Promise((r) => setTimeout(r, hold * 1000));
    const cpu = ((cpuSeconds() - cpu0) / hold) * 100;
    const latencies: number[] = [];
    let bytes = 0;
    for (const r of await Promise.all(workers.map((_, i) => ask(i)))) {
      absorb(r);
      bytes += r?.bytes ?? 0;
      for (const l of r?.latencies ?? []) latencies.push(l);
    }
    latencies.sort((a, b) => a - b);
    const q = (p: number) =>
      latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? Number.NaN;
    const row = [
      (n + 1) * step,
      sockets,
      fmt(connectSeconds, 1),
      fmt(rssMb()),
      fmt(cpu),
      fmt((bytes * 8) / hold / 1e6, 1),
      fmt(q(0.5)),
      fmt(q(0.99)),
      failed,
      dropped,
    ];
    console.log(row.join("\t"));
    if (Object.keys(errors).length > 0) console.log(`  errors: ${JSON.stringify(errors)}`);
    if (relayDead) stop("the relay process died");
    if (failed > 0) stop(`${failed} connections failed`);
    if (dropped > 0) stop(`${dropped} connections were dropped`);
    if (q(0.99) > maxP99) stop(`p99 latency ${fmt(q(0.99))} ms is over ${maxP99} ms`);
  }
  stop(`reached --max-rooms ${maxRooms} without failing`);
}
