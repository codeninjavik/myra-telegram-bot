import type { Bot, Context } from "grammy";
import { chatAllowed } from "./gate.js";
import { getQuote } from "./market.js";
import { getJSON, getMany, listKeys, setJSON } from "./store.js";

// /anime (AniList) and the paper trading game (/buy /sell /portfolio /tradelb /resetpaper). Groups only.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- anime ----------
const ANILIST = `query ($q: String, $type: MediaType) {
  Media(search: $q, type: $type, sort: SEARCH_MATCH) {
    title { romaji english } format status episodes chapters averageScore genres description(asHtml: false)
    startDate { year } coverImage { large } siteUrl
  }
}`;

async function anilist(q: string, type: "ANIME" | "MANGA") {
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ANILIST, variables: { q, type } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as any)?.data?.Media ?? null;
  } catch {
    return null;
  }
}

// ---------- paper trading ----------
const START_CASH = 10_000;
type Account = { cash: number; pos: Record<string, { qty: number; cost: number }>; name: string; value: number; at: number };
const acctKey = (id: number) => `pt/${id}`;
const money = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const pctText = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

async function account(ctx: Context): Promise<Account> {
  const a = await getJSON<Account>(acctKey(ctx.from!.id));
  return a ?? { cash: START_CASH, pos: {}, name: ctx.from!.first_name, value: START_CASH, at: Date.now() };
}

/** Marks every position to market. Positions whose price cannot be fetched are valued at cost. */
async function worth(a: Account) {
  let total = a.cash;
  const rows: { sym: string; qty: number; price: number; value: number; pl: number }[] = [];
  for (const [sym, p] of Object.entries(a.pos)) {
    const q = await getQuote(sym);
    const price = q?.price ?? p.cost / p.qty;
    const value = p.qty * price;
    total += value;
    rows.push({ sym, qty: p.qty, price, value, pl: ((value - p.cost) / p.cost) * 100 });
  }
  return { total, rows };
}

async function save(ctx: Context, a: Account, total?: number) {
  a.name = ctx.from!.first_name;
  a.value = total ?? (await worth(a)).total;
  a.at = Date.now();
  await setJSON(acctKey(ctx.from!.id), a);
}

const NOTE = "🎮 Ye practice game hai: virtual paisa, asli nahi.";

