import { InputFile, type Bot, type Context } from "grammy";
import { chatAllowed } from "./gate.js";

// /raw /id /info (like @RawDataBot) and /tools: every tool of the bot as buttons.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

// ---------- the tool catalog (what the buttons show) ----------
type Tool = { cmd: string; title: string; usage: string; note?: string };
type Cat = { id: string; label: string; tools: Tool[] };

export const CATALOG: Cat[] = [
  {
    id: "m", label: "📈 Market",
    tools: [
      { cmd: "price", title: "Live price", usage: "/price btc\n/price reliance\n/price aapl", note: "Crypto aur stocks, 24h change aur high/low ke saath." },
      { cmd: "chart", title: "Price chart", usage: "/chart btc\n/chart eth 30", note: "Din ki sankhya do (max 365)." },
      { cmd: "top", title: "Crypto gainers/losers", usage: "/top\n/gainers\n/losers" },
      { cmd: "nifty", title: "Nifty 50 movers", usage: "/nifty\n/stockgainers\n/stocklosers" },
      { cmd: "alert", title: "Price alert", usage: "/alert btc 90000\n/alerts\n/delalert 1", note: "Price cross hone par group mein bata dega." },
      { cmd: "convert", title: "Currency convert", usage: "/convert 100 usd inr" },
      { cmd: "fear", title: "Fear & Greed", usage: "/fear" },
      { cmd: "gas", title: "Ethereum gas", usage: "/gas" },
      { cmd: "summary", title: "Market summary", usage: "/summary", note: "BTC, ETH, Nifty, Sensex ek jagah." },
      { cmd: "buy", title: "Paper trading", usage: "/buy btc 500\n/sell btc all\n/portfolio\n/tradelb\n/resetpaper", note: "Virtual $10,000 se practice, asli paisa nahi." },
    ],
  },
  {
    id: "a", label: "🤖 AI & Voice",
    tools: [
      { cmd: "live", title: "Live voice", usage: "/live", note: "Browser mein Myra se seedha baat (Gemini Live)." },
      { cmd: "voice", title: "Voice mode", usage: "/voice", note: "Group admin on/off kar sakta hai: Myra voice note mein jawab degi." },
      { cmd: "tr", title: "Translate", usage: "/tr hi good morning\n(msg ka reply karke) /tr en" },
      { cmd: "stt", title: "Voice se text", usage: "(voice msg ka reply karke) /stt" },
      { cmd: "see", title: "Photo samajhna", usage: "(photo ka reply karke) /see\nya photo ke caption mein: myra ye kya hai" },
      { cmd: "memory", title: "Myra ki yaaddasht", usage: "/memory\n/remember mera naam Rahul hai\n/forgetme" },
      { cmd: "forget", title: "Chat bhulana", usage: "/forget" },
    ],
  },
  {
    id: "f", label: "🎮 Fun & Games",
    tools: [
      { cmd: "truth", title: "Truth / Dare / WYR", usage: "/truth\n/dare\n/wyr" },
      { cmd: "anime", title: "Anime info", usage: "/anime naruto\n/manga one piece" },
      { cmd: "lovemeter", title: "Love meter", usage: "/lovemeter naam\n/match naam1 naam2" },
      { cmd: "joke", title: "Joke / fact / quote", usage: "/joke\n/fact\n/quote\n/motivate" },
      { cmd: "shayari", title: "Shayari / poem", usage: "/shayari\n/poem\n/lovenote" },
      { cmd: "horoscope", title: "Rashifal", usage: "/horoscope mesh" },
      { cmd: "coin", title: "Coin / dice / slot", usage: "/coin\n/dice\n/slot\n/dart\n/basket" },
      { cmd: "riddle", title: "Paheli", usage: "/riddle" },
      { cmd: "song", title: "Song / movie / food", usage: "/song\n/movie\n/food\n/date\n/gift" },
    ],
  },
  {
    id: "g", label: "🛡️ Group tools",
    tools: [
      { cmd: "rules", title: "Rules", usage: "/rules\n/setrules text (admin)" },
      { cmd: "setwelcome", title: "Welcome", usage: "/setwelcome Welcome {mention} to {group}!\n/welcome off\n/welcomebanner off\n/welcomedelete 60", note: "Admin. {mention} {name} {username} {group} {count}" },
      { cmd: "captcha", title: "Captcha", usage: "/captcha on", note: "Admin. Naya member button dabane tak mute." },
      { cmd: "antiraid", title: "AntiRaid", usage: "/antiraid on 8 30\n/unlockall", note: "Admin. Achanak bahut join hon to group lock." },
      { cmd: "lock", title: "Locks", usage: "/lock sticker gif link\n/unlock sticker\n/locks", note: "Admin. Bina argument ke /lock poora group lock karta hai." },
      { cmd: "addblock", title: "Blocklist", usage: "/addblock *casino* ban\n/unblock pattern\n/blocklist", note: "Admin. Actions: delete warn mute kick ban." },
      { cmd: "save", title: "Notes", usage: "/save naam text\n#naam\n/get naam\n/notes\n/clear naam", note: "Admin save karta hai, sab padh sakte hain." },
      { cmd: "filter", title: "Filters", usage: "/filter shabd jawab\n/stop shabd\n/filters", note: "Admin. Keyword aane par auto-reply." },
      { cmd: "warn", title: "Warn / mute / ban", usage: "(reply karke) /warn wajah\n/mute 30\n/kick\n/ban\n/unban", note: "Admin." },
      { cmd: "setlog", title: "Mod log", usage: "/setlog @channel\n/unsetlog", note: "Admin. Saari moderation actions channel mein." },
      { cmd: "daily", title: "Daily posts", usage: "/daily summary on\n/daily greet on\n/daily chatters on", note: "Admin. Market summary, good morning/night, top chatters." },
    ],
  },
  {
    id: "i", label: "🆔 Info",
    tools: [
      { cmd: "id", title: "ID", usage: "/id\n(kisi ke msg ka reply karke) /id", note: "User aur chat ka ID." },
      { cmd: "info", title: "User info", usage: "/info\n(reply karke) /info" },
      { cmd: "raw", title: "Raw JSON", usage: "/raw\n(kisi msg ka reply karke) /raw", note: "Message ka poora Telegram JSON, @RawDataBot jaisa." },
      { cmd: "points", title: "Points / referral", usage: "/points\n/refer\n/leaderboard" },
      { cmd: "stats", title: "Bot stats", usage: "/stats\n/users", note: "Sirf owner / bot admin." },
    ],
  },
];

