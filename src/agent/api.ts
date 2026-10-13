import { casUpdate, createOnce, delKey, getJSON, getMany, listKeys } from "../store.js";
import {
  LIMITS, TIMINGS_REF, addBots, addPlayer, advance, chat, hostStart, interact, makeCode, move, newRoom, removePlayer, setCharacter, setReady,
  setSettings, shareClue, touch, useAbility, validCode, viewFor, vote, type Mode, type Rng, type Room,
} from "./engine.js";
import { CHARACTERS, MAPS } from "./maps.js";
import {
  LUDO, addLudoBots, addSeat as ludoAddSeat, advanceLudo, ludoStandings, ludoView, makeCode as ludoCode, move as ludoMove, newLudoRoom, removeSeat as ludoRemoveSeat,
  roll as ludoRoll, seatIndex as ludoSeatIndex, startLudo, type LudoRoom,
} from "./ludo.js";
import {
  ACHIEVEMENTS, MISSIONS, addReport, audit, claimDaily, claimMission, coinHistory, dayKey, ensureProfile, finalizeMatch, getCfg, getMatchSummary,
  getProfile, leaderboard, listReports, levelOf, missionsFor, unlockedFor, unlockLevel, nextDayAt, recentAudit, resolveReport, saveCfg, updateProfile, xpForLevel,
  finalizeCore, type Board, type Profile, type RewardResult,
} from "./meta.js";

// HTTP-style router for the SECRET AGENT backend. It is transport-agnostic (the Netlify function and the tests both call
// route()), takes an already authenticated Telegram user, and never trusts a field of the body for identity or rewards.

export type Caller = { id: number; name: string; username?: string };
export type Ctx = { user: Caller; now: number; rng?: Rng; isAdmin: boolean };
export type Res = { status: number; body: any };

const ok = (body: Record<string, unknown> = {}): Res => ({ status: 200, body: { ok: true, ...body } });
const fail = (error: string, status = 400): Res => ({ status, body: { ok: false, error } });

const QUICK_WAIT_MS = 20_000;
const rKey = (c: string) => `sa/r/${c}`;
const uKey = (uid: number) => `sa/u/${uid}`;

// best-effort per-instance rate limiter (the engine's own cooldowns are the authoritative limits)
const buckets = new Map<string, { n: number; at: number }>();
function limited(uid: number, now: number, max = 40, windowMs = 5000) {
  const b = buckets.get(String(uid));
  if (!b || now - b.at > windowMs) {
    buckets.set(String(uid), { n: 1, at: now });
    return false;
  }
  b.n++;
  return b.n > max;
}

const str = (v: unknown, n = 64) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v));

// ---------------------------------------------------------------- rooms
async function indexAdd(code: string) {
  await casUpdate<{ codes: string[] }>("sa/idx", (c) => ({ codes: [...new Set([...(c?.codes ?? []), code])].slice(-300) }));
}

type Mutated<T> = { room: Room; result: T } | null;

/**
 * Loads a room, lets the engine catch up with the clock, applies `fn`, and writes it back atomically. Concurrent
 * players are serialised by the ETag; a snapshot comparison avoids writing when nothing changed.
 */
async function mutate<T>(code: string, now: number, rng: Rng | undefined, fn: (room: Room) => T, opts: { touchUid?: number; quiet?: boolean } = {}): Promise<Mutated<T>> {
  let result!: T;
  let missing = false;
  const saved = await casUpdate<Room>(rKey(code), (cur) => {
    missing = !cur;
    if (!cur) return undefined;
    const before = JSON.stringify(cur);
    if (opts.touchUid !== undefined) {
      const p = cur.players.find((x) => x.uid === opts.touchUid);
      // lastSeen is only rewritten every few seconds so idle polling does not become a write per request
      if (p && now - p.lastSeen > 4000) touch(cur, opts.touchUid, now);
      else if (p && !p.connected) touch(cur, opts.touchUid, now);
    }
    if (cur.mode === "quick" && cur.status === "lobby" && now - cur.createdAt > QUICK_WAIT_MS && cur.players.length < LIMITS.minPlayers) {
      addBots(cur, LIMITS.minPlayers - cur.players.length, now, rng);
      for (const p of cur.players) p.ready = true;
    }
    advance(cur, now, rng);
    result = fn(cur);
    advance(cur, now, rng);
    if (JSON.stringify(cur) === before) return undefined;
    cur.seq++;
    return cur;
  });
  if (missing || !saved) return null;
  return { room: saved, result };
}