export function registerExtras(bot: Bot) {
  const grp = (names: string | string[], fn: (ctx: Context, arg: string) => Promise<unknown>) =>
    bot.command(names, async (ctx, next) => {
      if (!chatAllowed(ctx)) return next();
      await fn(ctx, String(ctx.match ?? "").trim());
    });

  grp(["anime", "manga"], async (ctx, arg) => {
    const manga = ctx.message?.text?.startsWith("/manga");
    if (!arg) return void (await ctx.reply(`Jaise: /${manga ? "manga" : "anime"} naruto`));
    await ctx.replyWithChatAction("typing").catch(() => {});
    const m = await anilist(arg, manga ? "MANGA" : "ANIME");
    if (!m) return void (await ctx.reply(`"${arg}" nahi mila 🥺`));
    const title = m.title.english || m.title.romaji;
    const desc = String(m.description ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 350);
    const caption =
      `<b>${esc(title)}</b>${m.title.romaji && m.title.romaji !== title ? ` (${esc(m.title.romaji)})` : ""}\n` +
      `⭐ ${m.averageScore ? m.averageScore + "/100" : "n/a"}  ·  ${esc(String(m.format ?? ""))}  ·  ${esc(String(m.status ?? ""))}\n` +
      `${manga ? "📖 Chapters" : "📺 Episodes"}: ${m.episodes ?? m.chapters ?? "?"}${m.startDate?.year ? `  ·  ${m.startDate.year}` : ""}\n` +
      `🏷️ ${esc((m.genres ?? []).slice(0, 5).join(", "))}\n\n${esc(desc)}${desc.length >= 350 ? "..." : ""}\n\n<a href="${esc(m.siteUrl)}">AniList par dekho</a>`;
    try {
      await ctx.replyWithPhoto(m.coverImage.large, { caption, parse_mode: "HTML" });
    } catch {
      await ctx.reply(caption, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    }
  });

  grp(["buy"], async (ctx, arg) => {
    const m = arg.match(/^(\S+)\s+\$?([\d.,]+)$/);
    const usd = m ? Number(m[2].replace(/,/g, "")) : NaN;
    if (!m || !(usd > 0)) return void (await ctx.reply(`/buy btc 500  (500 dollar ka BTC)\n${NOTE} Shuru mein ${money(START_CASH)} milte hain.`));
    const q = await getQuote(m[1]);
    if (!q) return void (await ctx.reply(`"${m[1]}" nahi mila 🥺`));
    if (q.currency !== "USD") return void (await ctx.reply("Abhi sirf USD wale (crypto, US stocks) khareed sakte ho."));
    const a = await account(ctx);
    if (usd > a.cash + 1e-9) return void (await ctx.reply(`Itna cash nahi hai. Cash: ${money(a.cash)}`));
    const sym = q.symbol.toUpperCase();
    const qty = usd / q.price;
    const p = a.pos[sym] ?? { qty: 0, cost: 0 };
    a.pos[sym] = { qty: p.qty + qty, cost: p.cost + usd };
    a.cash -= usd;
    await save(ctx, a);
    await ctx.reply(`✅ Khareeda: ${qty.toPrecision(6)} ${sym} @ ${money(q.price)} (${money(usd)})\nCash bacha: ${money(a.cash)}\n${NOTE}`);
  });

  grp(["sell"], async (ctx, arg) => {
    const m = arg.match(/^(\S+)(?:\s+(all|\$?[\d.,]+))?$/i);
    if (!m) return void (await ctx.reply("/sell btc 200  ya  /sell btc all"));
    const q = await getQuote(m[1]);
    const a = await account(ctx);
    const sym = (q?.symbol ?? m[1]).toUpperCase();
    const p = a.pos[sym];
    if (!q || !p) return void (await ctx.reply(`Tumhare paas ${sym} nahi hai. /portfolio dekho.`));
    const have = p.qty * q.price;
    const want = !m[2] || m[2].toLowerCase() === "all" ? have : Math.min(Number(m[2].replace(/[$,]/g, "")), have);
    if (!(want > 0)) return void (await ctx.reply("Amount sahi nahi."));
    const frac = want / have;
    const costOut = p.cost * frac;
    a.cash += want;
    if (frac >= 0.999999) delete a.pos[sym];
    else a.pos[sym] = { qty: p.qty * (1 - frac), cost: p.cost - costOut };
    await save(ctx, a);
    const pl = want - costOut;
    await ctx.reply(`✅ Becha: ${sym} ${money(want)} @ ${money(q.price)}\n${pl >= 0 ? "🟢 Profit" : "🔴 Loss"}: ${money(Math.abs(pl))} (${pctText((pl / costOut) * 100)})\nCash: ${money(a.cash)}\n${NOTE}`);
  });

  grp(["portfolio", "pf"], async (ctx) => {
    const a = await account(ctx);
    const { total, rows } = await worth(a);
    await save(ctx, a, total);
    const lines = rows.map((r) => `${r.pl >= 0 ? "🟢" : "🔴"} ${r.sym}: ${r.qty.toPrecision(5)} × ${money(r.price)} = ${money(r.value)} (${pctText(r.pl)})`);
    await ctx.reply(
      `💼 ${esc(ctx.from!.first_name)} ka portfolio\n\n` +
        (lines.length ? lines.join("\n") + "\n\n" : "Koi position nahi. /buy btc 500\n\n") +
        `💵 Cash: ${money(a.cash)}\n📊 Total: ${money(total)} (${pctText(((total - START_CASH) / START_CASH) * 100)} vs shuruwat)\n${NOTE}`,
    );
  });

  grp(["tradelb", "paperlb"], async (ctx) => {
    const all = await getMany<Account>(await listKeys("pt/"));
    const top = all.sort((x, y) => y.value - x.value).slice(0, 10);
    if (!top.length) return void (await ctx.reply("Abhi koi trader nahi. /buy btc 500 se shuru karo 🎮"));
    const medals = ["🥇", "🥈", "🥉"];
    await ctx.reply(
      "🏆 Paper trading leaderboard\n\n" +
        top.map((t, i) => `${medals[i] ?? `${i + 1}.`} ${t.name}: ${money(t.value)} (${pctText(((t.value - START_CASH) / START_CASH) * 100)})`).join("\n") +
        "\n\n(Value tab update hoti hai jab trader trade ya /portfolio chalaye.)",
    );
  });

  grp(["resetpaper"], async (ctx) => {
    await setJSON(acctKey(ctx.from!.id), { cash: START_CASH, pos: {}, name: ctx.from!.first_name, value: START_CASH, at: Date.now() } satisfies Account);
    await ctx.reply(`Naya account: ${money(START_CASH)} cash 🎮`);
  });
}

export const EXTRAS_MENU = [
  { command: "anime", description: "Anime ki jaankari: /anime naruto" },
  { command: "buy", description: "Paper trading: /buy btc 500" },
  { command: "sell", description: "Paper trading: /sell btc all" },
  { command: "portfolio", description: "Tumhara paper portfolio" },
  { command: "tradelb", description: "Paper trading leaderboard" },
  { command: "notes", description: "Group ke saved notes" },
];

