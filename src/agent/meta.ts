import { casUpdate, createOnce, delKey, getJSON, getMany, listKeys, setJSON } from "../store.js";
import { CHARACTERS } from "./maps.js";
import type { Outcome, Room } from "./engine.js";

// Persistent side of SECRET AGENT: profiles, reward ledger, missions, achievements, leaderboards, history, reports,
// admin configuration. Every balance change is exactly-once (createOnce idempotency key + compare-and-swap).

export type RewardCfg = {
  partCoins: number; winCoins: number; spyWinBonus: number; xpPart: number; xpWin: number; xpTask: number; levelUpCoins: number;
  dailyBase: number; dailyStreakStep: number; maxRewardedPerDay: number; practiceCoins: number; practiceXpFactor: number; practiceDailyCap: number;
  rankedWin: number; rankedLoss: number;
};
export type SACfg = {
  rewards: RewardCfg;
  modes: Record<"quick" | "private" | "friends" | "practice" | "ranked", boolean>;
  maintenance: boolean;
  limits: { minPlayers: number; maxPlayers: number };
};
export const DEFAULT_CFG: SACfg = {
  rewards: {
    partCoins: 10, winCoins: 25, spyWinBonus: 10, xpPart: 20, xpWin: 30, xpTask: 5, levelUpCoins: 15, dailyBase: 20, dailyStreakStep: 5,
    maxRewardedPerDay: 20, practiceCoins: 0, practiceXpFactor: 0.4, practiceDailyCap: 3, rankedWin: 18, rankedLoss: 12,
  },
  modes: { quick: true, private: true, friends: true, practice: true, ranked: false },
  maintenance: false,
  limits: { minPlayers: 4, maxPlayers: 10 },
};

export async function getCfg(): Promise<SACfg> {
  const c = (await getJSON<Partial<SACfg>>("sa/cfg")) ?? {};
  return {
    rewards: { ...DEFAULT_CFG.rewards, ...(c.rewards ?? {}) },
    modes: { ...DEFAULT_CFG.modes, ...(c.modes ?? {}) },
    maintenance: !!c.maintenance,
    limits: { ...DEFAULT_CFG.limits, ...(c.limits ?? {}) },
  };
}

// ---------------------------------------------------------------- time keys (UTC, consistent reset boundaries)
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
export function weekKey(t: number) {
  const d = new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d.getTime() - y0) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
export const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);
export const nextDayAt = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate() + 1);

// ---------------------------------------------------------------- profiles
export type Profile = {
  uid: number; name: string; username?: string; char: string; unlocked: string[];
  xp: number; level: number; coins: number;
  matches: number; wins: number; losses: number; spyMatches: number; spyWins: number; agentWins: number;
  streak: number; best: number; rating: number; rankedMatches: number;
  ludoMatches?: number; ludoWins?: number;
  cluesTotal: number; tasksTotal: number; correctVotesTotal: number; perfect: number;
  created: number; last: number; banned?: boolean; banReason?: string;
  daily: { last: string; streak: number };
  missions: { day: string; week: string; progress: Record<string, number>; claimed: string[] };
  ach: Record<string, number>;
  period: { week: string; weekWins: number; weekXp: number; month: string; monthWins: number; monthXp: number };
  friends: number[]; history: string[];
  rewardedToday: { day: string; n: number; practice: number };
  applied: string[];
  settings: { sound: boolean; music: boolean; reduceMotion: boolean; haptics: boolean };
};

/** Characters 1-4 are free; the others unlock with level (cosmetic only). */
export const unlockLevel = (index: number) => (index < 4 ? 1 : 2 * (index - 3) + 1);
export const unlockedFor = (level: number) => CHARACTERS.filter((_, i) => level >= unlockLevel(i)).map((c) => c.id);

export const levelOf = (xp: number) => Math.floor(Math.sqrt(Math.max(0, xp) / 60)) + 1;
export const xpForLevel = (lvl: number) => (lvl - 1) ** 2 * 60;

