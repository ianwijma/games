import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock } from "@games/relay-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadState } from "./persistence";
import { type RelayOptions, type RunningRelay, startRelay } from "./server";
import {
  healthz,
  MOVES_TO_WIN,
  move,
  movesOf,
  type Player,
  quiesce,
  startGame,
  waitFor,
} from "./test-helpers";

let dir: string;
let file: string;
const relays: RunningRelay[] = [];
let players: Player[] = [];
let logs: { level: string; message: string }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-restart-"));
  file = join(dir, "state.json");
  logs = [];
});

afterEach(async () => {
  for (const p of players.splice(0)) p.session.destroy();
  for (const r of relays.splice(0)) await r.close({ skipSnapshot: true }).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const start = async (options: RelayOptions = {}) => {
  const relay = await startRelay({
    host: "127.0.0.1",
    stateFile: file,
    snapshotIntervalMs: 20,
    log: (level, message) => logs.push({ level, message }),
    ...options,
  });
  relays.push(relay);
  return relay;
};
const wsUrl = (relay: RunningRelay) => `ws://127.0.0.1:${relay.port}/ws`;
const allConnected = () => players.every((p) => p.session.getSnapshot().status === "connected");

/** Closes `relay` and starts a new one from the same state file on the same port. */
async function restart(relay: RunningRelay, closeOptions = {}, options: RelayOptions = {}) {
  await relay.close(closeOptions);
  await waitFor("clients to notice", () =>
    players.every((p) => p.session.getSnapshot().status === "reconnecting"),
  );
  return start({ port: relay.port, ...options });
}

describe("restart with a state file", () => {
  it("clients reconnect on their own, keep their seats and state, and finish the game", async () => {
    const relay = await start({ port: 0 });
    const started = await startGame(wsUrl(relay));
    players = [...started.players];
    await move(players, 1);
    await move(players, 2);
    await move(players, 3);
    const before = players.map((p) => ({
      me: p.id(),
      code: p.session.getSnapshot().code,
      moves: movesOf(p),
    }));
    expect(before[0]?.moves).toEqual([1, 2, 3]);

    const second = await restart(relay);
    expect(
      logs.some((l) => l.level === "info" && /restored 1 rooms \(0 expired/.test(l.message)),
    ).toBe(true);
    await waitFor("clients to resume", allConnected);

    for (const [i, p] of players.entries()) {
      expect(p.statuses).toContain("reconnecting");
      expect(p.statuses.at(-1)).toBe("connected");
      expect({ me: p.id(), code: p.session.getSnapshot().code }).toEqual({
        me: before[i]?.me,
        code: before[i]?.code,
      });
      expect(p.session.getSnapshot().closed).toBeNull();
    }
    await waitFor("same state", () => players.every((p) => movesOf(p).join() === "1,2,3"));
    expect(second.hub.stats()).toMatchObject({ rooms: 1, peers: 2, connected: 2 });

    for (let n = 4; n <= MOVES_TO_WIN; n++) await move(players, n);
    await waitFor("game over", () =>
      players.every((p) => p.session.getSnapshot().phase === "ended"),
    );
    for (const p of players) expect(movesOf(p)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a crash without the final snapshot goes back to the last snapshot and carries on", async () => {
    const relay = await start({ port: 0, snapshotIntervalMs: 600_000 });
    const started = await startGame(wsUrl(relay));
    players = [...started.players];
    await move(players, 1);
    await move(players, 2);
    await relay.saveNow();
    await move(players, 3);
    expect(players.map(movesOf)).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);

    const second = await restart(relay, { skipSnapshot: true }, { snapshotIntervalMs: 600_000 });
    await waitFor("clients to resume", allConnected);
    // The third move was never saved: everyone converges on the saved state, even though their
    // own views were newer.
    await waitFor("converged on the snapshot", () =>
      players.every((p) => movesOf(p).join() === "1,2"),
    );
    expect(second.hub.stats().rooms).toBe(1);

    for (let n = 3; n <= MOVES_TO_WIN; n++) await move(players, n);
    await waitFor("game over", () =>
      players.every((p) => p.session.getSnapshot().phase === "ended"),
    );
    for (const p of players) expect(movesOf(p)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a turn timer set before the restart fires after it", async () => {
    // One fake clock for both relays, standing in for wall time that keeps going across a restart.
    const clock = createFakeClock();
    const relay = await start({ port: 0, hub: { clock } });
    const started = await startGame(wsUrl(relay), { timerMs: 20_000 });
    players = [...started.players];
    await move(players, 1);
    const turnBefore = players[0]?.view()?.turn;
    await quiesce(relay.hub);

    const second = await restart(relay, {}, { hub: { clock } });
    await waitFor("clients to resume", allConnected);
    await waitFor("state restored", () => players.every((p) => movesOf(p).join() === "1"));
    expect(players[0]?.view()?.turn).toBe(turnBefore);
    expect(players[0]?.view()?.timeouts).toBe(0);
    await quiesce(second.hub);

    clock.advance(120_000); // far beyond the deadline, however the clients' clocks are offset
    await waitFor("timeout applied", () => players.every((p) => p.view()?.timeouts === 1));
    expect(players[0]?.view()?.turn).not.toBe(turnBefore);
    expect(players.map(movesOf)).toEqual([[1], [1]]);
  });
});

describe("periodic snapshots", () => {
  it("rewrites only when something changed", async () => {
    const relay = await start({ port: 0 });
    const started = await startGame(wsUrl(relay));
    players = [...started.players];
    await move(players, 1);
    await quiesce(relay.hub);
    await relay.saveNow();
    const info = (await healthz(relay.port)).snapshot;
    expect(info).toMatchObject({ rooms: 1 });
    expect(info?.bytes).toBeGreaterThan(100);
    expect(info?.serializeMs).toBeGreaterThanOrEqual(0);
    expect(info?.writeMs).toBeGreaterThanOrEqual(0);
    const mtime = statSync(file).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 300)); // 15 intervals
    expect((await healthz(relay.port)).snapshot?.savedAt).toBe(info?.savedAt);
    expect(statSync(file).mtimeMs).toBe(mtime);

    await move(players, 2);
    await waitFor(
      "rewrite",
      async () => (await healthz(relay.port)).snapshot?.savedAt !== info?.savedAt,
    );
    const saved = loadState(file);
    expect(saved.status).toBe("ok");
    expect(JSON.stringify(saved)).toContain('"n":2');
    expect(readdirSync(dir)).toEqual(["state.json"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("/healthz has no snapshot field, and no file is touched, without a state file", async () => {
    const relay = await startRelay({ host: "127.0.0.1" });
    relays.push(relay);
    expect(await healthz(relay.port)).toEqual({ rooms: 0, peers: 0, connected: 0 });
    expect(readdirSync(dir)).toEqual([]);
    await relay.saveNow(); // a no-op
    expect(relay.snapshotInfo()).toBeNull();
  });

  it("/healthz snapshot is null before the first write", async () => {
    const relay = await start({ port: 0, snapshotIntervalMs: 600_000 });
    expect((await healthz(relay.port)).snapshot).toBeNull();
  });
});

describe("a state file the relay cannot use", () => {
  const cases: [string, string][] = [
    [
      "a different protocol version",
      JSON.stringify({ format: 1, protocol: 999, savedAt: 1, rooms: [] }),
    ],
    ["garbage", "\u0000not json{{"],
  ];
  for (const [name, content] of cases) {
    it(`${name}: starts empty, keeps the file as .rejected, then writes a good one`, async () => {
      writeFileSync(file, content);
      const relay = await start({ port: 0 });
      expect(await healthz(relay.port)).toMatchObject({ rooms: 0 });
      expect(
        logs.some((l) => l.level === "error" && l.message.includes("ignoring state file")),
      ).toBe(true);
      expect(readFileSync(`${file}.rejected`, "utf8")).toBe(content);
      expect(readdirSync(dir)).toEqual(["state.json.rejected"]);

      const started = await startGame(wsUrl(relay));
      players = [...started.players];
      await relay.saveNow();
      const loaded = loadState(file);
      expect(loaded).toMatchObject({
        status: "ok",
        data: { format: 1, rooms: [{ game: "count" }] },
      });

      // And that good file restores.
      const second = await restart(relay);
      await waitFor("clients to resume", allConnected);
      expect(second.hub.stats().rooms).toBe(1);
    });
  }

  it("a missing file logs a normal first start", async () => {
    await start({ port: 0 });
    expect(logs).toEqual([{ level: "info", message: expect.stringContaining("no state file") }]);
  });
});

describe("an unwritable state directory", () => {
  it("keeps serving, logs the failure, retries, and close() rejects after shutting down", async () => {
    file = join(dir, "missing", "state.json");
    const relay = await start({ port: 0 });
    const started = await startGame(wsUrl(relay));
    players = [...started.players];
    await move(players, 1);

    const failures = () =>
      logs.filter((l) => l.level === "error" && l.message.includes("snapshot write failed"));
    await waitFor("two failed attempts (it retries)", () => failures().length >= 2);
    expect(await healthz(relay.port)).toMatchObject({ rooms: 1, connected: 2, snapshot: null });
    await move(players, 2); // still serving
    await expect(relay.saveNow()).rejects.toThrow();

    await expect(relay.close()).rejects.toThrow(/final snapshot failed/);
    await expect(healthz(relay.port)).rejects.toThrow(); // it did shut down
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("closing", () => {
  it("the final snapshot contains every move that was acknowledged", async () => {
    const relay = await start({ port: 0, snapshotIntervalMs: 600_000 });
    const started = await startGame(wsUrl(relay));
    players = [...started.players];
    for (let n = 1; n <= 4; n++) await move(players, n);
    await relay.close();
    expect(JSON.stringify(loadState(file))).toContain('"n":4');
  });

  it("is idempotent", async () => {
    const relay = await start({ port: 0 });
    await Promise.all([relay.close(), relay.close()]);
    await relay.close();
  });
});