async function settleIfFinished(room: Room, now: number): Promise<Room> {
  if (room.status !== "finished" || room.rewarded) return room;
  const results = await finalizeMatch(room, now);
  const saved = await casUpdate<Room>(rKey(room.code), (cur) => {
    if (!cur || cur.rewarded) return undefined;
    cur.rewarded = true;
    if (results) cur.rewards = results as unknown as Record<string, unknown>;
    return cur;
  });
  return saved ?? room;
}

async function currentRoom(uid: number): Promise<Room | null> {
  const ptr = await getJSON<{ code: string }>(uKey(uid));
  if (!ptr) return null;
  const room = await getJSON<Room>(rKey(ptr.code));
  if (!room) return null;
  const me = room.players.find((p) => p.uid === uid);
  if (!me || me.left) return null;
  if (room.status === "cancelled") return null;
  if (room.status === "finished" && room.endedAt && Date.now() - room.endedAt > 10 * 60_000) return null;
  return room;
}

function viewWithRewards(room: Room, uid: number, now: number) {
  const v = viewFor(room, uid, now);
  const rewards = room.rewards?.[String(uid)] as RewardResult | undefined;
  return { ...v, rewards, rewardsPending: room.status === "finished" && !room.rewards };
}

// ---------------------------------------------------------------- profile helpers
function profileView(p: Profile, now: number) {
  const cur = xpForLevel(p.level), next = xpForLevel(p.level + 1);
  return {
    uid: p.uid, name: p.name, username: p.username, char: p.char, unlocked: unlockedFor(p.level), xp: p.xp, level: p.level, levelXp: p.xp - cur, levelNeed: next - cur,
    coins: p.coins, matches: p.matches, wins: p.wins, losses: p.losses, winRate: p.matches ? Math.round((p.wins / p.matches) * 100) : 0,
    spyWins: p.spyWins, agentWins: p.agentWins, streak: p.streak, best: p.best, rating: p.rating, created: p.created,
    daily: { claimable: p.daily.last !== dayKey(now), streak: p.daily.streak, next: nextDayAt(now) }, settings: p.settings,
    achievementsUnlocked: Object.keys(p.ach).length,
  };
}

function missionsView(p: Profile, now: number) {
  return missionsFor(p.missions.day).map((m) => ({
    id: m.id, title: m.title, desc: m.desc, target: m.target, reward: m.reward, period: m.period,
    progress: Math.min(m.target, p.missions.progress[m.id] ?? 0), claimed: p.missions.claimed.includes(m.id),
    resetsAt: m.period === "daily" ? nextDayAt(now) : nextWeekAt(now),
  }));
}
function nextWeekAt(t: number) {
  const d = new Date(t);
  const day = d.getUTCDay() || 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (8 - day));
}

function achievementsView(p: Profile) {
  return ACHIEVEMENTS.map((a) => ({
    id: a.id, name: a.name, desc: a.desc, reward: a.reward, target: a.target, progress: Math.min(a.target, a.value(p)), unlockedAt: p.ach[a.id] ?? null,
  }));
}