function homeKeyboard() {
  const rows = [];
  for (let i = 0; i < CATALOG.length; i += 2) {
    rows.push(CATALOG.slice(i, i + 2).map((c) => ({ text: c.label, callback_data: `tl:${c.id}` })));
  }
  return { inline_keyboard: rows };
}

const HOME_TEXT = "🧰 <b>Myra ke tools</b>\n\nKaunsa section dekhna hai? Button dabao 👇";

function catScreen(cat: Cat) {
  const rows = [];
  for (let i = 0; i < cat.tools.length; i += 2) {
    rows.push(cat.tools.slice(i, i + 2).map((t, j) => ({ text: `/${t.cmd}`, callback_data: `tl:${cat.id}:${i + j}` })));
  }
  rows.push([{ text: "⬅️ Wapas", callback_data: "tl:home" }]);
  return { text: `${cat.label}\n\nKisi tool par dabao:`, kb: { inline_keyboard: rows } };
}

function toolScreen(cat: Cat, t: Tool) {
  const text =
    `<b>${esc(t.title)}</b>  (<code>/${t.cmd}</code>)\n\n<pre>${esc(t.usage)}</pre>` + (t.note ? `\n${esc(t.note)}` : "");
  return { text, kb: { inline_keyboard: [[{ text: "⬅️ " + cat.label, callback_data: `tl:${cat.id}` }, { text: "🏠 Menu", callback_data: "tl:home" }]] } };
}

// ---------- raw JSON ----------
const MAX_INLINE = 3600;