const pKey = (uid: number) => `sa/p/${uid}`;
const newProfile = (u: { uid: number; name: string; username?: string }, now: number): Profile => ({
  uid: u.uid, name: u.name, username: u.username, char: CHARACTERS[u.uid % 4].id, unlocked: CHARACTERS.slice(0, 4).map((c) => c.id),
  xp: 0, level: 1, coins: 0, matches: 0, wins: 0, losses: 0, spyMatches: 0, spyWins: 0, agentWins: 0, streak: 0, best: 0, rating: 1000, rankedMatches: 0,
  cluesTotal: 0, tasksTotal: 0, correctVotesTotal: 0, perfect: 0, created: now, last: now,
  daily: { last: "", streak: 0 },
  missions: { day: dayKey(now), week: weekKey(now), progress: {}, claimed: [] },
  ach: {},
  period: { week: weekKey(now), weekWins: 0, weekXp: 0, month: monthKey(now), monthWins: 0, monthXp: 0 },
  friends: [], history: [], rewardedToday: { day: dayKey(now), n: 0, practice: 0 }, applied: [],
  settings: { sound: true, music: false, reduceMotion: false, haptics: true },
});

/** Roll daily/weekly/monthly counters over when the UTC period changed. */
function rollover(p: Profile, now: number) {
  const d = dayKey(now), w = weekKey(now), m = monthKey(now);
  if (p.missions.day !== d) {
    const keepWeekly = Object.fromEntries(Object.entries(p.missions.progress).filter(([k]) => k.startsWith("w_")));
    p.missions = { day: d, week: p.missions.week, progress: keepWeekly, claimed: p.missions.claimed.filter((c) => c.startsWith("w_")) };
  }
  if (p.missions.week !== w) {
    p.missions.week = w;
    p.missions.progress = Object.fromEntries(Object.entries(p.missions.progress).filter(([k]) => !k.startsWith("w_")));
    p.missions.claimed = p.missions.claimed.filter((c) => !c.startsWith("w_"));
  }
  if (p.period.week !== w) (p.period.week = w), (p.period.weekWins = 0), (p.period.weekXp = 0);
  if (p.period.month !== m) (p.period.month = m), (p.period.monthWins = 0), (p.period.monthXp = 0);
  if (p.rewardedToday.day !== d) p.rewardedToday = { day: d, n: 0, practice: 0 };
}

export async function getProfile(uid: number): Promise<Profile | null> {
  return getJSON<Profile>(pKey(uid));
}

export async function ensureProfile(u: { uid: number; name: string; username?: string }, now: number): Promise<Profile> {
  let fresh: Profile | null = null;
  const p = await casUpdate<Profile>(pKey(u.uid), (cur) => {
    const p = cur ?? newProfile(u, now);
    const before = cur ? JSON.stringify([cur.missions, cur.period, cur.rewardedToday]) : "";
    const name = u.name.slice(0, 40) || p.name;
    const changed = !cur || p.name !== name || p.username !== u.username || now - p.last > 60_000;
    p.name = name;
    p.username = u.username;
    rollover(p, now);
    const rolled = before !== JSON.stringify([p.missions, p.period, p.rewardedToday]);
    if (cur && !changed && !rolled) {
      fresh = cur;
      return undefined; // nothing to write: polling must not become a write per request
    }
    p.last = now;
    fresh = p;
    return p;
  });
  return (p ?? fresh)!;
}

export async function updateProfile(uid: number, fn: (p: Profile) => void | Profile): Promise<Profile | null> {
  return casUpdate<Profile>(pKey(uid), (cur) => {
    if (!cur) return undefined;
    return fn(cur) ?? cur;
  });
}

// ---------------------------------------------------------------- coin ledger (immutable lines, unique per idempotency key)
export type CoinLine = { id: string; uid: number; type: string; amount: number; unit: "coins" | "xp"; dir: "credit"; idem: string; at: number; ref?: string; meta?: Record<string, unknown> };

