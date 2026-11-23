import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

// Guard the published tarball contract so releases cannot regress to raw TypeScript.
const packOutput = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: packageRoot, encoding: "utf8" },
);
const packResults = JSON.parse(packOutput);

assert.deepEqual(packageJson.pi?.extensions, ["./dist/index.js"]);
assert.equal(packageJson.main, "./dist/index.js");
assert.equal(packageJson.types, "./dist/index.d.ts");
assert.equal(packResults.length, 1, "expected one npm pack result");

const publishedFiles = new Set(packResults[0].files.map(({ path }) => path));
assert(publishedFiles.has("dist/index.js"), "dist/index.js is missing from the package");
assert(publishedFiles.has("dist/index.d.ts"), "dist/index.d.ts is missing from the package");
assert(publishedFiles.has("dist/src/config.js"), "dist/src/config.js is missing from the package");
assert(publishedFiles.has("README.md"), "README.md is missing from the package");
assert(publishedFiles.has("LICENSE"), "LICENSE is missing from the package");
assert(
  ![...publishedFiles].some((path) => path.endsWith(".map")),
  "source/declaration .map files must not be published",
);
assert(
  ![...publishedFiles].some((path) => path.startsWith("dist/src/") && path.endsWith(".d.ts")),
  "internal dist/src/*.d.ts files must not be published",
);
assert(
  ![...publishedFiles].some((path) => path.includes("multi-batch-loader")),
  "dead multi-batch-loader files must not be published",
);
assert(!publishedFiles.has("index.ts"), "index.ts must not be published");
assert(
  ![...publishedFiles].some((path) => path.startsWith("src/")),
  "src/ TypeScript sources must not be published",
);

console.log("Package check passed: compiled JS + root index.d.ts + docs are included; maps, internal .d.ts, and TypeScript sources are excluded.");
