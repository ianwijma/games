import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadState,
  setAsideRejected,
  stringifySnapshot,
  writeStateAtomic,
  writeStateAtomicSync,
} from "./persistence";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-persist-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeStateAtomic", () => {
  for (const [name, write] of [
    ["async", writeStateAtomic],
    ["sync", async (f: string, j: string) => writeStateAtomicSync(f, j)],
  ] as const) {
    it(`${name}: writes the content, leaves no temp file, mode 0600`, async () => {
      const file = join(dir, "state.json");
      await write(file, '{"a":1}');
      expect(readFileSync(file, "utf8")).toBe('{"a":1}');
      expect(readdirSync(dir)).toEqual(["state.json"]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it(`${name}: replaces an existing file and tightens a stale temp file's mode`, async () => {
      const file = join(dir, "state.json");
      writeFileSync(file, "old", { mode: 0o644 });
      writeFileSync(`${file}.tmp`, "stale", { mode: 0o666 });
      await write(file, "new");
      expect(readFileSync(file, "utf8")).toBe("new");
      expect(readdirSync(dir)).toEqual(["state.json"]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  }

  it("fails without touching the target when the directory does not exist", async () => {
    const file = join(dir, "nope", "state.json");
    await expect(writeStateAtomic(file, "x")).rejects.toThrow();
    expect(() => writeStateAtomicSync(file, "x")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("cleans up the temp file when the final rename fails", async () => {
    // A non-empty directory at the target path makes the rename fail.
    const file = join(dir, "state.json");
    mkdirSync(file);
    writeFileSync(join(file, "inner"), "x");
    await expect(writeStateAtomic(file, "v2")).rejects.toThrow();
    expect(() => writeStateAtomicSync(file, "v3")).toThrow();
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

describe("loadState", () => {
  it("a missing file is a normal first start", () => {
    expect(loadState(join(dir, "state.json"))).toEqual({ status: "missing" });
  });

  it("returns parsed JSON", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, '{"x":[1,2]}');
    expect(loadState(file)).toEqual({ status: "ok", data: { x: [1, 2] } });
  });

  it("garbage and truncated JSON give a reason", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, "this is not json");
    expect(loadState(file)).toMatchObject({
      status: "error",
      reason: expect.stringContaining("JSON"),
    });
    writeFileSync(file, '{"format":1,"rooms":[{"code":"AB');
    expect(loadState(file)).toMatchObject({ status: "error" });
    writeFileSync(file, "");
    expect(loadState(file)).toMatchObject({ status: "error" });
  });

  it("an unreadable path (a directory) is an error, not a crash", () => {
    expect(loadState(dir)).toMatchObject({ status: "error" });
  });
});

describe("setAsideRejected", () => {
  it("moves the file to .rejected, and reports failure for a missing one", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, "bad");
    expect(setAsideRejected(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(["state.json.rejected"]);
    expect(setAsideRejected(file)).toBe(false);
  });
});

describe("large snapshots", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-large-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the shutdown writer writes all of a file far larger than one write call's buffer", () => {
    const file = join(dir, "state.json");
    const json = JSON.stringify({ blob: "x".repeat(8 * 1024 * 1024) });
    writeStateAtomicSync(file, json);
    expect(statSync(file).size).toBe(Buffer.byteLength(json));
    expect(loadState(file)).toMatchObject({ status: "ok" });
  });

  it("slices give the same JSON as one stringify, even when the hub moves on between slices", async () => {
    const rooms = Array.from({ length: 200 }, (_, i) => ({ code: `R${i}`, state: { n: i } }));
    const snapshot = { format: 1, protocol: 1, savedAt: 5, rooms };
    const expected = JSON.stringify(snapshot);
    const pending = stringifySnapshot(snapshot, 0); // 0 ms: pause after every room
    // What the hub does meanwhile: it replaces rooms and states in its own structures, never in
    // a snapshot it already handed out.
    const liveRooms = [...rooms];
    liveRooms.pop();
    const { json, maxBlockMs, totalMs } = await pending;
    expect(json).toBe(expected);
    expect(JSON.parse(json)).toEqual(snapshot);
    expect(maxBlockMs).toBeLessThanOrEqual(totalMs);
  });

  it("an empty room list serialises to valid JSON", async () => {
    const { json } = await stringifySnapshot({ format: 1, protocol: 1, savedAt: 5, rooms: [] });
    expect(JSON.parse(json)).toEqual({ format: 1, protocol: 1, savedAt: 5, rooms: [] });
  });
});
