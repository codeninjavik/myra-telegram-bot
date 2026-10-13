import { InputFile, type Api, type Bot } from "grammy";
import { chatAllowed } from "./gate.js";
import { delKey, getJSON, getMany, listKeys, setJSON } from "./store.js";

// Market data: /price /chart /convert /alert /alerts /delalert. Every source is free; keys are only used when set.
//   crypto: Binance public mirror -> CoinGecko    stocks: Yahoo -> Finnhub / Twelve Data / Alpha Vantage (optional keys)
//   fiat: open.er-api.com -> frankfurter          charts: quickchart.io
const UA = { "User-Agent": "Mozilla/5.0 (compatible; MyraBot/1.0)" };
const DISCLAIMER = "ℹ️ Sirf jaankari ke liye, financial advice nahi.";

async function getJson(url: string, init: RequestInit = {}): Promise<any | null> {
  try {
    const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers as object) }, signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const num = (v: unknown): number | null => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

// ---------- quotes ----------
type Src = "binance" | "yahoo" | "gecko" | "finnhub" | "twelve" | "alpha";
export type Quote = {
  name: string; symbol: string; price: number; change: number | null; high: number | null; low: number | null;
  currency: string; src: Src; ref: string;
};

const binance = async (sym: string): Promise<Quote | null> => {
  const d = await getJson(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${sym}USDT`);
  const price = num(d?.lastPrice);
  if (price === null) return null;
  return { name: sym, symbol: sym, price, change: num(d.priceChangePercent), high: num(d.highPrice), low: num(d.lowPrice), currency: "USD", src: "binance", ref: `${sym}USDT` };
};

const yahoo = async (ticker: string): Promise<Quote | null> => {
  const d = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`);
  const m = d?.chart?.result?.[0]?.meta;
  const price = num(m?.regularMarketPrice);
  if (!m || price === null) return null;
  const prev = num(m.chartPreviousClose) ?? num(m.previousClose);
  return {
    name: m.longName ?? m.shortName ?? ticker, symbol: m.symbol ?? ticker, price,
    change: num(m.regularMarketChangePercent) ?? (prev ? ((price - prev) / prev) * 100 : null),
    high: num(m.regularMarketDayHigh), low: num(m.regularMarketDayLow), currency: m.currency ?? "USD", src: "yahoo", ref: ticker,
  };
};

const gecko = async (query: string): Promise<Quote | null> => {
  const s = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
  const coin = s?.coins?.[0];
  if (!coin) return null;
  const p = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_24hr_change=true`);
  const price = num(p?.[coin.id]?.usd);
  if (price === null) return null;
  return { name: coin.name, symbol: String(coin.symbol).toUpperCase(), price, change: num(p[coin.id].usd_24h_change), high: null, low: null, currency: "USD", src: "gecko", ref: coin.id };
};

const finnhub = async (sym: string): Promise<Quote | null> => {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const d = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`);
  const price = num(d?.c);
  if (!price) return null;
  return { name: sym, symbol: sym, price, change: num(d.dp), high: num(d.h), low: num(d.l), currency: "USD", src: "finnhub", ref: sym };
};

const twelve = async (sym: string): Promise<Quote | null> => {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  const d = await getJson(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${key}`);
  const price = num(d?.close);
  if (price === null) return null;
  return { name: d.name ?? sym, symbol: sym, price, change: num(d.percent_change), high: num(d.high), low: num(d.low), currency: d.currency ?? "USD", src: "twelve", ref: sym };
};

const alpha = async (sym: string): Promise<Quote | null> => {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) return null;
  const q = (await getJson(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${key}`))?.["Global Quote"];
  const price = num(q?.["05. price"]);
  if (price === null) return null;
  return { name: sym, symbol: sym, price, change: num(String(q["10. change percent"]).replace("%", "")), high: num(q["03. high"]), low: num(q["04. low"]), currency: "USD", src: "alpha", ref: sym };
};

const CACHE_MS = 45_000;

