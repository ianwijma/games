// Fails when a tracked binary asset breaks the budget in docs/limitations.md.
// Git history keeps every version of a binary forever, so this has to be caught before merge.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { extname } from "node:path";

const MAX_FILE_BYTES = 500 * 1024;
const MAX_GAME_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Set([".svg", ".webp", ".opus", ".woff2", ".ico"]);
const BINARY = new Set([
  ...ALLOWED,
  ...[".png", ".jpg", ".jpeg", ".gif", ".bmp", ".avif", ".psd", ".aseprite"],
  ...[".mp3", ".wav", ".ogg", ".flac", ".m4a", ".mp4", ".webm", ".mov"],
  ...[".ttf", ".otf", ".woff", ".zip", ".wasm", ".pdf", ".swf"],
]);

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const problems = [];
const perGame = new Map();

for (const file of files) {
  const ext = extname(file).toLowerCase();
  if (!BINARY.has(ext)) continue;
  const size = statSync(file).size;
  if (!ALLOWED.has(ext)) problems.push(`${file}: ${ext} is not an allowed asset format`);
  if (size > MAX_FILE_BYTES) problems.push(`${file}: ${Math.round(size / 1024)} KB, over 500 KB`);
  const game = /^games\/([^/]+)\//.exec(file)?.[1];
  if (game) perGame.set(game, (perGame.get(game) ?? 0) + size);
}
for (const [game, size] of perGame) {
  if (size > MAX_GAME_BYTES) {
    problems.push(`games/${game}: ${Math.round(size / 1024 / 1024)} MB of assets, over 20 MB`);
  }
}

if (problems.length > 0) {
  console.error(`Asset budget exceeded (see docs/limitations.md):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("Assets within budget.");
