// Run with `npm run check` (or `node --test scripts/next-version.test.mjs`).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  BUMPS,
  compareVersions,
  nextVersion,
  parseVersion,
  RELEASE_TYPES,
} from "./next-version.mjs";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "next-version.mjs");

describe("nextVersion", () => {
  // The same examples as .github/workflows/release.yml and docs/releasing.md.
  const cases = [
    ["1.2.3", "patch", "release", "1.2.4"],
    ["1.2.3", "minor", "release", "1.3.0"],
    ["1.2.3", "major", "release", "2.0.0"],
    ["1.2.3", "patch", "prerelease", "1.2.4-rc.0"],
    ["1.2.3", "minor", "prerelease", "1.3.0-rc.0"],
    ["1.2.3", "major", "prerelease", "2.0.0-rc.0"],
    ["1.3.0-rc.0", "minor", "prerelease", "1.3.0-rc.1"],
    ["1.3.0-rc.9", "minor", "prerelease", "1.3.0-rc.10"],
    ["1.3.0-rc.2", "minor", "release", "1.3.0"],
    ["1.2.4-rc.1", "patch", "release", "1.2.4"],
    ["2.0.0-rc.0", "major", "release", "2.0.0"],
    // A candidate of another version: the bump starts from its numbers.
    ["1.2.4-rc.1", "minor", "release", "1.3.0"],
    ["1.3.0-rc.2", "major", "prerelease", "2.0.0-rc.0"],
    ["1.3.0-rc.2", "patch", "release", "1.3.0"],
    // The first release of this repository: package.json starts at 0.0.0.
    ["0.0.0", "minor", "prerelease", "0.1.0-rc.0"],
    ["0.0.0", "minor", "release", "0.1.0"],
  ];
  for (const [current, bump, releaseType, expected] of cases) {
    test(`${current} + ${bump} ${releaseType} → ${expected}`, () => {
      assert.equal(nextVersion(current, bump, releaseType), expected);
    });
  }

  test("each prerelease run of the same bump makes the next release candidate", () => {
    let version = "0.2.0";
    const seen = [];
    for (let index = 0; index < 4; index++) {
      version = nextVersion(version, "minor", "prerelease");
      seen.push(version);
    }
    assert.deepEqual(seen, ["0.3.0-rc.0", "0.3.0-rc.1", "0.3.0-rc.2", "0.3.0-rc.3"]);
    assert.equal(nextVersion(version, "minor", "release"), "0.3.0");
  });

  test("every bump and release type gives a newer, valid version", () => {
    for (const current of ["0.0.0", "1.2.3", "1.3.0-rc.1", "2.0.0-rc.0", "1.2.4-beta.7"]) {
      for (const bump of BUMPS) {
        for (const releaseType of RELEASE_TYPES) {
          const next = nextVersion(current, bump, releaseType);
          assert.ok(parseVersion(next), `${next} is valid`);
          assert.ok(compareVersions(next, current) > 0, `${next} > ${current}`);
          assert.equal(parseVersion(next).prerelease.length > 0, releaseType === "prerelease");
        }
      }
    }
  });

  test("another identifier starts a new series at .0", () => {
    assert.equal(nextVersion("1.3.0-beta.3", "minor", "prerelease", "rc"), "1.3.0-rc.0");
    assert.equal(nextVersion("1.2.3", "minor", "prerelease", "beta"), "1.3.0-beta.0");
    assert.equal(nextVersion("1.2.3", "minor", "prerelease", ""), "1.3.0-rc.0");
  });

  test("an identifier that would go backwards is refused", () => {
    assert.throws(() => nextVersion("1.3.0-rc.2", "minor", "prerelease", "beta"), /not newer/);
  });

  test("bad input is refused", () => {
    assert.throws(() => nextVersion("1.2", "patch", "release"), /not a valid semver/);
    assert.throws(() => nextVersion("v1.2.3", "patch", "release"), /not a valid semver/);
    assert.throws(() => nextVersion("1.2.3", "huge", "release"), /Unknown version bump/);
    assert.throws(() => nextVersion("1.2.3", "patch", "stable"), /Unknown release type/);
    assert.throws(() => nextVersion("1.2.3", "patch", "prerelease", "r c"), /identifier/);
    assert.throws(() => nextVersion("1.2.3", "patch", "prerelease", "rc.1"), /identifier/);
    assert.throws(() => nextVersion("1.2.3", "patch", "prerelease", "12"), /identifier/);
    // Not used for a stable release, so not checked.
    assert.equal(nextVersion("1.2.3", "patch", "release", "r c"), "1.2.4");
  });
});

describe("compareVersions", () => {
  test("orders versions by SemVer precedence", () => {
    // The example from semver.org, section 11.
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.1.0",
      "1.10.0",
      "2.0.0",
    ];
    for (let low = 0; low < ordered.length; low++) {
      assert.equal(compareVersions(ordered[low], ordered[low]), 0);
      for (let high = low + 1; high < ordered.length; high++) {
        assert.ok(compareVersions(ordered[low], ordered[high]) < 0);
        assert.ok(compareVersions(ordered[high], ordered[low]) > 0);
      }
    }
  });

  test("refuses versions it cannot parse", () => {
    assert.equal(parseVersion("1.02.3"), null);
    assert.equal(parseVersion("1.2.3-01"), null);
    assert.equal(parseVersion("1.2.3+build"), null);
    assert.throws(() => compareVersions("1.2.3", "latest"), /not a valid semver/);
  });
});

describe("as a script", () => {
  test("prints the version after the one in package.json", () => {
    const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const printed = execFileSync(process.execPath, [script, "minor", "release"], {
      encoding: "utf8",
    });
    assert.equal(printed.trim(), nextVersion(version, "minor", "release"));
  });

  test("exits 1 with a message on bad input", () => {
    const result = spawnSync(process.execPath, [script, "huge", "release"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown version bump/);
    assert.equal(result.stdout, "");
  });
});