// ---------------------------------------------------------------- router
export async function route(method: string, path: string, query: Record<string, string>, body: any, ctx: Ctx): Promise<Res> {
  const { user, now, rng } = ctx;
  const b = body && typeof body === "object" ? body : {};
  if (limited(user.id, now)) return fail("rate-limited", 429);

  const cfg = await getCfg();
  const profile = await ensureProfile({ uid: user.id, name: user.name, username: user.username }, now);
  if (profile.banned) return fail("banned", 403);
  const adminOnly = path.startsWith("/admin/");
  if (adminOnly && !ctx.isAdmin) return fail("forbidden", 403);
  if (cfg.maintenance && !ctx.isAdmin && path !== "/me" && path !== "/config") return fail("maintenance", 503);

  if (path.startsWith("/ludo/")) return ludoRoute(method, path, query, b, ctx, profile);

  switch (`${method} ${path}`) {
    case "GET /config":
      return ok({ maintenance: cfg.maintenance, modes: cfg.modes, limits: cfg.limits, characters: CHARACTERS, maps: MAPS.map((m) => ({ id: m.id, name: m.name })) });

    case "GET /me": {
      const room = await currentRoom(user.id);
      return ok({
        profile: profileView(profile, now), missions: missionsView(profile, now), maintenance: cfg.maintenance, modes: cfg.modes,
        room: room ? { code: room.code, status: room.status, phase: room.phase, mode: room.mode } : null, admin: ctx.isAdmin,
        ludo: await currentLudo(user.id).then((l) => (l ? { code: l.code, status: l.status, mode: l.mode } : null)),
        recent: profile.history.slice(0, 3),
      });
    }

    case "POST /settings": {
      const s = { sound: !!b.sound, music: !!b.music, reduceMotion: !!b.reduceMotion, haptics: !!b.haptics };
      await updateProfile(user.id, (p) => ({ ...p, settings: s }));
      return ok({ settings: s });
    }

    case "POST /profile/char": {
      const id = str(b.char, 16);
      if (!unlockedFor(profile.level).includes(id)) return fail("locked");
      await updateProfile(user.id, (p) => ({ ...p, char: id }));
      return ok({ char: id });
    }

    case "POST /room/create":
    case "POST /room/practice":
    case "POST /room/quick":
    case "POST /room/join": {
      const kind = path.split("/")[2];
      const existing = await currentRoom(user.id);
      let mode: Mode = kind === "practice" ? "practice" : kind === "quick" ? (b.ranked ? "ranked" : "quick") : "private";
      if (kind === "create" && b.mode === "friends") mode = "friends";
      if (existing && existing.status !== "finished") {
        if (kind === "join" && str(b.code, 5).toUpperCase() === existing.code) {
          return ok({ view: viewWithRewards(existing, user.id, now) });
        }
        return fail("already-in-room");
      }
      if (kind !== "join" && !cfg.modes[mode]) return fail("mode-disabled");

      if (kind === "join") {
        const code = str(b.code, 5).toUpperCase();
        if (!validCode(code)) return fail("bad-code");
        let err: string | null = null;
        const m = await mutate(code, now, rng, (room) => {
          const r = addPlayer(room, { uid: user.id, name: profile.name, char: profile.char }, now);
          if (!r.ok) err = r.error;
          else if (room.mode === "quick" || room.mode === "ranked") setReady(room, user.id, true, now);
        });
        if (!m) return fail("room-not-found", 404);
        if (err) return fail(err);
        await casUpdate(uKey(user.id), () => ({ code }));
        return ok({ view: viewWithRewards(m.room, user.id, now) });
      }

      if (kind === "quick") {
        // Try an open public lobby of the same mode first.
        const idx = await getJSON<{ codes: string[] }>("sa/idx");
        const rooms = await getMany<Room>((idx?.codes ?? []).map(rKey));
        const open = rooms.filter(
          (r) => r.status === "lobby" && r.settings.public && r.mode === mode && r.players.length < r.settings.maxPlayers && !r.players.some((p) => p.uid === user.id) && !r.players.some((p) => p.bot),
        ).sort((a, c) => c.players.length - a.players.length);
        for (const cand of open) {
          let err: string | null = null;
          const m = await mutate(cand.code, now, rng, (room) => {
            const r = addPlayer(room, { uid: user.id, name: profile.name, char: profile.char }, now);
            if (!r.ok) err = r.error;
            else setReady(room, user.id, true, now);
          });
          if (m && !err) {
            await casUpdate(uKey(user.id), () => ({ code: cand.code }));
            return ok({ view: viewWithRewards(m.room, user.id, now) });
          }
        }
      }

      // Create a new room.
      const pubOpts = { maxPlayers: Math.min(cfg.limits.maxPlayers, Math.max(cfg.limits.minPlayers, num(b.maxPlayers) || LIMITS.defaultSize)), spies: num(b.spies) || 1 };
      let code = "";
      let room!: Room;
      for (let i = 0; i < 6; i++) {
        code = makeCode(rng);
        room = newRoom(code, { uid: user.id, name: profile.name, char: profile.char }, mode, now, pubOpts);
        if (await createOnce(rKey(code), room)) break;
        code = "";
      }
      if (!code) return fail("try-again", 503);
      if (mode === "practice") {
        addBots(room, 5, now, rng);
        room.settings.public = false;
        room.players[0].ready = true;
      } else if (mode === "quick" || mode === "ranked") room.players[0].ready = true;
      await casUpdate<Room>(rKey(code), () => room);
      await indexAdd(code);
      await casUpdate(uKey(user.id), () => ({ code }));
      return ok({ view: viewWithRewards(room, user.id, now), code });
    }

    case "POST /room/leave": {
      const cur = await currentRoom(user.id);
      if (!cur) {
        await delKey(uKey(user.id));
        return ok({});
      }
      await mutate(cur.code, now, rng, (room) => removePlayer(room, user.id, now));
      await delKey(uKey(user.id));
      return ok({});
    }
  }

  // ---- everything below acts on the caller's current room
  if (path.startsWith("/room/")) {
    const code = str(b.code ?? query.code, 5).toUpperCase();
    const action = path.slice(6);
    if (!validCode(code)) return fail("bad-code");
    let reply: Record<string, unknown> = {};
    let error: string | null = null;
    const set = (r: { ok: boolean; [k: string]: any }) => {
      if (!r.ok) error = r.error ?? "failed";
      else reply = { ...r };
    };
    const m = await mutate(
      code, now, rng,
      (room) => {
        const me = room.players.find((p) => p.uid === user.id);
        if (!me) {
          error = "not-in-room";
          return;
        }
        switch (action) {
          case "tick":
          case "state":
            if (action === "tick" && b.x !== undefined && b.y !== undefined && room.phase === "explore") {
              const r = move(room, user.id, num(b.x), num(b.y), now);
              if (!r.ok && r.error !== "not-active" && r.error !== "wrong-phase") error = r.error;
            }
            break;
          case "ready": return set(setReady(room, user.id, !!b.ready, now));
          case "char": return set(setCharacter(room, user.id, str(b.char, 16)));
          case "settings": return set(setSettings(room, user.id, { maxPlayers: b.maxPlayers === undefined ? undefined : num(b.maxPlayers), spies: b.spies === undefined ? undefined : num(b.spies), public: b.public === undefined ? undefined : !!b.public }));
          case "start": return set(hostStart(room, user.id, now, rng));
          case "interact": return set(interact(room, user.id, str(b.obj, 8), now));
          case "ability": return set(useAbility(room, user.id, str(b.ability, 12), { obj: str(b.obj, 8), target: b.target === undefined ? undefined : num(b.target) }, now, rng));
          case "chat": return set(chat(room, user.id, { text: typeof b.text === "string" ? b.text : undefined, quick: typeof b.quick === "string" ? b.quick : undefined, target: b.target === undefined ? undefined : num(b.target) }, now));
          case "share": return set(shareClue(room, user.id, str(b.clue, 12), now));
          case "vote": return set(vote(room, user.id, num(b.target) || 0, now));
          case "report": {
            const t = room.players.find((p) => p.uid === num(b.target));
            if (!t || t.uid === user.id) return void (error = "bad-target");
            t.reports++;
            if (t.reports >= 3 && !t.bot) t.muted = true; // enough reports from different moments mutes chat for the match
            reply = { reported: t.uid };
            return;
          }
          default:
            error = "unknown-action";
        }
      },
      { touchUid: user.id },
    );
    if (!m) return fail("room-not-found", 404);
    if (action === "report" && !error) await addReport({ reporter: user.id, target: num(b.target), reason: str(b.reason, 200) || "unspecified", code, matchId: m.room.matchId }, now);
    const room = await settleIfFinished(m.room, now);
    if (error) return { status: 400, body: { ok: false, error, view: viewWithRewards(room, user.id, now) } };
    return ok({ ...reply, view: viewWithRewards(room, user.id, now) });
  }

  switch (`${method} ${path}`) {
    case "GET /leaderboard": {
      const board = (["global", "weekly", "monthly", "ranked", "friends"].includes(query.board) ? query.board : "global") as Board;
      const r = await leaderboard(board, user.id, { page: Number(query.page) || 0, size: Number(query.size) || 20, q: query.q }, now);
      return ok(r as unknown as Record<string, unknown>);
    }
    case "GET /missions":
      return ok({ missions: missionsView(profile, now), daily: profileView(profile, now).daily, achievements: achievementsView(profile) });
    case "POST /missions/claim": {
      const r = await claimMission(user.id, str(b.id, 24), now);
      return r.ok ? ok({ reward: r.reward, coins: r.coins }) : fail(r.error);
    }
    case "POST /daily/claim": {
      const r = await claimDaily(user.id, now);
      return r.ok ? ok({ amount: r.amount, streak: r.streak, coins: r.coins }) : fail(r.error);
    }
    case "GET /history": {
      const rows = (await getMany<any>(profile.history.map((id) => `sa/m/${id}`))).sort((a, c) => (c.endedAt ?? 0) - (a.endedAt ?? 0));
      return ok({
        matches: rows.map((m) => {
          const me = m.players.find((p: any) => p.uid === user.id);
          return { matchId: m.matchId, mode: m.mode, map: m.map, endedAt: m.endedAt, duration: m.duration, winner: m.winner, role: me?.role, won: !!me?.won, players: m.players.length };
        }),
        coins: await coinHistory(user.id, 15),
      });
    }
    case "GET /match": {
      const id = str(query.id, 40);
      if (!profile.history.includes(id) && !ctx.isAdmin) return fail("forbidden", 403);
      const m = await getMatchSummary(id);
      return m ? ok({ match: m }) : fail("not-found", 404);
    }
    case "GET /profile": {
      return ok({ profile: profileView(profile, now), achievements: achievementsView(profile), levelFromXp: levelOf(profile.xp) });
    }

    case "GET /admin/dashboard": {
      const profiles = await getMany<Profile>(await listKeys("sa/p/"));
      const idx = await getJSON<{ codes: string[] }>("sa/idx");
      const rooms = await getMany<Room>((idx?.codes ?? []).map(rKey));
      const summaries = await getMany<any>(await listKeys("sa/m/"));
      const today = dayKey(now);
      const todays = summaries.filter((m) => m.endedAt && dayKey(m.endedAt) === today);
      const maps: Record<string, number> = {};
      for (const m of summaries) maps[m.map] = (maps[m.map] ?? 0) + 1;
      const reports = await listReports(50);
      return ok({
        players: profiles.length, active24h: profiles.filter((p) => now - p.last < 86400000).length, banned: profiles.filter((p) => p.banned).length,
        activeMatches: rooms.filter((r) => r.status === "playing").length, lobbies: rooms.filter((r) => r.status === "lobby").length,
        completed: summaries.length, playedToday: todays.length, cancelled: rooms.filter((r) => r.status === "cancelled").length,
        avgDuration: summaries.length ? Math.round(summaries.reduce((s, m) => s + (m.duration ?? 0), 0) / summaries.length) : 0,
        popularMaps: Object.entries(maps).sort((a, c) => c[1] - a[1]).slice(0, 6), openReports: reports.filter((r) => r.status === "open").length,
        errors: (await getJSON<{ n: number; last?: string }>("sa/err")) ?? { n: 0 }, config: cfg,
      });
    }
    case "GET /admin/reports":
      return ok({ reports: await listReports(40) });
    case "POST /admin/report": {
      const done = await resolveReport(str(b.id, 40), b.status === "dismissed" ? "dismissed" : "resolved");
      if (done) await audit(user.id, "report", str(b.id, 40), { status: b.status }, now);
      return done ? ok({}) : fail("not-found", 404);
    }
    case "GET /admin/player": {
      const uid = Number(query.uid);
      const p = await getProfile(uid);
      return p ? ok({ profile: p, coins: await coinHistory(uid, 20) }) : fail("not-found", 404);
    }
    case "POST /admin/ban":
    case "POST /admin/unban": {
      const uid = num(b.uid);
      const banned = path.endsWith("/ban");
      const p = await updateProfile(uid, (q) => ({ ...q, banned, banReason: banned ? str(b.reason, 120) || "unspecified" : undefined }));
      if (!p) return fail("not-found", 404);
      await audit(user.id, banned ? "ban" : "unban", String(uid), { reason: str(b.reason, 120) }, now);
      return ok({});
    }
    case "POST /admin/config": {
      const patch: any = {};
      if (b.rewards && typeof b.rewards === "object") {
        patch.rewards = {};
        for (const [k, v] of Object.entries(b.rewards)) if (typeof v === "number" && v >= 0 && v <= 10000) patch.rewards[k] = v;
      }
      if (b.modes && typeof b.modes === "object") patch.modes = Object.fromEntries(Object.entries(b.modes).map(([k, v]) => [k, !!v]));
      if (typeof b.maintenance === "boolean") patch.maintenance = b.maintenance;
      if (b.limits && typeof b.limits === "object") {
        const l = b.limits as any;
        patch.limits = {};
        if (Number.isInteger(l.minPlayers) && l.minPlayers >= 3 && l.minPlayers <= 10) patch.limits.minPlayers = l.minPlayers;
        if (Number.isInteger(l.maxPlayers) && l.maxPlayers >= 4 && l.maxPlayers <= 10) patch.limits.maxPlayers = l.maxPlayers;
      }
      return ok({ config: await saveCfg(patch, user.id, now) });
    }
    case "GET /admin/audit":
      return ok({ audit: await recentAudit(40) });
  }

  return fail("not-found", 404);
}

