process.env.MYRA_MEM_STORE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { route, type Ctx } from "../src/agent/api.js";
import { TIMINGS_REF, type Room } from "../src/agent/engine.js";
import { MAPS } from "../src/agent/maps.js";
import { finalizeMatch, getProfile, coinHistory, reconcileCoins, clearLbCache, saveCfg } from "../src/agent/meta.js";
import { getJSON, casUpdate } from "../src/store.js";

Object.assign(TIMINGS_REF.t, { countdown: 1000, briefing: 1000, explore: 8000, discussion: 4000, voting: 4000, result: 1000, grace: 30000, lobbyIdle: 60000 });

let now = 5_000_000_000;
const ADMIN = 9_000_001;
const user = (id: number) => ({ id, name: `Agent ${id}`, username: `agent${id}` });
async function call(uid: number, method: string, path: string, body: any = {}, query: Record<string, string> = {}, admin = false) {
  const ctx: Ctx = { user: user(uid), now, isAdmin: admin || uid === ADMIN };
  return route(method, path, query, method === "POST" ? body : undefined, ctx).then((r) => ({ ...r, b: r.body as any }));
}
const roomOf = async (code: string) => (await getJSON<Room>(`sa/r/${code}`))!;
async function place(code: string, uid: number, objId: string) {
  await casUpdate<Room>(`sa/r/${code}`, (r) => {
    const o = MAPS.find((m) => m.id === r!.mapId)!.objects.find((x) => x.id === objId)!;
    const p = r!.players.find((q) => q.uid === uid)!;
    p.x = o.x;
    p.y = o.y + 10;
    return r!;
  });
}
const tickAll = async (code: string, uids: number[]) => {
  for (const u of uids) await call(u, "POST", "/room/tick", { code });
};

async function openRoom(base: number, n = 4) {
  const ids = Array.from({ length: n }, (_, i) => base + i);
  const created = await call(ids[0], "POST", "/room/create", { maxPlayers: n });
  assert.equal(created.status, 200, JSON.stringify(created.b));
  const code = created.b.code as string;
  for (const id of ids.slice(1)) {
    const j = await call(id, "POST", "/room/join", { code });
    assert.equal(j.status, 200, JSON.stringify(j.b));
  }
  for (const id of ids) await call(id, "POST", "/room/ready", { code, ready: true });
  return { ids, code };
}

async function playToVoting(code: string, ids: number[]) {
  await tickAll(code, ids);
  now += 1500; // countdown over
  await tickAll(code, ids);
  assert.equal((await roomOf(code)).phase, "briefing");
  now += 1500;
  await tickAll(code, ids);
  assert.equal((await roomOf(code)).phase, "explore");
}

