import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const exact = /^\d+\.\d+\.\d+$/;

test("Console dependencies are exact and never use latest or ranges", () => {
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(version, exact, `${name} must be pinned exactly`);
  }
});

test("every direct dependency is recorded in the license ledger", () => {
  const ledger = readFileSync(new URL("../../../docs/THIRD-PARTY-LICENSES.md", import.meta.url), "utf8");
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(ledger, new RegExp("\\| `" + escapedName + "` \\|"));
  }
});
