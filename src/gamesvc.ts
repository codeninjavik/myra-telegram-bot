import { casUpdate, createOnce, delKey, getJSON, getMany, listKeys, setJSON } from "./store.js";
import { other, rpsNew, tttNew, wordNew, type Difficulty, type RpsState, type Side, type TttState, type WordMode, type WordState } from "./gamecore.js";

// Storage and accounting for the game system, on top of Netlify Blobs. Blobs have no SQL transactions, so the
// guarantees come from two primitives in store.ts: createOnce (idempotency keys) and casUpdate (ETag compare-and-swap).

export type GameId = "ttt" | "rps" | "word";
export const GAMES: Record<GameId, { icon: string; name: string }> = {
  ttt: { icon: "⭕", name: "Tic-Tac-Toe" },
  rps: { icon: "✊", name: "Rock-Paper-Scissors" },
  word: { icon: "🔤", name: "Word Battle" },
};

// ---------------------------------------------------------------- configuration
export type GameConfig = {
  disabled: GameId[]; // games switched off for maintenance
  winPoints: number;
  drawPoints: number;
  lossPoints: number;
  dailyBonus: number;
  maxRewardedPerDay: number; // rewarded matches per player per day
  maxPerPairPerDay: number; // rewarded matches between the same two players per day
  realMoney: false; // compliance gate: cash features stay off until the owner confirms the legal review
};
export const DEFAULT_CFG: GameConfig = {
  disabled: [], winPoints: 20, drawPoints: 8, lossPoints: 3, dailyBonus: 50, maxRewardedPerDay: 15, maxPerPairPerDay: 4, realMoney: false,
};
export async function getConfig(): Promise<GameConfig> {
  return { ...DEFAULT_CFG, ...((await getJSON<Partial<GameConfig>>("gcfg")) ?? {}), realMoney: false };
}

export const CHALLENGE_TTL_MS = 10 * 60_000;
export const IDLE_TTL_MS = 10 * 60_000;
export const dayKey = (t = Date.now()) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10); // IST day

// ---------------------------------------------------------------- products (Telegram Stars)
export type Product = { id: string; title: string; desc: string; stars: number; points?: number; kind: "theme" | "badge" | "stats" };
export const PRODUCTS: Product[] = [
  { id: "theme_neon", title: "Neon board theme", desc: "🔥 vs 💧 pieces in Tic-Tac-Toe", stars: 25, points: 400, kind: "theme" },
  { id: "theme_royal", title: "Royal board theme", desc: "👑 vs 💎 pieces in Tic-Tac-Toe", stars: 25, points: 400, kind: "theme" },
  { id: "badge_vip", title: "VIP badge", desc: "💎 next to your name on profile and leaderboard", stars: 50, kind: "badge" },
  { id: "stats_pro", title: "Pro statistics", desc: "Per-game breakdown and recent match details on /profile", stars: 40, kind: "stats" },
];
export const product = (id: string) => PRODUCTS.find((p) => p.id === id);
export const THEMES: Record<string, [string, string]> = { default: ["❌", "⭕"], theme_neon: ["🔥", "💧"], theme_royal: ["👑", "💎"] };

// ---------------------------------------------------------------- players
export type GameStat = { w: number; l: number; d: number };
export type Player = {
  id: number; // Telegram user id: the canonical key (usernames change)
  username?: string;
  name: string;
  lang: string;
  status: "active" | "banned";
  created: number;
  last: number;
  wins: number; losses: number; draws: number; matches: number;
  streak: number; best: number; rating: number;
  points: number; // non-cash game points, always equal to the sum of completed point-ledger entries
  applied: string[]; // last idempotency keys applied to `points` (crash-safe retries)
  badges: string[];
  items: string[]; // owned product ids
  theme: string;
  notify: boolean;
  dm: boolean; // started the bot privately (needed to receive DMs)
  g: Record<GameId, GameStat>;
  daily?: string; // last day the daily bonus was claimed
};
const newPlayer = (id: number, name: string, username?: string, lang = "en"): Player => ({
  id, username, name, lang, status: "active", created: Date.now(), last: Date.now(),
  wins: 0, losses: 0, draws: 0, matches: 0, streak: 0, best: 0, rating: 1000,
  points: 0, applied: [], badges: [], items: [], theme: "default", notify: true, dm: false,
  g: { ttt: { w: 0, l: 0, d: 0 }, rps: { w: 0, l: 0, d: 0 }, word: { w: 0, l: 0, d: 0 } },
});
const pKey = (id: number) => `gp/${id}`;

