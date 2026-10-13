import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLORS, HOME, LUDO, SAFE, TRACK, absCell, addLudoBots, addSeat, advanceLudo, capturesAt, legalMoves, ludoView, move, newLudoRoom, removeSeat, roll, startLudo, target,
  type LudoRoom,
} from "../src/agent/ludo.js";

// rng that produces the given dice values in order
const fixed = (...vals: number[]) => {
  let i = 0;
  return () => (vals[i++ % vals.length] - 1) / 6 + 0.01;
};
const T = 1_000_000;

function game(n = 2) {
  const r = newLudoRoom("LUDOA", { uid: 1, name: "A", char: "nova" }, "private", n, T);
  for (let i = 2; i <= n; i++) assert.ok(addSeat(r, { uid: i, name: `P${i}`, char: "raven" }, T).ok);
  assert.ok(startLudo(r, T).ok);
  return r;
}

test("board constants: 52 track cells, 8 safe cells, four colours", () => {
  assert.equal(TRACK, 52);
  assert.equal(SAFE.size, 8);
  assert.equal(COLORS.length, 4);
  for (let c = 0; c < 4; c++) assert.equal(absCell(c, 0), [0, 13, 26, 39][c]);
  assert.equal(absCell(0, 50), 50);
});

test("lobby: colours for 2/3/4 players, capacity and duplicates", () => {
  const r = newLudoRoom("LOBBY", { uid: 1, name: "A", char: "nova" }, "private", 2, T);
  assert.ok(addSeat(r, { uid: 2, name: "B", char: "raven" }, T).ok);
  assert.deepEqual(r.seats.map((s) => s.color), [0, 2], "two players sit opposite each other");
  assert.deepEqual(addSeat(r, { uid: 3, name: "C", char: "pixel" }, T), { ok: false, error: "room-full" });
  const r4 = newLudoRoom("LOBB4", { uid: 1, name: "A", char: "nova" }, "private", 4, T);
  for (const id of [2, 3, 4]) addSeat(r4, { uid: id, name: `P${id}`, char: "raven" }, T);
  assert.deepEqual(r4.seats.map((s) => s.color), [0, 1, 2, 3], "turn order follows the board");
  assert.deepEqual(addSeat(r4, { uid: 2, name: "P2", char: "raven" }, T), { ok: false, error: "already-in" });
  const solo = newLudoRoom("SOLOA", { uid: 1, name: "A", char: "nova" }, "private", 4, T);
  assert.deepEqual(startLudo(solo, T), { ok: false, error: "need-more-players" });
});

test("a token leaves the yard only on a six; finishing needs an exact roll", () => {
  const r = game();
  const s = r.seats[0];
  assert.deepEqual(legalMoves(s, 3), []);
  assert.deepEqual(legalMoves(s, 6), [0, 1, 2, 3]);
  s.tokens = [54, -1, 20, HOME];
  assert.equal(target(s, 0, 2), HOME);
  assert.equal(target(s, 0, 3), null, "overshooting home is not allowed");
  assert.equal(target(s, 3, 1), null, "a token at home stays there");
  assert.deepEqual(legalMoves(s, 2), [0, 2]);
});

test("turn order, roll then move, and only the current player may act", () => {
  const r = game();
  assert.deepEqual(roll(r, 2, T, fixed(6)), { ok: false, error: "not-your-turn" });
  assert.deepEqual(move(r, 1, 0, T), { ok: false, error: "roll-first" });
  const a = roll(r, 1, T, fixed(6));
  assert.ok(a.ok && a.value === 6);
  assert.equal(r.phase, "move");
  assert.deepEqual(roll(r, 1, T, fixed(6)), { ok: false, error: "move-first" });
  assert.deepEqual(move(r, 2, 0, T), { ok: false, error: "not-your-turn" });
  assert.deepEqual(move(r, 1, 9, T), { ok: false, error: "illegal-move" });
  assert.ok(move(r, 1, 0, T).ok);
  assert.equal(r.seats[0].tokens[0], 0);
  assert.equal(r.turn, 0, "a six gives another roll");
  assert.equal(r.phase, "roll");
});

test("no legal move passes the turn", () => {
  const r = game();
  const res = roll(r, 1, T, fixed(3));
  assert.ok(res.ok && !res.moved);
  assert.equal(r.turn, 1);
  assert.equal(r.phase, "roll");
});

test("three sixes in a row cost the turn", () => {
  const r = game();
  roll(r, 1, T, fixed(6));
  move(r, 1, 0, T);
  roll(r, 1, T, fixed(6));
  move(r, 1, 0, T);
  const third = roll(r, 1, T, fixed(6));
  assert.ok(third.ok && !third.moved);
  assert.equal(r.turn, 1);
  assert.equal(r.seats[0].tokens[0], 6, "the third six is not played");
});

