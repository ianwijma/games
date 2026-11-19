import type { ClientMessage, ServerMessage } from "@games/protocol";
import { decode, encode } from "@games/protocol";
import type { Hub } from "@games/relay-core";

export interface TransportHandlers {
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onClose(): void;
}

export interface TransportLink {
  send(message: ClientMessage): void;
  close(): void;
}

/** A way to reach a relay. `open` starts one connection; handlers are called asynchronously. */
export interface Transport {
  open(handlers: TransportHandlers): TransportLink;
}

/** Talks to a relay over a WebSocket (`ws://` or `wss://` URL). */
export function webSocketTransport(url: string, WebSocketCtor?: typeof WebSocket): Transport {
  return {
    open(handlers) {
      const Ctor = WebSocketCtor ?? WebSocket;
      const socket = new Ctor(url);
      let closed = false;
      socket.onopen = () => handlers.onOpen();
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = decode(event.data);
        if (message) handlers.onMessage(message as ServerMessage);
      };
      socket.onerror = () => {}; // `close` always follows
      socket.onclose = () => {
        if (closed) return;
        closed = true;
        handlers.onClose();
      };
      return {
        send(message) {
          if (socket.readyState === 1) socket.send(encode(message));
        },
        close() {
          socket.close();
        },
      };
    },
  };
}

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Runs the relay logic in-process. `defer` schedules delivery; default queueMicrotask. Never deliver re-entrantly. */
export function localTransport(
  hub: Hub,
  options: { defer?: (deliver: () => void) => void } = {},
): Transport {
  const defer = options.defer ?? queueMicrotask;
  return {
    open(handlers) {
      // `ended` stops deliveries once either side has closed; `closeSent` makes onClose fire once.
      let ended = false;
      let closeSent = false;
      const notifyClose = () => {
        if (closeSent) return;
        closeSent = true;
        handlers.onClose();
      };
      // Messages go through JSON so the two sides see exactly what a real wire does (no shared objects,
      // `undefined` dropped, NaN -> null).
      const session = hub.connect({
        send: (message) => {
          const copy = wire(message);
          defer(() => {
            if (!ended) handlers.onMessage(copy);
          });
        },
        close: () =>
          defer(() => {
            ended = true;
            notifyClose();
          }),
      });
      defer(() => {
        if (!ended) handlers.onOpen();
      });
      return {
        send(message) {
          if (ended) return;
          const copy = wire(message);
          defer(() => session.receive(copy)); // still delivered if we close right after (e.g. `leave`)
        },
        close() {
          if (ended) return;
          ended = true;
          defer(() => {
            session.disconnected();
            notifyClose();
          });
        },
      };
    },
  };
}
