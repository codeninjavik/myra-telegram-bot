// Ludo rules and room state. Server-authoritative like the rest of SECRET AGENT: dice are rolled here, moves are
// validated here, clients only ask "roll" or "move token N".
//
// A token's position `p` is relative to its own colour:  -1 = in the yard, 0..50 = main track (0 is the colour's
// start square), 51..55 = home column, 56 = home. Absolute track cell = (START[colour] + p) % 52.

export type Rng = () => number;
export const COLORS = ["red", "green", "yellow", "blue"] as const;
export type Color = (typeof COLORS)[number];

export const TRACK = 52;
export const START = [0, 13, 26, 39]; // absolute cell where each colour enters the board
export const SAFE = new Set([0, 13, 26, 39, 8, 21, 34, 47]); // start squares and stars: nobody is captured here
export const HOME = 56;

export const LUDO = { minPlayers: 2, maxPlayers: 4, tokens: 4, turnMs: 20_000, botMs: 900, diceMs: 700, maxSixes: 3, afkLimit: 3, idleCancelMs: 5 * 60_000 };

export type Seat = {
  uid: number; name: string; char: string; bot: boolean; color: number; // color = index into COLORS
  tokens: number[]; connected: boolean; lastSeen: number; timeouts: number; left: boolean; auto: boolean; // auto: AFK, a bot plays for them
};
export type LudoEvent = { id: number; at: number; text: string; seat?: number };
export type LudoRoom = {
  code: string; kind: "ludo"; host: number; mode: "private" | "practice"; status: "lobby" | "playing" | "finished" | "cancelled";
  createdAt: number; maxPlayers: number; tokensPer: number; seats: Seat[];
  turn: number; phase: "roll" | "move"; dice: number | null; sixes: number; legal: number[]; turnStart: number; deadline: number;
  lastRoll?: { seat: number; value: number; at: number }; lastMove?: { seat: number; token: number; from: number; to: number; captured: { seat: number; token: number }[]; at: number };
  winner: number | null; log: LudoEvent[]; seq: number; matchId: string; startedAt?: number; endedAt?: number; cancelReason?: string;
  rewarded: boolean; rewards?: Record<string, unknown>; nextId: number;
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const makeCode = (rng: Rng = Math.random) => Array.from({ length: 5 }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join("");
type Err = { ok: false; error: string };
const err = (error: string): Err => ({ ok: false, error });

// ---------------------------------------------------------------- geometry shared with the client
export const absCell = (color: number, p: number) => (START[color] + p) % TRACK;
export const onTrack = (p: number) => p >= 0 && p <= 50;

// ---------------------------------------------------------------- room lifecycle
export function newLudoRoom(code: string, host: { uid: number; name: string; char: string }, mode: "private" | "practice", maxPlayers: number, now: number, tokensPer = 4): LudoRoom {
  const room: LudoRoom = {
    code, kind: "ludo", host: host.uid, mode, status: "lobby", createdAt: now, maxPlayers: Math.min(4, Math.max(2, maxPlayers)), tokensPer: tokensPer === 2 ? 2 : 4, seats: [],
    turn: 0, phase: "roll", dice: null, sixes: 0, legal: [], turnStart: now, deadline: 0, winner: null, log: [], seq: 0,
    matchId: `L${code}-${now.toString(36)}`, rewarded: false, nextId: 1,
  };
  room.seats.push(mkSeat(host, 0, false, now, room.tokensPer));
  return room;
}

function mkSeat(u: { uid: number; name: string; char: string }, color: number, bot: boolean, now: number, n = 4): Seat {
  return { uid: u.uid, name: u.name.slice(0, 24), char: u.char, bot, color, tokens: Array(n).fill(-1), connected: true, lastSeen: now, timeouts: 0, left: false, auto: false };
}

/** Colours are spread around the board: 2 players sit opposite each other, 3 leave blue empty. */
function nextColor(room: LudoRoom): number {
  const used = new Set(room.seats.map((s) => s.color));
  const order = room.maxPlayers === 2 ? [0, 2] : [0, 2, 1, 3];
  return order.find((c) => !used.has(c)) ?? -1;
}

export function addSeat(room: LudoRoom, u: { uid: number; name: string; char: string; bot?: boolean }, now: number): Err | { ok: true } {
  if (room.status !== "lobby") return err("match-started");
  if (room.seats.some((s) => s.uid === u.uid)) return err("already-in");
  if (room.seats.length >= room.maxPlayers) return err("room-full");
  const c = nextColor(room);
  if (c < 0) return err("room-full");
  room.seats.push(mkSeat(u, c, !!u.bot, now, room.tokensPer));
  room.seats.sort((x, y) => x.color - y.color); // turns go clockwise round the board
  return { ok: true };
}

export function addLudoBots(room: LudoRoom, now: number, rng: Rng = Math.random) {
  const names = ["Bot Aarav", "Bot Zoya", "Bot Kabir", "Bot Meera", "Bot Rohan", "Bot Naina"];
  const chars = ["nova", "raven", "pixel", "atlas", "phantom", "echo", "viper", "orion", "cipher", "rook"];
  let i = Math.floor(rng() * names.length);
  while (room.seats.length < room.maxPlayers) {
    const id = -(room.seats.length + 1) * 1000 - i;
    const used = new Set(room.seats.map((s) => s.char));
    addSeat(room, { uid: id, name: names[i % names.length], char: chars.find((c) => !used.has(c)) ?? "nova", bot: true }, now);
    i++;
  }
}

export function removeSeat(room: LudoRoom, uid: number, now: number) {
  const s = room.seats.find((x) => x.uid === uid);
  if (!s) return;
  if (room.status === "lobby") {
    room.seats = room.seats.filter((x) => x.uid !== uid);
    if (room.host === uid) {
      const h = room.seats.find((x) => !x.bot);
      if (h) room.host = h.uid;
    }
    return;
  }
  if (room.status === "playing") {
    // the seat stays on the board; a bot takes over, so the others are not stuck waiting
    s.left = true;
    s.auto = true;
    s.connected = false;
    log(room, now, `${s.name} left. A bot plays their colour.`, seatIndex(room, uid));
    if (!room.seats.some((x) => !x.bot && !x.left)) cancel(room, "All human players left.", now);
  }
}

export const seatIndex = (room: LudoRoom, uid: number) => room.seats.findIndex((s) => s.uid === uid);

function log(room: LudoRoom, now: number, text: string, seat?: number) {
  room.log.push({ id: room.nextId++, at: now, text, seat });
  if (room.log.length > 30) room.log.shift();
}

export function startLudo(room: LudoRoom, now: number): Err | { ok: true } {
  if (room.status !== "lobby") return err("match-started");
  if (room.seats.length < LUDO.minPlayers) return err("need-more-players");
  room.status = "playing";
  room.startedAt = now;
  room.turn = 0;
  beginTurn(room, now);
  log(room, now, "The game begins. Roll a 6 to bring a token out.");
  return { ok: true };
}

function cancel(room: LudoRoom, reason: string, now: number) {
  room.status = "cancelled";
  room.cancelReason = reason;
  room.endedAt = now;
}

// ---------------------------------------------------------------- rules
/** Where would token `i` of `seat` end up after `dice`? null if it cannot move. */
export function target(seat: Seat, i: number, dice: number): number | null {
  const p = seat.tokens[i];
  if (p === HOME) return null;
  if (p === -1) return dice === 6 ? 0 : null;
  const to = p + dice;
  return to > HOME ? null : to; // exact roll needed to land on home
}

export function legalMoves(seat: Seat, dice: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < seat.tokens.length; i++) if (target(seat, i, dice) !== null) out.push(i);
  return out;
}

/** Opponent tokens that would be sent home if `seat` put a token on `to`. */
export function capturesAt(room: LudoRoom, seatIdx: number, to: number): { seat: number; token: number }[] {
  if (!onTrack(to)) return [];
  const cell = absCell(room.seats[seatIdx].color, to);
  if (SAFE.has(cell)) return [];
  const out: { seat: number; token: number }[] = [];
  room.seats.forEach((s, si) => {
    if (si === seatIdx) return;
    s.tokens.forEach((p, ti) => {
      if (onTrack(p) && absCell(s.color, p) === cell) out.push({ seat: si, token: ti });
    });
  });
  return out;
}

function beginTurn(room: LudoRoom, now: number) {
  room.phase = "roll";
  room.dice = null;
  room.legal = [];
  room.turnStart = now;
  room.deadline = now + LUDO.turnMs;
}

function nextSeat(room: LudoRoom): number {
  return (room.turn + 1) % room.seats.length;
}
function passTurn(room: LudoRoom, now: number) {
  room.turn = nextSeat(room);
  room.sixes = 0;
  beginTurn(room, now);
}

export function roll(room: LudoRoom, uid: number, now: number, rng: Rng = Math.random): Err | { ok: true; value: number; moved: boolean } {
  if (room.status !== "playing") return err("not-playing");
  const seat = room.seats[room.turn];
  if (!seat || seat.uid !== uid) return err("not-your-turn");
  if (room.phase !== "roll") return err("move-first");
  return doRoll(room, now, rng);
}

function doRoll(room: LudoRoom, now: number, rng: Rng): { ok: true; value: number; moved: boolean } {
  const seat = room.seats[room.turn];
  const value = 1 + Math.floor(rng() * 6);
  room.dice = value;
  room.lastRoll = { seat: room.turn, value, at: now };
  if (value === 6) room.sixes++;
  // three sixes in a row cancel the turn
  if (value === 6 && room.sixes >= LUDO.maxSixes) {
    log(room, now, `${seat.name} rolled three sixes in a row: turn lost.`, room.turn);
    passTurn(room, now);
    return { ok: true, value, moved: false };
  }
  const legal = legalMoves(seat, value);
  if (!legal.length) {
    log(room, now, `${seat.name} rolled ${value}: no move.`, room.turn);
    passTurn(room, now);
    room.dice = value; // keep showing the last value for the table
    return { ok: true, value, moved: false };
  }
  room.legal = legal;
  room.phase = "move";
  room.turnStart = now;
  room.deadline = now + LUDO.turnMs;
  return { ok: true, value, moved: legal.length > 0 };
}

export function move(room: LudoRoom, uid: number, token: number, now: number): Err | { ok: true; captured: number; finished: boolean; won: boolean } {
  if (room.status !== "playing") return err("not-playing");
  const seat = room.seats[room.turn];
  if (!seat || seat.uid !== uid) return err("not-your-turn");
  if (room.phase !== "move" || room.dice === null) return err("roll-first");
  if (!Number.isInteger(token) || !room.legal.includes(token)) return err("illegal-move");
  return doMove(room, token, now);
}

function doMove(room: LudoRoom, token: number, now: number) {
  const seatIdx = room.turn;
  const seat = room.seats[seatIdx];
  const dice = room.dice as number;
  const from = seat.tokens[token];
  const to = target(seat, token, dice) as number;
  const hit = capturesAt(room, seatIdx, to);
  seat.tokens[token] = to;
  for (const h of hit) room.seats[h.seat].tokens[h.token] = -1;
  room.lastMove = { seat: seatIdx, token, from, to, captured: hit, at: now };
  if (hit.length) log(room, now, `${seat.name} captured ${hit.map((h) => room.seats[h.seat].name).join(", ")}.`, seatIdx);
  const finished = to === HOME;
  if (finished) log(room, now, `${seat.name} brought a token home.`, seatIdx);
  seat.timeouts = 0;

  if (seat.tokens.every((p) => p === HOME)) {
    room.status = "finished";
    room.winner = seatIdx;
    room.endedAt = now;
    log(room, now, `${seat.name} wins!`, seatIdx);
    return { ok: true as const, captured: hit.length, finished, won: true };
  }
  // a six, a capture, or reaching home earns another roll
  if (dice === 6 || hit.length || finished) {
    beginTurn(room, now);
    log(room, now, `${seat.name} rolls again.`, seatIdx);
  } else passTurn(room, now);
  return { ok: true as const, captured: hit.length, finished, won: false };
}

// ---------------------------------------------------------------- bots / autopilot
/** Simple, readable heuristic: win a token home > capture > leave the yard > escape danger > move the furthest token. */
export function chooseToken(room: LudoRoom, seatIdx: number, dice: number, legal: number[], rng: Rng): number {
  const seat = room.seats[seatIdx];
  let best = legal[0];
  let bestScore = -1e9;
  for (const i of legal) {
    const to = target(seat, i, dice) as number;
    let score = to + rng() * 0.5;
    if (to === HOME) score += 100;
    if (capturesAt(room, seatIdx, to).length) score += 60;
    if (seat.tokens[i] === -1) score += 35;
    if (onTrack(to) && SAFE.has(absCell(seat.color, to))) score += 12;
    if (to >= 51) score += 10; // into the home column: cannot be captured any more
    if (onTrack(seat.tokens[i]) && threatened(room, seatIdx, seat.tokens[i])) score += 20; // run away
    if (score > bestScore) (bestScore = score), (best = i);
  }
  return best;
}

function threatened(room: LudoRoom, seatIdx: number, p: number): boolean {
  const cell = absCell(room.seats[seatIdx].color, p);
  if (SAFE.has(cell)) return false;
  for (let si = 0; si < room.seats.length; si++) {
    if (si === seatIdx) continue;
    for (const q of room.seats[si].tokens) {
      if (!onTrack(q)) continue;
      const qc = absCell(room.seats[si].color, q);
      const d = (cell - qc + TRACK) % TRACK;
      if (d >= 1 && d <= 6) return true;
    }
  }
  return false;
}

/**
 * Moves the clock: bots and AFK players act after a short pause, human turns time out. Safe to call repeatedly
 * from any request; a late call catches up through several turns.
 */
export function advanceLudo(room: LudoRoom, now: number, rng: Rng = Math.random): boolean {
  let changed = false;
  for (const s of room.seats) {
    if (!s.bot && !s.left) {
      const was = s.connected;
      s.connected = now - s.lastSeen < 30_000;
      if (was !== s.connected) changed = true;
    }
  }
  if (room.status === "lobby") {
    const stale = room.seats.filter((s) => !s.bot && now - s.lastSeen > 90_000);
    for (const s of stale) (removeSeat(room, s.uid, now), (changed = true));
    return changed;
  }
  if (room.status !== "playing") return changed;
  for (let guard = 0; guard < 200 && room.status === "playing"; guard++) {
    const seat = room.seats[room.turn];
    const botLike = seat.bot || seat.auto;
    const age = now - room.turnStart;
    if (botLike) {
      const wait = room.phase === "roll" ? LUDO.botMs : LUDO.botMs + 400;
      if (age < wait) break;
      const at = room.turnStart + wait;
      if (room.phase === "roll") doRoll(room, at, rng);
      else doMove(room, chooseToken(room, room.turn, room.dice as number, room.legal, rng), at);
      changed = true;
      continue;
    }
    if (now < room.deadline) break;
    // a human ran out of time: play for them, and hand the seat to a bot after repeated timeouts
    seat.timeouts++;
    log(room, room.deadline, `${seat.name} ran out of time.`, room.turn);
    if (seat.timeouts >= LUDO.afkLimit) {
      seat.auto = true;
      log(room, room.deadline, `${seat.name} is away: a bot plays their colour.`, room.turn);
    }
    if (room.phase === "roll") doRoll(room, room.deadline, rng);
    else doMove(room, chooseToken(room, room.turn, room.dice as number, room.legal, rng), room.deadline);
    changed = true;
  }
  const humans = room.seats.filter((s) => !s.bot && !s.left);
  if (room.status === "playing" && humans.length > 0 && !humans.some((s) => now - s.lastSeen < LUDO.idleCancelMs)) {
    cancel(room, "All players disconnected.", now);
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------- what a client may see
export function ludoView(room: LudoRoom, uid: number | null, now: number) {
  const me = room.seats.findIndex((s) => s.uid === uid);
  return {
    kind: "ludo" as const, code: room.code, mode: room.mode, status: room.status, host: room.host, maxPlayers: room.maxPlayers, tokensPer: room.tokensPer, seq: room.seq,
    serverNow: now, matchId: room.matchId, startedAt: room.startedAt, endedAt: room.endedAt, cancelReason: room.cancelReason,
    turn: room.turn, phase: room.phase, dice: room.dice, legal: room.status === "playing" && me === room.turn ? room.legal : [],
    deadline: room.deadline, turnStart: room.turnStart, sixes: room.sixes, lastRoll: room.lastRoll, lastMove: room.lastMove,
    winner: room.winner, me,
    seats: room.seats.map((s) => ({
      uid: s.uid, name: s.name, char: s.char, bot: s.bot, color: s.color, colorName: COLORS[s.color], tokens: s.tokens,
      home: s.tokens.filter((p) => p === HOME).length, connected: s.connected || s.bot, left: s.left, auto: s.auto,
    })),
    log: room.log.slice(-8),
  };
}

export function ludoStandings(room: LudoRoom) {
  const score = (s: Seat) => s.tokens.reduce((a, p) => a + (p === -1 ? 0 : p + 1), 0);
  return room.seats.map((s, i) => ({ i, s, score: score(s) })).sort((a, b) => (b.i === room.winner ? 1 : 0) - (a.i === room.winner ? 1 : 0) || b.score - a.score);
}
