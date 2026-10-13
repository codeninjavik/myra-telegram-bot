process.env.MYRA_MEM_STORE = "1";
process.env.OWNER_ID = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGE_TTL_MS, IDLE_TTL_MS, applyExpiry, buyWithPoints, claimDaily, createChallenge, createOrder, ensurePlayer, fulfilPayment, getMatch,
  getPayment, getPlayer, history, markRefunded, movePoints, reconcile, settle, startState, topPlayers, updateMatch, type Match,
} from "../src/gamesvc.js";
import { casUpdate, createOnce, getJSON } from "../src/store.js";

let n = 1000;
const uid = () => ++n;
const user = (id: number, extra: Record<string, unknown> = {}) => ({ id, first_name: `U${id}`, ...extra });

// ---- store primitives
test("store: createOnce is exactly-once under concurrency", async () => {
  const results = await Promise.all(Array.from({ length: 25 }, () => createOnce("t/once", { x: 1 })));
  assert.equal(results.filter(Boolean).length, 1);
});

test("store: casUpdate loses no increments under concurrency", async () => {
  await Promise.all(Array.from({ length: 40 }, () => casUpdate<{ n: number }>("t/counter", async (c) => {
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    return { n: (c?.n ?? 0) + 1 };
  })));
  assert.equal((await getJSON<{ n: number }>("t/counter"))!.n, 40);
});

// ---- identity
test("profile: keyed by Telegram id, username change keeps the same account", async () => {
  const id = uid();
  const a = await ensurePlayer(user(id, { username: "old_name" }));
  const b = await ensurePlayer(user(id, { username: "new_name", first_name: "Renamed" }));
  assert.equal(a.id, id);
  assert.equal(b.id, id);
  assert.equal(b.username, "new_name");
  assert.equal(b.name, "Renamed");
  assert.equal(b.created, a.created);
  assert.equal((await getPlayer(id))!.rating, 1000);
});

// ---- ledger
test("ledger: same idempotency key credits once, sequentially and concurrently", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  const first = await movePoints(id, 50, "credit", "daily", "k1");
  const dup = await movePoints(id, 50, "credit", "daily", "k1");
  assert.ok(first.applied && !dup.applied);
  const burst = await Promise.all(Array.from({ length: 20 }, () => movePoints(id, 7, "credit", "win", "burst")));
  assert.equal(burst.filter((r) => r.applied).length, 1);
  assert.equal((await getPlayer(id))!.points, 57);
  assert.deepEqual(await reconcile(id), { balance: 57, ledger: 57, ok: true });
});

test("ledger: concurrent distinct credits all land", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  await Promise.all(Array.from({ length: 30 }, (_, i) => movePoints(id, 2, "credit", "win", `c${i}`)));
  assert.equal((await getPlayer(id))!.points, 60);
  assert.ok((await reconcile(id)).ok);
});

test("ledger: balance never goes negative, even with concurrent debits", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  await movePoints(id, 100, "credit", "daily", "seed");
  const res = await Promise.all(Array.from({ length: 10 }, (_, i) => movePoints(id, 30, "debit", "purchase", `d${i}`)));
  assert.equal(res.filter((r) => r.ok).length, 3);
  const p = await getPlayer(id);
  assert.equal(p!.points, 10);
  assert.ok(res.filter((r) => !r.ok).every((r) => r.reason === "insufficient"));
  assert.ok((await reconcile(id)).ok);
});

test("ledger: a rejected debit can be retried later with the same key", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  assert.equal((await movePoints(id, 10, "debit", "purchase", "retry")).reason, "insufficient");
  await movePoints(id, 20, "credit", "daily", "fund");
  assert.ok((await movePoints(id, 10, "debit", "purchase", "retry")).ok);
});

test("ledger: invalid amounts and unknown players are refused", async () => {
  const id = uid();
  assert.equal((await movePoints(id, 5, "credit", "x", "nope")).reason, "no-player");
  await ensurePlayer(user(id));
  assert.equal((await movePoints(id, -5, "credit", "x", "neg")).reason, "bad-amount");
  assert.equal((await movePoints(id, 1.5, "credit", "x", "frac")).reason, "bad-amount");
});

test("ledger: an interrupted attempt (pending entry) is completed by a retry without double credit", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  // Simulate a crash after the balance changed but before the entry was marked completed.
  await createOnce(`gl/${id}/crash`, { id: `${id}:crash`, uid: id, type: "win", amount: 20, unit: "points", dir: "credit", status: "pending", idem: "crash", createdAt: Date.now() });
  await casUpdate<any>(`gp/${id}`, (p) => ({ ...p, points: p.points + 20, applied: [...p.applied, "crash"] }));
  const r = await movePoints(id, 20, "credit", "win", "crash");
  assert.equal(r.balance, 20);
  assert.ok((await reconcile(id)).ok);
});

