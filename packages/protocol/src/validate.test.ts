import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./validate";

const create = { t: "create", v: 1, game: "ono", gameVersion: 1, mode: "turn", name: "Ann" };
const join = { t: "join", v: 1, code: "ABC234", game: "ono", gameVersion: 1, name: "Bob" };

describe("parseClientMessage", () => {
  it("accepts create and trims name, dropping unknown keys", () => {
    const m = parseClientMessage({
      ...create,
      name: "  Ann ",
      extra: 1,
      maxPeers: 4,
      canHost: false,
      meta: { a: 1 },
    });
    expect(m).toEqual({ ...create, name: "Ann", maxPeers: 4, canHost: false, meta: { a: 1 } });
    expect(m).not.toHaveProperty("extra");
  });

  it("accepts join, resume, send, commit, alarm, room, kick, handoff, leave, ping", () => {
    expect(parseClientMessage(join)).toEqual(join);
    const resume = { t: "resume", v: 1, code: "ABC234", token: "abc" };
    expect(parseClientMessage(resume)).toEqual(resume);
    expect(parseClientMessage({ t: "send", to: "host", d: 1 })).toEqual({
      t: "send",
      to: "host",
      d: 1,
    });
    expect(parseClientMessage({ t: "send", to: ["a", "b"], ch: "volatile", d: null })).toEqual({
      t: "send",
      to: ["a", "b"],
      ch: "volatile",
      d: null,
    });
    const commit = {
      t: "commit",
      epoch: 1,
      seq: 0,
      state: { x: 1 },
      out: [
        { to: "all", d: "hi" },
        { to: ["p1"], d: 2 },
      ],
    };
    expect(parseClientMessage(commit)).toEqual(commit);
    expect(parseClientMessage({ t: "alarm", epoch: 1, id: "x", at: null })).toEqual({
      t: "alarm",
      epoch: 1,
      id: "x",
      at: null,
    });
    expect(parseClientMessage({ t: "alarm", epoch: 1, id: "x", at: 123.5 })).toMatchObject({
      at: 123.5,
    });
    expect(parseClientMessage({ t: "room", epoch: 2, locked: true, maxPeers: 3 })).toEqual({
      t: "room",
      epoch: 2,
      locked: true,
      maxPeers: 3,
    });
    expect(parseClientMessage({ t: "kick", epoch: 2, peer: "p1", reason: "x" })).toEqual({
      t: "kick",
      epoch: 2,
      peer: "p1",
      reason: "x",
    });
    expect(parseClientMessage({ t: "handoff", epoch: 2 })).toEqual({ t: "handoff", epoch: 2 });
    expect(parseClientMessage({ t: "handoff", epoch: 2, to: "p2" })).toEqual({
      t: "handoff",
      epoch: 2,
      to: "p2",
    });
    expect(parseClientMessage({ t: "leave", junk: 1 })).toEqual({ t: "leave" });
    expect(parseClientMessage({ t: "ping", n: 5 })).toEqual({ t: "ping", n: 5 });
  });

  it("rejects non-objects and unknown types", () => {
    for (const v of [null, undefined, 1, "x", [], { t: 1 }, {}, { t: "nope" }]) {
      expect(parseClientMessage(v)).toBeNull();
    }
  });

  it("rejects bad create/join fields", () => {
    const bad: unknown[] = [
      { ...create, name: "   " },
      { ...create, name: "x".repeat(33) },
      { ...create, name: 5 },
      { ...create, game: "Bad_Game" },
      { ...create, game: "a".repeat(49) },
      { ...create, game: "" },
      { ...create, v: 1.5 },
      { ...create, v: "1" },
      { ...create, gameVersion: "1" },
      { ...create, mode: "other" },
      { ...create, maxPeers: 2.5 },
      { ...create, canHost: "yes" },
      { ...join, code: 5 },
      { ...join, game: "A" },
    ];
    for (const b of bad) expect(parseClientMessage(b)).toBeNull();
    const { name: _n, ...noName } = create;
    expect(parseClientMessage(noName)).toBeNull();
  });

  it("rejects bad resume", () => {
    expect(parseClientMessage({ t: "resume", v: 1, code: "ABC234" })).toBeNull();
    expect(parseClientMessage({ t: "resume", v: 1, token: "x" })).toBeNull();
  });

  it("rejects bad send", () => {
    expect(parseClientMessage({ t: "send", to: "host" })).toBeNull();
    expect(parseClientMessage({ t: "send", to: 5, d: 1 })).toBeNull();
    expect(parseClientMessage({ t: "send", to: [1], d: 1 })).toBeNull();
    expect(parseClientMessage({ t: "send", to: "all", ch: "x", d: 1 })).toBeNull();
  });

  it("rejects bad commit", () => {
    const ok = { t: "commit", epoch: 1, seq: 1, state: 1, out: [] };
    expect(parseClientMessage(ok)).not.toBeNull();
    expect(parseClientMessage({ ...ok, state: undefined })).toBeNull();
    expect(parseClientMessage({ ...ok, seq: 1.5 })).toBeNull();
    expect(parseClientMessage({ ...ok, out: "x" })).toBeNull();
    expect(parseClientMessage({ ...ok, out: [{ to: "all" }] })).toBeNull();
    expect(parseClientMessage({ ...ok, out: [{ to: "host", d: 1 }] })).toBeNull();
    expect(parseClientMessage({ ...ok, out: [{ to: 3, d: 1 }] })).toBeNull();
  });

  it("rejects bad alarm/room/kick/handoff/ping", () => {
    expect(parseClientMessage({ t: "alarm", epoch: 1, id: "x" })).toBeNull();
    expect(parseClientMessage({ t: "alarm", epoch: 1, id: 1, at: 1 })).toBeNull();
    expect(parseClientMessage({ t: "alarm", epoch: 1, id: "x", at: Number.NaN })).toBeNull();
    expect(parseClientMessage({ t: "room", epoch: 1, locked: "y" })).toBeNull();
    expect(parseClientMessage({ t: "room", locked: true })).toBeNull();
    expect(parseClientMessage({ t: "kick", epoch: 1 })).toBeNull();
    expect(parseClientMessage({ t: "kick", epoch: 1, peer: "p", reason: 1 })).toBeNull();
    expect(parseClientMessage({ t: "handoff", epoch: 1, to: 1 })).toBeNull();
    expect(parseClientMessage({ t: "ping", n: "1" })).toBeNull();
  });
});