test("full match: 4 independent clients, private roles, synchronized phases, winner screen, rewards once", async () => {
  const { ids, code } = await openRoom(100, 4);
  await playToVoting(code, ids);

  const room = await roomOf(code);
  const spy = room.players.find((p) => p.role === "spy")!;
  const agents = room.players.filter((p) => p.role !== "spy");

  // every client sees only their own role; all clients see the same phase and seq
  const views = [];
  for (const id of ids) views.push((await call(id, "POST", "/room/tick", { code })).b.view);
  for (const v of views) {
    assert.equal(v.phase, "explore");
    assert.equal(v.players.length, 4);
    assert.equal(v.players.filter((p: any) => p.role !== undefined).length, 0);
  }
  assert.equal(new Set(views.map((v) => v.seq)).size, 1, "all clients are on the same state version");
  const spyView = views.find((v) => v.me.uid === spy.uid)!;
  assert.equal(spyView.me.role, "spy");
  assert.ok(views.filter((v) => v.me.uid !== spy.uid).every((v) => v.me.role !== "spy"));

  // agents work on objectives; the spy fakes one; progress is server counted
  now += 1300;
  await place(code, agents[0].uid, "o1");
  const t1 = await call(agents[0].uid, "POST", "/room/interact", { code, obj: "o1" });
  assert.equal(t1.b.ok, true);
  assert.equal(t1.b.view.progress.done, 1);
  await place(code, spy.uid, "o2");
  const t2 = await call(spy.uid, "POST", "/room/interact", { code, obj: "o2" });
  assert.equal(t2.b.ok, true);
  assert.equal(t2.b.view.progress.done, 1, "fake task does not advance the mission");

  // a client cannot vote during exploration
  const early = await call(agents[1].uid, "POST", "/room/vote", { code, target: spy.uid });
  assert.equal(early.status, 400);

  // time passes: discussion, then voting
  now += 8000;
  await tickAll(code, ids);
  assert.equal((await roomOf(code)).phase, "discussion");
  const said = await call(agents[0].uid, "POST", "/room/chat", { code, quick: "found" });
  assert.equal(said.b.ok, true);
  assert.ok(said.b.view.chat.some((c: any) => c.kind === "quick"));
  now += 4000;
  await tickAll(code, ids);
  assert.equal((await roomOf(code)).phase, "voting");

  for (const a of agents) assert.equal((await call(a.uid, "POST", "/room/vote", { code, target: spy.uid })).b.ok, true);
  const last = await call(spy.uid, "POST", "/room/vote", { code, target: agents[0].uid });
  assert.equal(last.b.ok, true);
  // everyone voted: the server resolves the vote on the next tick, the winner is decided by the server
  const fin = await call(agents[0].uid, "POST", "/room/tick", { code });
  assert.equal(fin.b.view.status, "finished");
  assert.equal(fin.b.view.outcome.winner, "agents");
  assert.ok(fin.b.view.outcome.players.every((p: any) => p.role), "roles revealed only after the match");

  // rewards: present once, identical for repeated polls, ledger lines unique per match
  const r1 = (await call(agents[0].uid, "POST", "/room/tick", { code })).b.view;
  assert.ok(r1.rewards, "reward summary available");
  assert.ok(r1.rewards.won);
  const coinsAfter = (await getProfile(agents[0].uid))!.coins;
  for (let i = 0; i < 5; i++) await call(agents[0].uid, "POST", "/room/tick", { code });
  const again = await finalizeMatch(await roomOf(code), now);
  assert.equal(again, null, "second finalisation is refused");
  assert.equal((await getProfile(agents[0].uid))!.coins, coinsAfter);
  const matchId = (await roomOf(code)).matchId;
  const lines = (await coinHistory(agents[0].uid, 50)).filter((l) => l.idem === `match:${matchId}`);
  assert.equal(lines.length, 1);
  assert.equal((await reconcileCoins(agents[0].uid)).ok, true);

  const p = (await getProfile(agents[0].uid))!;
  assert.equal(p.wins, 1);
  assert.equal(p.matches, 1);
  assert.ok(p.xp > 0 && p.coins >= 35);
  const loser = (await getProfile(spy.uid))!;
  assert.equal(loser.losses, 1);
  assert.ok(loser.coins >= 10, "losers still get participation coins");

  // match history and details (participants only)
  const hist = await call(agents[0].uid, "GET", "/history");
  assert.equal(hist.b.matches.length, 1);
  const detail = await call(agents[0].uid, "GET", "/match", {}, { id: hist.b.matches[0].matchId });
  assert.equal(detail.status, 200);
  const stranger = await call(555000, "GET", "/match", {}, { id: hist.b.matches[0].matchId });
  assert.equal(stranger.status, 403);

  // leaderboard comes from persisted results; own rank is pinned
  clearLbCache();
  const lb = await call(agents[0].uid, "GET", "/leaderboard", {}, { board: "global" });
  assert.equal(lb.b.me.uid, agents[0].uid);
  assert.ok(lb.b.rows.length >= 4);
  assert.ok(lb.b.rows[0].xp >= lb.b.rows[lb.b.rows.length - 1].xp);
  const weekly = await call(agents[0].uid, "GET", "/leaderboard", {}, { board: "weekly" });
  assert.ok(weekly.b.rows.some((r: any) => r.uid === agents[0].uid));
});

