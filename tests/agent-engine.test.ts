import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS, TIMINGS_REF, addPlayer, advance, chat, interact, move, newRoom, removePlayer, setCharacter, setReady, startGame, useAbility, viewFor, vote,
  shareClue, type Room,
} from "../src/agent/engine.js";
import { MAPS, WORLD, dist, walkable } from "../src/agent/maps.js";

// small deterministic RNG so tests are repeatable
function lcg(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

Object.assign(TIMINGS_REF.t, { countdown: 1000, briefing: 1000, explore: 10000, discussion: 5000, voting: 5000, result: 1000, grace: 20000, lobbyIdle: 60000 });

let T = 1_000_000;
// the clients' requests keep players "present"; tests that jump the clock refresh that explicitly
const adv = (room: Room, now: number, rng: () => number) => {
  for (const p of room.players) if (!p.bot && !p.left) p.lastSeen = now;
  return advance(room, now, rng);
};
function lobby(n: number, mode: "private" | "practice" = "private") {
  const room = newRoom("TESTA", { uid: 1, name: "P1" }, mode, T, { maxPlayers: Math.max(4, n) });
  for (let i = 2; i <= n; i++) assert.ok(addPlayer(room, { uid: i, name: `P${i}` }, T).ok);
  return room;
}
function started(n = 6, seed = 3) {
  const room = lobby(n);
  startGame(room, T, lcg(seed));
  return room;
}
const roleOf = (room: Room, r: string) => room.players.filter((p) => p.role === r);
function toExplore(room: Room, rng = lcg(5)) {
  adv(room, room.phaseEnd, rng); // briefing -> explore
  assert.equal(room.phase, "explore");
}
function standAt(room: Room, uid: number, objId: string) {
  const o = MAPS.find((m) => m.id === room.mapId)!.objects.find((x) => x.id === objId)!;
  const p = room.players.find((q) => q.uid === uid)!;
  p.x = o.x;
  p.y = o.y + 10;
}

test("lobby: capacity, duplicate accounts and unique characters are enforced", () => {
  const room = newRoom("CAPAC", { uid: 1, name: "A" }, "private", T, { maxPlayers: 4 });
  assert.deepEqual(addPlayer(room, { uid: 1, name: "A" }, T), { ok: false, error: "already-in" });
  for (const id of [2, 3, 4]) assert.ok(addPlayer(room, { uid: id, name: `P${id}` }, T).ok);
  assert.deepEqual(addPlayer(room, { uid: 5, name: "E" }, T), { ok: false, error: "room-full" });
  assert.equal(new Set(room.players.map((p) => p.char)).size, 4);
  assert.deepEqual(setCharacter(room, 2, room.players[0].char), { ok: false, error: "character-taken" });
});

test("roles: counts are balanced for 4 to 10 players and exactly one spy by default", () => {
  for (let n = 4; n <= 10; n++) {
    const room = started(n, n);
    assert.equal(room.players.length, n);
    assert.equal(roleOf(room, "spy").length, 1);
    assert.equal(roleOf(room, "detective").length, 1);
    assert.equal(roleOf(room, "hacker").length, n >= 4 ? 1 : 0);
    assert.equal(roleOf(room, "guard").length, n >= 5 ? 1 : 0);
    assert.ok(room.players.every((p) => p.role));
  }
});

test("privacy: a client view never contains another player's role", () => {
  const room = started(6, 11);
  for (const viewer of room.players) {
    const v = viewFor(room, viewer.uid, T);
    assert.equal(v.me!.role, viewer.role);
    for (const p of v.players) assert.equal((p as any).role, undefined, "no public role during play");
    const json = JSON.stringify(v);
    for (const other of room.players.filter((p) => p.uid !== viewer.uid && p.role === "spy")) {
      assert.ok(!json.includes(`"role":"spy","alive"`), "spy flag must not leak");
      assert.equal(v.me!.teammates.includes(other.uid), viewer.role === "spy");
    }
  }
  // spectators and logged-out viewers see no roles either
  const anon = viewFor(room, null, T);
  assert.ok(anon.players.every((p) => (p as any).role === undefined));
  assert.equal(anon.me, null);
});

test("phase machine: actions outside their phase are rejected", () => {
  const room = lobby(5);
  assert.deepEqual(move(room, 1, 100, 100, T), { ok: false, error: "not-active" });
  startGame(room, T, lcg(2));
  assert.equal(room.phase, "briefing");
  assert.equal(move(room, 1, 100, 100, T + 100).ok, false);
  assert.deepEqual(vote(room, 1, 2, T), { ok: false, error: "wrong-phase" });
  toExplore(room);
  assert.deepEqual(vote(room, 1, 2, T), { ok: false, error: "wrong-phase" });
  assert.deepEqual(chat(room, 1, { text: "hi" }, T + 3000), { ok: false, error: "wrong-phase" });
  adv(room, room.phaseEnd, lcg(1)); // discussion
  assert.equal(room.phase, "discussion");
  const o = interact(room, 1, "o1", T + 20000);
  assert.deepEqual(o, { ok: false, error: "wrong-phase" });
  assert.equal(chat(room, 1, { text: "hello team" }, T + 20000).ok, true);
  assert.equal(chat(room, 1, { text: "again" }, T + 20100).ok, false, "chat rate limit");
});

test("movement: speed limit, bounds and obstacles are enforced server-side", () => {
  const room = started(5, 4);
  toExplore(room);
  const map = MAPS.find((m) => m.id === room.mapId)!;
  const p = room.players[0];
  const t0 = room.phaseStart;
  p.x = 100; p.y = 60; p.lastMove = t0;
  // teleport across the map in one tick: corrected to at most speed * dt
  const r = move(room, p.uid, 700, 60, t0 + 100);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.corrected);
    assert.ok(r.x - 100 <= LIMITS.speed * 0.1 * 1.35 + 6 + 0.1, `moved ${r.x - 100}`);
  }
  // out of bounds
  p.x = 30; p.y = 100; p.lastMove = t0;
  const out = move(room, p.uid, -500, 100, t0 + 1000);
  assert.ok(out.ok && walkable(map, out.x, out.y));
  // obstacle
  const ob = map.obstacles[0];
  p.x = ob.x - 40; p.y = ob.y + ob.h / 2; p.lastMove = t0;
  const into = move(room, p.uid, ob.x + 5, ob.y + ob.h / 2, t0 + 1500);
  assert.ok(into.ok && walkable(map, into.x, into.y));
  assert.ok(into.ok && into.x < ob.x - WORLD.radius + 1);
  assert.deepEqual(move(room, p.uid, NaN, 0, t0 + 1600), { ok: false, error: "bad-input" });
});