describe("limits", () => {
  it("decode rejects JSON nested deeper than maxDepth but ignores brackets in strings", async () => {
    const { decode, LIMITS } = await import("./index");
    const nest = (n: number) => `{"t":"x","d":${"[".repeat(n)}${"]".repeat(n)}}`;
    expect(decode(nest(LIMITS.maxDepth - 1))).toBeDefined();
    expect(decode(nest(LIMITS.maxDepth))).toBeUndefined();
    expect(decode(`{"t":"x","d":"${"[".repeat(500)}\\"[["}`)).toBeDefined();
  });

  it("rejects oversized meta", () => {
    const base = { t: "join", v: 1, code: "ABCDEF", game: "g", gameVersion: 1, name: "a" };
    expect(parseClientMessage({ ...base, meta: "x".repeat(100) })).not.toBeNull();
    expect(parseClientMessage({ ...base, meta: "x".repeat(2000) })).toBeNull();
  });
});

describe("integers", () => {
  it("refuses integers too large to count with exactly", () => {
    const big = 2 ** 60;
    expect(parseClientMessage({ ...create, gameVersion: big })).toBeNull();
    expect(parseClientMessage({ t: "commit", epoch: 1, seq: big, state: 1, out: [] })).toBeNull();
    expect(parseClientMessage({ t: "commit", epoch: big, seq: 1, state: 1, out: [] })).toBeNull();
    expect(parseClientMessage({ t: "ping", n: big })).toBeNull();
    expect(
      parseClientMessage({
        t: "commit",
        epoch: 1,
        seq: Number.MAX_SAFE_INTEGER,
        state: 1,
        out: [],
      }),
    ).not.toBeNull();
  });
});