// exposed for tests and the scheduler
export const MISSION_DEFS = MISSIONS;
export const UNLOCK_LEVEL = unlockLevel;
export { TIMINGS_REF };

/** Scheduler hook: drops finished/cancelled rooms from the index after a while and settles unrewarded matches. */
export async function sweepAgentRooms(now: number) {
  const idx = await getJSON<{ codes: string[] }>("sa/idx");
  if (!idx) return;
  const keep: string[] = [];
  for (const code of idx.codes) {
    const m = await mutate(code, now, undefined, () => undefined);
    if (!m) continue;
    const room = await settleIfFinished(m.room, now);
    const done = room.status === "finished" || room.status === "cancelled";
    if (done && now - (room.endedAt ?? now) > 60 * 60_000) {
      await delKey(rKey(code));
      continue;
    }
    keep.push(code);
  }
  await casUpdate("sa/idx", () => ({ codes: keep }));

  // Ludo rooms: settle finished matches and drop old rooms
  const lidx = await getJSON<{ codes: string[] }>("sa/lidx");
  if (lidx) {
    const lkeep: string[] = [];
    for (const code of lidx.codes) {
      const m = await mutateLudo(code, now, undefined, () => undefined);
      if (!m) continue;
      const room = await settleLudo(m.room, now);
      const done = room.status === "finished" || room.status === "cancelled";
      if (done && now - (room.endedAt ?? now) > 60 * 60_000) {
        await delKey(lrKey(code));
        continue;
      }
      lkeep.push(code);
    }
    await casUpdate("sa/lidx", () => ({ codes: lkeep }));
  }
}