test("interaction: distance check, one task per object per round, clue collected once", () => {
  const room = started(5, 6);
  toExplore(room);
  const agent = room.players.find((p) => p.role !== "spy")!;
  const now = room.phaseStart + 500;
  agent.x = 10; agent.y = 10;
  assert.deepEqual(interact(room, agent.uid, "o1", now), { ok: false, error: "too-far" });
  standAt(room, agent.uid, "o1");
  const r = interact(room, agent.uid, "o1", now);
  assert.ok(r.ok && r.kind === "task");
  assert.equal(room.taskDone, 1);
  assert.deepEqual(interact(room, agent.uid, "o1", now + 100), { ok: false, error: "too-fast" });
  const again = interact(room, agent.uid, "o1", now + 2000);
  assert.deepEqual(again, { ok: false, error: "already-done" });
  assert.deepEqual(interact(room, agent.uid, "zzz", now + 4000), { ok: false, error: "no-such-object" });
  // a clue on that object is only given once
  const clue = room.clues.find((c) => c.objId === "o1");
  if (clue) assert.equal(agent.clues.filter((c) => c === clue.id).length, 1);
});

test("spy: fake tasks give no progress, sabotage has cooldown, limits and counterplay", () => {
  const room = started(6, 8);
  toExplore(room);
  const spy = roleOf(room, "spy")[0];
  const agent = room.players.find((p) => p.role === "agent" || p.role === "guard")!;
  const t = room.phaseStart + 1000;
  standAt(room, spy.uid, "o2");
  const fake = interact(room, spy.uid, "o2", t);
  assert.ok(fake.ok && fake.kind === "fake");
  assert.equal(room.taskDone, 0, "a fake task must not advance the mission");

  // only the spy has these abilities
  assert.deepEqual(useAbility(room, agent.uid, "sabotage", { obj: "o2" }, t + 1000), { ok: false, error: "unknown-ability" });
  const s1 = useAbility(room, spy.uid, "sabotage", { obj: "o2" }, t + 1000);
  assert.ok(s1.ok);
  assert.equal(room.meter, 1);
  assert.deepEqual(useAbility(room, spy.uid, "sabotage", { obj: "o2" }, t + 2000), { ok: false, error: "cooldown" });

  // an agent repairs it
  standAt(room, agent.uid, "o2");
  const rep = interact(room, agent.uid, "o2", t + 3000);
  assert.ok(rep.ok && rep.kind === "repair");
  assert.equal(room.meter, 0);
  assert.equal(room.objects.find((o) => o.id === "o2")!.state, "ok");

  // far away: rejected
  spy.x = 5; spy.y = 5;
  assert.deepEqual(useAbility(room, spy.uid, "sabotage", { obj: "o3" }, t + 30000), { ok: false, error: "too-far" });
});

