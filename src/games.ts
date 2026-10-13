import { InlineKeyboard, type Api, type Bot, type Context } from "grammy";
import { chatAllowed, isBotManager } from "./gate.js";
import { findUserByUsername } from "./db.js";
import { casUpdate, getMany, listKeys } from "./store.js";
import {
  RPS_CHOICES, other, rpsPick, tttMove, tttWinner, wordAnswer,
  type Difficulty, type RpsState, type Rps, type Side, type TttState, type WordMode, type WordState,
} from "./gamecore.js";
import {
  GAMES, PRODUCTS, THEMES, activeMatchIds, applyExpiry, audit, buyWithPoints, claimDaily, createChallenge, createOrder, ensurePlayer, fulfilPayment,
  getConfig, getMatch, getOrder, getPayment, getPlayer, history, markRefunded, movePoints, newId, product, purchases, rankOf, recentAudit,
  recentMatches, reconcile, setActiveIds, setBan, setConfig, settle, sideOf, startState, topPlayers, trackMatch, updateMatch, uidOf,
  type GameId, type Match, type MatchOpts, type Player,
} from "./gamesvc.js";

// Telegram layer of the game system: commands, inline-keyboard UI, callbacks, Stars payments and admin tools.
// Rules live in gamecore.ts, storage/accounting in gamesvc.ts. Nothing here trusts the client beyond "who pressed what".

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
const mention = (id: number, name: string) => `<a href="tg://user?id=${id}">${esc(name)}</a>`;
const vip = (p: Player | null | undefined) => (p?.items.includes("badge_vip") ? "💎 " : "");

// Telegram allows 100 commands in the "/" menu and the bot is already near that, so only the entry points are listed.
// The rest (/matches /gtop /transactions /purchases /shop /theme /gsettings ...) work too and are shown by /gamehelp.
export const GAME_MENU = [
  { command: "games", description: "Games: Tic-Tac-Toe, RPS, Word Battle" },
  { command: "challenge", description: "Kisi ko challenge karo (reply karke)" },
  { command: "profile", description: "Game profile aur stats" },
  { command: "wallet", description: "Game points aur purchases" },
  { command: "gamehelp", description: "Saare game commands" },
];

const CASH_OFF =
  "Cash tournaments aur withdrawals abhi available nahi hain. Aap free matches khel sakte ho aur non-cash features use kar sakte ho.";

// ---------------------------------------------------------------- rendering
const MODE_NAME: Record<WordMode, string> = { vocab: "Vocabulary quiz", scramble: "Word scramble", guess: "Guess the word" };
const RPS_ICON: Record<Rps, string> = { rock: "✊", paper: "✋", scissors: "✌️" };

async function pair(m: Match) {
  return { pa: await getPlayer(m.a), pb: m.b ? await getPlayer(m.b) : null };
}
const sym = (p: Player | null, side: Side) => (THEMES[p?.theme ?? "default"] ?? THEMES.default)[side === "a" ? 0 : 1];

function resultLine(m: Match, pa: Player | null, pb: Player | null): string {
  const nm = (id: number) => (id === m.a ? `${vip(pa)}${esc(m.an)}` : `${vip(pb)}${esc(m.bn)}`);
  let t: string;
  if (m.status === "abandoned") t = "⏹️ Match abandoned (no result).";
  else if (m.winner === "draw") t = "🤝 <b>Draw!</b>";
  else if (typeof m.winner === "number") {
    const how = m.how === "timeout" ? " (opponent timed out)" : m.how === "resign" ? " (opponent resigned)" : "";
    t = `🏆 <b>${nm(m.winner)}</b> wins!${how}`;
  } else t = "";
  if (m.rewards) {
    const bits = Object.entries(m.rewards).map(([id, n]) => `${esc(Number(id) === m.a ? m.an : m.bn)} +${n}`);
    if (bits.length) t += `\n🎯 Game points: ${bits.join(" · ")}`;
  }
  return t;
}