/** Credits coins exactly once per idempotency key. Returns whether this call applied the credit. */
export async function credit(uid: number, amount: number, type: string, idem: string, now: number, ref?: string): Promise<{ applied: boolean; coins: number }> {
  if (!Number.isInteger(amount) || amount <= 0) return { applied: false, coins: (await getProfile(uid))?.coins ?? 0 };
  const line: CoinLine = { id: `${uid}:${idem}`, uid, type, amount, unit: "coins", dir: "credit", idem, at: now, ref };
  const fresh = await createOnce(`sa/l/${uid}/${idem}`, line);
  if (!fresh) {
    // A previous attempt may have written the line and died before the balance changed: the applied-keys list decides.
    const p = await getProfile(uid);
    if (p?.applied.includes(idem)) return { applied: false, coins: p.coins };
  }
  let did = false;
  const p = await casUpdate<Profile>(pKey(uid), (cur) => {
    did = false;
    if (!cur || cur.applied.includes(idem)) return undefined;
    cur.coins += amount;
    cur.applied = [...cur.applied, idem].slice(-80);
    did = true;
    return cur;
  });
  return { applied: did, coins: p?.coins ?? 0 };
}

export async function coinHistory(uid: number, limit = 20): Promise<CoinLine[]> {
  const rows = await getMany<CoinLine>(await listKeys(`sa/l/${uid}/`));
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}

export async function reconcileCoins(uid: number, fix = false) {
  const lines = await getMany<CoinLine>(await listKeys(`sa/l/${uid}/`));
  const total = lines.filter((l) => l.unit === "coins").reduce((s, l) => s + l.amount, 0);
  const p = await getProfile(uid);
  const balance = p?.coins ?? 0;
  if (fix && p && total !== balance) await updateProfile(uid, (q) => ({ ...q, coins: total }));
  return { balance, ledger: total, ok: balance === total };
}

// ---------------------------------------------------------------- missions
export type MissionDef = { id: string; title: string; desc: string; stat: string; target: number; reward: number; period: "daily" | "weekly" };
export const MISSIONS: MissionDef[] = [
  { id: "d_play3", title: "Active duty", desc: "Complete 3 matches", stat: "matches", target: 3, reward: 20, period: "daily" },
  { id: "d_win_agent", title: "Clean sweep", desc: "Win 1 match as an Agent", stat: "agentWins", target: 1, reward: 25, period: "daily" },
  { id: "d_win_spy", title: "Deep cover", desc: "Win 1 match as the Spy", stat: "spyWins", target: 1, reward: 30, period: "daily" },
  { id: "d_clues5", title: "Evidence locker", desc: "Collect 5 clues", stat: "clues", target: 5, reward: 20, period: "daily" },
  { id: "d_tasks3", title: "Field work", desc: "Complete 3 objectives", stat: "tasks", target: 3, reward: 20, period: "daily" },
  { id: "d_vote1", title: "Civic duty", desc: "Submit a valid vote", stat: "votes", target: 1, reward: 10, period: "daily" },
  { id: "d_friend", title: "Buddy system", desc: "Play with a friend in a private room", stat: "friendMatches", target: 1, reward: 20, period: "daily" },
  { id: "w_play10", title: "Season regular", desc: "Complete 10 matches this week", stat: "matches", target: 10, reward: 60, period: "weekly" },
  { id: "w_win4", title: "Weekly victor", desc: "Win 4 matches this week", stat: "wins", target: 4, reward: 80, period: "weekly" },
];

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export function missionsFor(day: string): MissionDef[] {
  const daily = MISSIONS.filter((m) => m.period === "daily");
  const order = daily.map((m, i) => ({ m, k: hash(day + m.id + i) })).sort((a, b) => a.k - b.k).map((x) => x.m);
  return [...order.slice(0, 4), ...MISSIONS.filter((m) => m.period === "weekly")];
}

function bumpMissions(p: Profile, gain: Record<string, number>) {
  const active = missionsFor(p.missions.day);
  for (const m of active) {
    const add = gain[m.stat] ?? 0;
    if (add > 0 && !p.missions.claimed.includes(m.id)) p.missions.progress[m.id] = Math.min(m.target, (p.missions.progress[m.id] ?? 0) + add);
  }
}

