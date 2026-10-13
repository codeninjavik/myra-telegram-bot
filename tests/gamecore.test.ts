import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BANKS, rpsNew, rpsPick, rpsRoundWinner, tttMove, tttNew, tttWinner, wordAnswer, wordNew, wordQuestion, type RpsState, type TttState,
} from "../src/gamecore.js";

const seq = (...ns: number[]) => {
  let i = 0;
  return () => ns[i++ % ns.length];
};

// ---- Tic-Tac-Toe
function play(moves: [("a" | "b"), number][]) {
  let s: TttState = tttNew("a");
  let result: any = null;
  for (const [side, cell] of moves) {
    const r = tttMove(s, side, cell);
    assert.ok(r.ok, `move ${side}${cell} should be ok`);
    if (r.ok) (s = r.state), (result = r.result);
  }
  return { s, result };
}

test("ttt: row win is detected for the challenger", () => {
  const { result } = play([["a", 0], ["b", 3], ["a", 1], ["b", 4], ["a", 2]]);
  assert.equal(result, "a");
});

test("ttt: diagonal win for the opponent", () => {
  const { result } = play([["a", 1], ["b", 0], ["a", 2], ["b", 4], ["a", 3], ["b", 8]]);
  assert.equal(result, "b");
});

test("ttt: full board without a line is a draw", () => {
  const { result, s } = play([["a", 0], ["b", 1], ["a", 2], ["b", 4], ["a", 3], ["b", 5], ["a", 7], ["b", 6], ["a", 8]]);
  assert.equal(result, "draw");
  assert.equal(tttWinner(s.board), null);
});

test("ttt: occupied cell, wrong turn, bad cell and finished game are rejected", () => {
  const s0 = tttNew("a");
  const r1 = tttMove(s0, "a", 4);
  assert.ok(r1.ok);
  assert.deepEqual(tttMove(r1.ok ? r1.state : s0, "b", 4), { ok: false, reason: "occupied" });
  assert.deepEqual(tttMove(r1.ok ? r1.state : s0, "a", 5), { ok: false, reason: "not-your-turn" });
  assert.deepEqual(tttMove(s0, "a", 9), { ok: false, reason: "bad-cell" });
  assert.deepEqual(tttMove(s0, "a", -1), { ok: false, reason: "bad-cell" });
  assert.deepEqual(tttMove(s0, "a", 1.5), { ok: false, reason: "bad-cell" });
  const won = play([["a", 0], ["b", 3], ["a", 1], ["b", 4], ["a", 2]]).s;
  assert.deepEqual(tttMove(won, "b", 8), { ok: false, reason: "finished" });
});

test("ttt: a move never mutates the previous state (replayed callbacks are harmless)", () => {
  const s0 = tttNew("a");
  const snapshot = JSON.stringify(s0);
  tttMove(s0, "a", 0);
  assert.equal(JSON.stringify(s0), snapshot);
});

// ---- Rock-Paper-Scissors
test("rps: round winner matrix", () => {
  assert.equal(rpsRoundWinner("rock", "scissors"), "a");
  assert.equal(rpsRoundWinner("scissors", "rock"), "b");
  assert.equal(rpsRoundWinner("paper", "rock"), "a");
  assert.equal(rpsRoundWinner("rock", "rock"), "tie");
});

test("rps: first pick stays hidden, second pick resolves the round", () => {
  const s0 = rpsNew(3);
  const r1 = rpsPick(s0, "a", "rock");
  assert.ok(r1.ok && !r1.revealed);
  const r2 = rpsPick((r1 as any).state, "b", "scissors");
  assert.ok(r2.ok && r2.revealed);
  assert.deepEqual((r2 as any).state.score, { a: 1, b: 0 });
  assert.deepEqual((r2 as any).state.picks, {});
});

test("rps: a locked pick cannot be changed and bad choices are rejected", () => {
  const r1 = rpsPick(rpsNew(3), "a", "rock") as any;
  assert.deepEqual(rpsPick(r1.state, "a", "paper"), { ok: false, reason: "already-picked" });
  assert.deepEqual(rpsPick(rpsNew(3), "a", "lizard"), { ok: false, reason: "bad-choice" });
});

function round(s: RpsState, a: string, b: string) {
  const x: any = rpsPick(s, "a", a);
  const y: any = rpsPick(x.state, "b", b);
  return y;
}