export async function render(m: Match): Promise<{ text: string; kb: InlineKeyboard }> {
  const { pa, pb } = await pair(m);
  const g = GAMES[m.game];
  const head = `${g.icon} <b>${g.name}</b>`;
  const names = `${vip(pa)}${mention(m.a, m.an)} vs ${m.b ? `${vip(pb)}${mention(m.b, m.bn)}` : "❓"}`;
  const kb = new InlineKeyboard();

  if (m.status === "pending") {
    const opts = optsText(m);
    const who = m.target ? `${mention(m.a, m.an)} ne ${mention(m.b!, m.bn)} ko challenge kiya!` : `${mention(m.a, m.an)} ne challenge diya! Koi bhi accept kar sakta hai.`;
    kb.text("✅ Accept", `gx:acc:${m.id}`).text("❌ Decline", `gx:dec:${m.id}`).row().text("🚫 Cancel", `gx:can:${m.id}`);
    return { text: `${head}\n${who}${opts}\n\n⏳ 10 minute mein expire hoga.`, kb };
  }
  if (m.status === "declined") return { text: `${head}\n${names}\n❌ Challenge decline ho gaya.`, kb };
  if (m.status === "cancelled") return { text: `${head}\n${esc(m.an)} ne challenge cancel kar diya.`, kb };
  if (m.status === "expired") return { text: `${head}\n⌛ Challenge expire ho gaya (kisi ne accept nahi kiya).`, kb };

  const active = m.status === "active";
  const done = !active;
  if (m.game === "ttt") {
    const s = m.state as TttState;
    const sa = sym(pa, "a");
    const sb = sym(pb, "b");
    const win = tttWinner(s.board);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const i = r * 3 + c;
        const v = s.board[i];
        const label = v ? (v === "a" ? sa : sb) : win || done ? "▫️" : "⬜";
        kb.text(win?.line.includes(i) ? `⭐${label}` : label, done || v ? "gn:noop" : `gt:${m.id}:${i}`);
      }
      kb.row();
    }
    if (active) kb.text("🏳️ Resign", `gz:${m.id}`);
    const turn = s.turn === "a" ? `${sa} ${esc(m.an)}` : `${sb} ${esc(m.bn)}`;
    const body = `${head}\n${sa} ${mention(m.a, m.an)}  vs  ${sb} ${m.b ? mention(m.b, m.bn) : ""}`;
    if (active) return { text: `${body}\n\n👉 Turn: <b>${turn}</b>`, kb };
    kb.row().text("🔁 Rematch", `gx:rem:${m.id}`);
    return { text: `${body}\n\n${resultLine(m, pa, pb)}`, kb };
  }

  if (m.game === "rps") {
    const s = m.state as RpsState;
    const last = s.history[s.history.length - 1];
    const lastLine = last
      ? `\nLast round: ${esc(m.an)} ${RPS_ICON[last.a]} vs ${esc(m.bn)} ${RPS_ICON[last.b]} → ${last.winner === "tie" ? "tie" : last.winner === "a" ? esc(m.an) : esc(m.bn)}`
      : "";
    const board = `${head} · best of ${s.bestOf}\n${names}\n\nScore: <b>${s.score.a} – ${s.score.b}</b>${lastLine}`;
    if (active) {
      for (const c of RPS_CHOICES) kb.text(`${RPS_ICON[c]} ${c}`, `gr:${m.id}:${c}`);
      kb.row().text("🏳️ Resign", `gz:${m.id}`);
      const lock = (side: Side, n: string) => `${esc(n)} ${s.picks[side] ? "✅ locked" : "⏳ choosing"}`;
      return { text: `${board}\n\nRound ${s.round}: ${lock("a", m.an)} · ${lock("b", m.bn)}\n<i>Choices stay hidden until both are in.</i>`, kb };
    }
    kb.text("🔁 Rematch", `gx:rem:${m.id}`);
    return { text: `${board}\n\n${resultLine(m, pa, pb)}`, kb };
  }

  const s = m.state as WordState;
  const board = `${head} · ${MODE_NAME[s.mode]} · ${s.diff}\n${names}\n\nScore: <b>${s.score.a} – ${s.score.b}</b>`;
  if (active) {
    const letters = ["A", "B", "C", "D"];
    const opts = s.q.options.map((o, i) => `<b>${letters[i]}</b>) ${esc(o)}`).join("\n");
    s.q.options.forEach((_, i) => kb.text(letters[i], `gq:${m.id}:${i}:${s.round}`));
    kb.row().text("🏳️ Resign", `gz:${m.id}`);
    const lk = [s.locked.a ? `${esc(m.an)} ❌` : "", s.locked.b ? `${esc(m.bn)} ❌` : ""].filter(Boolean).join(" ");
    return { text: `${board}\n\nRound ${Math.min(s.round, s.rounds)}/${s.rounds}\n${esc(s.q.prompt)}\n\n${opts}${lk ? `\n\nGalat jawab: ${lk}` : ""}`, kb };
  }
  kb.text("🔁 Rematch", `gx:rem:${m.id}`);
  return { text: `${board}\n\n${resultLine(m, pa, pb)}`, kb };
}

function optsText(m: Match): string {
  const o = m.opts;
  if (m.game === "rps") return `\nFormat: best of ${o.bestOf ?? 3}`;
  if (m.game === "word") return `\nMode: ${MODE_NAME[o.mode ?? "vocab"]} · ${o.diff ?? "easy"} · ${o.rounds ?? 5} rounds`;
  return "";
}

/** Redraws a match in every message that shows it. */
async function refresh(api: Api, m: Match) {
  const { text, kb } = await render(m);
  await Promise.all(
    m.views.map((v) =>
      api.editMessageText(v.chat, v.msg, text, { ...html, reply_markup: kb }).catch((e: any) => {
        if (!/not modified/i.test(String(e?.description ?? e))) console.error("game refresh:", e?.description ?? e);
      }),
    ),
  );
}

// ---------------------------------------------------------------- core actions
type Out = { toast?: string; alert?: boolean };

async function notify(api: Api, uid: number, text: string, kb?: InlineKeyboard) {
  const p = await getPlayer(uid);
  if (!p?.dm || !p.notify || p.status !== "active") return;
  await api.sendMessage(uid, text, { ...html, reply_markup: kb }).catch(() => {});
}

async function finishIfDone(_api: Api, id: string): Promise<Match | null> {
  const m = await getMatch(id);
  if (!m) return null;
  if (m.status === "done" && !m.settled) {
    // settle() is exactly-once (settle marker). Only the call that did the work gets rewards back and stores them.
    const r = await settle(m);
    if (r) return (await updateMatch(id, (c) => ({ ...c, settled: true, rewards: r.rewards }))) ?? m;
  }
  return m;
}

async function gameEnabled(g: GameId) {
  return !(await getConfig()).disabled.includes(g);
}

/** Creates the challenge and posts the Accept/Decline message in `chat`. */
async function postChallenge(ctx: Context, p: { game: GameId; a: Player; target?: { id: number; name: string } | null; opts: MatchOpts; rematchOf?: string }) {
  const chat = ctx.chat!;
  const kind = chat.type === "private" ? "private" : "group";
  const m = await createChallenge({ game: p.game, kind, chat: chat.id, a: p.a, target: p.target, opts: p.opts, rematchOf: p.rematchOf });
  const { text, kb } = await render(m);
  if (kind === "private") {
    const link = `https://t.me/${ctx.me.username}?start=gch_${m.id}`;
    kb.row().url("📤 Dost ko bhejo", `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Mere saath game khelo 🎮")}`);
  }
  const sent = await ctx.api.sendMessage(chat.id, text, { ...html, reply_markup: kb });
  await updateMatch(m.id, (c) => ({ ...c, views: [...c.views, { chat: chat.id, msg: sent.message_id }] }));
  if (p.target) {
    const note = `🎮 ${esc(p.a.name)} ne tumhe <b>${GAMES[p.game].name}</b> ke liye challenge kiya! ${kind === "group" ? "Group mein accept karo." : ""}`;
    if (kind === "private") {
      const kb2 = new InlineKeyboard().text("✅ Accept", `gx:acc:${m.id}`).text("❌ Decline", `gx:dec:${m.id}`);
      await notify(ctx.api, p.target.id, note, kb2);
    } else await notify(ctx.api, p.target.id, note);
  }
  return m;
}