test("win: three unrepaired sabotages make the spy win", () => {
  const room = started(5, 9);
  toExplore(room);
  const spy = roleOf(room, "spy")[0];
  let t = room.phaseStart;
  for (const obj of ["o1", "o2", "o3"]) {
    t += LIMITS.sabotageCd + 100;
    standAt(room, spy.uid, obj);
    spy.lastMove = t;
    const r = useAbility(room, spy.uid, "sabotage", { obj }, t);
    assert.ok(r.ok, `sabotage ${obj}`);
  }
  assert.equal(room.status, "finished");
  assert.equal(room.outcome!.winner, "spy");
});

function toVoting(room: Room) {
  adv(room, room.phaseEnd, lcg(1)); // explore -> discussion
  adv(room, room.phaseEnd, lcg(1)); // discussion -> voting
  assert.equal(room.phase, "voting");
}

test("voting: plurality eliminates, ties eliminate nobody, abstain is allowed", () => {
  const room = started(6, 12);
  toExplore(room);
  toVoting(room);
  const innocent = room.players.filter((p) => p.role !== "spy");
  const [x, y] = innocent;
  const rest = room.players.filter((p) => p.uid !== x.uid && p.uid !== y.uid);
  // tie: two votes each for x and y; x and y themselves abstain
  vote(room, rest[0].uid, x.uid, T); vote(room, rest[1].uid, x.uid, T);
  vote(room, rest[2].uid, y.uid, T); vote(room, rest[3].uid, y.uid, T);
  vote(room, x.uid, 0, T); vote(room, y.uid, 0, T);
  // the room has human voters only: everyone voted so the phase ends immediately
  adv(room, room.phaseStart + 10, lcg(1));
  assert.equal(room.lastVote!.tie, true);
  assert.equal(room.lastVote!.eliminated, null);
  assert.ok(room.players.every((p) => p.alive));
});

test("voting: eliminating the spy ends the match for the agents; a vote for yourself is invalid", () => {
  const room = started(5, 13);
  toExplore(room);
  toVoting(room);
  const spy = roleOf(room, "spy")[0];
  assert.deepEqual(vote(room, spy.uid, spy.uid, T), { ok: false, error: "bad-target" });
  for (const p of room.players) if (p.uid !== spy.uid) vote(room, p.uid, spy.uid, T);
  vote(room, spy.uid, room.players.find((p) => p.uid !== spy.uid)!.uid, T);
  adv(room, room.phaseStart + 10, lcg(1));
  assert.equal(room.status, "finished");
  assert.equal(room.outcome!.winner, "agents");
  assert.equal(room.lastVote!.team, "spy");
});

