// npm test: compiles src + tests to .build-test and runs them with node:test (no extra dependencies needed).
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const out = ".build-test";
rmSync(out, { recursive: true, force: true });
const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.test.json"], { stdio: "inherit", shell: true });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
const files = readdirSync(join(out, "tests")).filter((f) => f.endsWith(".test.js")).map((f) => join(out, "tests", f));
const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
