// Pure game rules (no Telegram, no storage), so they are easy to test. Every function takes the current state and
// returns the next one; the server calls these and never trusts anything the client sends except "who pressed what".

export type Side = "a" | "b"; // a = challenger, b = opponent
export const other = (s: Side): Side => (s === "a" ? "b" : "a");

// ---------------------------------------------------------------- Tic-Tac-Toe
export type Cell = Side | null;
export type TttState = { board: Cell[]; turn: Side };
export type TttResult = Side | "draw" | null;

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export const tttNew = (first: Side = "a"): TttState => ({ board: Array(9).fill(null), turn: first });

export function tttWinner(board: Cell[]): { side: Side; line: number[] } | null {
  for (const l of LINES) {
    const [x, y, z] = l;
    if (board[x] && board[x] === board[y] && board[y] === board[z]) return { side: board[x] as Side, line: l };
  }
  return null;
}

export function tttMove(s: TttState, side: Side, cell: number): { ok: false; reason: string } | { ok: true; state: TttState; result: TttResult } {
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return { ok: false, reason: "bad-cell" };
  if (tttWinner(s.board) || s.board.every(Boolean)) return { ok: false, reason: "finished" };
  if (s.turn !== side) return { ok: false, reason: "not-your-turn" };
  if (s.board[cell]) return { ok: false, reason: "occupied" };
  const board = s.board.slice();
  board[cell] = side;
  const w = tttWinner(board);
  const result: TttResult = w ? w.side : board.every(Boolean) ? "draw" : null;
  return { ok: true, state: { board, turn: other(side) }, result };
}

// ---------------------------------------------------------------- Rock-Paper-Scissors
export type Rps = "rock" | "paper" | "scissors";
export const RPS_CHOICES: Rps[] = ["rock", "paper", "scissors"];
const BEATS: Record<Rps, Rps> = { rock: "scissors", paper: "rock", scissors: "paper" };

export type RpsState = {
  bestOf: 3 | 5;
  round: number; // 1-based number of the round being played
  picks: { a?: Rps; b?: Rps }; // hidden from clients until both are in
  score: { a: number; b: number };
  history: { a: Rps; b: Rps; winner: Side | "tie" }[];
};
export type RpsOutcome = { done: boolean; winner: Side | "draw" | null };

export const rpsNew = (bestOf: 3 | 5 = 3): RpsState => ({ bestOf, round: 1, picks: {}, score: { a: 0, b: 0 }, history: [] });

export function rpsRoundWinner(a: Rps, b: Rps): Side | "tie" {
  if (a === b) return "tie";
  return BEATS[a] === b ? "a" : "b";
}

/** Locks in a pick. A pick can never be changed. When both players are in, the round is resolved. */
export function rpsPick(s: RpsState, side: Side, choice: string):
  | { ok: false; reason: string }
  | { ok: true; state: RpsState; revealed: boolean; outcome: RpsOutcome } {
  if (!RPS_CHOICES.includes(choice as Rps)) return { ok: false, reason: "bad-choice" };
  const out = rpsOutcome(s);
  if (out.done) return { ok: false, reason: "finished" };
  if (s.picks[side]) return { ok: false, reason: "already-picked" };
  const st: RpsState = structuredClone(s);
  st.picks[side] = choice as Rps;
  if (!(st.picks.a && st.picks.b)) return { ok: true, state: st, revealed: false, outcome: { done: false, winner: null } };

  const w = rpsRoundWinner(st.picks.a, st.picks.b);
  st.history.push({ a: st.picks.a, b: st.picks.b, winner: w });
  if (w !== "tie") st.score[w]++;
  st.picks = {};
  st.round++;
  return { ok: true, state: st, revealed: true, outcome: rpsOutcome(st) };
}

/** First to a majority wins. Tied rounds are replayed, but at most bestOf extra rounds so a match always ends. */
export function rpsOutcome(s: RpsState): RpsOutcome {
  const need = Math.ceil(s.bestOf / 2);
  if (s.score.a >= need) return { done: true, winner: "a" };
  if (s.score.b >= need) return { done: true, winner: "b" };
  if (s.history.length >= s.bestOf * 2) {
    return { done: true, winner: s.score.a === s.score.b ? "draw" : s.score.a > s.score.b ? "a" : "b" };
  }
  return { done: false, winner: null };
}

