// Works out the next release version for the Release workflow (docs/releasing.md).
//
//   node scripts/next-version.mjs <bump> <release-type> [prerelease-identifier]
//
//   bump:          patch | minor | major
//   release-type:  prerelease | release
//
// Reads the current version from the root package.json and prints the next one.
//
// - `release` makes a stable version (1.2.3 + minor → 1.3.0). On a release candidate of that
//   version it releases the candidate (1.3.0-rc.2 + minor → 1.3.0).
// - `prerelease` makes a release candidate of that same stable version. If the current version is
//   already a candidate of it, this is the next candidate (1.3.0-rc.0 + minor → 1.3.0-rc.1);
//   otherwise it is the first one (1.2.3 + minor → 1.3.0-rc.0).
//
// No dependencies, so the workflow can run it without `npm ci`. It follows the SemVer 2.0.0 rules
// for the versions it makes; build metadata (`+…`) is not supported.
// scripts/next-version.test.mjs covers every combination.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUMPS = ["patch", "minor", "major"];
export const RELEASE_TYPES = ["prerelease", "release"];
export const DEFAULT_PRERELEASE_IDENTIFIER = "rc";

const NUMBER = "(0|[1-9]\\d*)";
// A prerelease identifier: digits without a leading zero, or letters, digits and hyphens.
const PART = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${PART}(?:\\.${PART})*))?$`);

/** "1.3.0-rc.1" → { major: 1, minor: 3, patch: 0, prerelease: ["rc", 1] }, or null if invalid. */
export function parseVersion(version) {
  const match = VERSION.exec(version);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = (match[4]?.split(".") ?? []).map((part) =>
    /^\d+$/.test(part) ? Number(part) : part,
  );
  return { major, minor, patch, prerelease };
}

function parseOrThrow(version) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`"${version}" is not a valid semver version.`);
  return parsed;
}

/** Negative when a < b, 0 when equal, positive when a > b, by SemVer precedence. */
export function compareVersions(a, b) {
  const left = parseOrThrow(a);
  const right = parseOrThrow(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  // A stable version is newer than any of its prereleases.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === y) continue;
    // Numbers sort before words; numbers by value; words by ASCII order.
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return left.prerelease.length - right.prerelease.length;
}

/** The stable version a bump leads to. A candidate of that version leads to it, not past it. */
function stableTarget({ major, minor, patch, prerelease }, bump) {
  const candidate = prerelease.length > 0;
  if (bump === "major") {
    return candidate && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
  }
  if (bump === "minor") {
    return candidate && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
  }
  return candidate ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
}

/** The version after `current` for a bump and a release type, e.g. "1.2.3" → "1.3.0-rc.0". */
export function nextVersion(
  current,
  bump,
  releaseType,
  prereleaseIdentifier = DEFAULT_PRERELEASE_IDENTIFIER,
) {
  const parsed = parseVersion(current);
  if (!parsed) throw new Error(`Current version "${current}" is not a valid semver version.`);
  if (!BUMPS.includes(bump)) {
    throw new Error(`Unknown version bump "${bump}". Use one of: ${BUMPS.join(", ")}.`);
  }
  if (!RELEASE_TYPES.includes(releaseType)) {
    throw new Error(
      `Unknown release type "${releaseType}". Use one of: ${RELEASE_TYPES.join(", ")}.`,
    );
  }
  const target = stableTarget(parsed, bump);
  // The identifier is not used for a stable release, so it is not checked either.
  if (releaseType === "release") return target;

  const identifier = prereleaseIdentifier || DEFAULT_PRERELEASE_IDENTIFIER;
  // One word: letters, digits and hyphens, and not only digits (the counter is the number).
  if (!/^[0-9A-Za-z-]+$/.test(identifier) || /^\d+$/.test(identifier)) {
    throw new Error(
      `Prerelease identifier "${identifier}" must be letters, digits and hyphens, and not only digits.`,
    );
  }

  // Already a candidate of the same version with the same identifier: the next candidate.
  // A new identifier starts again at .0 (1.3.0-beta.3 → 1.3.0-rc.0).
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const [word, counter] = parsed.prerelease;
  const sameSeries =
    core === target &&
    parsed.prerelease.length === 2 &&
    word === identifier &&
    typeof counter === "number";
  const next = `${target}-${identifier}.${sameSeries ? counter + 1 : 0}`;
  // A new identifier can sort before the current one (1.3.0-rc.2 → 1.3.0-beta.0): never go back.
  if (compareVersions(next, current) <= 0) {
    throw new Error(
      `The next prerelease ${next} is not newer than ${current}. Use a prerelease identifier that sorts after the current one, or a bigger version bump.`,
    );
  }
  return next;
}

// Run as a script (not when the tests import it).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [bump = "", releaseType = "", prereleaseIdentifier] = process.argv.slice(2);
  const packageJson = path.resolve(import.meta.dirname, "..", "package.json");
  try {
    const { version } = JSON.parse(readFileSync(packageJson, "utf8"));
    console.log(nextVersion(String(version), bump, releaseType, prereleaseIdentifier));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