test("rps: best of 3 ends when someone reaches 2 wins", () => {
  let r = round(rpsNew(3), "rock", "scissors");
  assert.equal(r.outcome.done, false);
  r = round(r.state, "paper", "rock");
  assert.deepEqual(r.outcome, { done: true, winner: "a" });
  assert.deepEqual(rpsPick(r.state, "a", "rock"), { ok: false, reason: "finished" });
});

test("rps: best of 5 needs 3 wins", () => {
  let r: any = round(rpsNew(5), "rock", "scissors");
  r = round(r.state, "rock", "paper");
  r = round(r.state, "rock", "scissors");
  assert.equal(r.outcome.done, false);
  r = round(r.state, "scissors", "rock");
  r = round(r.state, "paper", "rock");
  assert.equal(r.outcome.done, true);
  assert.equal(r.outcome.winner, "a");
});

test("rps: ties are replayed but the match always ends (draw after the round cap)", () => {
  let r: any = { state: rpsNew(3) };
  for (let i = 0; i < 6; i++) r = round(r.state, "rock", "rock");
  assert.deepEqual(r.outcome, { done: true, winner: "draw" });
});

// ---- Word Battle
test("word: every question has 4 distinct options and a valid answer index", () => {
  for (const mode of ["vocab", "scramble", "guess"] as const) {
    for (const diff of ["easy", "medium", "hard"] as const) {
      for (let i = 0; i < 20; i++) {
        const q = wordQuestion(mode, diff, []);
        assert.equal(q.options.length, 4);
        assert.equal(new Set(q.options).size, 4);
        assert.ok(q.answer >= 0 && q.answer < 4);
      }
    }
  }
});

test("word: scramble is a permutation and never equals the word", () => {
  for (let i = 0; i < 40; i++) {
    const q = wordQuestion("scramble", "medium", []);
    const letters = q.prompt.split("\n")[1].replace(/ /g, "").toLowerCase();
    assert.notEqual(letters, q.id);
    assert.equal([...letters].sort().join(""), [...q.id].sort().join(""));
  }
});

test("word: questions do not repeat inside a match", () => {
  const used: string[] = [];
  for (let i = 0; i < BANKS.en.filter((e) => e.d === "easy").length; i++) {
    const q = wordQuestion("vocab", "easy", used);
    assert.ok(!used.includes(q.id));
    used.push(q.id);
  }
});

test("word: correct answer scores and advances; a wrong answer locks only that player", () => {
  const rng = seq(0.1, 0.2, 0.3, 0.4, 0.5);
  const s0 = wordNew("vocab", "easy", 3, 1000, rng);
  const wrong = (s0.q.answer + 1) % 4;
  const w: any = wordAnswer(s0, "a", wrong, 2000, rng);
  assert.ok(w.ok && !w.correct && !w.roundOver);
  assert.deepEqual(wordAnswer(w.state, "a", s0.q.answer, 2100, rng), { ok: false, reason: "already-answered" });
  const c: any = wordAnswer(w.state, "b", s0.q.answer, 2200, rng);
  assert.ok(c.ok && c.correct && c.roundOver);
  assert.deepEqual(c.state.score, { a: 0, b: 1 });
  assert.equal(c.state.round, 2);
  assert.deepEqual(c.state.locked, {});
});

test("word: both wrong ends the round with no point", () => {
  const s0 = wordNew("guess", "easy", 3, 0);
  const wrong = (s0.q.answer + 1) % 4;
  const x: any = wordAnswer(s0, "a", wrong, 1);
  const y: any = wordAnswer(x.state, "b", wrong, 2);
  assert.ok(y.roundOver);
  assert.deepEqual(y.state.score, { a: 0, b: 0 });
  assert.equal(y.state.history[0].winner, "none");
});

test("word: match ends early when the lead cannot be caught, and out-of-range options are rejected", () => {
  let s = wordNew("vocab", "easy", 3, 0);
  assert.deepEqual(wordAnswer(s, "a", 7, 0), { ok: false, reason: "bad-option" });
  for (let i = 0; i < 2; i++) {
    const r: any = wordAnswer(s, "a", s.q.answer, i);
    s = r.state;
    if (i === 1) assert.deepEqual(r.outcome, { done: true, winner: "a" });
  }
});
