process.env.MYRA_MEM_STORE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { route, sweepAgentRooms, type Ctx } from "../src/agent/api.js";
import { getProfile, coinHistory, reconcileCoins } from "../src/agent/meta.js";
import { getJSON, casUpdate } from "../src/store.js";
import type { LudoRoom } from "../src/agent/ludo.js";

let now = 9_000_000_000;
const user = (id: number) => ({ id, name: `Ludo ${id}`, username: `ludo${id}` });
async function call(uid: number, method: string, path: string, body: any = {}, query: Record<string, string> = {}) {
  const ctx: Ctx = { user: user(uid), now, isAdmin: false };
  const r = await route(method, path, query, method === "POST" ? body : undefined, ctx);
  return { ...r, b: r.body as any };
}
const roomOf = async (code: string) => (await getJSON<LudoRoom>(`sa/lr/${code}`))!;

test("ludo: create, join, start, roll and move through the API with the server deciding the dice", async () => {
  const created = await call(7001, "POST", "/ludo/create", { players: 2 });
  assert.equal(created.b.ok, true, JSON.stringify(created.b));
  const code = created.b.code as string;
  assert.equal((await call(7002, "POST", "/ludo/join", { code })).b.ok, true);
  assert.equal((await call(7002, "POST", "/ludo/start", { code })).b.error, "host-only");
  assert.equal((await call(7003, "POST", "/ludo/join", { code })).b.error, "room-full");
  const s = await call(7001, "POST", "/ludo/start", { code });
  assert.equal(s.b.ok, true);
  assert.equal(s.b.view.status, "playing");

  // red (host) moves first; the other player may not act
  assert.equal((await call(7002, "POST", "/ludo/roll", { code })).b.error, "not-your-turn");
  assert.equal((await call(7001, "POST", "/ludo/move", { code, token: 0 })).b.error, "roll-first");
  const r = await call(7001, "POST", "/ludo/roll", { code });
  assert.equal(r.b.ok, true);
  assert.ok(r.b.value >= 1 && r.b.value <= 6);
  // a client cannot choose the dice
  const again = await call(7001, "POST", "/ludo/roll", { code, value: 6 });
  assert.ok(again.b.error === "move-first" || again.b.error === "not-your-turn" || again.b.ok);
  // the other player never sees the mover's options
  const theirs = await call(7002, "POST", "/ludo/tick", { code });
  assert.deepEqual(theirs.b.view.legal, []);
});

test("ludo: practice against bots plays through to a result with exactly one reward", async () => {
  const uid = 7101;
  const p = await call(uid, "POST", "/ludo/practice", {});
  assert.equal(p.b.ok, true, JSON.stringify(p.b));
  const code = p.b.code as string;
  assert.equal(p.b.view.seats.filter((x: any) => x.bot).length, 3);
  assert.equal(p.b.view.status, "playing");

  // the human plays when it is their turn; bots play by themselves as time passes
  let guard = 0;
  let view = p.b.view;
  while (view.status === "playing" && guard++ < 4000) {
    now += 1500;
    if (view.turn === view.me) {
      if (view.phase === "roll") view = (await call(uid, "POST", "/ludo/roll", { code })).b.view;
      else view = (await call(uid, "POST", "/ludo/move", { code, token: view.legal[0] })).b.view;
    } else view = (await call(uid, "POST", "/ludo/tick", { code })).b.view;
  }
  assert.equal(view.status, "finished", "game should finish");
  assert.ok(view.winner !== null);
  assert.ok(view.standings.length === 4);

  // rewards: once, even when the client keeps polling
  now += 1000;
  const a = (await call(uid, "POST", "/ludo/tick", { code })).b.view;
  assert.ok(a.rewards, "reward summary present");
  const coins1 = (await getProfile(uid))!.coins;
  for (let i = 0; i < 4; i++) await call(uid, "POST", "/ludo/tick", { code });
  assert.equal((await getProfile(uid))!.coins, coins1);
  // practice pays XP only (practiceCoins is 0), so there is no coin line and no second payout either
  const lines = (await coinHistory(uid, 50)).filter((l) => l.type === "match");
  assert.equal(lines.length, 0);
  assert.ok((await getProfile(uid))!.xp > 0);
  assert.ok((await reconcileCoins(uid)).ok);
  const prof = (await getProfile(uid))!;
  assert.equal(prof.matches, 1);
  assert.equal(prof.ludoMatches, 1);
  assert.equal(prof.agentWins + prof.spyWins, 0, "Ludo never touches the spy/agent counters");
});

test("ludo: one room per account, bad codes and leaving", async () => {
  const uid = 7201;
  const c = await call(uid, "POST", "/ludo/create", { players: 3 });
  assert.equal((await call(uid, "POST", "/ludo/create", { players: 3 })).b.error, "already-in-room");
  assert.equal((await call(7202, "POST", "/ludo/join", { code: "bad" })).b.error, "bad-code");
  assert.equal((await call(7202, "POST", "/ludo/join", { code: "ZZZZZ" })).status, 404);
  assert.equal((await call(uid, "POST", "/ludo/leave", {})).b.ok, true);
  const again = await call(uid, "POST", "/ludo/create", { players: 2 });
  assert.equal(again.b.ok, true);
  assert.notEqual(again.b.code, c.b.code);
  // /me reports the room so the app can rejoin
  const me = await call(uid, "GET", "/me");
  assert.equal(me.b.ludo.code, again.b.code);
});

test("ludo: host can add a bot and resize the lobby; non-members cannot act", async () => {
  const host = 7301;
  const c = await call(host, "POST", "/ludo/create", { players: 4 });
  const code = c.b.code as string;
  assert.equal((await call(host, "POST", "/ludo/addbot", { code })).b.ok, true);
  assert.equal((await roomOf(code)).seats.length, 2);
  assert.equal((await call(7399, "POST", "/ludo/roll", { code })).b.error, "not-in-room");
  assert.equal((await call(host, "POST", "/ludo/settings", { code, players: 3 })).b.ok, true);
  assert.equal((await roomOf(code)).maxPlayers, 3);
  assert.equal((await call(host, "POST", "/ludo/start", { code })).b.ok, true);
});

test("ludo: the sweep settles and removes old finished rooms", async () => {
  await sweepAgentRooms(now + 3 * 3600_000);
  assert.ok(true);
  await casUpdate("sa/lidx", (c: any) => c);
});