// ================================================================ Ludo
const lrKey = (c: string) => `sa/lr/${c}`;
const luKey = (uid: number) => `sa/lu/${uid}`;

async function currentLudo(uid: number): Promise<LudoRoom | null> {
  const ptr = await getJSON<{ code: string }>(luKey(uid));
  if (!ptr) return null;
  const room = await getJSON<LudoRoom>(lrKey(ptr.code));
  if (!room) return null;
  const me = room.seats.find((x) => x.uid === uid);
  if (!me || me.left || room.status === "cancelled") return null;
  if (room.status === "finished" && room.endedAt && Date.now() - room.endedAt > 10 * 60_000) return null;
  return room;
}

/** Same pattern as mutate(): catch the clock up, apply the change, write back atomically, skip no-op writes. */
async function mutateLudo<T>(code: string, now: number, rng: Rng | undefined, fn: (room: LudoRoom) => T, touchUid?: number): Promise<{ room: LudoRoom; result: T } | null> {
  let result!: T;
  let missing = false;
  const saved = await casUpdate<LudoRoom>(lrKey(code), (cur) => {
    missing = !cur;
    if (!cur) return undefined;
    const before = JSON.stringify(cur);
    if (touchUid !== undefined) {
      const s = cur.seats.find((x) => x.uid === touchUid);
      if (s && (now - s.lastSeen > 4000 || !s.connected)) {
        s.lastSeen = now;
        s.connected = true;
      }
    }
    advanceLudo(cur, now, rng);
    result = fn(cur);
    advanceLudo(cur, now, rng);
    if (JSON.stringify(cur) === before) return undefined;
    cur.seq++;
    return cur;
  });
  if (missing || !saved) return null;
  return { room: saved, result };
}

