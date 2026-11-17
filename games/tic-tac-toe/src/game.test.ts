import { createTable, type Table } from "@games/game/testing";
import { describe, expect, it } from "vitest";
import { type Action, type Config, game, type State, type View } from "./game";

type T = Table<Action, View, Config>;

async function started(turnSeconds?: Config["turnSeconds"]): Promise<T> {
  const table = await createTable<State, Action, View, Config>(game, { players: 2 });
  if (turnSeconds) {
    await table.run((table.sessions[0] as T["sessions"][number]).configure({ turnSeconds }));
  }
  await table.start();
  return table;
}

/** Index of the player whose turn it is. */
function mover(table: T): number {
  const view = table.view(0);
  const id = view.order[view.turn];
  return table.sessions.findIndex((s) => s.getSnapshot().me === id);
}

async function play(table: T, cells: number[]) {
  for (const cell of cells) await table.act(mover(table), { type: "place", cell });
}

describe("tic-tac-toe", () => {
  it("plays a full game to a win", async () => {
    const table = await started();
    await play(table, [0, 3, 1, 4, 2]); // first player takes the top row
    const view = table.view(0);
    expect(view.winner).toBe(view.order[0]);
    expect(table.sessions[0]?.getSnapshot().phase).toBe("ended");
    expect(table.view(0).yourMark).not.toBe(table.view(1).yourMark);
  });

  it("detects a draw", async () => {
    const table = await started();
    // X O X / X O O / O X X
    await play(table, [0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(table.view(0).winner).toBe("draw");
    expect(table.sessions[0]?.getSnapshot().phase).toBe("ended");
  });

  it("rejects wrong turn, taken cell, bad cell and moves after the end", async () => {
    const table = await started();
    const first = mover(table);
    const second = 1 - first;
    await expect(table.act(second, { type: "place", cell: 0 })).rejects.toThrow("not your turn");
    await table.act(first, { type: "place", cell: 0 });
    await expect(table.act(second, { type: "place", cell: 0 })).rejects.toThrow("taken");
    await expect(table.act(second, { type: "place", cell: 9 })).rejects.toThrow("Invalid cell");
    await expect(table.act(second, { type: "place", cell: 1.5 })).rejects.toThrow("Invalid cell");
    await play(table, [3, 1, 4, 2]); // first player completes the top row
    expect(table.view(0).winner).toBe(table.view(0).order[0]);
    await expect(table.act(second, { type: "place", cell: 8 })).rejects.toThrow(); // the runtime refuses play once phase is "ended";
  });

  it("validates config", () => {
    expect(() => game.validateConfig?.({ turnSeconds: 7 })).toThrow();
    expect(game.validateConfig?.({ turnSeconds: 30, extra: 1 })).toEqual({ turnSeconds: 30 });
  });

  it("passes the turn when the timer runs out", async () => {
    const table = await started(15);
    const before = table.view(0);
    expect(before.deadline).not.toBeNull();
    await table.advance(15_001);
    const after = table.view(0);
    expect(after.turn).toBe(1);
    expect(after.deadline).toBeGreaterThan(before.deadline as number);
    expect(after.board.every((c) => c === null)).toBe(true);
  });

  it("finishes with the right winner when the host is killed after every move", async () => {
    const table = await started();
    const cells = [0, 3, 1, 4, 2];
    const firstPlayer = table.view(0).order[0];
    for (const [i, cell] of cells.entries()) {
      await table.act(mover(table), { type: "place", cell });
      if (i < cells.length - 1) {
        const host = table.hostIndex();
        await table.killHost();
        expect(table.hostIndex()).not.toBe(host);
        await table.reconnect(host); // comes back as a replica
      }
    }
    for (const i of [0, 1]) expect(table.view(i).winner).toBe(firstPlayer);
  });
});
