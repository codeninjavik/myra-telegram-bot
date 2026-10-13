import { CHARACTERS, WORLD, charById, dist, mapById, walkable, MAPS, type GameMap } from "./maps.js";

// SECRET AGENT game engine. Pure and deterministic given (state, now, rng): no storage, no Telegram. The server is the
// only place this runs; clients send intentions (move here, use that object, vote for X) and receive a filtered view.

export type Role = "spy" | "detective" | "hacker" | "guard" | "agent";
export type Phase = "lobby" | "countdown" | "briefing" | "explore" | "discussion" | "voting" | "result" | "over";
export type Mode = "quick" | "private" | "friends" | "practice" | "ranked";
export type Rng = () => number;

export type Timings = { countdown: number; briefing: number; explore: number; discussion: number; voting: number; result: number; grace: number; lobbyIdle: number };
export const TIMINGS: Timings = { countdown: 5000, briefing: 9000, explore: 70000, discussion: 30000, voting: 20000, result: 7000, grace: 45000, lobbyIdle: 90000 };

export const LIMITS = {
  minPlayers: 4, maxPlayers: 10, defaultSize: 6, maxRounds: 4, speed: 150, dashFactor: 1.8, interact: 62, abilityRange: 90, vision: 300,
  sabotageToWin: 3, sabotageUses: 4, sabotageCd: 20000, distractCd: 30000, dashCd: 25000, dashMs: 4000, actCd: 1200, chatCd: 1500,
  chatMax: 120, vote: { abstain: 0 }, maxChat: 60, maxEvents: 30,
};

export type Clue = { id: string; objId: string; round: number; category: "footprint" | "log" | "camera" | "report"; tier: "verified" | "smudged" | "unsigned" | "neutral"; text: string };
export type Note = { at: number; text: string };
export type RP = {
  uid: number; name: string; char: string; bot: boolean; ready: boolean; alive: boolean; left: boolean;
  x: number; y: number; connected: boolean; lastSeen: number; lastMove: number; lastAct: number; lastChat: number;
  role?: Role;
  clues: string[]; notes: Note[];
  stats: { tasks: number; clues: number; votes: number; correctVotes: number; sabotages: number; repairs: number; fakes: number; abilities: number; chats: number };
  cd: { sabotage: number; distract: number; dash: number };
  uses: { sabotage: number; shield: number };
  roundUse: { inspect: number; scan: number }; // round number of last use
  dashUntil: number; shielded: boolean; sabRound: number; muted: boolean; botTarget?: string; botAt?: number; reports: number;
};
export type ChatMsg = { id: number; uid: number; name: string; char: string; text: string; at: number; kind: "chat" | "quick" | "evidence" | "system" };
export type GameEvent = { id: number; at: number; kind: string; text: string; obj?: string };
export type VoteResult = { round: number; tally: Record<string, number>; abstain: number; eliminated: number | null; team: "spy" | "agent" | null; shielded: boolean; tie: boolean };
export type Outcome = {
  winner: "agents" | "spy"; reason: string;
  players: { uid: number; name: string; char: string; bot: boolean; role: Role; alive: boolean; left: boolean; won: boolean; stats: RP["stats"] }[];
};

