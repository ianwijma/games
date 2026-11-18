// Fails if two packages in the repo ask for different versions of the same dependency, or if a
// version is a range. One exact version of everything keeps games from drifting apart.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execSync("git ls-files '*package.json'", { encoding: "utf8" }).trim().split("\n");
/** dependency name -> version -> files that ask for it */
const seen = new Map();
const problems = [];

for (const file of files) {
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith("@games/")) {
        if (version !== "*") problems.push(`${file}: ${name} must be "*" (a workspace package)`);
        continue;
      }
      // @types/node follows the Node major, so a caret range is allowed there.
      if (!/^\d+\.\d+\.\d+$/.test(version) && name !== "@types/node") {
        problems.push(`${file}: ${name}@${version} must be an exact version`);
      }
      const versions = seen.get(name) ?? new Map();
      versions.set(version, [...(versions.get(version) ?? []), file]);
      seen.set(name, versions);
    }
  }
}

for (const [name, versions] of seen) {
  if (versions.size < 2) continue;
  const detail = [...versions].map(([v, where]) => `${v} in ${where.join(", ")}`).join("; ");
  problems.push(`${name} has more than one version: ${detail}`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`dependency versions agree across ${files.length} packages`);