/** Best match for "btc", "reliance", "tcs.ns", "aapl". Cached 45s so a busy group costs one API call. */
export async function getQuote(query: string): Promise<Quote | null> {
  const q = query.trim().replace(/^\$/, "");
  if (!/^[\p{L}\p{N}.\-^& ]{1,30}$/u.test(q)) return null;
  const key = `mk/${q.toLowerCase().replace(/\s+/g, "-")}`;
  const hit = await getJSON<{ at: number; q: Quote | null }>(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.q;

  const sym = q.toUpperCase().replace(/\s+/g, "");
  const hasExchange = /\.(NS|BO)$/.test(sym);
  let out: Quote | null = null;
  if (!hasExchange && /^[A-Z0-9]{2,12}$/.test(sym)) out = await binance(sym);
  out ??= hasExchange ? await yahoo(sym) : (await yahoo(`${sym}.NS`)) ?? (await yahoo(sym));
  out ??= await gecko(q);
  for (const f of [finnhub, twelve, alpha]) out ??= await f(sym);
  await setJSON(key, { at: Date.now(), q: out });
  return out;
}

// ---------- fiat ----------
async function fiatRates(): Promise<Record<string, number> | null> {
  const hit = await getJSON<{ at: number; rates: Record<string, number> }>("mk/fx");
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.rates;
  let rates: Record<string, number> | null = (await getJson("https://open.er-api.com/v6/latest/USD"))?.rates ?? null;
  rates ??= (await getJson("https://api.frankfurter.dev/v1/latest?base=USD"))?.rates ?? null;
  if (rates) {
    rates.USD = 1;
    await setJSON("mk/fx", { at: Date.now(), rates });
  }
  return rates;
}

// ---------- formatting ----------
function fmt(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: abs >= 1 ? 2 : 0 });
}
const sym = (cur: string) => (cur === "USD" ? "$" : cur === "INR" ? "₹" : cur === "EUR" ? "€" : cur === "GBP" ? "£" : cur + " ");

async function quoteText(q: Quote): Promise<string> {
  const s = sym(q.currency);
  const arrow = q.change === null ? "" : q.change >= 0 ? "🟢" : "🔴";
  let t = `${arrow} ${q.name}${q.symbol && q.symbol !== q.name ? ` (${q.symbol})` : ""}\n💰 ${s}${fmt(q.price)}`;
  if (q.currency === "USD" && q.src !== "finnhub") {
    const inr = (await fiatRates())?.INR;
    if (inr) t += `  (≈ ₹${fmt(q.price * inr)})`;
  }
  if (q.change !== null) t += `\n📊 24h: ${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)}%`;
  if (q.high !== null && q.low !== null) t += `\n⬆️ ${s}${fmt(q.high)}   ⬇️ ${s}${fmt(q.low)}`;
  return t;
}

// ---------- chart history ----------
async function history(q: Quote, days: number): Promise<{ t: number; c: number }[] | null> {
  if (q.src === "binance") {
    const [interval, limit] = days <= 1 ? ["15m", 96] : days <= 7 ? ["2h", 84] : days <= 30 ? ["12h", 60] : ["1d", Math.min(days, 365)];
    const d = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${q.ref}&interval=${interval}&limit=${limit}`);
    return Array.isArray(d) ? d.map((k: any) => ({ t: k[0], c: Number(k[4]) })) : null;
  }
  if (q.src === "yahoo") {
    const [range, interval] = days <= 1 ? ["1d", "15m"] : days <= 7 ? ["5d", "30m"] : days <= 30 ? ["1mo", "1d"] : days <= 90 ? ["3mo", "1d"] : ["1y", "1d"];
    const r = (await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(q.ref)}?range=${range}&interval=${interval}`))?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const close: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    const pts = ts.map((t, i) => ({ t: t * 1000, c: close[i] })).filter((p): p is { t: number; c: number } => p.c !== null && p.c !== undefined);
    return pts.length ? pts : null;
  }
  if (q.src === "gecko") {
    const d = await getJson(`https://api.coingecko.com/api/v3/coins/${q.ref}/market_chart?vs_currency=usd&days=${days}`);
    return d?.prices?.map((p: number[]) => ({ t: p[0], c: p[1] })) ?? null;
  }
  return null;
}

