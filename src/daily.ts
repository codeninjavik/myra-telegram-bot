import type { Api, Bot } from "grammy";
import { oneShot } from "./ai.js";
import { chatAllowed } from "./gate.js";
import { marketSummaryText } from "./market.js";
import { chatCfg, isChatAdmin, saveChatCfg, type ChatCfg } from "./moderation.js";
import { delKey, getJSON, listKeys, setJSON } from "./store.js";
import { pick } from "./persona.js";

// Scheduled group posts, switched on per group by an admin with /daily:
//   summary  09:00 IST  BTC, ETH, Nifty, Sensex, Fear & Greed
//   greet    07:30 IST good morning, 22:30 IST good night (written by Myra)
//   chatters 22:00 IST  top 5 most active members of the day
// scheduler.ts (a Netlify scheduled function) calls runDaily() every 15 minutes; each job runs once per IST day.

const IST = 5.5 * 3600_000;
const istNow = () => new Date(Date.now() + IST);
const istDay = () => istNow().toISOString().slice(0, 10);
const istMinutes = () => istNow().getUTCHours() * 60 + istNow().getUTCMinutes();

type Counts = Record<string, { n: number; name: string }>;
const countKey = (chatId: number, day = istDay()) => `tc/${chatId}/${day}`;

const FLAGS = { summary: "Daily market summary (9 AM)", greet: "Good morning/night (7:30 AM, 10:30 PM)", chatters: "Top chatters (10 PM)" } as const;
type Flag = keyof typeof FLAGS;

export function registerDaily(bot: Bot) {
  // Counts messages per member for the "top chatters" post. Only runs where an admin switched it on.
  bot.use(async (ctx, next) => {
    try {
      const chat = ctx.chat;
      const from = ctx.from;
      const text = ctx.message?.text ?? ctx.message?.caption;
      if (chat && from && !from.is_bot && text && !text.startsWith("/") && chatAllowed(ctx) && chatCfg(chat.id).daily?.chatters) {
        const key = countKey(chat.id);
        const counts = (await getJSON<Counts>(key)) ?? {};
        const row = counts[from.id] ?? { n: 0, name: from.first_name };
        counts[from.id] = { n: row.n + 1, name: from.first_name };
        await setJSON(key, counts);
      }
    } catch (e) {
      console.error("chatter count failed:", e);
    }
    await next();
  });

  bot.command("daily", async (ctx, next) => {
    if (!chatAllowed(ctx)) return next();
    const c = chatCfg(ctx.chat.id);
    const flags = (c.daily ??= {});
    const [what, state] = String(ctx.match ?? "").trim().toLowerCase().split(/\s+/);
    const status = () =>
      "📅 Daily posts (IST):\n" +
      (Object.keys(FLAGS) as Flag[]).map((f) => `• ${f}: ${flags[f] ? "ON ✅" : "OFF ❌"}  (${FLAGS[f]})`).join("\n") +
      "\n\nBadlne ke liye (sirf admin):\n/daily summary on\n/daily greet on\n/daily chatters on\n(off likhne par band)";
    if (!what) return void (await ctx.reply(status()));
    if (!(await isChatAdmin(ctx, ctx.from!.id))) return void (await ctx.reply("Ye sirf admins kar sakte hain 😒"));
    if (!(what in FLAGS) || (state !== "on" && state !== "off")) return void (await ctx.reply(status()));
    flags[what as Flag] = state === "on";
    saveChatCfg(ctx.chat.id);
    await ctx.reply(`${FLAGS[what as Flag]}: ${state === "on" ? "ON ✅" : "OFF ❌"}`);
  });
}

// ---------- scheduled part ----------
const MORNING = [
  "Good morning sabko ☀️ aaj ka din bahut accha jaane wala hai, muskurate raho 😊",
  "Subah ho gayi 🌤️ chai ya coffee leke aao, aaj kuch naya karte hain 💕",
  "Uth jao sab! Naya din, nayi umeed ☀️ Good morning 🥰",
];
const NIGHT = [
  "Good night sabko 🌙 aaj ki thakaan chhod do, kal naya din hai 💤",
  "Chaand nikal aaya 🌛 ab sone ka time, sweet dreams 🥰",
  "Din khatam, sab so jao 😴 Good night, kal milte hain 💕",
];

async function enabledChats(flag: Flag): Promise<number[]> {
  const keys = await listKeys("m/");
  const rows = await Promise.all(keys.map(async (k) => ({ id: Number(k.slice(2)), c: await getJSON<ChatCfg>(k) })));
  return rows.filter((r) => Number.isFinite(r.id) && r.c?.daily?.[flag]).map((r) => r.id);
}

async function send(api: Api, chatId: number, text: string) {
  await api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } }).catch((e) =>
    console.error(`daily post to ${chatId} failed:`, e?.description ?? e),
  );
}

type Job = { name: string; at: number; run: (api: Api) => Promise<void> };
const JOBS: Job[] = [
  {
    name: "morning",
    at: 7 * 60 + 30,
    run: async (api) => {
      const chats = await enabledChats("greet");
      if (!chats.length) return;
      const msg = await oneShot(
        "Group ke sabhi members ke liye ek chhota pyaara good morning message likho (2-3 vaakya), halka motivational ya cute, 1-2 emoji. Kisi ek ka naam mat lo.",
        pick(MORNING),
      );
      for (const id of chats) await send(api, id, msg);
    },
  },
  {
    name: "summary",
    at: 9 * 60,
    run: async (api) => {
      const chats = await enabledChats("summary");
      if (!chats.length) return;
      const msg = await marketSummaryText();
      if (msg) for (const id of chats) await send(api, id, msg);
    },
  },
  {
    name: "chatters",
    at: 22 * 60,
    run: async (api) => {
      for (const id of await enabledChats("chatters")) {
        const key = countKey(id);
        const counts = (await getJSON<Counts>(key)) ?? {};
        const top = Object.values(counts).sort((a, b) => b.n - a.n).slice(0, 5);
        if (!top.length) continue;
        const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
        await send(api, id, "🏆 Aaj ke top chatters\n\n" + top.map((t, i) => `${medals[i]} ${t.name} — ${t.n} msgs`).join("\n") + "\n\nKal phir milte hain 💕");
        await delKey(key);
      }
    },
  },
  {
    name: "night",
    at: 22 * 60 + 30,
    run: async (api) => {
      const chats = await enabledChats("greet");
      if (!chats.length) return;
      const msg = await oneShot(
        "Group ke sabhi members ke liye ek chhota pyaara good night message likho (2-3 vaakya), sukoon bhara, 1-2 emoji. Kisi ek ka naam mat lo.",
        pick(NIGHT),
      );
      for (const id of chats) await send(api, id, msg);
    },
  },
];

/** Runs every job whose time has come and that has not run yet today. Safe to call as often as you like. */
export async function runDaily(api: Api) {
  const now = istMinutes();
  const day = istDay();
  for (const job of JOBS) {
    if (now < job.at || now >= job.at + 180) continue; // a late cron tick still counts for up to 3 hours
    if ((await getJSON<string>(`job/${job.name}`)) === day) continue;
    await setJSON(`job/${job.name}`, day); // mark first: a slow run must not be started twice by the next tick
    try {
      await job.run(api);
    } catch (e) {
      console.error(`daily job ${job.name} failed:`, e);
    }
  }
}