async function settleLudo(room: LudoRoom, now: number): Promise<LudoRoom> {
  if (room.status !== "finished" || room.rewarded || room.winner === null) return room;
  const win = room.seats[room.winner];
  const outcome = {
    winner: "agents" as const, reason: `${win.name} brought all four tokens home.`,
    players: room.seats.map((s, i) => ({
      uid: s.uid, name: s.name, char: s.char, bot: s.bot, role: "agent" as const, alive: true, left: s.left || s.auto && !s.bot, won: i === room.winner,
      stats: { tasks: 0, clues: 0, votes: 0, correctVotes: 0, sabotages: 0, repairs: 0, fakes: 0, abilities: 0, chats: 0 },
    })),
  };
  const results = await finalizeCore({
    matchId: room.matchId, mode: room.mode, outcome, startedAt: room.startedAt, endedAt: room.endedAt, game: "ludo",
    summary: { code: room.code, winner: win.name, rounds: 0, map: "ludo" },
  }, now);
  const saved = await casUpdate<LudoRoom>(lrKey(room.code), (cur) => {
    if (!cur || cur.rewarded) return undefined;
    cur.rewarded = true;
    if (results) cur.rewards = results as unknown as Record<string, unknown>;
    return cur;
  });
  return saved ?? room;
}