test("daily bonus: once per day", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  const a = await claimDaily(id);
  const b = await claimDaily(id);
  assert.ok(a.ok);
  assert.ok(!b.ok);
  assert.equal(b.balance, a.balance);
});

// ---- matches and settlement
async function finishedMatch(a: number, b: number, winner: number | "draw", game: "ttt" | "rps" | "word" = "ttt") {
  const pa = await ensurePlayer(user(a));
  await ensurePlayer(user(b));
  const m = await createChallenge({ game, kind: "group", chat: -100, a: pa, target: { id: b, name: `U${b}` }, opts: {} });
  return (await updateMatch(m.id, (c) => ({ ...c, b, bn: `U${b}`, status: "done", winner, state: startState(c) })))!;
}

test("settle: stats and points are applied exactly once even when called concurrently", async () => {
  const a = uid(), b = uid();
  const m = await finishedMatch(a, b, a);
  const rs = await Promise.all([settle(m), settle(m), settle(m)]);
  assert.equal(rs.filter(Boolean).length, 1);
  const pa = (await getPlayer(a))!, pb = (await getPlayer(b))!;
  assert.equal(pa.wins, 1);
  assert.equal(pb.losses, 1);
  assert.equal(pa.matches, 1);
  assert.equal(pa.points, 20);
  assert.equal(pb.points, 3);
  assert.ok(pa.rating > 1000 && pb.rating < 1000);
  assert.ok(pa.badges.includes("first-win"));
  assert.ok((await reconcile(a)).ok);
});

test("settle: draw updates both players and abandoned matches are never settled", async () => {
  const a = uid(), b = uid();
  const m = await finishedMatch(a, b, "draw");
  await settle(m);
  assert.equal((await getPlayer(a))!.draws, 1);
  assert.equal((await getPlayer(b))!.draws, 1);
  const c = uid(), d = uid();
  const x = await finishedMatch(c, d, c);
  assert.equal(await settle({ ...x, status: "abandoned" }), null);
  assert.equal((await getPlayer(c))!.matches, 0);
});

test("anti-farming: the same pair earns points for a limited number of matches per day", async () => {
  const a = uid(), b = uid();
  let rewarded = 0;
  for (let i = 0; i < 7; i++) {
    const m = await finishedMatch(a, b, a);
    const r = await settle(m);
    if (r && r.rewards[a]) rewarded++;
  }
  assert.equal(rewarded, 4); // maxPerPairPerDay
  assert.equal((await getPlayer(a))!.wins, 7); // stats still count
});

test("leaderboard: ordered by rating and only players with matches", async () => {
  const a = uid(), b = uid(), idle = uid();
  await ensurePlayer(user(idle));
  await settle(await finishedMatch(a, b, a));
  const top = await topPlayers(100);
  const ia = top.findIndex((p) => p.id === a), ib = top.findIndex((p) => p.id === b);
  assert.ok(ia >= 0 && ib >= 0 && ia < ib);
  assert.ok(!top.some((p) => p.id === idle));
});

test("expiry: pending challenge, tic-tac-toe idle loser, rps one-sided pick, abandoned", async () => {
  const a = uid(), b = uid();
  const pa = await ensurePlayer(user(a));
  const base = await createChallenge({ game: "ttt", kind: "group", chat: 1, a: pa, opts: {} });
  const p: Match = { ...base };
  assert.ok(applyExpiry(p, base.created + CHALLENGE_TTL_MS + 1));
  assert.equal(p.status, "expired");

  const active = (g: any, state: any): Match => ({ ...base, game: g, b, bn: "B", status: "active", state, lastAt: 0 });
  const t = active("ttt", { board: Array(9).fill(null), turn: "b" });
  assert.ok(applyExpiry(t, IDLE_TTL_MS + 1));
  assert.deepEqual([t.status, t.winner], ["done", a]); // b ran out of time, a wins

  const r = active("rps", { bestOf: 3, round: 1, picks: { a: "rock" }, score: { a: 0, b: 0 }, history: [] });
  assert.ok(applyExpiry(r, IDLE_TTL_MS + 1));
  assert.deepEqual([r.status, r.winner], ["done", a]);

  const r2 = active("rps", { bestOf: 3, round: 1, picks: {}, score: { a: 0, b: 0 }, history: [] });
  applyExpiry(r2, IDLE_TTL_MS + 1);
  assert.equal(r2.status, "abandoned");

  const fresh = active("ttt", { board: Array(9).fill(null), turn: "a" });
  fresh.lastAt = 5000;
  assert.equal(applyExpiry(fresh, 5000 + IDLE_TTL_MS - 1), false);
});

