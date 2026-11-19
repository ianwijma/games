/**
 * Reading and writing the relay's state file. The file holds seat tokens, which are secrets, so it
 * is created with mode 0600. Writes go to `<file>.tmp` in the same directory and are renamed over
 * the target, so a reader (or the next start after a crash) sees the old file or the new one,
 * never half of one. Nothing is ever written outside the directory of the state file.
 */
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type LoadResult =
  /** The normal first start: there is no file yet. */
  { status: "missing" } | { status: "ok"; data: unknown } | { status: "error"; reason: string };

const tempPath = (file: string) => `${file}.tmp`;

export function loadState(file: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "error", reason: `cannot read ${file}: ${errorText(error)}` };
  }
  try {
    return { status: "ok", data: JSON.parse(text) };
  } catch (error) {
    return { status: "error", reason: `invalid JSON: ${errorText(error)}` };
  }
}

/** Moves a file the relay refused to `<file>.rejected`. Best effort; true if it was moved. */
export function setAsideRejected(file: string): boolean {
  try {
    renameSync(file, `${file}.rejected`);
    return true;
  } catch {
    return false;
  }
}

/** Asynchronous atomic write, for the periodic snapshot. Rejects if any step fails. */
export async function writeStateAtomic(file: string, json: string): Promise<void> {
  const tmp = tempPath(file);
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      // An older temp file keeps its mode when reopened, so set it explicitly.
      await handle.chmod(0o600);
      await handle.writeFile(json);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await syncDirectory(dirname(file));
}

/** Synchronous atomic write, for shutdown. Same guarantees as `writeStateAtomic`. */
export function writeStateAtomicSync(file: string, json: string): void {
  const tmp = tempPath(file);
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      fchmodSync(fd, 0o600);
      // Not `writeSync`: that can write only part of the data (a full disk) without throwing, and
      // the rename below would then replace a good file with half of one.
      writeFileSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
  try {
    const fd = openSync(dirname(file), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

/** Makes the rename itself durable. Best effort: some filesystems cannot fsync a directory. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
}

/**
 * `JSON.stringify(snapshot)`, done a few rooms at a time with a pause for the event loop whenever
 * `sliceMs` has passed, so a large snapshot never holds up players' messages for long. The result
 * is still one point in time: the snapshot object is a copy whose checkpoint states are never
 * modified, only replaced in the hub.
 */
export async function stringifySnapshot<T extends { rooms: unknown[] }>(
  snapshot: T,
  sliceMs = 4,
): Promise<{ json: string; totalMs: number; maxBlockMs: number }> {
  const { rooms, ...head } = snapshot;
  const parts: string[] = [];
  let totalMs = 0;
  let maxBlockMs = 0;
  let sliceStart = performance.now();
  const endSlice = () => {
    const ms = performance.now() - sliceStart;
    totalMs += ms;
    maxBlockMs = Math.max(maxBlockMs, ms);
  };
  for (const room of rooms) {
    parts.push(JSON.stringify(room));
    if (performance.now() - sliceStart >= sliceMs) {
      endSlice();
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
  }
  const json = `${JSON.stringify(head).slice(0, -1)},"rooms":[${parts.join(",")}]}`;
  endSlice();
  return { json, totalMs, maxBlockMs };
}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