function ludoReply(room: LudoRoom, uid: number, now: number) {
  const v = ludoView(room, uid, now);
  const rewards = room.rewards?.[String(uid)] as RewardResult | undefined;
  const standings = room.status === "finished" ? ludoStandings(room).map((x) => ({ name: x.s.name, char: x.s.char, color: x.s.color, home: x.s.tokens.filter((p) => p === 56).length, won: x.i === room.winner, bot: x.s.bot })) : undefined;
  return { ...v, rewards, rewardsPending: room.status === "finished" && !room.rewards, standings };
}

async function ludoRoute(method: string, path: string, query: Record<string, string>, b: any, ctx: Ctx, profile: Profile): Promise<Res> {
  const { user, now, rng } = ctx;
  const action = path.slice(6);
  const cfg = await getCfg();

  if (action === "create" || action === "practice" || action === "join") {
    const existing = await currentLudo(user.id);
    const agentRoom = await currentRoom(user.id);
    if (agentRoom && agentRoom.status !== "finished") return fail("already-in-room");
    if (existing && existing.status !== "finished") {
      if (action === "join" && str(b.code, 5).toUpperCase() === existing.code) return ok({ view: ludoReply(existing, user.id, now) });
      return fail("already-in-room");
    }
    if (action === "join") {
      const code = str(b.code, 5).toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return fail("bad-code");
      let err: string | null = null;
      const m = await mutateLudo(code, now, rng, (room) => {
        const r = ludoAddSeat(room, { uid: user.id, name: profile.name, char: profile.char }, now);
        if (!r.ok) err = r.error;
      });
      if (!m) return fail("room-not-found", 404);
      if (err) return fail(err);
      await casUpdate(luKey(user.id), () => ({ code }));
      return ok({ view: ludoReply(m.room, user.id, now) });
    }
    if (!cfg.modes[action === "practice" ? "practice" : "private"]) return fail("mode-disabled");
    const players = Math.min(4, Math.max(2, Number(b.players) || 4));
    let room!: LudoRoom;
    let code = "";
    for (let i = 0; i < 6; i++) {
      code = ludoCode(rng);
      room = newLudoRoom(code, { uid: user.id, name: profile.name, char: profile.char }, action === "practice" ? "practice" : "private", players, now, Number(b.tokens) === 2 ? 2 : 4);
      if (action === "practice") {
        addLudoBots(room, now, rng);
        startLudo(room, now);
      }
      if (await createOnce(lrKey(code), room)) break;
      code = "";
    }
    if (!code) return fail("try-again", 503);
    await casUpdate<{ codes: string[] }>("sa/lidx", (c) => ({ codes: [...new Set([...(c?.codes ?? []), code])].slice(-300) }));
    await casUpdate(luKey(user.id), () => ({ code }));
    return ok({ view: ludoReply(room, user.id, now), code });
  }

  if (action === "leave") {
    const cur = await currentLudo(user.id);
    if (cur) await mutateLudo(cur.code, now, rng, (room) => ludoRemoveSeat(room, user.id, now));
    await delKey(luKey(user.id));
    return ok({});
  }

  const code = str(b.code ?? query.code, 5).toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return fail("bad-code");
  let error: string | null = null;
  let extra: Record<string, unknown> = {};
  const m = await mutateLudo(code, now, rng, (room) => {
    const idx = ludoSeatIndex(room, user.id);
    if (idx < 0) {
      error = "not-in-room";
      return;
    }
    switch (action) {
      case "tick":
      case "state":
        break;
      case "start": {
        if (room.host !== user.id) return void (error = "host-only");
        const r = startLudo(room, now);
        if (!r.ok) error = r.error;
        break;
      }
      case "addbot": {
        if (room.host !== user.id) return void (error = "host-only");
        if (room.status !== "lobby") return void (error = "match-started");
        if (room.seats.length >= room.maxPlayers) return void (error = "room-full");
        const before = room.seats.length;
        const mx = room.maxPlayers;
        room.maxPlayers = before + 1; // add exactly one bot
        addLudoBots(room, now, rng);
        room.maxPlayers = mx;
        break;
      }
      case "settings": {
        if (room.host !== user.id) return void (error = "host-only");
        const n = Math.floor(Number(b.players));
        if (room.status !== "lobby" || !(n >= Math.max(2, room.seats.length) && n <= 4)) return void (error = "bad-size");
        room.maxPlayers = n;
        break;
      }
      case "roll": {
        const r = ludoRoll(room, user.id, now, rng);
        if (!r.ok) error = r.error;
        else extra = { value: r.value, moved: r.moved };
        break;
      }
      case "move": {
        const r = ludoMove(room, user.id, Number(b.token), now);
        if (!r.ok) error = r.error;
        else extra = { captured: r.captured, finished: r.finished };
        break;
      }
      default:
        error = "unknown-action";
    }
  }, user.id);
  if (!m) return fail("room-not-found", 404);
  const room = await settleLudo(m.room, now);
  const view = ludoReply(room, user.id, now);
  void LUDO;
  if (error) return { status: 400, body: { ok: false, error, view } };
  return ok({ ...extra, view });
}