async function chartPng(title: string, pts: { t: number; c: number }[], days: number): Promise<Buffer | null> {
  const step = Math.max(1, Math.ceil(pts.length / 120));
  const p = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const label = (t: number) =>
    new Date(t).toLocaleString("en-GB", days <= 1 ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short" });
  const up = p[p.length - 1].c >= p[0].c;
  const color = up ? "#16a34a" : "#dc2626";
  try {
    const res = await fetch("https://quickchart.io/chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        version: "4", width: 720, height: 380, backgroundColor: "white", format: "png",
        chart: {
          type: "line",
          data: { labels: p.map((x) => label(x.t)), datasets: [{ data: p.map((x) => x.c), borderColor: color, backgroundColor: color + "22", fill: true, pointRadius: 0, borderWidth: 2 }] },
          options: { plugins: { legend: { display: false }, title: { display: true, text: title } }, scales: { x: { ticks: { maxTicksLimit: 8 } } } },
        },
      }),
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

// ---------- alerts ----------
type Alert = { key: string; chatId: number; userId: number; name: string; query: string; target: number; dir: "above" | "below"; currency: string };
const MAX_ALERTS = 5;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Called by the scheduled function: fire every alert whose target has been crossed. */
export async function checkAlerts(api: Api) {
  const alerts = await getMany<Alert>(await listKeys("al/"));
  const byQuery = new Map<string, Alert[]>();
  for (const a of alerts) byQuery.set(a.query, [...(byQuery.get(a.query) ?? []), a]);
  for (const [query, list] of byQuery) {
    const q = await getQuote(query);
    if (!q) continue;
    for (const a of list) {
      if (!(a.dir === "above" ? q.price >= a.target : q.price <= a.target)) continue;
      await delKey(a.key);
      await api
        .sendMessage(
          a.chatId,
          `🔔 <a href="tg://user?id=${a.userId}">Alert</a>: ${esc(a.name)} ${a.dir === "above" ? "upar gaya" : "neeche aaya"}!\n` +
            `Target ${sym(a.currency)}${fmt(a.target)} | ab ${sym(q.currency)}${fmt(q.price)}`,
          { parse_mode: "HTML" },
        )
        .catch((e) => console.error("alert send failed:", e?.description ?? e));
    }
  }
}

// ---------- top movers ----------
type Mover = { symbol: string; price: number; change: number; volume: number };
// Leveraged tokens (BTCUP, ETHBEAR...) and stable coins are noise in a gainers list.
const NOISE = /(UP|DOWN|BULL|BEAR)$/;
const STABLE = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "AEUR", "USD1", "BUSD", "XUSD", "PAXG"]);

/** All USDT pairs on Binance with their 24h move, cached for a minute. */
async function movers(): Promise<Mover[] | null> {
  const hit = await getJSON<{ at: number; list: Mover[] }>("mk/movers");
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const d = await getJson("https://data-api.binance.vision/api/v3/ticker/24hr?type=MINI");
  if (!Array.isArray(d)) return hit?.list ?? null;
  const list: Mover[] = [];
  for (const t of d) {
    const s = String(t.symbol);
    if (!s.endsWith("USDT")) continue;
    const base = s.slice(0, -4);
    if (NOISE.test(base) || STABLE.has(base)) continue;
    const open = num(t.openPrice), last = num(t.lastPrice), vol = num(t.quoteVolume);
    if (!open || !last || vol === null || vol < 1_000_000) continue; // skip illiquid pairs: +300% on $5k volume is not a signal
    list.push({ symbol: base, price: last, change: ((last - open) / open) * 100, volume: vol });
  }
  await setJSON("mk/movers", { at: Date.now(), list });
  return list;
}

const moverLine = (m: Mover, i: number, cur = "$") =>
  `${i + 1}. ${m.symbol}  ${cur}${fmt(m.price)}  ${m.change >= 0 ? "+" : ""}${m.change.toFixed(2)}%`;

// Yahoo's own "day gainers" screener only returns US stocks, so Indian movers are computed from the Nifty 50 names.
// Names that were renamed/removed simply come back empty and are skipped.
const NIFTY50 = [
  "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BEL",
  "BHARTIARTL", "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL", "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE",
  "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "INDUSINDBK", "INFY", "ITC", "JIOFIN", "JSWSTEEL", "KOTAKBANK",
  "LT", "M&M", "MARUTI", "NESTLEIND", "NTPC", "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN", "SHRIRAMFIN",
  "SUNPHARMA", "TATACONSUM", "TATAMOTORS", "TATASTEEL", "TCS", "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "WIPRO",
];