async function sendJson(ctx: Context, data: unknown) {
  const text = JSON.stringify(data, null, 4);
  if (text.length <= MAX_INLINE) {
    await ctx.reply(`<pre><code class="language-json">${esc(text)}</code></pre>`, { ...html, reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined });
  } else {
    await ctx.replyWithDocument(new InputFile(Buffer.from(text, "utf8"), "update.json"), { caption: "Poora JSON file mein (message bada tha)." });
  }
}

const code = (v: unknown) => `<code>${esc(String(v))}</code>`;

export const INFO_MENU = [
  { command: "tools", description: "Myra ke saare tools button mein" },
  { command: "id", description: "User aur chat ID" },
  { command: "info", description: "User ki jaankari" },
  { command: "raw", description: "Message ka raw JSON" },
];

export function registerToolMenu(bot: Bot) {
  const grp = (names: string | string[], fn: (ctx: Context) => Promise<unknown>) =>
    bot.command(names, async (ctx, next) => {
      if (!chatAllowed(ctx)) return next();
      await fn(ctx);
    });

  // Exactly the update Telegram sent (update_id and message), 4-space indent, like @RawDataBot.
  grp(["raw", "json"], async (ctx) => sendJson(ctx, ctx.update));

  grp("id", async (ctx) => {
    const r = ctx.message?.reply_to_message;
    const lines = [`🙋 Tumhara user ID: ${code(ctx.from!.id)}`, `💬 Chat ID: ${code(ctx.chat!.id)}`];
    if (r?.from) lines.push(`↩️ ${esc(r.from.first_name)} ka user ID: ${code(r.from.id)}`);
    if (r?.forward_origin && "sender_user" in r.forward_origin && r.forward_origin.sender_user) {
      lines.push(`📨 Forward karne wale ka ID: ${code(r.forward_origin.sender_user.id)}`);
    }
    if (r?.sender_chat) lines.push(`📢 Channel/group ID: ${code(r.sender_chat.id)}`);
    await ctx.reply(lines.join("\n"), html);
  });

  grp("info", async (ctx) => {
    const u = ctx.message?.reply_to_message?.from ?? ctx.from!;
    const lines = [
      `👤 <b>${esc([u.first_name, u.last_name].filter(Boolean).join(" "))}</b>`,
      `🆔 ID: ${code(u.id)}`,
      `🔗 Username: ${u.username ? "@" + esc(u.username) : "nahi hai"}`,
      `🌐 Language: ${code(u.language_code ?? "?")}`,
      `🤖 Bot: ${u.is_bot ? "haan" : "nahi"}${(u as any).is_premium ? "  ·  ⭐ Premium" : ""}`,
      `📎 <a href="tg://user?id=${u.id}">Profile link</a>`,
    ];
    const m = await ctx.api.getChatMember(ctx.chat!.id, u.id).catch(() => null);
    if (m) lines.push(`🏷️ Is group mein: ${m.status}`);
    await ctx.reply(lines.join("\n"), html);
  });

  // The tool buttons
  grp(["tools", "list", "menu", "help2"], async (ctx) => {
    await ctx.reply(HOME_TEXT, { ...html, reply_markup: homeKeyboard() });
  });

  bot.callbackQuery(/^tl:(.+)$/, async (ctx) => {
    const [a, b] = ctx.match[1].split(":");
    await ctx.answerCallbackQuery().catch(() => {});
    if (a === "new") return void (await ctx.reply(HOME_TEXT, { ...html, reply_markup: homeKeyboard() })); // from the DM keyboard
    let screen: { text: string; kb: any };
    const cat = CATALOG.find((c) => c.id === a);
    if (a === "home" || !cat) screen = { text: HOME_TEXT, kb: homeKeyboard() };
    else if (b === undefined) screen = catScreen(cat);
    else {
      const t = cat.tools[Number(b)];
      screen = t ? toolScreen(cat, t) : catScreen(cat);
    }
    await ctx.editMessageText(screen.text, { ...html, reply_markup: screen.kb }).catch(() => {});
  });
}