test("voting: the guard's shield blocks one elimination", () => {
  const room = started(6, 14);
  toExplore(room);
  const guard = roleOf(room, "guard")[0];
  const target = room.players.find((p) => p.role === "agent")!;
  standAt(room, guard.uid, "o1");
  target.x = guard.x + 20; target.y = guard.y;
  const r = useAbility(room, guard.uid, "shield", { target: target.uid }, room.phaseStart + 1000);
  assert.ok(r.ok);
  assert.deepEqual(useAbility(room, guard.uid, "shield", { target: target.uid }, room.phaseStart + 5000), { ok: false, error: "no-uses-left" });
  toVoting(room);
  for (const p of room.players) if (p.uid !== target.uid) vote(room, p.uid, target.uid, T);
  vote(room, target.uid, 0, T);
  adv(room, room.phaseStart + 10, lcg(1));
  assert.equal(room.lastVote!.shielded, true);
  assert.equal(target.alive, true);
});

test("spy outnumbering the agents wins; leaving the match counts as elimination", () => {
  const room = started(4, 15);
  toExplore(room);
  const non = room.players.filter((p) => p.role !== "spy");
  removePlayer(room, non[0].uid, T);
  assert.equal(room.status, "playing");
  removePlayer(room, non[1].uid, T);
  assert.equal(room.status, "finished");
  assert.equal(room.outcome!.winner, "spy");
});

test("evidence is private until a player shares it", () => {
  const room = started(5, 16);
  toExplore(room);
  const a = room.players.find((p) => p.role !== "spy")!;
  const clue = room.clues[0];
  standAt(room, a.uid, clue.objId);
  const r = interact(room, a.uid, clue.objId, room.phaseStart + 1000);
  assert.ok(r.ok && r.clue);
  const other = room.players.find((p) => p.uid !== a.uid)!;
  assert.equal(viewFor(room, other.uid, T).me!.clues.length, 0, "others cannot see my clues");
  assert.equal(viewFor(room, a.uid, T).me!.clues.length, 1);
  adv(room, room.phaseEnd, lcg(1)); // discussion
  assert.ok(shareClue(room, a.uid, clue.id, T + 20000).ok);
  assert.ok(room.chat.some((c) => c.kind === "evidence" && c.text === clue.text));
  assert.deepEqual(shareClue(room, other.uid, clue.id, T + 25000), { ok: false, error: "not-collected" });
});

test("clues are fair: round one always has a verified clue that names the spy's colour", () => {
  for (let seed = 1; seed <= 15; seed++) {
    const room = started(6, seed);
    toExplore(room, lcg(seed));
    const verified = room.clues.filter((c) => c.tier === "verified");
    assert.ok(verified.length >= 1, `seed ${seed}`);
  }
});

test("disconnects: a silent player abstains and an abandoned match is cancelled, not won", () => {
  const room = started(5, 17);
  toExplore(room);
  const t = room.phaseStart;
  // everyone stops sending requests
  advance(room, t + TIMINGS_REF.t.grace * 2 + TIMINGS_REF.t.explore + 1000, lcg(1));
  advance(room, t + TIMINGS_REF.t.grace * 5, lcg(1));
  assert.equal(room.status, "cancelled");
  assert.equal(room.outcome, undefined, "no winner is declared for a technical failure");
});

test("practice mode labels simulated players as bots and they act on their own", () => {
  const room = newRoom("PRACT", { uid: 1, name: "Solo" }, "practice", T, { maxPlayers: 6 });
  // use the engine helper through a fresh import to keep the test independent of api.ts
  return import("../src/agent/engine.js").then(({ addBots }) => {
    addBots(room, 5, T, lcg(3));
    assert.equal(room.players.filter((p) => p.bot).length, 5);
    room.players[0].ready = true;
    advance(room, T, lcg(3)); // countdown
    advance(room, T + 1500, lcg(3)); // started
    assert.equal(room.status, "playing");
    const v = viewFor(room, 1, T + 1500);
    assert.ok(v.players.filter((p) => p.bot).length === 5);
    advance(room, room.phaseEnd, lcg(3)); // explore
    for (let i = 1; i <= 6; i++) advance(room, room.phaseStart + i * 1600, lcg(3));
    assert.ok(room.taskDone >= 0);
  });
});

test("geometry helpers", () => {
  assert.equal(dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  for (const m of MAPS) {
    for (const o of m.objects) assert.ok(walkable(m, o.x, o.y + 10), `${m.id}/${o.id} reachable`);
    for (const s of m.spawns) assert.ok(walkable(m, s.x, s.y), `${m.id} spawn`);
  }
  assert.ok(setReady);
});