export async function getPlayer(id: number): Promise<Player | null> {
  return getJSON<Player>(pKey(id));
}

/** Creates the profile on first contact and refreshes name/username. Returns the stored profile. */
export async function ensurePlayer(u: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string }, opts: { dm?: boolean } = {}): Promise<Player> {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.username || String(u.id);
  const p = await casUpdate<Player>(pKey(u.id), (cur) => {
    const p = cur ?? newPlayer(u.id, name, u.username, (u.language_code ?? "en").slice(0, 2));
    p.name = name;
    p.username = u.username;
    p.last = Date.now();
    if (opts.dm) p.dm = true;
    return p;
  });
  return p!;
}

// ---------------------------------------------------------------- ledger (game points)
export type LedgerEntry = {
  id: string;
  uid: number;
  type: string; // win, draw, loss, daily, purchase, admin, refund, ...
  amount: number;
  unit: "points" | "XTR";
  dir: "credit" | "debit";
  status: "pending" | "completed" | "failed" | "reversed" | "refunded";
  matchId?: string;
  provider?: string;
  providerRef?: string;
  idem: string;
  createdAt: number;
  completedAt?: number;
  meta?: Record<string, unknown>;
};
const lKey = (uid: number, idem: string) => `gl/${uid}/${idem}`;

export type PointsResult = { ok: boolean; applied: boolean; balance: number; reason?: "insufficient" | "no-player" | "bad-amount" | "duplicate" };

/**
 * Moves game points. Exactly-once per idempotency key, even under retries and concurrent callers:
 *  1. the ledger entry is created with createOnce (the key IS the uniqueness constraint),
 *  2. the balance is changed in one compare-and-swap that also records the key on the player, so a retry after a
 *     crash sees the key and does not apply twice,
 *  3. the entry is marked completed.
 */
export async function movePoints(
  uid: number, amount: number, dir: "credit" | "debit", type: string, idem: string,
  extra: { matchId?: string; meta?: Record<string, unknown> } = {},
): Promise<PointsResult> {
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, applied: false, balance: 0, reason: "bad-amount" };
  const key = lKey(uid, idem);
  const entry: LedgerEntry = {
    id: `${uid}:${idem}`, uid, type, amount, unit: "points", dir, status: "pending", idem, createdAt: Date.now(), ...extra,
  };
  const fresh = await createOnce(key, entry);
  if (!fresh) {
    const old = await getJSON<LedgerEntry>(key);
    if (old && old.status !== "pending") {
      const p = await getPlayer(uid);
      return { ok: old.status === "completed", applied: false, balance: p?.points ?? 0, reason: "duplicate" };
    }
    // pending: a previous attempt died midway; fall through and finish it (the applied-keys guard keeps it exactly-once)
  }

  let insufficient = false;
  let missing = false;
  let didApply = false;
  const p = await casUpdate<Player>(pKey(uid), (cur) => {
    insufficient = false;
    missing = false;
    didApply = false;
    if (!cur) {
      missing = true;
      return undefined;
    }
    if (cur.applied.includes(idem)) return undefined; // already applied by an earlier attempt
    if (dir === "debit" && cur.points < amount) {
      insufficient = true;
      return undefined;
    }
    cur.points += dir === "credit" ? amount : -amount;
    cur.applied = [...cur.applied, idem].slice(-60);
    didApply = true;
    return cur;
  });
  if (missing || insufficient) {
    // A rejected movement is not a ledger line: drop the placeholder so the same key can be retried later.
    await delKey(key);
    return { ok: false, applied: false, balance: p?.points ?? 0, reason: missing ? "no-player" : "insufficient" };
  }
  await setJSON(key, { ...entry, status: "completed", completedAt: Date.now() } satisfies LedgerEntry);
  // applied is true only for the one call whose compare-and-swap really changed the balance
  return { ok: true, applied: didApply, balance: p!.points };
}