test("a spy victory by sabotage is decided by the server and rewards the spy", async () => {
  const { ids, code } = await openRoom(200, 4);
  await playToVoting(code, ids);
  const room = await roomOf(code);
  const spy = room.players.find((p) => p.role === "spy")!;
  for (const obj of ["o1", "o2", "o3"]) {
    now += 21000;
    await casUpdate<Room>(`sa/r/${code}`, (r) => ({ ...r!, phaseEnd: now + 100000 }));
    await place(code, spy.uid, obj);
    const r = await call(spy.uid, "POST", "/room/ability", { code, ability: "sabotage", obj });
    assert.equal(r.b.ok, true, JSON.stringify(r.b));
  }
  const v = (await call(ids[0], "POST", "/room/tick", { code })).b.view;
  assert.equal(v.status, "finished");
  assert.equal(v.outcome.winner, "spy");
  const mine = (await call(spy.uid, "POST", "/room/tick", { code })).b.view;
  assert.ok(mine.rewards.won);
  assert.equal((await getProfile(spy.uid))!.spyWins, 1);
});

test("clients cannot claim rewards, set balances or decide winners", async () => {
  const { ids, code } = await openRoom(300, 4);
  const before = (await getProfile(ids[0]))!.coins;
  for (const path of ["/room/claim", "/rewards/claim", "/room/result", "/room/win"]) {
    const r = await call(ids[0], "POST", path, { code, coins: 9999, winner: "spy", xp: 99999 });
    assert.ok(r.status === 404 || r.status === 400);
  }
  const t = await call(ids[0], "POST", "/room/tick", { code, coins: 5000, role: "spy", phase: "voting" });
  assert.equal(t.b.view.phase !== "voting", true);
  assert.equal((await getProfile(ids[0]))!.coins, before);
});

test("rooms: one room per account, bad codes, capacity and reconnection", async () => {
  const { ids, code } = await openRoom(400, 4);
  const second = await call(ids[0], "POST", "/room/create", {});
  assert.equal(second.b.error, "already-in-room");
  const other = await call(ids[1], "POST", "/room/join", { code: "ZZZZZ" });
  assert.ok(other.status === 404 || other.b.error === "already-in-room");
  assert.equal((await call(9999991, "POST", "/room/join", { code: "bad" })).b.error, "bad-code");

  // fifth player cannot enter a 4-player room (and not once it started)
  await playToVoting(code, ids);
  const late = await call(8800001, "POST", "/room/join", { code });
  assert.equal(late.b.error, "match-started");

  // a player goes silent for a while and comes back: same room, same private role
  const room = await roomOf(code);
  const me = room.players.find((p) => p.uid === ids[2])!;
  now += 12000;
  await tickAll(code, [ids[0], ids[1], ids[3]]);
  const back = await call(ids[2], "GET", "/me");
  assert.equal(back.b.room.code, code);
  const view = (await call(ids[2], "POST", "/room/tick", { code })).b.view;
  assert.equal(view.me.role, me.role);
  assert.notEqual(view.status, "cancelled");
});

test("matchmaking: quick match joins open lobbies and fills with labelled bots after the wait", async () => {
  const a = await call(500, "POST", "/room/quick", {});
  const b = await call(501, "POST", "/room/quick", {});
  assert.equal(a.b.view.code, b.b.view.code, "second player lands in the first player's lobby");
  now += 25000;
  const v = (await call(500, "POST", "/room/tick", { code: a.b.view.code })).b.view;
  assert.ok(v.players.filter((p: any) => p.bot).length >= 2);
  assert.ok(v.players.every((p: any) => p.bot === !!p.bot));
});

test("practice mode starts alone against bots", async () => {
  const r = await call(600, "POST", "/room/practice", {});
  assert.equal(r.b.view.players.filter((p: any) => p.bot).length, 5);
  now += 6000;
  const v = (await call(600, "POST", "/room/tick", { code: r.b.view.code })).b.view;
  assert.ok(["briefing", "explore", "countdown"].includes(v.phase));
});

