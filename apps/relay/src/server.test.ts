import type { ServerMessage } from "@games/protocol";
import { PROTOCOL_VERSION } from "@games/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type RunningRelay, startRelay } from "./server";

let relay: RunningRelay | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await relay?.close();
  relay = undefined;
});

class TestClient {
  messages: ServerMessage[] = [];
  private waiters: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    sockets.push(ws);
    ws.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()));
      for (const w of this.waiters.splice(0)) w();
    });
  }
  static async open(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async next<T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const i = this.messages.findIndex((m) => m.t === t);
      if (i >= 0) return this.messages.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }
}

/** Opens a socket with extra request headers; resolves "open" or the HTTP status it was refused with. */
function connectWith(port: number, headers: Record<string, string>): Promise<"open" | number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  sockets.push(ws);
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {});
  });
}

const base = { v: PROTOCOL_VERSION, game: "test", gameVersion: 1 };

describe("relay server", () => {
  it("migrates the host over real sockets with the committed checkpoint", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1" });
    const a = await TestClient.open(relay.port);
    a.send({ t: "create", ...base, mode: "turn", name: "A" });
    const welcomeA = await a.next("welcome");
    expect((await a.next("host")).hostId).toBe(welcomeA.you);

    const b = await TestClient.open(relay.port);
    b.send({ t: "join", ...base, code: welcomeA.room.code, name: "B" });
    const welcomeB = await b.next("welcome");
    expect(welcomeB.room.hostId).toBe(welcomeA.you);

    a.send({ t: "commit", epoch: 1, seq: 1, state: { n: 1 }, out: [{ to: "all", d: "hi" }] });
    expect((await b.next("msg")).d).toBe("hi");

    a.ws.terminate();
    const host = await b.next("host");
    expect(host).toMatchObject({
      hostId: welcomeB.you,
      epoch: 2,
      checkpoint: { seq: 1, state: { n: 1 } },
    });
  });

  it("answers bad frames with bad-message", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1" });
    const a = await TestClient.open(relay.port);
    a.ws.send("not json");
    expect((await a.next("error")).code).toBe("bad-message");
    a.ws.send(Buffer.from([1, 2, 3]));
    expect((await a.next("error")).code).toBe("bad-message");
  });

  it("rejects disallowed origins, allows listed and missing ones", async () => {
    relay = await startRelay({
      port: 0,
      host: "127.0.0.1",
      allowedOrigins: ["https://games.example"],
    });
    const url = `ws://127.0.0.1:${relay.port}/ws`;
    const bad = new WebSocket(url, { origin: "https://evil.example" });
    sockets.push(bad);
    const status = await new Promise<number>((resolve) => {
      bad.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      bad.on("error", () => {});
    });
    expect(status).toBe(403);
    const good = new WebSocket(url, { origin: "https://games.example" });
    sockets.push(good);
    await new Promise((resolve, reject) => {
      good.once("open", resolve);
      good.once("error", reject);
    });
    await TestClient.open(relay.port);
  });

  it("only upgrades on /ws", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1" });
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/other`);
    sockets.push(ws);
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    expect(status).toBe(404);
  });

  it("caps concurrent connections per IP", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1", maxConnectionsPerIp: 1 });
    await TestClient.open(relay.port);
    const second = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`);
    sockets.push(second);
    const status = await new Promise<number>((resolve) => {
      second.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      second.on("error", () => {});
    });
    expect(status).toBe(429);
  });

  it("counts the per-IP cap by clientIpHeader when set", async () => {
    relay = await startRelay({
      port: 0,
      host: "127.0.0.1",
      maxConnectionsPerIp: 1,
      clientIpHeader: "CF-Connecting-IP",
      trustProxy: 1,
    });
    // Behind the tunnel every request has the same last X-Forwarded-For entry (cloudflared).
    const via = (ip: string) => ({
      "cf-connecting-ip": ip,
      "x-forwarded-for": `${ip}, 10.42.0.40`,
    });
    expect(await connectWith(relay.port, via("203.0.113.1"))).toBe("open");
    expect(await connectWith(relay.port, via("203.0.113.2"))).toBe("open");
    expect(await connectWith(relay.port, via("203.0.113.1"))).toBe(429);
    // Without the header it falls back to X-Forwarded-For (here: one proxy, the last entry).
    expect(await connectWith(relay.port, { "x-forwarded-for": "10.42.0.41" })).toBe("open");
    expect(await connectWith(relay.port, { "x-forwarded-for": "x, 10.42.0.41" })).toBe(429);
  });

  it("takes the trustProxy-th X-Forwarded-For entry from the right", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1", maxConnectionsPerIp: 1, trustProxy: 2 });
    const xff = (value: string) => ({ "x-forwarded-for": value });
    expect(await connectWith(relay.port, xff("203.0.113.1, 10.42.0.40"))).toBe("open");
    expect(await connectWith(relay.port, xff("203.0.113.2, 10.42.0.40"))).toBe("open");
    // A client-supplied entry on the left does not change who it is.
    expect(await connectWith(relay.port, xff("1.2.3.4, 203.0.113.1, 10.42.0.40"))).toBe(429);
    // Fewer entries than proxies: none are trusted, the socket address (127.0.0.1) counts.
    expect(await connectWith(relay.port, xff("10.42.0.40"))).toBe("open");
    expect(await connectWith(relay.port, {})).toBe(429);
  });

  it("uses the socket address by default, ignoring X-Forwarded-For", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1", maxConnectionsPerIp: 1 });
    expect(await connectWith(relay.port, { "x-forwarded-for": "203.0.113.1" })).toBe("open");
    expect(await connectWith(relay.port, { "x-forwarded-for": "203.0.113.2" })).toBe(429);
  });

  it("serves /healthz", async () => {
    relay = await startRelay({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: 0, peers: 0, connected: 0 });
    expect((await fetch(`http://127.0.0.1:${relay.port}/nope`)).status).toBe(404);
  });
});

describe("relay hardening", () => {
  it("survives deeply nested JSON", async () => {
    relay = await startRelay({ port: 0 });
    const c = await TestClient.open(relay.port);
    const deep = `${"[".repeat(50_000)}${"]".repeat(50_000)}`;
    c.ws.send(
      `{"t":"create","v":${PROTOCOL_VERSION},"game":"x","gameVersion":1,"mode":"turn","name":"a","meta":${deep}}`,
    );
    expect((await c.next("error")).code).toBe("bad-message");
    const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    expect(res.status).toBe(200);
  });

  it("releases the per-IP slot when a handshake is aborted", async () => {
    relay = await startRelay({ port: 0, maxConnectionsPerIp: 1 });
    const { connect } = await import("node:net");
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => {
        const raw = connect(relay?.port ?? 0, "127.0.0.1", () => {
          // No Sec-WebSocket-Key: `ws` aborts this without calling the upgrade callback.
          raw.write(
            "GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
        });
        raw.on("close", () => resolve());
        raw.on("data", () => raw.destroy());
      });
    }
    await new Promise((r) => setTimeout(r, 20));
    const c = await TestClient.open(relay.port);
    c.send({ t: "ping", n: 1 });
    expect((await c.next("error")).code).toBe("bad-message");
  });
});