export async function history(uid: number, limit = 15): Promise<LedgerEntry[]> {
  const rows = await getMany<LedgerEntry>(await listKeys(`gl/${uid}/`));
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** Recomputes a balance from the ledger. With fix=true a mismatch is corrected (and audited by the caller). */
export async function reconcile(uid: number, fix = false): Promise<{ balance: number; ledger: number; ok: boolean }> {
  const rows = (await getMany<LedgerEntry>(await listKeys(`gl/${uid}/`))).filter((e) => e.unit === "points" && e.status === "completed");
  const ledger = rows.reduce((s, e) => s + (e.dir === "credit" ? e.amount : -e.amount), 0);
  const p = await getPlayer(uid);
  const balance = p?.points ?? 0;
  if (fix && p && balance !== ledger) await casUpdate<Player>(pKey(uid), (c) => (c ? { ...c, points: ledger } : undefined));
  return { balance, ledger, ok: balance === ledger };
}

// ---------------------------------------------------------------- audit log
export async function audit(actor: number, action: string, targetType: string, targetId: string | number, metadata: Record<string, unknown> = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await createOnce(`ga/${id}`, { id, actor, action, targetType, targetId: String(targetId), metadata, at: Date.now() });
}
export async function recentAudit(limit = 15) {
  const keys = (await listKeys("ga/")).sort().slice(-limit);
  return (await getMany<{ id: string; actor: number; action: string; targetType: string; targetId: string; metadata: unknown; at: number }>(keys)).sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------- matches
export type MatchStatus = "pending" | "active" | "done" | "declined" | "cancelled" | "expired" | "abandoned";
export type View = { chat: number; msg: number };
export type MatchOpts = { bestOf?: 3 | 5; mode?: WordMode; diff?: Difficulty; rounds?: number };
export type Match = {
  id: string;
  game: GameId;
  kind: "private" | "group";
  chat: number;
  a: number; an: string;
  b: number | null; bn: string; // b set at accept time (or at creation for a targeted challenge)
  target: boolean; // only `b` may accept
  status: MatchStatus;
  opts: MatchOpts;
  state: TttState | RpsState | WordState | null;
  winner: number | "draw" | null;
  how?: "normal" | "timeout" | "resign";
  views: View[];
  created: number;
  lastAt: number;
  expires: number;
  seq: number;
  settled: boolean;
  rewards?: Record<string, number>; // points granted at settlement, by user id
  rematchOf?: string;
};
const mKey = (id: string) => `gm/${id}`;
export const newId = () => Math.random().toString(36).slice(2, 10);

export async function getMatch(id: string) {
  return getJSON<Match>(mKey(id));
}

export async function createChallenge(p: {
  game: GameId; kind: "private" | "group"; chat: number; a: Player; target?: { id: number; name: string } | null; opts: MatchOpts; rematchOf?: string;
}): Promise<Match> {
  const now = Date.now();
  const m: Match = {
    id: newId(), game: p.game, kind: p.kind, chat: p.chat, a: p.a.id, an: p.a.name,
    b: p.target?.id ?? null, bn: p.target?.name ?? "", target: !!p.target, status: "pending", opts: p.opts, state: null,
    winner: null, views: [], created: now, lastAt: now, expires: now + CHALLENGE_TTL_MS, seq: 0, settled: false, rematchOf: p.rematchOf,
  };
  await createOnce(mKey(m.id), m);
  await trackMatch(m.a, m.id);
  if (m.b) await trackMatch(m.b, m.id);
  await casUpdate<{ ids: string[] }>("gact", (c) => ({ ids: [...(c?.ids ?? []), m.id].slice(-500) }));
  return m;
}

/** Last matches of a player (for /matches). */
export async function trackMatch(uid: number, id: string) {
  await casUpdate<{ ids: string[] }>(`gr/${uid}`, (c) => (c?.ids.includes(id) ? undefined : { ids: [...(c?.ids ?? []), id].slice(-12) }));
}
export async function recentMatches(uid: number): Promise<Match[]> {
  const ids = (await getJSON<{ ids: string[] }>(`gr/${uid}`))?.ids ?? [];
  const rows = await getMany<Match>(ids.map(mKey));
  return rows.sort((x, y) => y.created - x.created);
}
export async function activeMatchIds(): Promise<string[]> {
  return (await getJSON<{ ids: string[] }>("gact"))?.ids ?? [];
}
export async function setActiveIds(ids: string[]) {
  await setJSON("gact", { ids });
}

export function startState(m: Match, now = Date.now()): Match["state"] {
  if (m.game === "ttt") return tttNew("a");
  if (m.game === "rps") return rpsNew(m.opts.bestOf ?? 3);
  return wordNew(m.opts.mode ?? "vocab", m.opts.diff ?? "easy", m.opts.rounds ?? 5, now);
}

/**
 * Atomic update of one match. `fn` mutates a copy and returns it (or undefined for "no change"). Everything that
 * changes a match goes through here, so two players pressing at the same time are serialised by the ETag.
 */
export async function updateMatch(id: string, fn: (m: Match) => Match | undefined | Promise<Match | undefined>): Promise<Match | null> {
  return casUpdate<Match>(mKey(id), async (cur) => {
    if (!cur) return undefined;
    const next = await fn(cur);
    if (!next) return undefined;
    next.seq = cur.seq + 1;
    return next;
  });
}

/** Moves a stale match to its terminal state. Pure: returns true when something changed. */
export function applyExpiry(m: Match, now = Date.now()): boolean {
  if (m.status === "pending" && now > m.expires) {
    m.status = "expired";
    return true;
  }
  if (m.status !== "active" || now <= m.lastAt + IDLE_TTL_MS) return false;
  m.how = "timeout";
  const s: any = m.state;
  if (m.game === "ttt") {
    // The player whose turn it was ran out of time and loses.
    const loser: Side = s.turn;
    m.status = "done";
    m.winner = loser === "a" ? m.b : m.a;
  } else if (m.game === "rps") {
    const { a, b } = s.picks as { a?: string; b?: string };
    if (a && !b) (m.status = "done"), (m.winner = m.a);
    else if (b && !a) (m.status = "done"), (m.winner = m.b);
    else m.status = "abandoned";
  } else {
    const { a, b } = s.score as { a: number; b: number };
    if (a === b) m.status = "abandoned";
    else (m.status = "done"), (m.winner = a > b ? m.a : m.b);
  }
  return true;
}

export const sideOf = (m: Match, uid: number): Side | null => (m.a === uid ? "a" : m.b === uid ? "b" : null);
export const uidOf = (m: Match, s: Side) => (s === "a" ? m.a : (m.b as number));
export const oppOf = (m: Match, uid: number) => (m.a === uid ? m.b : m.a);

// ---------------------------------------------------------------- settlement (stats + rewards), exactly once
const eloDelta = (ra: number, rb: number, score: number, k = 24) => Math.round(k * (score - 1 / (1 + 10 ** ((rb - ra) / 400))));

export async function settle(m: Match): Promise<{ rewards: Record<number, number>; rated: boolean } | null> {
  if (m.status !== "done" || m.b == null) return null;
  // The settle marker is the exactly-once guard; a duplicate callback or retried scheduler run gets false here.
  if (!(await createOnce(`gset/${m.id}`, { at: Date.now() }))) return null;

  const cfg = await getConfig();
  const pa = await getPlayer(m.a);
  const pb = await getPlayer(m.b);
  const ra = pa?.rating ?? 1000;
  const rb = pb?.rating ?? 1000;
  const draw = m.winner === "draw";
  const sa = draw ? 0.5 : m.winner === m.a ? 1 : 0;

  // Anti-farming: rewards only for two different accounts, within daily limits, and never for a rematch loop.
  const day = dayKey();
  const pairKey = `gday/${[m.a, m.b].sort().join("-")}/${day}`;
  let pairOk = false;
  await casUpdate<{ n: number }>(pairKey, (c) => {
    const n = (c?.n ?? 0) + 1;
    pairOk = n <= cfg.maxPerPairPerDay;
    return { n };
  });

  const rewards: Record<number, number> = {};
  for (const [uid, side] of [[m.a, "a"], [m.b, "b"]] as const) {
    const won = !draw && m.winner === uid;
    const score = draw ? 0.5 : won ? 1 : 0;
    const delta = eloDelta(side === "a" ? ra : rb, side === "a" ? rb : ra, score);
    await casUpdate<Player>(pKey(uid), (p) => {
      if (!p) return undefined;
      p.matches++;
      if (draw) (p.draws++, (p.streak = 0), p.g[m.game].d++);
      else if (won) (p.wins++, p.streak++, (p.best = Math.max(p.best, p.streak)), p.g[m.game].w++);
      else (p.losses++, (p.streak = 0), p.g[m.game].l++);
      p.rating = Math.max(100, p.rating + delta);
      p.last = Date.now();
      const earn = (b: string) => (p.badges.includes(b) ? 0 : (p.badges.push(b), 1));
      if (p.wins >= 1) earn("first-win");
      if (p.wins >= 10) earn("10-wins");
      if (p.best >= 3) earn("hot-streak");
      if (p.matches >= 25) earn("regular");
      return p;
    });

    // Points: capped per day per player, and not at all when the pair limit is exceeded.
    let allowed = pairOk;
    if (allowed) {
      await casUpdate<{ n: number }>(`gday/${uid}/${day}`, (c) => {
        const n = (c?.n ?? 0) + 1;
        allowed = n <= cfg.maxRewardedPerDay;
        return { n };
      });
    }
    if (allowed) {
      const amt = draw ? cfg.drawPoints : won ? cfg.winPoints : cfg.lossPoints;
      const r = await movePoints(uid, amt, "credit", draw ? "draw" : won ? "win" : "loss", `m:${m.id}`, { matchId: m.id });
      if (r.applied) rewards[uid] = amt;
    }
  }
  return { rewards, rated: true };
}

// ---------------------------------------------------------------- daily bonus
export async function claimDaily(uid: number): Promise<{ ok: boolean; amount: number; balance: number; reason?: string }> {
  const cfg = await getConfig();
  const day = dayKey();
  const r = await movePoints(uid, cfg.dailyBonus, "credit", "daily", `daily:${day}`);
  if (r.applied) await casUpdate<Player>(pKey(uid), (p) => (p ? { ...p, daily: day } : undefined));
  return { ok: r.applied, amount: cfg.dailyBonus, balance: r.balance, reason: r.applied ? undefined : r.reason };
}

// ---------------------------------------------------------------- leaderboard
export async function topPlayers(limit = 10): Promise<Player[]> {
  const rows = await getMany<Player>(await listKeys("gp/"));
  return rows
    .filter((p) => p.status === "active" && p.matches > 0)
    .sort((x, y) => y.rating - x.rating || y.wins - x.wins)
    .slice(0, limit);
}
export async function rankOf(uid: number): Promise<number | null> {
  const rows = await getMany<Player>(await listKeys("gp/"));
  const sorted = rows.filter((p) => p.status === "active" && p.matches > 0).sort((x, y) => y.rating - x.rating || y.wins - x.wins);
  const i = sorted.findIndex((p) => p.id === uid);
  return i < 0 ? null : i + 1;
}

// ---------------------------------------------------------------- Stars orders and payments
export type Order = {
  id: string;
  uid: number;
  productId: string;
  amount: number;
  currency: "XTR";
  status: "pending" | "paid" | "failed" | "refunded";
  provider: "telegram_stars";
  createdAt: number;
  completedAt?: number;
  chargeId?: string;
};
export type StarPayment = {
  chargeId: string; // telegram_payment_charge_id
  providerChargeId?: string;
  orderId: string;
  uid: number;
  amount: number;
  currency: string;
  status: "received" | "fulfilled" | "refunded";
  createdAt: number;
  completedAt?: number;
};

export async function createOrder(uid: number, productId: string): Promise<Order | null> {
  const pr = product(productId);
  if (!pr) return null;
  const o: Order = { id: newId(), uid, productId, amount: pr.stars, currency: "XTR", status: "pending", provider: "telegram_stars", createdAt: Date.now() };
  await createOnce(`go/${o.id}`, o);
  return o;
}
export const getOrder = (id: string) => getJSON<Order>(`go/${id}`);

/** Grants a purchased item. Safe to run more than once. */
async function grant(uid: number, productId: string) {
  await casUpdate<Player>(pKey(uid), (p) => {
    if (!p) return undefined;
    if (p.items.includes(productId)) return undefined;
    p.items.push(productId);
    if (product(productId)?.kind === "theme" && p.theme === "default") p.theme = productId;
    return p;
  });
}
async function revoke(uid: number, productId: string) {
  await casUpdate<Player>(pKey(uid), (p) => {
    if (!p || !p.items.includes(productId)) return undefined;
    p.items = p.items.filter((i) => i !== productId);
    if (p.theme === productId) p.theme = "default";
    return p;
  });
}

/**
 * Called for every `successful_payment` update. Idempotent on Telegram's charge id: webhook retries and duplicate
 * deliveries create the record once and fulfil once. Nothing is credited before this runs.
 */
export async function fulfilPayment(p: {
  uid: number; payload: string; chargeId: string; providerChargeId?: string; amount: number; currency: string;
}): Promise<{ ok: boolean; duplicate: boolean; product?: Product; reason?: string }> {
  const orderId = p.payload.startsWith("ord:") ? p.payload.slice(4) : "";
  const order = orderId ? await getOrder(orderId) : null;
  if (!order || order.uid !== p.uid || order.amount !== p.amount || p.currency !== "XTR") {
    // Money arrived that does not match any order: record it for the owner to review, never grant anything.
    await createOnce(`gs/${p.chargeId}`, { chargeId: p.chargeId, orderId, uid: p.uid, amount: p.amount, currency: p.currency, status: "received", createdAt: Date.now(), note: "unmatched" });
    return { ok: false, duplicate: false, reason: "unmatched" };
  }
  const rec: StarPayment = {
    chargeId: p.chargeId, providerChargeId: p.providerChargeId, orderId, uid: p.uid, amount: p.amount, currency: p.currency, status: "received", createdAt: Date.now(),
  };
  const fresh = await createOnce(`gs/${p.chargeId}`, rec);
  const existing = fresh ? rec : await getJSON<StarPayment>(`gs/${p.chargeId}`);
  if (!fresh && existing?.status !== "received") return { ok: true, duplicate: true, product: product(order.productId) };

  await grant(order.uid, order.productId);
  await setJSON(`gs/${p.chargeId}`, { ...existing!, status: "fulfilled", completedAt: Date.now() } satisfies StarPayment);
  await setJSON(`go/${order.id}`, { ...order, status: "paid", completedAt: Date.now(), chargeId: p.chargeId } satisfies Order);
  // Ledger line in Stars (its own unit: never mixed with game points).
  await createOnce(lKey(order.uid, `star:${p.chargeId}`), {
    id: `${order.uid}:star:${p.chargeId}`, uid: order.uid, type: "purchase", amount: order.amount, unit: "XTR", dir: "debit", status: "completed",
    idem: `star:${p.chargeId}`, createdAt: Date.now(), completedAt: Date.now(), provider: "telegram_stars", providerRef: p.chargeId, meta: { product: order.productId, order: order.id },
  } satisfies LedgerEntry);
  return { ok: true, duplicate: !fresh, product: product(order.productId) };
}

export async function purchases(uid: number): Promise<Order[]> {
  const rows = await getMany<Order>(await listKeys("go/"));
  return rows.filter((o) => o.uid === uid && o.status !== "pending").sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

/** Marks a payment refunded and takes the item back. The caller has already asked Telegram to refund the Stars. */
export async function markRefunded(chargeId: string): Promise<{ ok: boolean; reason?: string }> {
  const pay = await getJSON<StarPayment>(`gs/${chargeId}`);
  if (!pay) return { ok: false, reason: "unknown-charge" };
  if (pay.status === "refunded") return { ok: false, reason: "already-refunded" };
  const order = await getOrder(pay.orderId);
  await setJSON(`gs/${chargeId}`, { ...pay, status: "refunded", completedAt: Date.now() } satisfies StarPayment);
  if (order) {
    await setJSON(`go/${order.id}`, { ...order, status: "refunded", completedAt: Date.now() } satisfies Order);
    await revoke(order.uid, order.productId);
  }
  await createOnce(lKey(pay.uid, `refund:${chargeId}`), {
    id: `${pay.uid}:refund:${chargeId}`, uid: pay.uid, type: "refund", amount: pay.amount, unit: "XTR", dir: "credit", status: "refunded",
    idem: `refund:${chargeId}`, createdAt: Date.now(), completedAt: Date.now(), provider: "telegram_stars", providerRef: chargeId,
  } satisfies LedgerEntry);
  return { ok: true };
}
export const getPayment = (chargeId: string) => getJSON<StarPayment>(`gs/${chargeId}`);

/** Buys a theme with game points instead of Stars (debit goes through the same ledger). */
export async function buyWithPoints(uid: number, productId: string): Promise<{ ok: boolean; reason?: string; balance?: number }> {
  const pr = product(productId);
  if (!pr?.points) return { ok: false, reason: "not-for-points" };
  const p = await getPlayer(uid);
  if (!p) return { ok: false, reason: "no-player" };
  if (p.items.includes(productId)) return { ok: false, reason: "owned" };
  const r = await movePoints(uid, pr.points, "debit", "purchase", `buy:${productId}`, { meta: { product: productId } });
  if (!r.ok) return { ok: false, reason: r.reason === "insufficient" ? "insufficient" : "failed", balance: r.balance };
  await grant(uid, productId);
  return { ok: true, balance: r.balance };
}
export async function ownedItem(uid: number, id: string) {
  return !!(await getPlayer(uid))?.items.includes(id);
}

// ---------------------------------------------------------------- admin helpers
export async function setBan(uid: number, banned: boolean) {
  return casUpdate<Player>(pKey(uid), (p) => (p ? { ...p, status: banned ? "banned" : "active" } : undefined));
}
export async function setConfig(patch: Partial<GameConfig>) {
  await casUpdate<Partial<GameConfig>>("gcfg", (c) => ({ ...(c ?? {}), ...patch, realMoney: false }));
}
export { other };