test("missions and daily reward cannot be claimed twice; incomplete missions are refused", async () => {
  const uid = 700;
  await call(uid, "GET", "/me");
  const d1 = await call(uid, "POST", "/daily/claim");
  const d2 = await call(uid, "POST", "/daily/claim");
  assert.equal(d1.b.ok, true);
  assert.equal(d2.b.ok, false);
  assert.equal((await getProfile(uid))!.coins, d1.b.amount);
  const list = await call(uid, "GET", "/missions");
  const m = list.b.missions[0];
  const early = await call(uid, "POST", "/missions/claim", { id: m.id });
  assert.equal(early.b.error, "not-complete");
  // complete it server-side (as a finished match would) and claim twice
  const { updateProfile } = await import("../src/agent/meta.js");
  await updateProfile(uid, (p) => ({ ...p, missions: { ...p.missions, progress: { ...p.missions.progress, [m.id]: m.target } } }));
  const c1 = await call(uid, "POST", "/missions/claim", { id: m.id });
  const c2 = await call(uid, "POST", "/missions/claim", { id: m.id });
  assert.equal(c1.b.ok, true);
  assert.equal(c2.b.ok, false);
  assert.equal((await reconcileCoins(uid)).ok, true);
});

test("admin endpoints require an administrator and are audited", async () => {
  const denied = await call(701, "GET", "/admin/dashboard");
  assert.equal(denied.status, 403);
  assert.equal((await call(701, "POST", "/admin/ban", { uid: 700 })).status, 403);
  assert.equal((await call(701, "POST", "/admin/config", { maintenance: true })).status, 403);

  const dash = await call(ADMIN, "GET", "/admin/dashboard");
  assert.equal(dash.status, 200);
  assert.ok(dash.b.players >= 1);

  const ban = await call(ADMIN, "POST", "/admin/ban", { uid: 700, reason: "test" });
  assert.equal(ban.b.ok, true);
  assert.equal((await call(700, "GET", "/me")).status, 403, "banned account is locked out");
  await call(ADMIN, "POST", "/admin/unban", { uid: 700 });
  assert.equal((await call(700, "GET", "/me")).status, 200);

  const audit = await call(ADMIN, "GET", "/admin/audit");
  assert.ok(audit.b.audit.some((a: any) => a.action === "ban"));
});

test("maintenance mode blocks play but keeps the app readable; admins keep access", async () => {
  await saveCfg({ maintenance: true }, ADMIN, now);
  assert.equal((await call(702, "POST", "/room/practice", {})).status, 503);
  assert.equal((await call(702, "GET", "/me")).b.maintenance, true);
  assert.equal((await call(ADMIN, "POST", "/room/practice", {})).status, 200);
  await saveCfg({ maintenance: false }, ADMIN, now);
  assert.equal((await call(703, "POST", "/room/practice", {})).status, 200);
});

test("ranked mode is off by default and configurable by the admin", async () => {
  const off = await call(710, "POST", "/room/quick", { ranked: true });
  assert.equal(off.b.error, "mode-disabled");
  await call(ADMIN, "POST", "/admin/config", { modes: { ranked: true } });
  const on = await call(710, "POST", "/room/quick", { ranked: true });
  assert.equal(on.status, 200);
  assert.equal(on.b.view.mode, "ranked");
});

test("reports are stored and visible to admins only", async () => {
  const { ids, code } = await openRoom(800, 4);
  const r = await call(ids[0], "POST", "/room/report", { code, target: ids[1], reason: "spam" });
  assert.equal(r.b.ok, true);
  assert.equal((await call(ids[0], "GET", "/admin/reports")).status, 403);
  const list = await call(ADMIN, "GET", "/admin/reports");
  assert.ok(list.b.reports.some((x: any) => x.target === ids[1] && x.reason === "spam"));
});