async function who(ctx: Context): Promise<{ id: number; name: string } | null> {
  const r = ctx.message?.reply_to_message?.from;
  if (r && !r.is_bot) return { id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(" ") };
  const arg = String(ctx.match ?? "").trim();
  const ent = ctx.message?.entities?.find((e) => e.type === "text_mention");
  if (ent && "user" in ent && ent.user && !ent.user.is_bot) return { id: ent.user.id, name: ent.user.first_name };
  const num = arg.match(/^\d{5,}$/)?.[0];
  if (num) {
    const p = await getPlayer(Number(num));
    return { id: Number(num), name: p?.name ?? num };
  }
  const un = arg.match(/^@?([A-Za-z0-9_]{4,32})$/)?.[1];
  if (un) {
    const row = await findUserByUsername(un);
    if (row) return { id: row.id, name: row.first_name ?? `@${un}` };
  }
  return null;
}

// ---------------------------------------------------------------- screens
function homeKeyboard(target = 0) {
  const kb = new InlineKeyboard();
  kb.text("⭕ Tic-Tac-Toe", `gs:ttt:${target}`).row().text("✊ Rock-Paper-Scissors", `gs:rps:${target}`).row().text("🔤 Word Battle", `gs:word:${target}`);
  return kb;
}
const stepKb = (rows: [string, string][][]) => {
  const kb = new InlineKeyboard();
  for (const r of rows) {
    for (const [t, d] of r) kb.text(t, d);
    kb.row();
  }
  return kb;
};

function profileText(p: Player, rank: number | null, pro: boolean): string {
  const wr = p.matches ? Math.round((p.wins / p.matches) * 100) : 0;
  let t =
    `👤 <b>${vip(p)}${esc(p.name)}</b>${p.username ? ` (@${esc(p.username)})` : ""}\n` +
    `🏅 Rating: <b>${p.rating}</b>${rank ? ` · Rank #${rank}` : ""}\n` +
    `🎮 Matches: ${p.matches} · ✅ ${p.wins} W · ❌ ${p.losses} L · 🤝 ${p.draws} D (${wr}% win)\n` +
    `🔥 Streak: ${p.streak} (best ${p.best})\n🎯 Game points: <b>${p.points}</b>\n` +
    `🏷️ Badges: ${p.badges.length ? p.badges.join(", ") : "—"}`;
  if (pro) {
    t += "\n\n📊 <b>Pro stats</b>\n" + (Object.keys(GAMES) as GameId[]).map((g) => `${GAMES[g].icon} ${GAMES[g].name}: ${p.g[g].w}W ${p.g[g].l}L ${p.g[g].d}D`).join("\n");
  } else if (!p.items.includes("stats_pro")) t += "\n\n🔒 Per-game breakdown: /shop → Pro statistics";
  return t;
}

const when = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