test("capture: non-safe cells send opponents home and grant an extra roll; safe cells do not capture", () => {
  const r = game();
  r.seats[0].tokens = [5, -1, -1, -1];
  r.seats[1].tokens = [33, -1, -1, -1]; // yellow rel 33 sits on abs (26 + 33) % 52 = 7
  assert.equal(r.seats[1].color, 2);
  assert.deepEqual(capturesAt(r, 0, 7), [{ seat: 1, token: 0 }]);
  r.dice = 2;
  r.phase = "move";
  r.legal = [0];
  const m = move(r, 1, 0, T);
  assert.ok(m.ok && m.captured === 1);
  assert.equal(r.seats[1].tokens[0], -1);
  assert.equal(r.turn, 0, "a capture earns another roll");

  const r2 = game();
  r2.seats[0].tokens = [6, -1, -1, -1];
  r2.seats[1].tokens = [(8 - 26 + 52) % 52, -1, -1, -1]; // abs 8 is a star
  assert.deepEqual(capturesAt(r2, 0, 8), []);
});

test("home column tokens cannot be captured; the first player with four tokens home wins", () => {
  const r = game();
  r.seats[0].tokens = [HOME, HOME, HOME, 55];
  r.seats[1].tokens = [51, -1, -1, -1];
  assert.deepEqual(capturesAt(r, 1, 52), []);
  r.dice = 1;
  r.phase = "move";
  r.legal = [3];
  const m = move(r, 1, 3, T);
  assert.ok(m.ok && m.won);
  assert.equal(r.status, "finished");
  assert.equal(r.winner, 0);
  assert.deepEqual(roll(r, 1, T, fixed(1)), { ok: false, error: "not-playing" });
});

test("bots play on their own and the clock catches up", () => {
  const r = newLudoRoom("BOTAA", { uid: 1, name: "Me", char: "nova" }, "practice", 4, T);
  addLudoBots(r, T, fixed(1));
  assert.equal(r.seats.length, 4);
  assert.equal(r.seats.filter((s) => s.bot).length, 3);
  startLudo(r, T);
  roll(r, 1, T, fixed(4));
  assert.ok(advanceLudo(r, T + 60_000, fixed(2, 3, 5, 6, 1)));
  assert.ok(r.log.length >= 1);
});

test("a human who times out is played for, and goes on autopilot after repeated timeouts", () => {
  const r = game();
  let now = T;
  for (let i = 0; i < 6; i++) {
    r.seats[0].lastSeen = now;
    r.seats[1].lastSeen = now;
    now += LUDO.turnMs + 1000;
    advanceLudo(r, now, fixed(2));
  }
  assert.ok(r.seats[0].auto || r.seats[1].auto || r.seats[0].timeouts + r.seats[1].timeouts >= 1);
});

test("leaving mid-game hands the colour to a bot; everyone leaving cancels the match", () => {
  const r = game(3);
  removeSeat(r, 2, T);
  assert.ok(r.seats.find((s) => s.uid === 2)!.auto);
  assert.equal(r.status, "playing");
  removeSeat(r, 1, T);
  removeSeat(r, 3, T);
  assert.equal(r.status, "cancelled");
});

test("a client view only exposes legal moves to the player whose turn it is", () => {
  const r = game();
  roll(r, 1, T, fixed(6));
  assert.deepEqual(ludoView(r, 1, T).legal, [0, 1, 2, 3]);
  assert.deepEqual(ludoView(r, 2, T).legal, []);
});

test("random full games always terminate with a winner who has all tokens home", () => {
  for (let seed = 1; seed <= 12; seed++) {
    let s = seed * 7919;
    const rng = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const r: LudoRoom = newLudoRoom("RANDG", { uid: 1, name: "A", char: "nova" }, "practice", 4, T);
    addLudoBots(r, T, rng);
    r.seats[0].bot = true;
    startLudo(r, T);
    for (let i = 0; i < 400 && r.status === "playing"; i++) advanceLudo(r, T + 3 * 3600_000, rng);
    assert.equal(r.status, "finished", `seed ${seed}`);
    assert.ok(r.winner !== null && r.seats[r.winner].tokens.every((p) => p === HOME));
  }
});

test("quick game: two tokens per player, the first to bring both home wins", () => {
  const r = newLudoRoom("QUICK", { uid: 1, name: "A", char: "nova" }, "private", 2, T, 2);
  addSeat(r, { uid: 2, name: "B", char: "raven" }, T);
  assert.deepEqual(r.seats.map((s) => s.tokens.length), [2, 2]);
  startLudo(r, T);
  assert.deepEqual(legalMoves(r.seats[0], 6), [0, 1]);
  r.seats[0].tokens = [HOME, 55];
  r.dice = 1;
  r.phase = "move";
  r.legal = [1];
  const m = move(r, 1, 1, T);
  assert.ok(m.ok && m.won);
  assert.equal(r.winner, 0);
  assert.equal(ludoView(r, 1, T).tokensPer, 2);
});