export async function claimMission(uid: number, id: string, now: number) {
  const cur = await getProfile(uid);
  if (!cur) return { ok: false as const, error: "no-profile" };
  const def = missionsFor(cur.missions.day).find((m) => m.id === id);
  if (!def) return { ok: false as const, error: "no-such-mission" };
  const period = def.period === "daily" ? cur.missions.day : cur.missions.week;
  if ((cur.missions.progress[id] ?? 0) < def.target) return { ok: false as const, error: "not-complete" };
  if (cur.missions.claimed.includes(id)) return { ok: false as const, error: "already-claimed" };
  const idem = `mission:${id}:${period}`;
  const r = await credit(uid, def.reward, "mission", idem, now, id);
  if (!r.applied) return { ok: false as const, error: "already-claimed" };
  await updateProfile(uid, (q) => ({ ...q, missions: { ...q.missions, claimed: [...new Set([...q.missions.claimed, id])] } }));
  return { ok: true as const, reward: def.reward, coins: r.coins };
}

export async function claimDaily(uid: number, now: number) {
  const cfg = (await getCfg()).rewards;
  const p = await getProfile(uid);
  if (!p) return { ok: false as const, error: "no-profile" };
  const today = dayKey(now);
  if (p.daily.last === today) return { ok: false as const, error: "already-claimed", next: nextDayAt(now) };
  const yesterday = dayKey(now - 86400000);
  const streak = p.daily.last === yesterday ? p.daily.streak + 1 : 1;
  const amount = cfg.dailyBase + cfg.dailyStreakStep * Math.min(streak - 1, 6);
  const r = await credit(uid, amount, "daily-login", `daily:${today}`, now);
  if (!r.applied) return { ok: false as const, error: "already-claimed", next: nextDayAt(now) };
  await updateProfile(uid, (q) => ({ ...q, daily: { last: today, streak } }));
  return { ok: true as const, amount, streak, coins: r.coins };
}

// ---------------------------------------------------------------- achievements
export type AchDef = { id: string; name: string; desc: string; reward: number; target: number; value: (p: Profile) => number };
export const ACHIEVEMENTS: AchDef[] = [
  { id: "first_mission", name: "First Mission", desc: "Finish your first match", reward: 10, target: 1, value: (p) => p.matches },
  { id: "first_victory", name: "First Victory", desc: "Win a match", reward: 15, target: 1, value: (p) => p.wins },
  { id: "spy_master", name: "Spy Master", desc: "Win 5 matches as the Spy", reward: 40, target: 5, value: (p) => p.spyWins },
  { id: "sharp_detective", name: "Sharp Detective", desc: "Vote for the Spy 10 times", reward: 40, target: 10, value: (p) => p.correctVotesTotal },
  { id: "clue_collector", name: "Clue Collector", desc: "Collect 50 clues", reward: 30, target: 50, value: (p) => p.cluesTotal },
  { id: "team_player", name: "Team Player", desc: "Complete 50 objectives", reward: 30, target: 50, value: (p) => p.tasksTotal },
  { id: "winning_streak", name: "Winning Streak", desc: "Win 3 matches in a row", reward: 25, target: 3, value: (p) => p.best },
  { id: "veteran_agent", name: "Veteran Agent", desc: "Play 50 matches", reward: 50, target: 50, value: (p) => p.matches },
  { id: "perfect_investigation", name: "Perfect Investigation", desc: "Win as an Agent with every vote correct", reward: 35, target: 1, value: (p) => p.perfect },
  { id: "ludo_champion", name: "Ludo Champion", desc: "Win 3 Ludo matches", reward: 30, target: 3, value: (p) => p.ludoWins ?? 0 },
  { id: "ranked_champion", name: "Ranked Champion", desc: "Reach a ranked rating of 1200", reward: 60, target: 1200, value: (p) => p.rating },
];

// ---------------------------------------------------------------- match finalisation (exactly once per match)
export type RewardResult = { uid: number; won: boolean; role: string; coins: number; xp: number; ratingDelta: number; level: number; leveledUp: boolean; levelBonus: number; achievements: string[]; skipped?: string };

export async function finalizeMatch(room: Room, now: number): Promise<Record<string, RewardResult> | null> {
  if (!room.outcome || room.status !== "finished") return null;
  return finalizeCore({
    matchId: room.matchId, mode: room.mode, outcome: room.outcome, startedAt: room.startedAt, endedAt: room.endedAt, game: "agent",
    summary: { map: room.mapId, rounds: room.round, votes: room.history, code: room.code },
  }, now);
}

