// npm run agent:dev: play SECRET AGENT locally in a normal browser, no Telegram needed.
//
// It compiles the real engine, serves public/ and the real API router on http://localhost:8799 with an in-memory
// store, and replaces Telegram's sign-in with a fake user taken from ?uid=. This is a development tool only: it binds
// to 127.0.0.1, lives in scripts/ (never deployed) and production code has no such bypass.
//
//   http://localhost:8799/agent/?uid=1            you
//   http://localhost:8799/agent/?uid=2            open in another tab to play against yourself
//   http://localhost:8799/agent/?uid=1&admin=1    admin console in the Profile tab
// Flags: --fast shortens phases, --port=NNNN changes the port, --lat=MS adds network delay to every API call.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".build-dev");
const args = process.argv.slice(2);
const FAST = args.includes("--fast");
const PORT = Number((args.find((a) => a.startsWith("--port=")) ?? "--port=8799").split("=")[1]);
const LAT = Number((args.find((a) => a.startsWith("--lat=")) ?? "--lat=0").split("=")[1]); // simulate a slow network (ms per API call)

console.log("compiling…");
rmSync(OUT, { recursive: true, force: true });
const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.test.json", "--outDir", OUT], { cwd: ROOT, stdio: "inherit", shell: true });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "package.json"), JSON.stringify({ type: "module" }));

process.env.MYRA_MEM_STORE = "1";
const { route } = await import(pathToFileURL(join(OUT, "src/agent/api.js")).href);
const { TIMINGS_REF } = await import(pathToFileURL(join(OUT, "src/agent/engine.js")).href);
const { MAPS } = await import(pathToFileURL(join(OUT, "src/agent/maps.js")).href);
writeFileSync(join(ROOT, "public/agent/maps.json"), JSON.stringify(MAPS)); // keep the client geometry in sync
if (FAST) Object.assign(TIMINGS_REF.t, { countdown: 2000, briefing: 8000, explore: 30000, discussion: 15000, voting: 12000, result: 4000 });

const ADMIN_UID = 1;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const MOCK = (uid, name) => `<script>(function(){var n=function(){};var back=null;window.Telegram={WebApp:{initData:'mock:${uid}:${name}',initDataUnsafe:{start_param:new URLSearchParams(location.search).get('start')||''},ready:n,expand:n,setHeaderColor:n,setBackgroundColor:n,enableClosingConfirmation:n,disableClosingConfirmation:n,onEvent:n,viewportStableHeight:0,BackButton:{show:n,hide:n,onClick:function(f){back=f}},HapticFeedback:{impactOccurred:n,notificationOccurred:n},openTelegramLink:function(u){console.log('openTelegramLink',u)}}};})();</script>`;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/sa/api/")) {
    if (LAT) await new Promise((r) => setTimeout(r, LAT));
    const m = /^mock:(\d+):?(.*)$/.exec(String(req.headers["x-init-data"] ?? ""));
    if (!m) return send(res, 401, { ok: false, error: "auth-missing" });
    let body;
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { body = {}; }
    }
    const uid = Number(m[1]);
    const r = await route(req.method, url.pathname.slice("/sa/api".length), Object.fromEntries(url.searchParams), body, {
      user: { id: uid, name: decodeURIComponent(m[2] || `Agent ${uid}`), username: `agent${uid}` }, now: Date.now(), isAdmin: uid === ADMIN_UID,
    });
    return send(res, r.status, r.body);
  }
  let p = url.pathname.split("..").join("");
  if (p.endsWith("/")) p += "index.html";
  const file = join(ROOT, "public", p);
  if (!existsSync(file) || statSync(file).isDirectory()) return send(res, 404, { error: "not found" });
  let data = readFileSync(file);
  if (p === "/agent/index.html") {
    const uid = Number(url.searchParams.get("uid") || 1);
    const name = encodeURIComponent(url.searchParams.get("name") || `Agent ${uid}`);
    // swap Telegram's SDK for the local fake sign-in
    data = Buffer.from(data.toString("utf8").replace(/<script src="https:\/\/telegram\.org[^>]*><\/script>/, MOCK(uid, name)));
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(data);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`\nSECRET AGENT dev server${FAST ? " (fast phases)" : ""}`);
  console.log(`  you        http://localhost:${PORT}/agent/?uid=1`);
  console.log(`  2nd player http://localhost:${PORT}/agent/?uid=2   (another tab or browser)`);
  console.log("  Admin is uid 1. Data lives in memory and resets when you stop the server.\n");
});
