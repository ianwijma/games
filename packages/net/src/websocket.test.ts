import type { AddressInfo } from "node:net";
import { decode, encode } from "@games/protocol";
import { Hub } from "@games/relay-core";
import { expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { RoomClient } from "./client";
import { webSocketTransport } from "./transport";

it("creates and joins a room through a real WebSocket", async () => {
  const hub = new Hub();
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (socket) => {
    const session = hub.connect({
      send: (m) => socket.send(encode(m)),
      close: () => socket.close(),
    });
    socket.on("message", (raw) => session.receive(decode(raw.toString()) ?? {}));
    socket.on("close", () => session.disconnected());
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = webSocketTransport(url, NodeWebSocket as unknown as typeof WebSocket);
  const make = () => new RoomClient({ transport, game: "toy", gameVersion: 1 });
  const a = make();
  const b = make();
  try {
    const room = await a.create({ name: "A" });
    const received = new Promise<unknown>((resolve) => a.on("message", (m) => resolve(m.d)));
    await b.join(room.code, { name: "B" });
    b.send("host", { hello: "world" });
    expect(await received).toEqual({ hello: "world" });
    expect(a.room?.peers).toHaveLength(2);
    expect(b.room?.hostId).toBe(a.me);
  } finally {
    a.close();
    b.close();
    server.close();
  }
});
