import type { Hub } from "@games/relay-core";
import { expect, it } from "vitest";
import { localTransport } from "./transport";

it("localTransport delivers what a JSON wire would", () => {
  const received: unknown[] = [];
  const hub = {
    connect: () => ({ receive: (m: unknown) => received.push(m), disconnected() {} }),
  } as unknown as Hub;
  const queue: (() => void)[] = [];
  const link = localTransport(hub, { defer: (f) => void queue.push(f) }).open({
    onOpen() {},
    onMessage() {},
    onClose() {},
  });
  link.send({ t: "send", to: "host", d: { a: undefined, b: Number.NaN, c: [1] } } as never);
  while (queue.length) queue.shift()?.();
  expect(received[0]).toStrictEqual({ t: "send", to: "host", d: { b: null, c: [1] } });
});