// ---------------------------------------------------------------- registration
export function registerGames(bot: Bot) {
  // Group commands need chatAllowed(); in a verified DM the gate lets these commands through (see gate.ts DM_PASS).
  const cmd = (names: string | string[], fn: (ctx: Context, p: Player) => Promise<unknown>) =>
    bot.command(names, async (ctx, next) => {
      if (!ctx.from || ctx.from.is_bot) return next();
      if (ctx.chat.type !== "private" && !chatAllowed(ctx)) return next();
      const p = await ensurePlayer(ctx.from, { dm: ctx.chat.type === "private" });
      if (p.status === "banned") return void (await ctx.reply("Tumhe games se restrict kiya gaya hai."));
      try {
        await fn(ctx, p);
      } catch (e) {
        console.error(`game command ${names}:`, e);
        await ctx.reply("Kuch gadbad ho gayi, thodi der baad try karo 🥺").catch(() => {});
      }
    });

  cmd(["games", "play"], async (ctx) => {
    await ctx.reply("🎮 <b>Games</b>\nKaunsa game khelna hai? Phir koi bhi dost accept kar sakta hai.", { ...html, reply_markup: homeKeyboard(0) });
  });

  cmd("challenge", async (ctx, p) => {
    const t = await who(ctx);
    if (String(ctx.match ?? "").trim() && !t && !ctx.message?.reply_to_message) {
      return void (await ctx.reply("Ye user mujhe nahi mila. Uske message ka reply karke /challenge likho."));
    }
    if (t && t.id === p.id) return void (await ctx.reply("Khud se kaise khelogi? 😄"));
    const q = t ? `\n🎯 Opponent: ${esc(t.name)}` : "\nOpen challenge: koi bhi accept kar sakta hai.";
    await ctx.reply(`⚔️ <b>Challenge</b>${q}\nGame chuno:`, { ...html, reply_markup: homeKeyboard(t?.id ?? 0) });
  });

  cmd("cancel", async (ctx, p) => {
    const rows = await recentMatches(p.id);
    const mine = rows.filter((m) => m.status === "pending" && m.a === p.id);
    if (!mine.length) return void (await ctx.reply("Cancel karne ke liye koi pending challenge nahi hai."));
    for (const m of mine) {
      const u = await updateMatch(m.id, (c) => (c.status === "pending" ? { ...c, status: "cancelled" } : undefined));
      if (u) await refresh(ctx.api, u);
    }
    await ctx.reply(`🚫 ${mine.length} challenge cancel ho gaya.`);
  });

  cmd("matches", async (ctx, p) => {
    const rows = await recentMatches(p.id);
    if (!rows.length) return void (await ctx.reply("Abhi koi match nahi. /games se shuru karo 🎮"));
    const lines = rows.slice(0, 8).map((m) => {
      const opp = m.a === p.id ? m.bn || "open" : m.an;
      const res = m.status === "done" ? (m.winner === "draw" ? "🤝 draw" : m.winner === p.id ? "✅ won" : "❌ lost") : m.status;
      return `${GAMES[m.game].icon} ${esc(GAMES[m.game].name)} vs ${esc(opp)} — ${res} (${when(m.created)})`;
    });
    await ctx.reply(`🎮 <b>Tumhare matches</b>\n\n${lines.join("\n")}`, html);
  });

  cmd("profile", async (ctx, p) => {
    const t = await who(ctx);
    const target = t && t.id !== p.id ? await getPlayer(t.id) : p;
    if (!target) return void (await ctx.reply("Is user ne abhi tak koi game nahi khela."));
    const pro = target.id === p.id && p.items.includes("stats_pro");
    await ctx.reply(profileText(target, await rankOf(target.id), pro), html);
  });

  cmd(["gtop", "toplayers"], async (ctx) => {
    const top = await topPlayers(10);
    if (!top.length) return void (await ctx.reply("Abhi rankings khali hain. Pehla match khelo! 🏁"));
    const medals = ["🥇", "🥈", "🥉"];
    await ctx.reply(
      "🏆 <b>Game leaderboard</b>\n\n" +
        top.map((p, i) => `${medals[i] ?? `${i + 1}.`} ${vip(p)}${esc(p.name)} — ${p.rating} (${p.wins}W/${p.losses}L)`).join("\n"),
      html,
    );
  });

  cmd("wallet", async (ctx, p) => {
    const stars = (await purchases(p.id)).filter((o) => o.status === "paid").reduce((s, o) => s + o.amount, 0);
    await ctx.reply(
      "💰 <b>Wallet</b>\n\n" +
        `🎯 <b>Game points:</b> ${p.points}\n<i>Non-cash points. Cash value nahi, withdraw ya transfer nahi hote.</i>\n\n` +
        `⭐ <b>Telegram Stars:</b> ab tak ${stars} Stars digital items par kharch kiye\n<i>Stars yahan balance ke roop mein store nahi hote; har purchase seedha Telegram se hoti hai.</i>\n\n` +
        `💵 <b>Cash wallet:</b> unavailable\n<i>${CASH_OFF}</i>\n\n` +
        "/transactions · /purchases · /shop · /dailygame",
      html,
    );
  });

  cmd("transactions", async (ctx, p) => {
    const rows = await history(p.id, 12);
    if (!rows.length) return void (await ctx.reply("Abhi koi transaction nahi. /dailygame se bonus lo 🎁"));
    await ctx.reply(
      "🧾 <b>Transactions</b>\n\n" +
        rows
          .map((e) => `${e.dir === "credit" ? "➕" : "➖"} ${e.amount} ${e.unit === "XTR" ? "⭐" : "pts"} — ${esc(e.type)}${e.status === "completed" ? "" : ` (${e.status})`} · ${when(e.createdAt)}`)
          .join("\n"),
      html,
    );
  });

  cmd("purchases", async (ctx, p) => {
    const rows = await purchases(p.id);
    if (!rows.length) return void (await ctx.reply("Abhi koi purchase nahi. /shop dekho ⭐"));
    await ctx.reply(
      "🛍️ <b>Purchases</b>\n\n" +
        rows.map((o) => `${product(o.productId)?.title ?? o.productId} — ${o.amount} ⭐ · ${o.status} · ${when(o.createdAt)}`).map(esc).join("\n"),
      html,
    );
  });

  cmd("dailygame", async (ctx, p) => {
    const r = await claimDaily(p.id);
    await ctx.reply(r.ok ? `🎁 Daily bonus: +${r.amount} game points! Balance: ${r.balance}` : `Aaj ka bonus pehle hi le liya. Kal phir aana 😉 (Balance: ${r.balance})`);
  });

  cmd("gsettings", async (ctx, p) => {
    const u = await casUpdate<Player>(`gp/${p.id}`, (c) => (c ? { ...c, notify: !c.notify } : undefined));
    await ctx.reply(u?.notify ? "🔔 Game notifications ON" : "🔕 Game notifications OFF (sirf zaroori payment messages aayenge)");
  });

  cmd("theme", async (ctx, p) => {
    const owned = ["default", ...p.items.filter((i) => THEMES[i])];
    const kb = new InlineKeyboard();
    for (const t of owned) kb.text(`${THEMES[t][0]}${THEMES[t][1]} ${t === p.theme ? "✓" : ""}`.trim(), `gth:${t}`);
    await ctx.reply("🎨 Board theme chuno:", { reply_markup: kb });
  });

  cmd("shop", async (ctx, p) => {
    if (ctx.chat?.type !== "private") {
      return void (await ctx.reply("Shop DM mein khulta hai 🛍️", { reply_markup: new InlineKeyboard().url("Shop kholo", `https://t.me/${ctx.me.username}?start=gm_shop`) }));
    }
    await sendShop(ctx, p);
  });

  cmd("paysupport", async (ctx) => {
    await ctx.reply(
      "💬 <b>Payment support</b>\nKisi purchase mein dikkat ho ya refund chahiye to owner ko apna purchase ka naam aur time batao. " +
        "Eligible Stars purchases ka refund Telegram ke rules ke hisaab se kiya jata hai.",
      html,
    );
  });

  cmd(["deposit", "withdraw", "cashout", "tournament"], async (ctx) => {
    await ctx.reply(`💵 ${CASH_OFF}`);
  });

  cmd("gamehelp", async (ctx) => {
    await ctx.reply(
      "🎮 <b>Game commands</b>\n/games — game chuno\n/challenge — kisi ko challenge (reply karke)\n/matches — tumhare matches\n/profile — stats\n" +
        "/gtop — rankings\n/wallet · /transactions · /purchases\n/dailygame — daily points\n/shop · /theme\n/gsettings — notifications\n/cancel — pending challenge hatao",
      html,
    );
  });

  // /start deep links: gch_<matchId> opens a DM challenge, gm_shop opens the shop.
  bot.command("start", async (ctx, next) => {
    const payload = String(ctx.match ?? "");
    if (ctx.chat.type !== "private" || !ctx.from) return next();
    if (!/^(gch_|gm_)/.test(payload)) return next();
    const p = await ensurePlayer(ctx.from, { dm: true });
    if (payload === "gm_shop") return void (await sendShop(ctx, p));
    const m = await getMatch(payload.slice(4));
    if (!m || m.status !== "pending") return void (await ctx.reply("Ye challenge ab available nahi hai."));
    const { text, kb } = await render(m);
    const sent = await ctx.reply(text, { ...html, reply_markup: kb });
    await updateMatch(m.id, (c) => ({ ...c, views: c.views.some((v) => v.chat === sent.chat.id) ? c.views : [...c.views, { chat: sent.chat.id, msg: sent.message_id }] }));
  });

  // ---- callbacks
  const guard = async (ctx: Context): Promise<Player | null> => {
    if (!ctx.from) return null;
    const p = await ensurePlayer(ctx.from, { dm: ctx.chat?.type === "private" });
    if (p.status === "banned") {
      await ctx.answerCallbackQuery({ text: "Tumhe games se restrict kiya gaya hai.", show_alert: true }).catch(() => {});
      return null;
    }
    return p;
  };
  const answer = (ctx: Context, o: Out = {}) => ctx.answerCallbackQuery({ text: o.toast, show_alert: o.alert }).catch(() => {});

  bot.callbackQuery("gn:noop", (ctx) => answer(ctx));

  // game -> options screens
  bot.callbackQuery(/^gs:(ttt|rps|word)(?::(\d+))?(?::(\w+))?(?::(\w+))?$/, async (ctx) => {
    const p = await guard(ctx);
    if (!p) return;
    const [, game, target, a1, a2] = ctx.match as unknown as string[];
    if (!(await gameEnabled(game as GameId))) return void (await answer(ctx, { toast: "Ye game abhi maintenance mein hai.", alert: true }));
    const t = target ?? "0";
    await answer(ctx);
    if (game === "ttt") return void (await create(ctx, p, "ttt", Number(t), {}));
    if (game === "rps") {
      return void (await ctx.editMessageText("✊ Best of kitna?", { reply_markup: stepKb([[["Best of 3", `gn:rps:${t}:3`], ["Best of 5", `gn:rps:${t}:5`]]]) }).catch(() => {}));
    }
    if (!a1) {
      return void (await ctx.editMessageText("🔤 Word Battle mode chuno:", {
        reply_markup: stepKb([[["Vocabulary quiz", `gs:word:${t}:vocab`]], [["Word scramble", `gs:word:${t}:scramble`]], [["Guess the word", `gs:word:${t}:guess`]]]),
      }).catch(() => {}));
    }
    if (!a2) {
      return void (await ctx.editMessageText("Difficulty:", {
        reply_markup: stepKb([[["Easy", `gs:word:${t}:${a1}:easy`], ["Medium", `gs:word:${t}:${a1}:medium`], ["Hard", `gs:word:${t}:${a1}:hard`]]]),
      }).catch(() => {}));
    }
    await ctx.editMessageText("Kitne rounds?", {
      reply_markup: stepKb([[["3", `gn:word:${t}:${a1}:${a2}:3`], ["5", `gn:word:${t}:${a1}:${a2}:5`], ["7", `gn:word:${t}:${a1}:${a2}:7`]]]),
    }).catch(() => {});
  });

  bot.callbackQuery(/^gn:(rps|word):(\d+):(\w+)(?::(\w+))?(?::(\d+))?$/, async (ctx) => {
    const p = await guard(ctx);
    if (!p) return;
    const [, game, target, x, y, z] = ctx.match as unknown as string[];
    await answer(ctx);
    const opts: MatchOpts =
      game === "rps"
        ? { bestOf: x === "5" ? 5 : 3 }
        : { mode: (["vocab", "scramble", "guess"].includes(x) ? x : "vocab") as WordMode, diff: (["easy", "medium", "hard"].includes(y) ? y : "easy") as Difficulty, rounds: [3, 5, 7].includes(Number(z)) ? Number(z) : 5 };
    await create(ctx, p, game as GameId, Number(target), opts);
  });

  async function create(ctx: Context, p: Player, game: GameId, target: number, opts: MatchOpts) {
    if (!(await gameEnabled(game))) return;
    if (target && target === p.id) return void (await ctx.reply("Khud se kaise khelogi? 😄"));
    let t: { id: number; name: string } | null = null;
    if (target) {
      const tp = await getPlayer(target);
      if (tp?.status === "banned") return void (await ctx.reply("Ye user abhi games nahi khel sakta."));
      t = { id: target, name: tp?.name ?? String(target) };
    }
    await ctx.editMessageText("⚔️ Challenge bhej diya!").catch(() => {});
    await postChallenge(ctx, { game, a: p, target: t, opts });
  }

  // accept / decline / cancel / rematch
  bot.callbackQuery(/^gx:(acc|dec|can|rem):(\w+)$/, async (ctx) => {
    const p = await guard(ctx);
    if (!p) return;
    const [, act, id] = ctx.match as unknown as string[];
    const out: Out = {};
    if (act === "rem") {
      const old = await getMatch(id);
      if (!old || old.status === "pending" || old.status === "active") return void (await answer(ctx, { toast: "Rematch abhi possible nahi." }));
      const side = sideOf(old, p.id);
      if (!side || !old.b) return void (await answer(ctx, { toast: "Ye tumhara match nahi hai." }));
      if (!(await gameEnabled(old.game))) return void (await answer(ctx, { toast: "Ye game abhi maintenance mein hai.", alert: true }));
      await answer(ctx);
      const oppId = uidOf(old, other(side));
      const opp = await getPlayer(oppId);
      await postChallenge(ctx, { game: old.game, a: p, target: { id: oppId, name: opp?.name ?? "Player" }, opts: old.opts, rematchOf: old.id });
      return;
    }
    const msg = ctx.callbackQuery.message;
    const m = await updateMatch(id, (c) => {
      out.toast = undefined;
      if (applyExpiry(c)) return c;
      if (c.status !== "pending") {
        out.toast = "Ye challenge ab active nahi hai.";
        return undefined;
      }
      if (act === "can") {
        if (c.a !== p.id) return void (out.toast = "Sirf challenger cancel kar sakta hai.");
        c.status = "cancelled";
        return c;
      }
      if (c.a === p.id) return void (out.toast = "Apna hi challenge accept nahi kar sakte 😄");
      if (c.target && c.b !== p.id) return void (out.toast = "Ye challenge tumhare liye nahi hai.");
      if (act === "dec") {
        if (!c.target) return void (out.toast = "Open challenge hai, bas ignore kar do.");
        c.status = "declined";
        return c;
      }
      const now = Date.now();
      c.b = p.id;
      c.bn = p.name;
      c.status = "active";
      c.lastAt = now;
      c.state = startState(c, now);
      if (msg && !c.views.some((v) => v.chat === msg.chat.id && v.msg === msg.message_id)) c.views.push({ chat: msg.chat.id, msg: msg.message_id });
      return c;
    });
    if (!m) return void (await answer(ctx, { toast: out.toast ?? "Match nahi mila." }));
    await answer(ctx, { toast: out.toast });
    await trackMatch(p.id, id);
    await refresh(ctx.api, m);
    if (m.status === "active") await notify(ctx.api, m.a, `✅ ${esc(p.name)} ne tumhara challenge accept kar liya! Match shuru.`);
    if (m.status === "declined") await notify(ctx.api, m.a, `❌ ${esc(p.name)} ne challenge decline kar diya.`);
  });

  // generic move runner
  async function move(ctx: Context, id: string, fn: (c: Match, side: Side, p: Player, out: Out) => Match | undefined) {
    const p = await guard(ctx);
    if (!p) return;
    const out: Out = {};
    const m = await updateMatch(id, (c) => {
      out.toast = undefined;
      out.alert = undefined;
      if (applyExpiry(c)) return c;
      if (c.status !== "active") {
        out.toast = "Ye match khatam ho chuka hai.";
        return undefined;
      }
      const side = sideOf(c, p.id);
      if (!side) {
        out.toast = "Tum is match ke player nahi ho.";
        out.alert = true;
        return undefined;
      }
      return fn(c, side, p, out);
    });
    if (!m) return void (await answer(ctx, { toast: out.toast ?? "Match nahi mila." }));
    await answer(ctx, out);
    const fin = await finishIfDone(ctx.api, id);
    await refresh(ctx.api, fin ?? m);
    if (fin && fin.status === "done" && fin.kind === "private") {
      for (const uid of [fin.a, fin.b!]) if (!fin.views.some((v) => v.chat === uid)) await notify(ctx.api, uid, `🏁 Match khatam: ${GAMES[fin.game].name}`);
    }
  }

  bot.callbackQuery(/^gt:(\w+):(\d)$/, (ctx) =>
    move(ctx, (ctx.match as any)[1], (c, side, _p, out) => {
      const r = tttMove(c.state as TttState, side, Number((ctx.match as any)[2]));
      if (!r.ok) {
        out.toast = { "not-your-turn": "Abhi tumhari baari nahi hai.", occupied: "Ye box bhara hua hai.", finished: "Match khatam ho chuka hai.", "bad-cell": "Galat move." }[r.reason];
        return undefined;
      }
      c.state = r.state;
      c.lastAt = Date.now();
      if (r.result) {
        c.status = "done";
        c.winner = r.result === "draw" ? "draw" : uidOf(c, r.result);
      }
      return c;
    }),
  );

  bot.callbackQuery(/^gr:(\w+):(rock|paper|scissors)$/, (ctx) =>
    move(ctx, (ctx.match as any)[1], (c, side, _p, out) => {
      const r = rpsPick(c.state as RpsState, side, (ctx.match as any)[2]);
      if (!r.ok) {
        out.toast = r.reason === "already-picked" ? "Tumne choice lock kar di hai, badal nahi sakte." : "Galat choice.";
        return undefined;
      }
      c.state = r.state;
      c.lastAt = Date.now();
      out.toast = `Tumne ${RPS_ICON[(ctx.match as any)[2] as Rps]} chuna. Lock ho gaya!`;
      if (r.outcome.done) {
        c.status = "done";
        c.winner = r.outcome.winner === "draw" ? "draw" : uidOf(c, r.outcome.winner as Side);
      }
      return c;
    }),
  );

  bot.callbackQuery(/^gq:(\w+):(\d):(\d+)$/, (ctx) =>
    move(ctx, (ctx.match as any)[1], (c, side, _p, out) => {
      const s = c.state as WordState;
      // The round number is part of the button: a tap on an old question can never answer the current one.
      if (Number((ctx.match as any)[3]) !== s.round) {
        out.toast = "Ye sawaal purana ho chuka hai.";
        return undefined;
      }
      const r = wordAnswer(s, side, Number((ctx.match as any)[2]), Date.now());
      if (!r.ok) {
        out.toast = r.reason === "already-answered" ? "Tum is round mein pehle hi galat answer de chuke ho." : "Galat option.";
        return undefined;
      }
      c.state = r.state;
      c.lastAt = Date.now();
      out.toast = r.correct ? "✅ Sahi jawab!" : "❌ Galat! Is round mein ab dobara nahi.";
      if (r.outcome.done) {
        c.status = "done";
        c.winner = r.outcome.winner === "draw" ? "draw" : uidOf(c, r.outcome.winner as Side);
      }
      return c;
    }),
  );

  bot.callbackQuery(/^gz:(\w+)$/, (ctx) =>
    move(ctx, (ctx.match as any)[1], (c, side) => {
      c.status = "done";
      c.how = "resign";
      c.winner = uidOf(c, other(side));
      return c;
    }),
  );

  bot.callbackQuery(/^gth:(\w+)$/, async (ctx) => {
    const p = await guard(ctx);
    if (!p) return;
    const t = (ctx.match as any)[1] as string;
    const ok = THEMES[t] && (t === "default" || p.items.includes(t));
    if (!ok) return void (await answer(ctx, { toast: "Ye theme tumhare paas nahi hai.", alert: true }));
    await casUpdate<Player>(`gp/${p.id}`, (c) => (c ? { ...c, theme: t } : undefined));
    await answer(ctx, { toast: "Theme set ✓" });
  });

  // ---- shop + Telegram Stars
  async function sendShop(ctx: Context, p: Player) {
    const kb = new InlineKeyboard();
    const lines = PRODUCTS.map((pr) => {
      const own = p.items.includes(pr.id);
      if (!own) {
        kb.text(`⭐ ${pr.stars} — ${pr.title}`, `gb:${pr.id}`);
        if (pr.points) kb.text(`🎯 ${pr.points} pts`, `gbp:${pr.id}`);
        kb.row();
      }
      return `${own ? "✅" : "▫️"} <b>${esc(pr.title)}</b> — ${esc(pr.desc)}`;
    });
    await ctx.reply(
      `🛍️ <b>Shop</b>\nSirf digital cosmetics aur features. Cash value nahi.\n\n${lines.join("\n")}\n\n🎯 Game points: ${p.points}`,
      { ...html, reply_markup: kb },
    );
  }

  bot.callbackQuery(/^gb:(\w+)$/, async (ctx) => {
    const p = await guard(ctx);
    if (!p) return;
    if (ctx.chat?.type !== "private") return void (await answer(ctx, { toast: "Shop DM mein khulta hai.", alert: true }));
    const pr = product((ctx.match as any)[1]);
    if (!pr) return void (await answer(ctx, { toast: "Item nahi mila." }));
    if (p.items.includes(pr.id)) return void (await answer(ctx, { toast: "Ye item tumhare paas pehle se hai." }));
    const order = await createOrder(p.id, pr.id);
    if (!order) return void (await answer(ctx, { toast: "Order nahi ban paya." }));
    await answer(ctx);
    // Telegram Stars: currency XTR, empty provider token, one price line equal to the product price.
    await ctx.api.sendInvoice(ctx.chat.id, pr.title, pr.desc, `ord:${order.id}`, "XTR", [{ label: pr.title, amount: pr.stars }]);
  });

  bot.callbackQuery(/^gbp:(\w+)$/, async (ctx) => {
    const p = await guard(ctx);
    if (!p) return;
    const r = await buyWithPoints(p.id, (ctx.match as any)[1]);
    const msg = r.ok
      ? `✅ Mil gaya! Balance: ${r.balance} pts. /theme se lagao.`
      : r.reason === "insufficient" ? `Points kam hain (tumhare paas ${r.balance ?? 0}).` : r.reason === "owned" ? "Ye item pehle se tumhare paas hai." : "Ye item points se nahi milta.";
    await answer(ctx, { toast: msg, alert: true });
  });

  // pre_checkout_query must be answered within 10 seconds: validate the order and nothing else.
  bot.on("pre_checkout_query", async (ctx) => {
    const q = ctx.preCheckoutQuery;
    const reject = (m: string) => ctx.answerPreCheckoutQuery(false, m).catch(() => {});
    try {
      const order = q.invoice_payload.startsWith("ord:") ? await getOrder(q.invoice_payload.slice(4)) : null;
      if (!order || order.uid !== q.from.id) return void (await reject("Order nahi mila. /shop se dobara try karo."));
      if (order.status !== "pending") return void (await reject("Ye order pehle hi complete ho chuka hai."));
      if (q.currency !== "XTR" || q.total_amount !== order.amount) return void (await reject("Price match nahi hui. /shop se dobara try karo."));
      const p = await getPlayer(order.uid);
      if (!p || p.status !== "active") return void (await reject("Account restricted hai."));
      if (p.items.includes(order.productId)) return void (await reject("Ye item tumhare paas pehle se hai."));
      await ctx.answerPreCheckoutQuery(true);
    } catch (e) {
      console.error("pre_checkout:", e);
      await reject("Abhi process nahi ho paya, thodi der baad try karo.");
    }
  });

  // Credit only here, after Telegram confirms the payment, and exactly once per charge id.
  bot.on("message:successful_payment", async (ctx) => {
    const sp = ctx.message.successful_payment;
    const r = await fulfilPayment({
      uid: ctx.from.id, payload: sp.invoice_payload, chargeId: sp.telegram_payment_charge_id,
      providerChargeId: sp.provider_payment_charge_id, amount: sp.total_amount, currency: sp.currency,
    });
    if (r.ok && !r.duplicate) {
      await ctx.reply(`✅ Payment mil gayi! <b>${esc(r.product?.title ?? "Item")}</b> unlock ho gaya. /theme ya /profile dekho.`, html);
    } else if (!r.ok) {
      console.error("unmatched payment", sp.telegram_payment_charge_id);
      await ctx.reply("Payment mil gayi par order match nahi hua. Owner ko /paysupport se batao, tumhara paisa safe hai.");
    }
  });

  // ---- admin
  bot.command("gadmin", async (ctx, next) => {
    if (!ctx.from || !isBotManager(ctx.from.id)) return next();
    const [sub = "help", ...rest] = String(ctx.match ?? "").trim().split(/\s+/);
    const actor = ctx.from.id;
    const num = (s?: string) => (s && /^\d{5,}$/.test(s) ? Number(s) : null);
    try {
      switch (sub.toLowerCase()) {
        case "stats": {
          const players = await getMany<Player>(await listKeys("gp/"));
          const matches = await getMany<Match>(await listKeys("gm/"));
          const by: Record<string, number> = {};
          for (const m of matches) by[m.game] = (by[m.game] ?? 0) + 1;
          const day = Date.now() - 86400_000;
          const active = players.filter((p) => p.last > day).length;
          const orders = await getMany<{ status: string; amount: number }>(await listKeys("go/"));
          const paid = orders.filter((o) => o.status === "paid");
          const led = await getMany<{ unit: string; dir: string; amount: number; status: string }>(await listKeys("gl/"));
          const issued = led.filter((e) => e.unit === "points" && e.dir === "credit" && e.status === "completed").reduce((s, e) => s + e.amount, 0);
          const spent = led.filter((e) => e.unit === "points" && e.dir === "debit" && e.status === "completed").reduce((s, e) => s + e.amount, 0);
          const cfg = await getConfig();
          return void (await ctx.reply(
            `📊 Game stats\nPlayers: ${players.length} (active 24h: ${active}, banned: ${players.filter((p) => p.status === "banned").length})\n` +
              `Matches: ${matches.length} — ${Object.entries(by).map(([g, n]) => `${g}:${n}`).join(", ") || "—"}\n` +
              `Stars purchases: ${paid.length} paid, ${paid.reduce((s, o) => s + o.amount, 0)} ⭐, refunded ${orders.filter((o) => o.status === "refunded").length}\n` +
              `Points: issued ${issued}, spent ${spent}\nDisabled games: ${cfg.disabled.join(", ") || "none"}`,
          ));
        }
        case "ban":
        case "unban": {
          const id = num(rest[0]);
          if (!id) return void (await ctx.reply("/gadmin ban <user id> [reason]"));
          const p = await setBan(id, sub === "ban");
          await audit(actor, sub, "user", id, { reason: rest.slice(1).join(" ") });
          return void (await ctx.reply(p ? `${sub} done: ${id}` : "Is user ka game profile nahi mila."));
        }
        case "game": {
          const [state, g] = rest;
          if (!["on", "off"].includes(state ?? "") || !(g in GAMES)) return void (await ctx.reply("/gadmin game off|on ttt|rps|word"));
          const cfg = await getConfig();
          const set = new Set(cfg.disabled);
          if (state === "off") set.add(g as GameId);
          else set.delete(g as GameId);
          await setConfig({ disabled: [...set] });
          await audit(actor, `game-${state}`, "game", g);
          return void (await ctx.reply(`${g}: ${state === "off" ? "disabled" : "enabled"}`));
        }
        case "grant":
        case "take": {
          const id = num(rest[0]);
          const amt = Number(rest[1]);
          const reason = rest.slice(2).join(" ").trim();
          if (!id || !Number.isInteger(amt) || amt <= 0 || reason.length < 3) return void (await ctx.reply(`/gadmin ${sub} <user id> <amount> <reason>\nReason zaroori hai (audit log mein jata hai).`));
          const r = await movePoints(id, amt, sub === "grant" ? "credit" : "debit", "admin", `admin:${newId()}`, { meta: { by: actor, reason } });
          await audit(actor, sub, "points", id, { amount: amt, reason, ok: r.ok });
          return void (await ctx.reply(r.ok ? `✅ ${sub} ${amt} pts — balance ${r.balance}` : `Nahi hua: ${r.reason}`));
        }
        case "reconcile": {
          const id = num(rest[0]);
          if (!id) return void (await ctx.reply("/gadmin reconcile <user id> [fix]"));
          const fix = rest[1] === "fix";
          const r = await reconcile(id, fix);
          if (fix && !r.ok) await audit(actor, "reconcile-fix", "points", id, r);
          return void (await ctx.reply(`Balance ${r.balance} · ledger ${r.ledger} · ${r.ok ? "match ✅" : fix ? "fixed" : "MISMATCH (add 'fix')"}`));
        }
        case "refund": {
          const charge = rest[0];
          if (!charge) return void (await ctx.reply("/gadmin refund <telegram_payment_charge_id>"));
          const pay = await getPayment(charge);
          if (!pay) return void (await ctx.reply("Ye charge id mere records mein nahi hai."));
          if (pay.status === "refunded") return void (await ctx.reply("Pehle hi refund ho chuka hai."));
          await ctx.api.refundStarPayment(pay.uid, charge);
          await markRefunded(charge);
          await audit(actor, "refund", "payment", charge, { uid: pay.uid, amount: pay.amount });
          await ctx.api.sendMessage(pay.uid, "↩️ Tumhari Stars purchase refund ho gayi.").catch(() => {});
          return void (await ctx.reply("✅ Refunded."));
        }
        case "audit": {
          const rows = await recentAudit(12);
          return void (await ctx.reply(rows.length ? rows.map((a) => `${when(a.at)} ${a.actor} ${a.action} ${a.targetType}:${a.targetId}`).join("\n") : "Audit log khali hai."));
        }
        case "cfg": {
          const [k, v] = rest;
          const keys = ["winPoints", "drawPoints", "lossPoints", "dailyBonus", "maxRewardedPerDay", "maxPerPairPerDay"] as const;
          if (!k) return void (await ctx.reply(JSON.stringify(await getConfig(), null, 2)));
          if (!(keys as readonly string[]).includes(k) || !/^\d{1,4}$/.test(v ?? "")) return void (await ctx.reply(`/gadmin cfg <${keys.join("|")}> <number>`));
          await setConfig({ [k]: Number(v) } as any);
          await audit(actor, "cfg", "config", k, { value: Number(v) });
          return void (await ctx.reply(`${k} = ${v}`));
        }
        case "announce": {
          const text = rest.join(" ").trim();
          if (!text) return void (await ctx.reply("/gadmin announce <message>"));
          const players = (await getMany<Player>(await listKeys("gp/"))).filter((p) => p.dm && p.notify && p.status === "active").slice(0, 300);
          let sent = 0;
          for (const p of players) {
            if (await ctx.api.sendMessage(p.id, `📣 ${text}`).then(() => true).catch(() => false)) sent++;
            await new Promise((r) => setTimeout(r, 40));
          }
          await audit(actor, "announce", "broadcast", "players", { sent });
          return void (await ctx.reply(`📣 ${sent}/${players.length} players ko bheja.`));
        }
        default:
          return void (await ctx.reply(
            "🛠️ /gadmin stats | ban <id> | unban <id> | game on|off <ttt|rps|word> | grant <id> <amt> <reason> | take <id> <amt> <reason> | " +
              "reconcile <id> [fix] | refund <charge_id> | audit | cfg [key value] | announce <text>",
          ));
      }
    } catch (e: any) {
      console.error("gadmin:", e);
      await ctx.reply(`Error: ${String(e?.description ?? e?.message ?? e).slice(0, 200)}`);
    }
  });

}

/** Scheduler hook: expires stale challenges and idle matches, and tidies the active index. */
export async function sweepGames(api: Api) {
  const ids = await activeMatchIds();
  const keep: string[] = [];
  for (const id of ids) {
    const m = await updateMatch(id, (c) => (applyExpiry(c) ? c : undefined));
    if (!m) continue;
    if (m.status === "pending" || m.status === "active") {
      keep.push(id);
      continue;
    }
    if (m.status === "done" || m.status === "expired" || m.status === "abandoned") {
      const fin = await finishIfDone(api, id);
      await refresh(api, fin ?? m);
    }
  }
  if (keep.length !== ids.length) await setActiveIds(keep);
}