// ---------------------------------------------------------------- Word Battle
export type Difficulty = "easy" | "medium" | "hard";
export type WordMode = "vocab" | "scramble" | "guess";
export type WordEntry = { w: string; m: string; d: Difficulty };
export type Rng = () => number;

const RAW = `easy|house:a building where people live
easy|water:clear liquid we drink
easy|friend:a person you like and trust
easy|smile:a happy look on the face
easy|river:a large natural stream of water
easy|music:sounds arranged to be pleasant
easy|garden:land where flowers or plants grow
easy|bridge:a structure used to cross a river
easy|winter:the coldest season of the year
easy|market:a place to buy and sell goods
easy|doctor:a person who treats sick people
easy|planet:a large body that moves around a star
easy|school:a place where children learn
easy|yellow:the colour of a lemon
easy|mother:a female parent
easy|kitchen:a room where food is cooked
easy|window:an opening in a wall with glass
easy|pencil:a tool for writing or drawing
easy|cloud:a white or grey mass in the sky
easy|breakfast:the first meal of the day
medium|journey:a long trip from one place to another
medium|curious:eager to know or learn something
medium|ancient:belonging to a very long time ago
medium|fragile:easily broken or damaged
medium|brilliant:very bright or very clever
medium|captain:the person in command of a ship or team
medium|harvest:the gathering of ripe crops
medium|mystery:something difficult to understand or explain
medium|silence:complete absence of sound
medium|courage:the ability to face fear
medium|disaster:a sudden event causing great damage
medium|neighbour:a person living next to you
medium|language:a system of words used to communicate
medium|adventure:an exciting or unusual experience
medium|whisper:to speak very softly
medium|generous:willing to give more than is expected
medium|compass:an instrument that shows direction
medium|volcano:a mountain that can erupt with lava
medium|treasure:a collection of valuable things
medium|lantern:a portable lamp
hard|ephemeral:lasting for a very short time
hard|benevolent:kind and generous
hard|meticulous:showing great attention to detail
hard|resilient:able to recover quickly from difficulty
hard|ambiguous:open to more than one meaning
hard|eloquent:fluent and persuasive in speaking
hard|tenacious:holding firmly to a goal
hard|pragmatic:dealing with things in a practical way
hard|serendipity:finding something good by chance
hard|ubiquitous:present everywhere
hard|candid:honest and straightforward
hard|diligent:careful and hard-working
hard|obsolete:no longer in use
hard|vivid:producing strong clear images
hard|formidable:inspiring fear or respect through power`;

function parseBank(raw: string): WordEntry[] {
  return raw.split("\n").map((l) => {
    const [d, rest] = l.split("|");
    const i = rest.indexOf(":");
    return { d: d as Difficulty, w: rest.slice(0, i), m: rest.slice(i + 1) };
  });
}

/** Question banks per language. Add `hi` here later with the same shape; nothing else has to change. */
export const BANKS: Record<string, WordEntry[]> = { en: parseBank(RAW) };

export type WordQ = {
  id: string; // word the question is about (used to avoid repeats)
  mode: WordMode;
  prompt: string;
  options: string[]; // 4 shuffled choices
  answer: number; // index into options (server only: never sent to clients)
};

