// Writes public/agent/maps.json from src/agent/maps.ts so the Mini App draws exactly the geometry the server validates.
// Run after changing maps: node scripts/agent-maps.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const out = ".build-maps";
rmSync(out, { recursive: true, force: true });
const r = spawnSync("npx", ["tsc", "-p", "tsconfig.test.json", "--outDir", out], { stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/package.json`, JSON.stringify({ type: "module" }));
const { MAPS } = await import(pathToFileURL(resolve(out, "src/agent/maps.js")).href);
writeFileSync("public/agent/maps.json", JSON.stringify(MAPS));
rmSync(out, { recursive: true, force: true });
console.log(`wrote public/agent/maps.json (${MAPS.length} maps)`);