async function niftyMovers(): Promise<Mover[] | null> {
  const hit = await getJSON<{ at: number; list: Mover[] }>("mk/nifty");
  if (hit && Date.now() - hit.at < 120_000) return hit.list;
  const chunks: string[][] = [];
  for (let i = 0; i < NIFTY50.length; i += 17) chunks.push(NIFTY50.slice(i, i + 17));
  const parts = await Promise.all(
    chunks.map((c) =>
      getJson(`https://query1.finance.yahoo.com/v7/finance/spark?range=1d&interval=1d&symbols=${encodeURIComponent(c.map((s) => `${s}.NS`).join(","))}`),
    ),
  );
  const list: Mover[] = [];
  for (const p of parts) {
    for (const r of p?.spark?.result ?? []) {
      const m = r?.response?.[0]?.meta;
      const price = num(m?.regularMarketPrice);
      const prev = num(m?.chartPreviousClose) ?? num(m?.previousClose);
      const change = num(m?.regularMarketChangePercent) ?? (price !== null && prev ? ((price - prev) / prev) * 100 : null);
      if (price !== null && change !== null) list.push({ symbol: String(r.symbol).replace(/\.NS$/, ""), price, change, volume: 0 });
    }
  }
  if (!list.length) return hit?.list ?? null;
  await setJSON("mk/nifty", { at: Date.now(), list });
  return list;
}

// ---------- mood, gas, daily summary ----------
async function fearGreed(): Promise<{ value: number; label: string } | null> {
  const d = await getJson("https://api.alternative.me/fng/?limit=1");
  const row = d?.data?.[0];
  const value = num(row?.value);
  return value === null ? null : { value, label: String(row.value_classification ?? "") };
}

const fearEmoji = (v: number) => (v < 25 ? "😱" : v < 45 ? "😟" : v < 55 ? "😐" : v < 75 ? "😀" : "🤑");

/** Ethereum gas price in gwei from public RPC nodes (no key). */
async function gasGwei(): Promise<number | null> {
  for (const rpc of ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"]) {
    const d = await getJson(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 }),
    });
    if (typeof d?.result === "string") return Number(BigInt(d.result)) / 1e9;
  }
  return null;
}

/** The morning post: BTC, ETH, Nifty, Sensex and the Fear & Greed index. */
export async function marketSummaryText(): Promise<string | null> {
  const [btc, eth, nifty, sensex, fg] = await Promise.all([binance("BTC"), binance("ETH"), yahoo("^NSEI"), yahoo("^BSESN"), fearGreed()]);
  const row = (name: string, q: Quote | null, cur: string) =>
    q ? `${q.change === null ? "•" : q.change >= 0 ? "🟢" : "🔴"} ${name}: ${cur}${fmt(q.price)}${q.change === null ? "" : `  (${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)}%)`}` : null;
  const lines = [row("Bitcoin", btc, "$"), row("Ethereum", eth, "$"), row("Nifty 50", nifty, ""), row("Sensex", sensex, "")].filter(Boolean);
  if (fg) lines.push(`${fearEmoji(fg.value)} Fear & Greed: ${fg.value} (${fg.label})`);
  return lines.length ? `📊 Aaj ka market\n\n${lines.join("\n")}\n\n${DISCLAIMER}` : null;
}

// ---------- commands ----------
export const MARKET_MENU = [
  { command: "fear", description: "Crypto Fear & Greed index" },
  { command: "gas", description: "Ethereum gas price" },
  { command: "top", description: "Aaj ke top gainers aur losers (crypto)" },
  { command: "nifty", description: "Nifty 50 ke top gainers aur losers (India)" },
  { command: "price", description: "Live price: /price btc, /price reliance" },
  { command: "chart", description: "Price chart: /chart btc 7" },
  { command: "convert", description: "Currency: /convert 100 usd inr" },
  { command: "alert", description: "Price alert: /alert btc 90000" },
  { command: "alerts", description: "Tumhare price alerts" },
];