test("concurrent moves on one match are serialised: every update is applied once", async () => {
  const a = uid(), b = uid();
  const pa = await ensurePlayer(user(a));
  const m = await createChallenge({ game: "ttt", kind: "group", chat: 1, a: pa, opts: {} });
  await Promise.all(Array.from({ length: 15 }, () => updateMatch(m.id, (c) => ({ ...c, lastAt: c.lastAt + 1 }))));
  const got = (await getMatch(m.id))!;
  assert.equal(got.seq, 15);
  assert.equal(got.lastAt, m.lastAt + 15);
  void b;
});

// ---- Stars purchases
test("stars: payment is credited once per charge id, however often Telegram redelivers it", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  const order = (await createOrder(id, "badge_vip"))!;
  const pay = { uid: id, payload: `ord:${order.id}`, chargeId: `ch_${id}`, amount: 50, currency: "XTR" };
  const rs = await Promise.all([fulfilPayment(pay), fulfilPayment(pay), fulfilPayment(pay)]);
  assert.equal(rs.filter((r) => r.ok && !r.duplicate).length, 1);
  const p = (await getPlayer(id))!;
  assert.deepEqual(p.items, ["badge_vip"]);
  assert.equal((await getJSON<any>(`go/${order.id}`)).status, "paid");
  assert.equal((await getPayment(`ch_${id}`))!.status, "fulfilled");
  const led = (await history(id)).filter((e) => e.unit === "XTR");
  assert.equal(led.length, 1); // Stars are tracked in their own unit, never mixed into game points
  assert.equal((await getPlayer(id))!.points, 0);
});

test("stars: mismatching amount, other user's order or unknown payload grant nothing", async () => {
  const id = uid(), other = uid();
  await ensurePlayer(user(id));
  await ensurePlayer(user(other));
  const order = (await createOrder(id, "theme_neon"))!;
  assert.equal((await fulfilPayment({ uid: id, payload: `ord:${order.id}`, chargeId: `bad1_${id}`, amount: 1, currency: "XTR" })).ok, false);
  assert.equal((await fulfilPayment({ uid: other, payload: `ord:${order.id}`, chargeId: `bad2_${id}`, amount: 25, currency: "XTR" })).ok, false);
  assert.equal((await fulfilPayment({ uid: id, payload: "hello", chargeId: `bad3_${id}`, amount: 25, currency: "XTR" })).ok, false);
  assert.equal((await fulfilPayment({ uid: id, payload: `ord:${order.id}`, chargeId: `bad4_${id}`, amount: 25, currency: "USD" })).ok, false);
  assert.deepEqual((await getPlayer(id))!.items, []);
});

test("stars: refund revokes the item once and is recorded in the ledger", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  const order = (await createOrder(id, "theme_royal"))!;
  await fulfilPayment({ uid: id, payload: `ord:${order.id}`, chargeId: `rf_${id}`, amount: 25, currency: "XTR" });
  assert.deepEqual((await getPlayer(id))!.items, ["theme_royal"]);
  assert.equal((await getPlayer(id))!.theme, "theme_royal");
  assert.ok((await markRefunded(`rf_${id}`)).ok);
  assert.equal((await markRefunded(`rf_${id}`)).reason, "already-refunded");
  const p = (await getPlayer(id))!;
  assert.deepEqual(p.items, []);
  assert.equal(p.theme, "default");
  assert.ok((await history(id)).some((e) => e.type === "refund" && e.unit === "XTR"));
});

test("points shop: buying with points debits the ledger once and rejects when too poor", async () => {
  const id = uid();
  await ensurePlayer(user(id));
  assert.equal((await buyWithPoints(id, "theme_neon")).reason, "insufficient");
  await movePoints(id, 500, "credit", "daily", "rich");
  const r = await buyWithPoints(id, "theme_neon");
  assert.ok(r.ok);
  assert.equal(r.balance, 100);
  assert.equal((await buyWithPoints(id, "theme_neon")).reason, "owned");
  assert.equal((await buyWithPoints(id, "badge_vip")).reason, "not-for-points"); // Stars-only item
  assert.ok((await reconcile(id)).ok);
});