const shuffle = <T>(a: T[], rng: Rng): T[] => {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

function scrambled(w: string, rng: Rng): string {
  if (new Set(w).size < 2) return w;
  for (let i = 0; i < 20; i++) {
    const s = shuffle([...w], rng).join("");
    if (s !== w) return s;
  }
  return [...w].reverse().join("");
}

function masked(w: string, rng: Rng): string {
  const n = Math.max(2, Math.floor(w.length / 3));
  const hide = new Set(shuffle([...Array(w.length).keys()].slice(1), rng).slice(0, n)); // never hide the first letter
  return [...w].map((c, i) => (hide.has(i) ? "_" : c)).join(" ");
}

export function wordQuestion(mode: WordMode, diff: Difficulty, used: string[], rng: Rng = Math.random, lang = "en"): WordQ {
  const bank = BANKS[lang] ?? BANKS.en;
  let pool = bank.filter((e) => e.d === diff && !used.includes(e.w));
  if (!pool.length) pool = bank.filter((e) => e.d === diff); // everything used: allow repeats rather than fail
  const e = pool[Math.floor(rng() * pool.length)];
  // Distractors: other words, preferring the same difficulty.
  const others = shuffle(bank.filter((x) => x.w !== e.w), rng);
  const same = others.filter((x) => x.d === diff);
  const pick = [...same, ...others.filter((x) => x.d !== diff)].slice(0, 3);

  let prompt: string;
  let opts: string[];
  if (mode === "vocab") {
    prompt = `What does “${e.w}” mean?`;
    opts = [e.m, ...pick.map((p) => p.m)];
  } else if (mode === "scramble") {
    prompt = `Unscramble the letters:\n${scrambled(e.w, rng).toUpperCase().split("").join(" ")}`;
    opts = [e.w, ...pick.map((p) => p.w)];
  } else {
    prompt = `Which word fits?\n${masked(e.w, rng).toUpperCase()}\nHint: ${e.m}`;
    opts = [e.w, ...pick.map((p) => p.w)];
  }
  const order = shuffle(opts.map((o, i) => ({ o, right: i === 0 })), rng);
  return { id: e.w, mode, prompt, options: order.map((x) => x.o), answer: order.findIndex((x) => x.right) };
}

export type WordState = {
  mode: WordMode;
  diff: Difficulty;
  rounds: number;
  round: number; // 1-based
  score: { a: number; b: number };
  q: WordQ;
  used: string[];
  locked: { a?: boolean; b?: boolean }; // players who already answered wrongly this round
  qAt: number; // when this question was shown (ms)
  history: { word: string; winner: Side | "none" }[];
};

export function wordNew(mode: WordMode, diff: Difficulty, rounds: number, now: number, rng: Rng = Math.random): WordState {
  const q = wordQuestion(mode, diff, [], rng);
  return { mode, diff, rounds, round: 1, score: { a: 0, b: 0 }, q, used: [q.id], locked: {}, qAt: now, history: [] };
}

export type WordOutcome = { done: boolean; winner: Side | "draw" | null };

export function wordAnswer(s: WordState, side: Side, option: number, now: number, rng: Rng = Math.random):
  | { ok: false; reason: string }
  | { ok: true; state: WordState; correct: boolean; roundOver: boolean; outcome: WordOutcome } {
  if (!Number.isInteger(option) || option < 0 || option >= s.q.options.length) return { ok: false, reason: "bad-option" };
  if (s.round > s.rounds) return { ok: false, reason: "finished" };
  if (s.locked[side]) return { ok: false, reason: "already-answered" };
  const st: WordState = structuredClone(s);
  const correct = option === st.q.answer;
  let roundOver = false;
  if (correct) {
    st.score[side]++;
    st.history.push({ word: st.q.id, winner: side });
    roundOver = true;
  } else {
    st.locked[side] = true;
    if (st.locked.a && st.locked.b) {
      st.history.push({ word: st.q.id, winner: "none" });
      roundOver = true;
    }
  }
  if (roundOver) {
    st.round++;
    st.locked = {};
    if (st.round <= st.rounds) {
      st.q = wordQuestion(st.mode, st.diff, st.used, rng);
      st.used.push(st.q.id);
      st.qAt = now;
    }
  }
  return { ok: true, state: st, correct, roundOver, outcome: wordOutcome(st) };
}

/** Ends after the set number of rounds, or early once one player has an unreachable lead. */
export function wordOutcome(s: WordState): WordOutcome {
  const left = Math.max(0, s.rounds - (s.round - 1));
  const { a, b } = s.score;
  if (a > b + left) return { done: true, winner: "a" };
  if (b > a + left) return { done: true, winner: "b" };
  if (s.round > s.rounds) return { done: true, winner: a === b ? "draw" : a > b ? "a" : "b" };
  return { done: false, winner: null };
}