export type Room = {
  code: string; mode: Mode; host: number; status: "lobby" | "playing" | "finished" | "cancelled"; createdAt: number;
  settings: { maxPlayers: number; spies: number; ranked: boolean; public: boolean };
  players: RP[]; mapId: string; phase: Phase; phaseStart: number; phaseEnd: number; round: number;
  objects: { id: string; state: "ok" | "sabotaged"; doneRound: number; lastUse?: { uid: number; real: boolean; at: number; round: number } }[];
  taskDone: number; taskGoal: number; meter: number;
  clues: Clue[]; chat: ChatMsg[]; events: GameEvent[]; votes: Record<string, number>; lastVote?: VoteResult; history: VoteResult[];
  seq: number; matchId: string; startedAt?: number; endedAt?: number; outcome?: Outcome; cancelReason?: string;
  rewarded: boolean; nextId: number; botAt: number; rewards?: Record<string, unknown>;
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const makeCode = (rng: Rng = Math.random) => Array.from({ length: 5 }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join("");
export const validCode = (c: string) => /^[A-HJ-NP-Z2-9]{5}$/.test(c);
const pickOne = <T>(a: T[], rng: Rng): T => a[Math.floor(rng() * a.length)];
const shuffle = <T>(a: T[], rng: Rng): T[] => {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

export const QUICK: Record<string, string> = {
  found: "I found suspicious evidence.",
  security: "Check the security room.",
  task: "I was completing a task.",
  suspect: "I suspect this player.",
  more: "We need more evidence.",
};

type Err = { ok: false; error: string };
const err = (error: string): Err => ({ ok: false, error });

function newPlayer(u: { uid: number; name: string; char: string; bot?: boolean }, now: number): RP {
  return {
    uid: u.uid, name: u.name.slice(0, 24), char: u.char, bot: !!u.bot, ready: !!u.bot, alive: true, left: false,
    x: 400, y: 240, connected: true, lastSeen: now, lastMove: now, lastAct: 0, lastChat: 0,
    clues: [], notes: [], stats: { tasks: 0, clues: 0, votes: 0, correctVotes: 0, sabotages: 0, repairs: 0, fakes: 0, abilities: 0, chats: 0 },
    cd: { sabotage: 0, distract: 0, dash: 0 }, uses: { sabotage: 0, shield: 0 }, roundUse: { inspect: 0, scan: 0 },
    dashUntil: 0, shielded: false, sabRound: 0, muted: false, reports: 0,
  };
}

// ---------------------------------------------------------------- lobby
export function newRoom(code: string, host: { uid: number; name: string; char?: string }, mode: Mode, now: number, opts: { maxPlayers?: number; spies?: number; public?: boolean } = {}): Room {
  const size = Math.min(LIMITS.maxPlayers, Math.max(LIMITS.minPlayers, opts.maxPlayers ?? LIMITS.defaultSize));
  const room: Room = {
    code, mode, host: host.uid, status: "lobby", createdAt: now,
    settings: { maxPlayers: size, spies: Math.max(1, opts.spies ?? 1), ranked: mode === "ranked", public: opts.public ?? (mode === "quick" || mode === "ranked") },
    players: [], mapId: MAPS[0].id, phase: "lobby", phaseStart: now, phaseEnd: 0, round: 0, objects: [],
    taskDone: 0, taskGoal: 0, meter: 0, clues: [], chat: [], events: [], votes: {}, history: [], seq: 0,
    matchId: `${code}-${now.toString(36)}`, rewarded: false, nextId: 1, botAt: now,
  };
  room.players.push(newPlayer({ uid: host.uid, name: host.name, char: host.char ?? CHARACTERS[0].id }, now));
  return room;
}

const freeChar = (room: Room, want?: string) => {
  const used = new Set(room.players.map((p) => p.char));
  if (want && !used.has(want) && CHARACTERS.some((c) => c.id === want)) return want;
  return CHARACTERS.find((c) => !used.has(c.id))?.id ?? null;
};

export function maxSpies(n: number) {
  return Math.max(1, Math.floor((n - 1) / 3));
}

export function addPlayer(room: Room, u: { uid: number; name: string; char?: string; bot?: boolean }, now: number): Err | { ok: true } {
  if (room.status !== "lobby") return err("match-started");
  if (room.players.some((p) => p.uid === u.uid)) return err("already-in");
  if (room.players.length >= room.settings.maxPlayers) return err("room-full");
  const char = freeChar(room, u.char);
  if (!char) return err("room-full");
  room.players.push(newPlayer({ ...u, char }, now));
  cancelCountdown(room, now);
  return { ok: true };
}

export function removePlayer(room: Room, uid: number, now: number) {
  const p = room.players.find((x) => x.uid === uid);
  if (!p) return;
  if (room.status === "lobby") {
    room.players = room.players.filter((x) => x.uid !== uid);
    if (room.host === uid) {
      const next = room.players.find((x) => !x.bot);
      if (next) room.host = next.uid;
    }
    cancelCountdown(room, now);
  } else if (room.status === "playing") {
    p.left = true;
    p.connected = false;
    if (p.alive) {
      p.alive = false;
      event(room, now, "left", `${p.name} left the mission.`);
    }
    checkWin(room, now);
  }
}

export function setReady(room: Room, uid: number, ready: boolean, now: number): Err | { ok: true } {
  const p = room.players.find((x) => x.uid === uid);
  if (!p || room.status !== "lobby") return err("not-in-lobby");
  p.ready = ready;
  if (!ready) cancelCountdown(room, now);
  return { ok: true };
}

export function setCharacter(room: Room, uid: number, char: string): Err | { ok: true } {
  const p = room.players.find((x) => x.uid === uid);
  if (!p || room.status !== "lobby") return err("not-in-lobby");
  if (!CHARACTERS.some((c) => c.id === char)) return err("bad-character");
  if (room.players.some((x) => x.char === char && x.uid !== uid)) return err("character-taken");
  p.char = char;
  return { ok: true };
}

export function setSettings(room: Room, uid: number, s: { maxPlayers?: number; spies?: number; public?: boolean }): Err | { ok: true } {
  if (room.host !== uid) return err("host-only");
  if (room.status !== "lobby") return err("match-started");
  if (s.maxPlayers !== undefined) {
    const n = Math.floor(s.maxPlayers);
    if (n < Math.max(LIMITS.minPlayers, room.players.length) || n > LIMITS.maxPlayers) return err("bad-size");
    room.settings.maxPlayers = n;
  }
  if (s.spies !== undefined) {
    const n = Math.floor(s.spies);
    if (n < 1 || n > maxSpies(Math.max(room.players.length, LIMITS.minPlayers))) return err("bad-spies");
    room.settings.spies = n;
  }
  if (s.public !== undefined && room.mode !== "ranked") room.settings.public = !!s.public;
  return { ok: true };
}

function cancelCountdown(room: Room, now: number) {
  if (room.phase === "countdown") {
    room.phase = "lobby";
    room.phaseStart = now;
    room.phaseEnd = 0;
  }
}

const eligible = (room: Room) => room.players.length >= LIMITS.minPlayers && room.players.every((p) => p.ready || p.bot);

/** Host pressed Start: needs the minimum number of players; a player who is not ready does not block the host. */
export function hostStart(room: Room, uid: number, now: number, rng: Rng = Math.random): Err | { ok: true } {
  if (room.host !== uid) return err("host-only");
  if (room.status !== "lobby") return err("match-started");
  if (room.players.length < LIMITS.minPlayers) return err("need-more-players");
  startGame(room, now, rng);
  return { ok: true };
}

// ---------------------------------------------------------------- start / roles
function roleSet(n: number, spies: number): Role[] {
  const roles: Role[] = [];
  for (let i = 0; i < spies; i++) roles.push("spy");
  // 4 players: spy, detective, hacker, agent. The guard joins from 5 players.
  const specials: Role[] = n >= 5 ? ["detective", "hacker", "guard"] : ["detective", "hacker"];
  for (const r of specials) if (roles.length < n) roles.push(r);
  while (roles.length < n) roles.push("agent");
  return roles;
}

export function startGame(room: Room, now: number, rng: Rng = Math.random) {
  const n = room.players.length;
  const spies = Math.min(room.settings.spies, maxSpies(n));
  const roles = shuffle(roleSet(n, spies), rng);
  const map = pickOne(MAPS, rng);
  room.mapId = map.id;
  const spawns = shuffle(map.spawns, rng);
  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.x = spawns[i % spawns.length].x;
    p.y = spawns[i % spawns.length].y;
    p.lastMove = now;
    p.lastSeen = now;
  });
  room.objects = map.objects.map((o) => ({ id: o.id, state: "ok" as const, doneRound: 0 }));
  room.taskGoal = map.objects.length * 2;
  room.taskDone = 0;
  room.meter = 0;
  room.round = 1;
  room.status = "playing";
  room.startedAt = now;
  room.chat = [];
  room.events = [];
  room.votes = {};
  room.history = [];
  setPhase(room, "briefing", now, TIMINGS_REF.t.briefing);
  event(room, now, "start", `Mission started on ${map.name}.`);
}

// timings are overridable (tests use short ones) through the object below
export const TIMINGS_REF = { t: { ...TIMINGS } };

function setPhase(room: Room, phase: Phase, now: number, dur: number) {
  room.phase = phase;
  room.phaseStart = now;
  room.phaseEnd = dur > 0 ? now + dur : 0;
}

function event(room: Room, now: number, kind: string, text: string, obj?: string) {
  room.events.push({ id: room.nextId++, at: now, kind, text, obj });
  if (room.events.length > LIMITS.maxEvents) room.events.shift();
}

function say(room: Room, p: { uid: number; name: string; char: string }, text: string, kind: ChatMsg["kind"], now: number) {
  room.chat.push({ id: room.nextId++, uid: p.uid, name: p.name, char: p.char, text, at: now, kind });
  if (room.chat.length > LIMITS.maxChat) room.chat.shift();
}

// ---------------------------------------------------------------- clues
function colorOf(char: string) {
  return charById(char).colorName;
}

export function generateClues(room: Room, rng: Rng): Clue[] {
  const map = mapById(room.mapId);
  const spy = room.players.find((p) => p.role === "spy" && p.alive) ?? room.players.find((p) => p.role === "spy");
  const innocents = room.players.filter((p) => p.role !== "spy" && p.alive);
  const spots = shuffle(map.objects, rng).slice(0, Math.min(4, map.objects.length));
  const cats: Clue["category"][] = ["footprint", "log", "camera", "report"];
  const out: Clue[] = [];
  spots.forEach((o, i) => {
    const category = cats[i % cats.length];
    let tier: Clue["tier"];
    // Round 1 always carries one verified clue so every match can be solved by careful players.
    if (room.round === 1 && i === 0 && spy) tier = "verified";
    else tier = pickOne(["verified", "smudged", "smudged", "unsigned", "neutral", "neutral"] as Clue["tier"][], rng);
    let text: string;
    if (tier === "neutral" || !spy) {
      text = pickOne([
        `Power draw spiked near the ${o.room}.`,
        `The ${o.label.toLowerCase()} was used recently, nothing out of place.`,
        `A door log shows two people passed the ${o.room} within a minute.`,
        `Camera feed at the ${o.room} had a short dropout.`,
      ], rng);
    } else if (tier === "verified") {
      text = `Verified ${category} data: a ${colorOf(spy.char)} suit was at the ${o.label.toLowerCase()} while a system failed.`;
    } else if (tier === "smudged") {
      const real = rng() < 0.5 || innocents.length === 0;
      const c = real ? colorOf(spy.char) : colorOf(pickOne(innocents, rng).char);
      text = `Smudged ${category} note: it looks like a ${c} suit was near the ${o.room}.`;
    } else {
      const real = rng() < 0.25 || innocents.length === 0;
      const c = real ? colorOf(spy.char) : colorOf(pickOne(innocents, rng).char);
      text = `Unsigned tip: someone in ${c} was acting strange by the ${o.label.toLowerCase()}.`;
    }
    out.push({ id: `c${room.round}-${i}`, objId: o.id, round: room.round, category, tier, text });
  });
  return out;
}

// ---------------------------------------------------------------- win conditions
export function checkWin(room: Room, now: number): boolean {
  if (room.status !== "playing") return true;
  const alive = room.players.filter((p) => p.alive && !p.left);
  const spies = alive.filter((p) => p.role === "spy").length;
  const others = alive.length - spies;
  const allSpies = room.players.filter((p) => p.role === "spy");
  if (allSpies.length && allSpies.every((p) => !p.alive)) return endGame(room, "agents", "The Spy was identified and removed.", now);
  if (room.meter >= LIMITS.sabotageToWin) return endGame(room, "spy", "Sabotage overwhelmed the facility.", now);
  if (room.taskDone >= room.taskGoal) return endGame(room, "agents", "All mission objectives were completed.", now);
  if (spies > 0 && spies >= others) return endGame(room, "spy", "The Spy outnumbers the remaining agents.", now);
  return false;
}

export function endGame(room: Room, winner: "agents" | "spy", reason: string, now: number): true {
  room.status = "finished";
  setPhase(room, "over", now, 0);
  room.endedAt = now;
  room.outcome = {
    winner, reason,
    players: room.players.map((p) => ({
      uid: p.uid, name: p.name, char: p.char, bot: p.bot, role: p.role ?? "agent", alive: p.alive, left: p.left,
      won: (p.role === "spy") === (winner === "spy"), stats: p.stats,
    })),
  };
  event(room, now, "end", winner === "spy" ? "The Spy wins." : "The agents win.");
  return true;
}

export function cancelRoom(room: Room, reason: string, now: number) {
  room.status = "cancelled";
  room.cancelReason = reason;
  room.endedAt = now;
  setPhase(room, "over", now, 0);
}

// ---------------------------------------------------------------- actions
export function touch(room: Room, uid: number, now: number) {
  const p = room.players.find((x) => x.uid === uid);
  if (p && !p.left) {
    p.lastSeen = now;
    p.connected = true;
  }
}

export function move(room: Room, uid: number, x: number, y: number, now: number): Err | { ok: true; x: number; y: number; corrected: boolean } {
  const p = room.players.find((q) => q.uid === uid);
  if (!p || room.status !== "playing" || !p.alive) return err("not-active");
  if (room.phase !== "explore") return err("wrong-phase");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return err("bad-input");
  const map = mapById(room.mapId);
  const dt = Math.min(1.5, Math.max(0.05, (now - p.lastMove) / 1000));
  const speed = LIMITS.speed * (p.dashUntil > now ? LIMITS.dashFactor : 1);
  const max = speed * dt * 1.35 + 6;
  let tx = x, ty = y;
  const d = dist(p, { x, y });
  let corrected = false;
  if (d > max) {
    tx = p.x + ((x - p.x) / d) * max;
    ty = p.y + ((y - p.y) / d) * max;
    corrected = true;
  }
  if (!walkable(map, tx, ty)) {
    // slide along an obstacle: try each axis on its own, otherwise stay
    if (walkable(map, tx, p.y)) ty = p.y;
    else if (walkable(map, p.x, ty)) tx = p.x;
    else (tx = p.x), (ty = p.y);
    corrected = true;
  }
  p.x = Math.round(tx * 10) / 10;
  p.y = Math.round(ty * 10) / 10;
  p.lastMove = now;
  return { ok: true, x: p.x, y: p.y, corrected };
}

function objectDef(room: Room, id: string) {
  return mapById(room.mapId).objects.find((o) => o.id === id);
}

export function interact(room: Room, uid: number, objId: string, now: number): Err | { ok: true; kind: "task" | "repair" | "fake"; clue?: string; progress: number } {
  const p = room.players.find((q) => q.uid === uid);
  if (!p || room.status !== "playing" || !p.alive) return err("not-active");
  if (room.phase !== "explore") return err("wrong-phase");
  const def = objectDef(room, objId);
  const st = room.objects.find((o) => o.id === objId);
  if (!def || !st) return err("no-such-object");
  if (dist(p, def) > LIMITS.interact) return err("too-far");
  if (now - p.lastAct < LIMITS.actCd) return err("too-fast");
  p.lastAct = now;

  let kind: "task" | "repair" | "fake";
  if (st.state === "sabotaged") {
    if (p.role === "spy") return err("sabotaged");
    st.state = "ok";
    room.meter = Math.max(0, room.meter - 1);
    p.stats.repairs++;
    kind = "repair";
    event(room, now, "repair", `${def.label} was repaired.`, st.id);
    st.lastUse = { uid, real: true, at: now, round: room.round };
  } else if (p.role === "spy") {
    // The spy "completes" the task: identical feedback, no progress. Hackers can notice the integrity failure.
    p.stats.fakes++;
    kind = "fake";
    st.lastUse = { uid, real: false, at: now, round: room.round };
  } else {
    if (st.doneRound === room.round) return err("already-done");
    st.doneRound = room.round;
    room.taskDone++;
    p.stats.tasks++;
    kind = "task";
    st.lastUse = { uid, real: true, at: now, round: room.round };
  }

  let clueText: string | undefined;
  const clue = room.clues.find((c) => c.objId === objId && c.round === room.round);
  if (clue && !p.clues.includes(clue.id)) {
    p.clues.push(clue.id);
    p.stats.clues++;
    clueText = clue.text;
    p.notes.push({ at: now, text: `Clue: ${clue.text}` });
  }
  checkWin(room, now);
  return { ok: true, kind, clue: clueText, progress: room.taskDone };
}

export function useAbility(
  room: Room, uid: number, ability: string, arg: { obj?: string; target?: number }, now: number, rng: Rng = Math.random,
): Err | { ok: true; message: string } {
  const p = room.players.find((q) => q.uid === uid);
  if (!p || room.status !== "playing" || !p.alive) return err("not-active");
  if (room.phase !== "explore") return err("wrong-phase");
  if (now - p.lastAct < 400) return err("too-fast");
  p.lastAct = now;
  const map = mapById(room.mapId);

  if (p.role === "spy") {
    if (ability === "sabotage") {
      if (p.uses.sabotage >= LIMITS.sabotageUses) return err("no-uses-left");
      if (now < p.cd.sabotage) return err("cooldown");
      const def = objectDef(room, arg.obj ?? "");
      const st = room.objects.find((o) => o.id === arg.obj);
      if (!def || !st) return err("no-such-object");
      if (dist(p, def) > LIMITS.interact) return err("too-far");
      if (st.state === "sabotaged") return err("already-sabotaged");
      st.state = "sabotaged";
      room.meter++;
      p.uses.sabotage++;
      p.cd.sabotage = now + LIMITS.sabotageCd;
      p.sabRound = room.round;
      p.stats.sabotages++;
      p.stats.abilities++;
      event(room, now, "sabotage", `Alert: ${def.label} in the ${def.room} is failing! Repair it.`, st.id);
      checkWin(room, now);
      return { ok: true, message: "Sabotage started." };
    }
    if (ability === "distract") {
      if (now < p.cd.distract) return err("cooldown");
      const z = pickOne(map.zones, rng);
      p.cd.distract = now + LIMITS.distractCd;
      p.stats.abilities++;
      event(room, now, "alert", `Motion detected near the ${z.name}.`);
      return { ok: true, message: "Distraction sent." };
    }
    if (ability === "dash") {
      if (now < p.cd.dash) return err("cooldown");
      p.cd.dash = now + LIMITS.dashCd;
      p.dashUntil = now + LIMITS.dashMs;
      p.stats.abilities++;
      return { ok: true, message: "Dash active." };
    }
    return err("unknown-ability");
  }

  const target = room.players.find((q) => q.uid === arg.target && q.alive && !q.left);
  if (p.role === "detective" && ability === "inspect") {
    if (p.roundUse.inspect === room.round) return err("used-this-round");
    if (!target || target.uid === uid) return err("bad-target");
    if (dist(p, target) > LIMITS.abilityRange) return err("too-far");
    p.roundUse.inspect = room.round;
    p.stats.abilities++;
    // Honest but noisy: a spy who sabotaged this round shows up, an innocent sometimes looks nervous too.
    const hit = target.role === "spy" ? target.sabRound === room.round : rngFloat(rng) < 0.15;
    const text = hit ? `Inspection: ${target.name} shows signs of tampering.` : `Inspection: ${target.name} shows no anomalies.`;
    p.notes.push({ at: now, text });
    return { ok: true, message: text };
  }
  if (p.role === "hacker" && ability === "scan") {
    if (p.roundUse.scan === room.round) return err("used-this-round");
    p.roundUse.scan = room.round;
    p.stats.abilities++;
    const used = room.objects.filter((o) => o.lastUse && o.lastUse.round === room.round);
    const rows = shuffle(used, rng).slice(0, 3).map((o) => {
      const u = room.players.find((q) => q.uid === o.lastUse!.uid);
      const label = objectDef(room, o.id)?.label ?? o.id;
      return `${label}: used by a ${u ? colorOf(u.char) : "unknown"} suit, integrity ${o.lastUse!.real ? "OK" : "FAILED"}`;
    });
    const text = rows.length ? `Scan: ${rows.join("; ")}.` : "Scan: no recent terminal activity.";
    p.notes.push({ at: now, text });
    return { ok: true, message: text };
  }
  if (p.role === "guard" && ability === "shield") {
    if (p.uses.shield >= 1) return err("no-uses-left");
    if (!target || target.uid === uid) return err("bad-target");
    if (dist(p, target) > LIMITS.abilityRange) return err("too-far");
    p.uses.shield++;
    target.shielded = true;
    p.stats.abilities++;
    p.notes.push({ at: now, text: `You shielded ${target.name} for the next vote.` });
    return { ok: true, message: `${target.name} is shielded for the next vote.` };
  }
  return err("unknown-ability");
}

const rngFloat = (rng: Rng) => rng();

export function chat(room: Room, uid: number, input: { text?: string; quick?: string; target?: number }, now: number): Err | { ok: true } {
  const p = room.players.find((q) => q.uid === uid);
  if (!p || room.status === "lobby" || room.status === "cancelled") return err("not-active");
  if (room.phase !== "discussion" && room.phase !== "voting" && room.phase !== "result") return err("wrong-phase");
  if (p.left) return err("not-active");
  if (p.muted) return err("muted");
  if (!p.alive) return err("eliminated");
  if (now - p.lastChat < LIMITS.chatCd) return err("too-fast");
  let text: string;
  let kind: ChatMsg["kind"] = "chat";
  if (input.quick) {
    const base = QUICK[input.quick];
    if (!base) return err("bad-quick");
    kind = "quick";
    text = base;
    if (input.quick === "suspect") {
      const t = room.players.find((q) => q.uid === input.target && q.alive);
      if (!t) return err("bad-target");
      text = `I suspect ${t.name}.`;
    }
  } else {
    text = String(input.text ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return err("empty");
    if (text.length > LIMITS.chatMax) text = text.slice(0, LIMITS.chatMax);
  }
  p.lastChat = now;
  p.stats.chats++;
  say(room, p, text, kind, now);
  return { ok: true };
}

/** Shares a clue the player collected into the discussion chat (the only way private evidence becomes public). */
export function shareClue(room: Room, uid: number, clueId: string, now: number): Err | { ok: true } {
  const p = room.players.find((q) => q.uid === uid);
  if (!p || !p.alive || p.left) return err("not-active");
  if (room.phase !== "discussion") return err("wrong-phase");
  if (!p.clues.includes(clueId)) return err("not-collected");
  const c = room.clues.find((x) => x.id === clueId);
  if (!c) return err("no-such-clue");
  if (now - p.lastChat < LIMITS.chatCd) return err("too-fast");
  p.lastChat = now;
  say(room, p, c.text, "evidence", now);
  return { ok: true };
}

export function vote(room: Room, uid: number, target: number, now: number): Err | { ok: true; voted: number } {
  const p = room.players.find((q) => q.uid === uid);
  if (!p || room.status !== "playing" || !p.alive || p.left) return err("not-active");
  if (room.phase !== "voting") return err("wrong-phase");
  if (target !== 0) {
    const t = room.players.find((q) => q.uid === target && q.alive && !q.left);
    if (!t) return err("bad-target");
    if (t.uid === uid) return err("bad-target");
  }
  room.votes[String(uid)] = target;
  void now;
  return { ok: true, voted: Object.keys(room.votes).length };
}

// ---------------------------------------------------------------- phase machine
function beginRound(room: Room, now: number, rng: Rng) {
  room.round++;
  room.clues = generateClues(room, rng);
  room.votes = {};
  setPhase(room, "explore", now, TIMINGS_REF.t.explore);
}

function tally(room: Room, now: number): VoteResult {
  const alive = room.players.filter((p) => p.alive && !p.left);
  const counts: Record<string, number> = {};
  let abstain = 0;
  for (const p of alive) {
    const v = room.votes[String(p.uid)];
    // A silent or disconnected player abstains; one vote per player by construction.
    if (v === undefined || v === 0 || !p.connected) abstain++;
    else counts[String(v)] = (counts[String(v)] ?? 0) + 1;
    if (v) {
      p.stats.votes++;
      const t = room.players.find((q) => q.uid === v);
      if (t?.role === "spy") p.stats.correctVotes++;
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const res: VoteResult = { round: room.round, tally: counts, abstain, eliminated: null, team: null, shielded: false, tie: false };
  if (!ranked.length) return res;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    res.tie = true;
    return res;
  }
  const top = Number(ranked[0][0]);
  const t = room.players.find((p) => p.uid === top)!;
  if (t.shielded) {
    t.shielded = false;
    res.shielded = true;
    return res;
  }
  t.alive = false;
  res.eliminated = top;
  res.team = t.role === "spy" ? "spy" : "agent";
  event(room, now, "eliminated", `${t.name} was removed. They were ${t.role === "spy" ? "the Spy" : "not the Spy"}.`);
  return res;
}

/** Moves the clock forward. Safe to call any number of times; a late call catches up through several phases. */
export function advance(room: Room, now: number, rng: Rng = Math.random): boolean {
  const before = room.seq; // the caller compares snapshots and bumps `seq` when something really changed
  let guard = 0;
  while (guard++ < 12 && room.status !== "finished" && room.status !== "cancelled") {
    markPresence(room, now);
    if (room.status === "lobby") {
      if (room.phase === "lobby" && eligible(room)) {
        setPhase(room, "countdown", now, TIMINGS_REF.t.countdown);
        continue;
      }
      if (room.phase === "countdown") {
        if (!eligible(room)) cancelCountdown(room, now);
        else if (now >= room.phaseEnd) startGame(room, now, rng);
      }
      if (room.status === "lobby") pruneLobby(room, now);
      break;
    }
    // playing
    if (humansPresent(room, now) === 0) {
      if (now - room.phaseStart > TIMINGS_REF.t.grace * 2) {
        cancelRoom(room, "All players disconnected.", now);
      }
      break;
    }
    if (room.phase === "voting" && votingComplete(room)) {
      finishVoting(room, now);
      continue;
    }
    if (now < room.phaseEnd) {
      if (room.phase === "explore") botsAct(room, now, rng);
      break;
    }
    switch (room.phase) {
      case "briefing":
        room.clues = generateClues({ ...room, round: 1 } as Room, rng);
        room.round = 1;
        setPhase(room, "explore", room.phaseEnd, TIMINGS_REF.t.explore);
        break;
      case "explore":
        setPhase(room, "discussion", room.phaseEnd, TIMINGS_REF.t.discussion);
        botsTalk(room, room.phaseStart, rng);
        break;
      case "discussion":
        room.votes = {};
        setPhase(room, "voting", room.phaseEnd, TIMINGS_REF.t.voting);
        botsVote(room, rng);
        break;
      case "voting":
        finishVoting(room, room.phaseEnd);
        break;
      case "result":
        if (room.round >= LIMITS.maxRounds) {
          endGame(room, "spy", "The Spy stayed hidden until the end.", room.phaseEnd);
        } else {
          beginRound(room, room.phaseEnd, rng);
        }
        break;
      default:
        return room.seq !== before;
    }
  }
  return room.seq !== before;
}

function votingComplete(room: Room) {
  const voters = room.players.filter((p) => p.alive && !p.left && p.connected);
  return voters.length > 0 && voters.every((p) => room.votes[String(p.uid)] !== undefined);
}

function finishVoting(room: Room, now: number) {
  const res = tally(room, now);
  room.lastVote = res;
  room.history.push(res);
  setPhase(room, "result", now, TIMINGS_REF.t.result);
  for (const p of room.players) p.shielded = false;
  checkWin(room, now);
}

function humansPresent(room: Room, now: number) {
  return room.players.filter((p) => !p.bot && !p.left && now - p.lastSeen < TIMINGS_REF.t.grace * 2).length;
}

function markPresence(room: Room, now: number) {
  for (const p of room.players) {
    if (p.bot || p.left) continue;
    p.connected = now - p.lastSeen < TIMINGS_REF.t.grace;
  }
}

function pruneLobby(room: Room, now: number) {
  const stale = room.players.filter((p) => !p.bot && now - p.lastSeen > TIMINGS_REF.t.lobbyIdle);
  for (const p of stale) removePlayer(room, p.uid, now);
}

// ---------------------------------------------------------------- bots (practice mode and fillers, always labelled)
export function addBots(room: Room, count: number, now: number, rng: Rng = Math.random) {
  const names = ["Bot Atlas", "Bot Mira", "Bot Juno", "Bot Kite", "Bot Sable", "Bot Quill", "Bot Onyx", "Bot Fenn", "Bot Lyra"];
  const pool = shuffle(names, rng);
  for (let i = 0; i < count && room.players.length < room.settings.maxPlayers; i++) {
    addPlayer(room, { uid: -(i + 1) - room.players.length * 10, name: pool[i % pool.length], bot: true }, now);
  }
}

function botsAct(room: Room, now: number, rng: Rng) {
  if (now - room.botAt < 1500) return;
  const dt = Math.min(3, (now - room.botAt) / 1000);
  room.botAt = now;
  const map: GameMap = mapById(room.mapId);
  for (const b of room.players.filter((p) => p.bot && p.alive)) {
    if (!b.botTarget || rng() < 0.08) b.botTarget = pickOne(map.objects, rng).id;
    const o = map.objects.find((x) => x.id === b.botTarget)!;
    const d = dist(b, o);
    const step = LIMITS.speed * dt * 0.7;
    if (d > 40) {
      const k = Math.min(1, step / d);
      const nx = b.x + (o.x - b.x) * k, ny = b.y + (o.y - b.y) * k;
      if (walkable(map, nx, ny)) (b.x = nx), (b.y = ny);
      else (b.x = Math.min(WORLD.w - 30, Math.max(30, b.x + (rng() - 0.5) * 60))), (b.y = Math.min(WORLD.h - 30, Math.max(30, b.y + (rng() - 0.5) * 60)));
    } else {
      const st = room.objects.find((x) => x.id === o.id)!;
      b.x = o.x + 20;
      b.y = o.y + 20;
      if (!walkable(map, b.x, b.y)) (b.x = o.x), (b.y = o.y + 30);
      if (b.role === "spy" && st.state === "ok" && now >= b.cd.sabotage && b.uses.sabotage < LIMITS.sabotageUses && rng() < 0.25) {
        b.x = o.x; b.y = o.y;
        useAbility(room, b.uid, "sabotage", { obj: o.id }, now, rng);
      } else {
        b.x = o.x; b.y = o.y;
        interact(room, b.uid, o.id, now);
      }
      b.botTarget = undefined;
    }
  }
}

function botsTalk(room: Room, at: number, rng: Rng) {
  for (const b of room.players.filter((p) => p.bot && p.alive)) {
    if (rng() < 0.6) {
      const keys = Object.keys(QUICK).filter((k) => k !== "suspect");
      say(room, b, QUICK[pickOne(keys, rng)], "quick", at);
    }
  }
}

function botsVote(room: Room, rng: Rng) {
  const alive = room.players.filter((p) => p.alive && !p.left);
  for (const b of alive.filter((p) => p.bot)) {
    if (rng() < 0.25) {
      room.votes[String(b.uid)] = 0;
      continue;
    }
    // A spy bot never votes for itself; agent bots guess among the others.
    const options = alive.filter((p) => p.uid !== b.uid && (b.role !== "spy" || p.role !== "spy"));
    room.votes[String(b.uid)] = options.length ? pickOne(options, rng).uid : 0;
  }
}

// ---------------------------------------------------------------- views (what a client may see)
export type PublicPlayer = {
  uid: number; name: string; char: string; bot: boolean; ready: boolean; alive: boolean; left: boolean; connected: boolean;
  x?: number; y?: number; host: boolean; team?: "spy" | "agent"; role?: Role; voted?: boolean;
};

export function viewFor(room: Room, uid: number | null, now: number) {
  const me = room.players.find((p) => p.uid === uid) ?? null;
  const over = room.status === "finished";
  const playing = room.status === "playing";
  const vision = LIMITS.vision;
  const players: PublicPlayer[] = room.players.map((p) => {
    const pub: PublicPlayer = {
      uid: p.uid, name: p.name, char: p.char, bot: p.bot, ready: p.ready, alive: p.alive, left: p.left, connected: p.connected, host: p.uid === room.host,
    };
    if (room.status === "lobby") return pub;
    // Positions: yourself always; others only inside your vision radius while a round is being explored.
    const inExplore = playing && room.phase === "explore";
    const canSee = !me || p.uid === me.uid || !inExplore || !me.alive || dist(p, me) <= vision;
    if (canSee && (p.alive || over)) (pub.x = p.x), (pub.y = p.y);
    if (over) pub.role = p.role;
    else if (!p.alive && room.history.some((h) => h.eliminated === p.uid)) pub.team = p.role === "spy" ? "spy" : "agent";
    if (room.phase === "voting") pub.voted = room.votes[String(p.uid)] !== undefined;
    return pub;
  });

  const myClues = me ? room.clues.filter((c) => me.clues.includes(c.id)).map((c) => ({ id: c.id, text: c.text, tier: c.tier, round: c.round, category: c.category })) : [];
  const abilities: string[] = [];
  if (me?.alive && playing) {
    if (me.role === "spy") abilities.push("sabotage", "distract", "dash");
    if (me.role === "detective") abilities.push("inspect");
    if (me.role === "hacker") abilities.push("scan");
    if (me.role === "guard") abilities.push("shield");
  }
  return {
    code: room.code, mode: room.mode, status: room.status, phase: room.phase, phaseStart: room.phaseStart, phaseEnd: room.phaseEnd,
    serverNow: now, round: room.round, maxRounds: LIMITS.maxRounds, settings: room.settings, host: room.host, mapId: room.mapId, seq: room.seq,
    matchId: room.matchId, players,
    me: me && {
      uid: me.uid, role: me.role, alive: me.alive, x: me.x, y: me.y, clues: myClues, notes: me.notes.slice(-12), abilities,
      cd: { sabotage: Math.max(0, me.cd.sabotage - now), distract: Math.max(0, me.cd.distract - now), dash: Math.max(0, me.cd.dash - now) },
      uses: me.uses, usedThisRound: { inspect: me.roundUse.inspect === room.round, scan: me.roundUse.scan === room.round },
      stats: me.stats,
      voted: room.votes[String(me.uid)],
      // The spy may know their own team; nobody else's role is ever included here.
      teammates: me.role === "spy" ? room.players.filter((p) => p.role === "spy" && p.uid !== me.uid).map((p) => p.uid) : [],
    },
    objects: room.objects.map((o) => ({ id: o.id, state: o.state, done: o.doneRound === room.round })),
    progress: { done: room.taskDone, goal: room.taskGoal, meter: room.meter, meterMax: LIMITS.sabotageToWin },
    events: room.events.slice(-12),
    chat: room.chat.slice(-40),
    lastVote: room.phase === "result" || room.phase === "over" ? room.lastVote : undefined,
    voteHistory: room.history,
    outcome: over ? room.outcome : undefined,
    cancelReason: room.status === "cancelled" ? room.cancelReason : undefined,
    startedAt: room.startedAt, endedAt: room.endedAt,
  };
}
