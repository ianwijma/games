/**
 * End-to-end check that a relay restart does not end a game. Run it against a relay in a
 * container (or any relay started with STATE_FILE), then restart that relay while this waits:
 *
 *   RELAY_URL=ws://127.0.0.1:6767/ws npm run restart-check -w @games/relay
 *   ... wait for READY_FOR_RESTART, then `docker restart <relay>` (or delete the pod) ...
 *
 * Two real clients play tic-tac-toe: three moves, then the restart, then the rest to a win. It
 * prints RESTART_CHECK_OK and exits 0, or the reason and exits 1.
 *
 * Environment:
 *   RELAY_URL           default ws://127.0.0.1:6767/ws
 *   RESTART_TIMEOUT_S   how long to wait for the restart and the reconnect, default 120
 *   EXPECT_TIMER=1      also set a 60 s turn timer; after the restart check that the deadline
 *                       survived and that the turn timeout fired once it passed (adds up to a minute)
 */
import { createSession } from "@games/game";
import { webSocketTransport } from "@games/net";
import { game, type View } from "@games/tic-tac-toe/game";

const url = process.env.RELAY_URL ?? "ws://127.0.0.1:6767/ws";
const timeoutMs = Number(process.env.RESTART_TIMEOUT_S ?? 120) * 1000;
const expectTimer = process.env.EXPECT_TIMER === "1";
const TIMER_SECONDS = 60;

const log = (line: string) => console.log(line);
const fail = (reason: string): never => {
  console.error(`RESTART_CHECK_FAILED: ${reason}`);
  process.exit(1);
};

async function waitFor(what: string, condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline)
      fail(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function makeClient(label: string) {
  const session = createSession(game, {
    transport: webSocketTransport(url),
    reconnect: { minMs: 200, maxMs: 2000 },
  });
  const history: { status: string; at: number }[] = [];
  const note = () => {
    const status = session.getSnapshot().status;
    if (history.at(-1)?.status !== status) history.push({ status, at: performance.now() });
    const closed = session.getSnapshot().closed;
    if (closed) fail(`${label} was closed for good: ${closed.reason} ${closed.message ?? ""}`);
  };
  session.subscribe(note);
  const snap = () => session.getSnapshot();
  return {
    label,
    session,
    history,
    id: () => snap().me as string,
    view: () => snap().view as View | null,
    status: () => snap().status,
    /** Seconds spent not connected after the first connection, or null if never dropped. */
    downSeconds(): number | null {
      const down = history.find((h) => h.status === "reconnecting");
      if (!down) return null;
      const up = history.find((h) => h.status === "connected" && h.at > down.at);
      return up ? (up.at - down.at) / 1000 : null;
    },
  };
}
type Client = ReturnType<typeof makeClient>;

const a = makeClient("client A");
const b = makeClient("client B");
const clients = [a, b];

async function play(cell: number): Promise<void> {
  const turn = a.view()?.order[a.view()?.turn ?? 0];
  const mover = clients.find((c) => c.id() === turn) ?? fail(`nobody holds the turn (${turn})`);
  await mover.session.act({ type: "place", cell });
  await waitFor(
    "both clients to see the move",
    () => clients.every((c) => c.view()?.board[cell] !== null),
    10_000,
  );
}

const board = (c: Client) => JSON.stringify(c.view()?.board);
const render = (v: View | null) =>
  v
    ? [0, 3, 6]
        .map((r) =>
          v.board
            .slice(r, r + 3)
            .map((c) => (c === null ? "." : v.order[0] === c ? "X" : "O"))
            .join(" "),
        )
        .join(" / ")
    : "no view";

try {
  const code = await a.session.create({ name: "A" });
  await b.session.join(code, { name: "B" });
  if (expectTimer) await a.session.configure({ turnSeconds: TIMER_SECONDS });
  await Promise.all([a.session.setReady(true), b.session.setReady(true)]);
  await a.session.start();
  await waitFor(
    "both clients to see the game",
    () => clients.every((c) => c.view() !== null),
    10_000,
  );

  // X (order[0]) takes 0 then 1; O takes 3. X's third move at 2 wins, after the restart.
  const x = a.view()?.order[0];
  const queue = { X: [0, 1, 2], O: [3, 4, 5] };
  await play(queue.X.shift() as number);
  await play(queue.O.shift() as number);
  await play(queue.X.shift() as number);

  const before = {
    code,
    ids: [a.id(), b.id()],
    board: board(a),
    deadline: a.view()?.deadline ?? null,
    turn: a.view()?.turn,
  };
  if (board(b) !== before.board) fail("the two clients disagree before the restart");
  log(`room ${code}`);
  log(`players ${before.ids.join(" ")}`);
  log(`board ${render(a.view())}  (${before.board})`);
  if (expectTimer) log(`turn deadline ${before.deadline}`);
  log("READY_FOR_RESTART");

  await waitFor(
    "the relay restart (both clients reconnecting, then connected again)",
    () =>
      clients.every(
        (c) => c.history.some((h) => h.status === "reconnecting") && c.status() === "connected",
      ),
    timeoutMs,
  );
  await waitFor(
    "both clients to hold a view again",
    () => clients.every((c) => c.view() !== null),
    10_000,
  );

  // -- verify ------------------------------------------------------------------------
  const after = { code: a.session.getSnapshot().code, ids: [a.id(), b.id()] };
  if (after.code !== before.code) fail(`room code changed: ${before.code} -> ${after.code}`);
  if (after.ids.join() !== before.ids.join())
    fail(`player ids changed: ${before.ids} -> ${after.ids}`);
  for (const c of clients) {
    if (board(c) !== before.board)
      fail(`${c.label} board differs after the restart: ${board(c)} vs ${before.board}`);
    log(`${c.label} was disconnected for ${c.downSeconds()?.toFixed(2)} s`);
  }
  if (expectTimer) {
    if (a.view()?.deadline === null) fail("the turn deadline was lost in the restart");
    log("waiting for the turn timer to fire after the restart ...");
    const until = (before.deadline ?? 0) - a.session.serverNow();
    await waitFor(
      "the turn timeout",
      () => clients.every((c) => c.view()?.turn !== before.turn),
      Math.max(0, until) + 15_000,
    );
    if (clients.some((c) => board(c) !== before.board)) fail("the timeout changed the board");
    log("turn timer fired once after the restart");
  } else if (a.view()?.turn !== before.turn) {
    fail("the turn changed across the restart");
  }
  log(`restored. board ${render(a.view())}`);

  // -- finish the game -----------------------------------------------------------------
  for (let guard = 0; guard < 9 && a.view()?.winner === null; guard++) {
    const turn = a.view()?.order[a.view()?.turn ?? 0];
    const cell = (turn === x ? queue.X : queue.O).shift() ?? fail("ran out of planned moves");
    await play(cell);
  }
  await waitFor(
    "both clients to see the end",
    () => clients.every((c) => c.view()?.winner !== null),
    10_000,
  );
  const results = clients.map((c) => JSON.stringify([c.view()?.winner, c.view()?.line]));
  if (results[0] !== results[1]) fail(`clients disagree on the result: ${results.join(" vs ")}`);
  if (a.view()?.winner !== x) fail(`expected X to win, got ${a.view()?.winner}`);
  log(`final board ${render(a.view())}, winner ${a.view()?.winner}`);
  log("RESTART_CHECK_OK");
  for (const c of clients) c.session.destroy();
  process.exit(0);
} catch (error) {
  fail(`unexpected error: ${error instanceof Error ? error.stack : String(error)}`);
}