export type CoreInput = {
  matchId: string; mode: string; outcome: Outcome; startedAt?: number; endedAt?: number; game: "agent" | "ludo";
  summary: Record<string, unknown>;
};

/** Shared by every game: pays rewards, updates profiles and writes the match summary, exactly once per match. */
export async function finalizeCore(inp: CoreInput, now: number): Promise<Record<string, RewardResult> | null> {
  const out = inp.outcome;
  const room = { matchId: inp.matchId, mode: inp.mode, startedAt: inp.startedAt, endedAt: inp.endedAt };
  const isAgent = inp.game === "agent";
  // Exactly-once marker. A retry (or a second client polling the result) gets false and does nothing.
  if (!(await createOnce(`sa/fin/${room.matchId}`, { at: now }))) return null;

  const cfg = await getCfg();
  const r = cfg.rewards;
  const humans = out.players.filter((p) => !p.bot);
  const results: Record<string, RewardResult> = {};
  const practice = room.mode === "practice" || humans.length < 2;
  const full = !practice && humans.length >= 3;
  const duration = (room.endedAt ?? now) - (room.startedAt ?? now);

  // Public, privacy-checked match summary (roles are revealed only now that the match is over).
  await setJSON(`sa/m/${room.matchId}`, {
    matchId: room.matchId, mode: room.mode, game: inp.game, startedAt: room.startedAt, endedAt: room.endedAt, duration,
    winner: out.winner, reason: out.reason, players: out.players, ...inp.summary,
  });

  for (const pl of humans) {
    const res: RewardResult = { uid: pl.uid, won: pl.won, role: pl.role, coins: 0, xp: 0, ratingDelta: 0, level: 1, leveledUp: false, levelBonus: 0, achievements: [] };
    results[String(pl.uid)] = res;
    const stats = pl.stats;
    // Players who left, or never took part, are not rewarded.
    const participated = !pl.left && (stats.tasks + stats.clues + stats.votes + stats.sabotages + stats.fakes + stats.chats > 0 || duration > 20000);
    let skipped: string | undefined;
    if (!participated) skipped = "left-early";
    const prof0 = await getProfile(pl.uid);
    if (!prof0) continue;

    let coins = 0, xp = 0;
    if (!skipped) {
      const base = pl.won ? r.partCoins + r.winCoins + (pl.role === "spy" ? r.spyWinBonus : 0) : r.partCoins;
      const xpBase = r.xpPart + (pl.won ? r.xpWin : 0) + stats.tasks * r.xpTask;
      if (practice) {
        coins = r.practiceCoins;
        xp = Math.round(xpBase * r.practiceXpFactor);
      } else if (full) {
        coins = base;
        xp = xpBase;
      } else {
        coins = Math.round(base * 0.5);
        xp = Math.round(xpBase * 0.5);
      }
    }
    let ratingDelta = 0;
    if (!skipped && room.mode === "ranked") ratingDelta = pl.won ? r.rankedWin : -r.rankedLoss;

    let capped = false;
    let applied = false;
    let finalCoins = 0;
    let finalXp = 0;
    const updated = await updateProfile(pl.uid, (p) => {
      rollover(p, now);
      applied = false;
      capped = false;
      let c = coins;
      let x = xp;
      if (p.applied.includes(`m:${room.matchId}`)) return p; // already counted
      applied = true;
      p.matches++;
      p.last = now;
      if (isAgent && pl.role === "spy") p.spyMatches++;
      if (!isAgent) {
        p.ludoMatches = (p.ludoMatches ?? 0) + 1;
        if (pl.won) p.ludoWins = (p.ludoWins ?? 0) + 1;
      }
      if (pl.won) {
        p.wins++;
        if (isAgent) {
          if (pl.role === "spy") p.spyWins++;
          else p.agentWins++;
        }
        p.streak++;
        p.best = Math.max(p.best, p.streak);
        p.period.weekWins++;
        p.period.monthWins++;
      } else {
        p.losses++;
        p.streak = 0;
      }
      p.cluesTotal += stats.clues;
      p.tasksTotal += stats.tasks;
      p.correctVotesTotal += stats.correctVotes;
      if (isAgent && pl.won && pl.role !== "spy" && stats.votes > 0 && stats.correctVotes === stats.votes) p.perfect++;
      if (room.mode === "ranked") (p.rankedMatches++, (p.rating = Math.max(100, p.rating + ratingDelta)));

      // Anti-farming: a daily cap on rewarded matches, and a smaller one for practice matches.
      if (practice) {
        if (p.rewardedToday.practice >= r.practiceDailyCap) capped = true;
        else p.rewardedToday.practice++;
      } else if (p.rewardedToday.n >= r.maxRewardedPerDay) capped = true;
      else p.rewardedToday.n++;
      if (skipped || capped) {
        c = 0;
        x = 0;
      }
      finalCoins = c;
      finalXp = x;
      const before = p.level;
      p.xp += x;
      p.period.weekXp += x;
      p.period.monthXp += x;
      p.level = levelOf(p.xp);
      res.leveledUp = p.level > before;
      res.level = p.level;
      bumpMissions(p, {
        matches: 1, wins: pl.won ? 1 : 0, agentWins: isAgent && pl.won && pl.role !== "spy" ? 1 : 0, spyWins: isAgent && pl.won && pl.role === "spy" ? 1 : 0,
        clues: stats.clues, tasks: stats.tasks, votes: stats.votes, friendMatches: room.mode === "private" || room.mode === "friends" ? (humans.length >= 2 ? 1 : 0) : 0,
      });
      if (room.mode === "private" || room.mode === "friends") {
        for (const o of humans) if (o.uid !== p.uid && !p.friends.includes(o.uid)) p.friends = [...p.friends, o.uid].slice(-50);
      }
      p.history = [room.matchId, ...p.history].slice(0, 30);
      p.applied = [...p.applied, `m:${room.matchId}`].slice(-80);
      return p;
    });
    if (!updated || !applied) continue;
    coins = finalCoins;
    xp = finalXp;
    res.xp = xp;
    res.ratingDelta = ratingDelta;
    res.skipped = skipped ?? (capped ? "daily-cap" : undefined);

    // Coins through the ledger (exactly once per match), then level-up and achievement bonuses.
    if (coins > 0) {
      const c = await credit(pl.uid, coins, "match", `match:${room.matchId}`, now, room.matchId);
      if (c.applied) res.coins += coins;
    }
    if (res.leveledUp && !res.skipped) {
      const bonus = r.levelUpCoins;
      const c = await credit(pl.uid, bonus, "level-up", `level:${res.level}`, now);
      if (c.applied) (res.coins += bonus), (res.levelBonus = bonus);
    }
    const fresh = await getProfile(pl.uid);
    if (fresh) {
      for (const a of ACHIEVEMENTS) {
        if (fresh.ach[a.id] || a.value(fresh) < a.target) continue;
        const c = await credit(pl.uid, a.reward, "achievement", `ach:${a.id}`, now, a.id);
        if (c.applied) {
          await updateProfile(pl.uid, (q) => ({ ...q, ach: { ...q.ach, [a.id]: now } }));
          res.achievements.push(a.id);
          res.coins += a.reward;
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------- leaderboards
export type Board = "global" | "weekly" | "monthly" | "ranked" | "friends";
export type LbRow = { rank: number; uid: number; name: string; username?: string; char: string; level: number; wins: number; winRate: number; xp: number; rating: number; streak: number; metric: number };

let lbCache: { at: number; rows: Profile[] } | null = null;
async function allProfiles(now: number): Promise<Profile[]> {
  if (lbCache && now - lbCache.at < 15000) return lbCache.rows;
  const rows = await getMany<Profile>(await listKeys("sa/p/"));
  lbCache = { at: now, rows };
  return rows;
}
export const clearLbCache = () => (lbCache = null);

export async function leaderboard(board: Board, uid: number, opts: { page?: number; size?: number; q?: string }, now: number) {
  const size = Math.min(50, Math.max(5, opts.size ?? 20));
  const page = Math.max(0, opts.page ?? 0);
  const all = (await allProfiles(now)).filter((p) => !p.banned);
  const me = all.find((p) => p.uid === uid);
  const wk = weekKey(now), mo = monthKey(now);
  let pool = all.filter((p) => p.matches > 0);
  const metric = (p: Profile): number =>
    board === "weekly" ? (p.period.week === wk ? p.period.weekWins * 1000 + p.period.weekXp : 0)
    : board === "monthly" ? (p.period.month === mo ? p.period.monthWins * 1000 + p.period.monthXp : 0)
    : board === "ranked" ? p.rating : p.xp;
  if (board === "ranked") pool = pool.filter((p) => p.rankedMatches > 0);
  if (board === "friends") pool = pool.filter((p) => p.uid === uid || me?.friends.includes(p.uid));
  if (board === "weekly") pool = pool.filter((p) => metric(p) > 0);
  if (board === "monthly") pool = pool.filter((p) => metric(p) > 0);
  // Stable tie-break: metric, then wins, then the older account first.
  pool.sort((a, b) => metric(b) - metric(a) || b.wins - a.wins || a.created - b.created || a.uid - b.uid);
  const toRow = (p: Profile, i: number): LbRow => ({
    rank: i + 1, uid: p.uid, name: p.name, username: p.username, char: p.char, level: p.level, wins: p.wins,
    winRate: p.matches ? Math.round((p.wins / p.matches) * 100) : 0, xp: p.xp, rating: p.rating, streak: p.streak, metric: metric(p),
  });
  const rows = pool.map(toRow);
  const q = (opts.q ?? "").trim().toLowerCase();
  const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || (r.username ?? "").toLowerCase() === q.replace(/^@/, "")) : rows;
  const mine = rows.find((r) => r.uid === uid) ?? null;
  return { board, total: filtered.length, page, size, rows: filtered.slice(page * size, page * size + size), me: mine, updatedAt: now };
}

// ---------------------------------------------------------------- reports and audit
export async function addReport(r: { reporter: number; target: number; reason: string; code?: string; matchId?: string }, now: number) {
  const id = `${now}-${Math.random().toString(36).slice(2, 7)}`;
  await createOnce(`sa/rep/${id}`, { id, ...r, reason: r.reason.slice(0, 200), at: now, status: "open" });
  return id;
}
export async function listReports(limit = 30) {
  const keys = (await listKeys("sa/rep/")).sort().slice(-limit);
  return (await getMany<any>(keys)).sort((a, b) => b.at - a.at);
}
export async function resolveReport(id: string, status: "resolved" | "dismissed") {
  const cur = await getJSON<any>(`sa/rep/${id}`);
  if (!cur) return false;
  await setJSON(`sa/rep/${id}`, { ...cur, status });
  return true;
}
export async function audit(actor: number, action: string, target: string, data: Record<string, unknown>, now: number) {
  const id = `${now}-${Math.random().toString(36).slice(2, 7)}`;
  await createOnce(`sa/audit/${id}`, { id, actor, action, target, data, at: now });
}
export async function recentAudit(limit = 30) {
  const keys = (await listKeys("sa/audit/")).sort().slice(-limit);
  return (await getMany<any>(keys)).sort((a, b) => b.at - a.at);
}

export async function saveCfg(patch: Partial<SACfg>, actor: number, now: number) {
  const cur = await getCfg();
  const next: SACfg = {
    rewards: { ...cur.rewards, ...(patch.rewards ?? {}) },
    modes: { ...cur.modes, ...(patch.modes ?? {}) },
    maintenance: patch.maintenance ?? cur.maintenance,
    limits: { ...cur.limits, ...(patch.limits ?? {}) },
  };
  await setJSON("sa/cfg", next);
  await audit(actor, "config", "sa/cfg", patch as Record<string, unknown>, now);
  return next;
}

export async function deleteKey(key: string) {
  await delKey(key);
}

export type MatchSummary = { matchId: string; mode: string; map: string; startedAt?: number; endedAt?: number; duration: number; winner: string; reason: string; rounds: number; players: Outcome["players"]; code: string };
export const getMatchSummary = (id: string) => getJSON<MatchSummary>(`sa/m/${id}`);
