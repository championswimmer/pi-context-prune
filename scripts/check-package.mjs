import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
function safeJsonParse(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${label}: ${err.message}`);
  }
}

const packageJson = safeJsonParse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  "package.json",
);

// Guard the published tarball contract so releases cannot regress to raw TypeScript.
const packOutput = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: packageRoot, encoding: "utf8", shell: true },
);
const packResults = safeJsonParse(packOutput, "npm pack output");
const packResultList = Array.isArray(packResults)
  ? packResults
  : Object.values(packResults);

assert.deepEqual(packageJson.pi?.extensions, ["./dist/index.js"]);
assert.equal(packResultList.length, 1, "expected one npm pack result");

const publishedFiles = new Set(packResultList[0].files.map(({ path }) => path));
assert(publishedFiles.has("dist/index.js"), "dist/index.js is missing from the package");
assert(
  publishedFiles.has("dist/index.js.map"),
  "dist/index.js.map is missing from the package",
);
assert(!publishedFiles.has("index.ts"), "index.ts must not be published");
assert(
  ![...publishedFiles].some((path) => path.startsWith("src/")),
  "src/ TypeScript sources must not be published",
);

console.log("Package check passed: compiled output is included and TypeScript sources are excluded.");