export function registerMarket(bot: Bot) {
  const guard = (ctx: any, next: () => Promise<void>, fn: () => Promise<unknown>) => (chatAllowed(ctx) ? fn() : next());

  bot.command(["price", "p"], (ctx, next) =>
    guard(ctx, next, async () => {
      const arg = String(ctx.match ?? "").trim();
      if (!arg) return void (await ctx.reply("Kaunsa coin/stock? Jaise: /price btc, /price eth, /price reliance, /price aapl"));
      await ctx.replyWithChatAction("typing").catch(() => {});
      const q = await getQuote(arg);
      if (!q) return void (await ctx.reply(`"${arg}" ka price nahi mila 🥺 Symbol check karo (jaise btc, eth, tcs, reliance, aapl).`));
      await ctx.reply(`${await quoteText(q)}\n\n${DISCLAIMER}`);
    }),
  );

  // /top = 5 gainers + 5 losers, /gainers and /losers = 10 of one kind.
  bot.command(["top", "gainers", "losers", "movers"], (ctx, next) =>
    guard(ctx, next, async () => {
      await ctx.replyWithChatAction("typing").catch(() => {});
      const all = await movers();
      if (!all?.length) return void (await ctx.reply("Market data abhi nahi mil raha 🥺 thodi der baad try karo."));
      const up = [...all].sort((a, b) => b.change - a.change);
      const cmd = ctx.message?.text?.match(/^\/(\w+)/)?.[1]?.toLowerCase();
      const gainers = (n: number) => `🟢 Top gainers (24h)\n${up.slice(0, n).map((m, i) => moverLine(m, i)).join("\n")}`;
      const losers = (n: number) => `🔴 Top losers (24h)\n${up.slice(-n).reverse().map((m, i) => moverLine(m, i)).join("\n")}`;
      const body = cmd === "gainers" ? gainers(10) : cmd === "losers" ? losers(10) : `${gainers(5)}\n\n${losers(5)}`;
      await ctx.reply(`${body}\n\nSirf liquid coins (volume > $1M), Binance USDT pairs.\n${DISCLAIMER}`);
    }),
  );

  // Indian stocks: Nifty 50 movers. /nifty = 5 + 5, /stockgainers and /stocklosers = 10.
  bot.command(["nifty", "stockgainers", "stocklosers", "sgainers", "slosers"], (ctx, next) =>
    guard(ctx, next, async () => {
      await ctx.replyWithChatAction("typing").catch(() => {});
      const all = await niftyMovers();
      if (!all?.length) return void (await ctx.reply("NSE data abhi nahi mil raha 🥺 thodi der baad try karo."));
      const up = [...all].sort((a, b) => b.change - a.change);
      const cmd = ctx.message?.text?.match(/^\/(\w+)/)?.[1]?.toLowerCase();
      const line = (m: Mover, i: number) => moverLine(m, i, "₹");
      const gainers = (n: number) => `🟢 Nifty 50 top gainers\n${up.slice(0, n).map(line).join("\n")}`;
      const losers = (n: number) => `🔴 Nifty 50 top losers\n${up.slice(-n).reverse().map(line).join("\n")}`;
      const body =
        cmd === "stockgainers" || cmd === "sgainers" ? gainers(10)
        : cmd === "stocklosers" || cmd === "slosers" ? losers(10)
        : `${gainers(5)}\n\n${losers(5)}`;
      await ctx.reply(`${body}\n\nNSE, pichle trading session ke hisaab se (market band ho to last close).\n${DISCLAIMER}`);
    }),
  );

  bot.command(["fear", "fng", "feargreed"], (ctx, next) =>
    guard(ctx, next, async () => {
      const f = await fearGreed();
      if (!f) return void (await ctx.reply("Fear & Greed index abhi nahi mila 🥺"));
      await ctx.reply(`${fearEmoji(f.value)} Crypto Fear & Greed: ${f.value}/100 (${f.label})\n\n0 = bahut dar, 100 = bahut lalach.\n${DISCLAIMER}`);
    }),
  );

  bot.command("gas", (ctx, next) =>
    guard(ctx, next, async () => {
      const g = await gasGwei();
      if (g === null) return void (await ctx.reply("Gas price abhi nahi mila 🥺"));
      await ctx.reply(`⛽ Ethereum gas: ${g < 1 ? g.toFixed(3) : g.toFixed(1)} gwei\n(Transfer ka fee roughly ${(g * 21000 / 1e9).toFixed(6)} ETH)`);
    }),
  );

  bot.command(["summary", "market"], (ctx, next) =>
    guard(ctx, next, async () => {
      const t = await marketSummaryText();
      await ctx.reply(t ?? "Market data abhi nahi mil raha 🥺");
    }),
  );

  bot.command("chart", (ctx, next) =>
    guard(ctx, next, async () => {
      const parts = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return void (await ctx.reply("Jaise: /chart btc  ya  /chart btc 30  (din)"));
      const last = parts[parts.length - 1];
      const days = parts.length > 1 && /^\d+$/.test(last) ? Math.min(Math.max(Number(last), 1), 365) : 7;
      const query = parts.length > 1 && /^\d+$/.test(last) ? parts.slice(0, -1).join(" ") : parts.join(" ");
      await ctx.replyWithChatAction("upload_photo").catch(() => {});
      const q = await getQuote(query);
      const pts = q ? await history(q, days) : null;
      if (!q || !pts || pts.length < 2) return void (await ctx.reply(`"${query}" ka chart nahi ban paya 🥺`));
      const png = await chartPng(`${q.name} (${q.symbol}) - ${days} din, ${q.currency}`, pts, days);
      if (!png) return void (await ctx.reply("Chart abhi nahi ban paya, thodi der baad try karo 🥺"));
      await ctx.replyWithPhoto(new InputFile(png, "chart.png"), { caption: `${await quoteText(q)}\n\n${DISCLAIMER}` });
    }),
  );

  bot.command(["convert", "fx"], (ctx, next) =>
    guard(ctx, next, async () => {
      const m = String(ctx.match ?? "").trim().match(/^(?:(\d+(?:[.,]\d+)?)\s+)?([a-z]{3})\s+(?:to\s+|in\s+)?([a-z]{3})$/i);
      if (!m) return void (await ctx.reply("Jaise: /convert 100 usd inr  ya  /convert usd inr"));
      const amount = m[1] ? Number(m[1].replace(",", ".")) : 1;
      const [from, to] = [m[2].toUpperCase(), m[3].toUpperCase()];
      const rates = await fiatRates();
      if (!rates || !rates[from] || !rates[to]) return void (await ctx.reply(`${from} ya ${to} currency nahi mili 🥺 (3 letter code likho, jaise USD, INR, EUR)`));
      const out = (amount / rates[from]) * rates[to];
      await ctx.reply(`💱 ${fmt(amount)} ${from} = ${fmt(out)} ${to}\n1 ${from} = ${fmt(rates[to] / rates[from])} ${to}`);
    }),
  );

  bot.command("alert", (ctx, next) =>
    guard(ctx, next, async () => {
      const m = String(ctx.match ?? "").trim().match(/^(.+?)\s+([\d.,]+)$/);
      const target = m ? Number(m[2].replace(/,/g, "")) : NaN;
      if (!m || !Number.isFinite(target) || target <= 0) return void (await ctx.reply("Jaise: /alert btc 90000  (jab price 90000 cross kare to bataungi)"));
      const q = await getQuote(m[1]);
      if (!q) return void (await ctx.reply(`"${m[1]}" nahi mila 🥺`));
      if (target === q.price) return void (await ctx.reply("Ye price abhi wahi hai 😅"));
      const uid = ctx.from!.id;
      const mine = await listKeys(`al/${ctx.chat.id}/${uid}-`);
      if (mine.length >= MAX_ALERTS) return void (await ctx.reply(`Ek user ke max ${MAX_ALERTS} alerts. /alerts dekho aur /delalert se hatao.`));
      const key = `al/${ctx.chat.id}/${uid}-${Date.now()}`;
      const alert: Alert = { key, chatId: ctx.chat.id, userId: uid, name: `${q.name} (${q.symbol})`, query: m[1], target, dir: target > q.price ? "above" : "below", currency: q.currency };
      await setJSON(key, alert);
      await ctx.reply(
        `🔔 Alert set: ${alert.name} ${alert.dir === "above" ? "≥" : "≤"} ${sym(q.currency)}${fmt(target)}\nAbhi: ${sym(q.currency)}${fmt(q.price)} | har kuch minute mein check hota hai.`,
      );
    }),
  );

  const myAlerts = async (chatId: number, userId: number) => (await getMany<Alert>(await listKeys(`al/${chatId}/${userId}-`))).sort((a, b) => a.key.localeCompare(b.key));

  bot.command("alerts", (ctx, next) =>
    guard(ctx, next, async () => {
      const list = await myAlerts(ctx.chat.id, ctx.from!.id);
      if (!list.length) return void (await ctx.reply("Tumhara koi alert nahi hai. /alert btc 90000 se lagao."));
      await ctx.reply("🔔 Tumhare alerts:\n" + list.map((a, i) => `${i + 1}. ${a.name} ${a.dir === "above" ? "≥" : "≤"} ${sym(a.currency)}${fmt(a.target)}`).join("\n") + "\n\nHatane ke liye: /delalert 1");
    }),
  );

  bot.command("delalert", (ctx, next) =>
    guard(ctx, next, async () => {
      const list = await myAlerts(ctx.chat.id, ctx.from!.id);
      const n = Number(String(ctx.match ?? "").trim());
      if (!Number.isInteger(n) || n < 1 || n > list.length) return void (await ctx.reply("Number do: /delalert 1  (list ke liye /alerts)"));
      await delKey(list[n - 1].key);
      await ctx.reply("Alert hata diya ✅");
    }),
  );
}
