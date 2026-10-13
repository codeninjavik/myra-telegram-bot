import { InlineKeyboard, type Bot, type Context } from "grammy";
import { chatAllowed } from "../gate.js";
import { validCode } from "./engine.js";

// Telegram entry points for SECRET AGENT. The game itself is the Mini App at /agent/; these commands open it
// (web_app buttons only work in private chats, so in groups the button leads to the bot's DM first).

export const AGENT_MENU = [
  { command: "game", description: "SECRET AGENT: open the spy game" },
];

const baseUrl = () => (process.env.PUBLIC_URL || "https://myra-bot-88823.netlify.app").replace(/\/$/, "");
const appUrl = (q: Record<string, string> = {}) => {
  const qs = new URLSearchParams(q).toString();
  return `${baseUrl()}/agent/${qs ? `?${qs}` : ""}`;
};

export const TELEGRAM_APP_COMMANDS = ["game", "spyplay", "createroom", "joinroom", "agentprofile", "agentboard", "missions", "rewards", "agenthistory", "ludo"];

export function registerAgent(bot: Bot) {
  const open = async (ctx: Context, text: string, q: Record<string, string> = {}, label = "Open SECRET AGENT") => {
    if (ctx.chat?.type === "private") {
      return ctx.reply(text, { reply_markup: new InlineKeyboard().webApp(label, appUrl(q)) });
    }
    // Group: web_app buttons are not allowed, so hand over to the private chat with a deep link.
    const payload = q.ludo ? `sa_L${q.ludo}` : q.room ? `sa_${q.room}` : `sa_${q.go ?? "home"}`;
    return ctx.reply(text, { reply_markup: new InlineKeyboard().url("Open in private chat", `https://t.me/${ctx.me.username}?start=${payload}`) });
  };

  const on = (names: string | string[], fn: (ctx: Context) => Promise<unknown>) =>
    bot.command(names, async (ctx, next) => {
      if (ctx.chat.type !== "private" && !chatAllowed(ctx)) return next();
      try {
        await fn(ctx);
      } catch (e: any) {
        // e.g. the bot may not write in that chat; never let this bubble up as a failed webhook
        console.error(`/${String(names)} failed:`, e?.description ?? e?.message ?? e);
      }
    });

  on("game", (ctx) =>
    open(ctx, "SECRET AGENT\nOne of you is the Spy. Find them before the mission fails.\n\nQuick match, private rooms and a practice mode against bots."),
  );
  on("spyplay", (ctx) => open(ctx, "Finding a match.", { go: "quick" }, "Play now"));
  on("createroom", (ctx) => open(ctx, "Create a private room and share its code.", { go: "create" }, "Create room"));
  on("joinroom", (ctx) => {
    const code = String(ctx.match ?? "").trim().toUpperCase();
    if (!validCode(code)) return ctx.reply("Send the room code after the command, for example /joinroom K7M2P.");
    return open(ctx, `Join room ${code}.`, { room: code }, `Join ${code}`);
  });
  on("agentprofile", (ctx) => open(ctx, "Your agent profile.", { go: "profile" }, "Open profile"));
  on("agentboard", (ctx) => open(ctx, "Leaderboard.", { go: "leaderboard" }, "Open leaderboard"));
  on("missions", (ctx) => open(ctx, "Daily and weekly missions.", { go: "missions" }, "Open missions"));
  on("rewards", (ctx) => open(ctx, "Daily reward and achievements.", { go: "rewards" }, "Open rewards"));
  on("agenthistory", (ctx) => open(ctx, "Your recent matches.", { go: "history" }, "Open history"));
  on("ludo", (ctx) => {
    const code = String(ctx.match ?? "").trim().toUpperCase();
    if (validCode(code)) return open(ctx, `Join Ludo room ${code}.`, { ludo: code }, `Join ${code}`);
    return open(ctx, "Ludo: 2 to 4 players, or practice against bots.", { go: "ludo" }, "Play Ludo");
  });

  // Deep link: t.me/<bot>?start=sa_<ROOMCODE> or sa_quick / sa_home
  bot.command("start", async (ctx, next) => {
    const payload = String(ctx.match ?? "");
    if (ctx.chat.type !== "private" || !payload.startsWith("sa_")) return next();
    const arg = payload.slice(3).toUpperCase();
    if (/^L[A-HJ-NP-Z2-9]{5}$/.test(arg)) return void (await open(ctx, `Join Ludo room ${arg.slice(1)}.`, { ludo: arg.slice(1) }, `Join ${arg.slice(1)}`));
    if (validCode(arg)) return void (await open(ctx, `Join room ${arg}.`, { room: arg }, `Join ${arg}`));
    const go = ["QUICK", "CREATE", "PROFILE", "LEADERBOARD", "MISSIONS", "REWARDS", "HISTORY", "LUDO"].includes(arg) ? arg.toLowerCase() : "";
    return void (await open(ctx, "SECRET AGENT", go ? { go } : {}));
  });
}
