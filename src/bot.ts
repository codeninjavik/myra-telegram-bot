import { API_CONSTANTS, Bot, InlineKeyboard, InputFile } from "grammy";
import { liveLink } from "./live.js";
import { chatReply, hasGemini, learnAbout, speak, toOggOpus, transcribe } from "./ai.js";
import { registerCommands } from "./commands.js";
import { chatAllowed, loadGate, registerGate } from "./gate.js";
import { delKey, getJSON, setJSON } from "./store.js";
import { registerReferral } from "./referral.js";
import { registerMarket } from "./market.js";
import { registerDaily } from "./daily.js";
import { registerModPlus } from "./modplus.js";
import { registerExtras } from "./extras.js";
import { registerToolMenu } from "./toolmenu.js";
import { registerTools } from "./tools.js";
import { registerStats } from "./stats.js";
import { GAME_MENU, registerGames } from "./games.js";
import { AGENT_MENU, registerAgent } from "./agent/bot.js";
import { MOD_MENU, isChatAdmin, registerModeration } from "./moderation.js";
import { ANGRY, APP_INFO, APP_INTENT, BOT_WORDS, NICE_WORDS, pick } from "./persona.js";

export const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) console.error("BOT_TOKEN missing: set it in Netlify > Site configuration > Environment variables.");

export const bot = new Bot(BOT_TOKEN ?? "missing-token");
const WANTS_VOICE = /(voice|audio|bol ke|bolo|sunao|awaaz|awaz|aawaz)/i;

// Chats where Myra always answers in voice ("/voice"). Stored per chat because functions keep no memory.
const voiceOn = async (chatId: number) => (await getJSON<number>(`v/${chatId}`)) === 1;

// Loaded first on every update: required-group list used by chatAllowed().
bot.use(async (_ctx, next) => {
  await loadGate();
  await next();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function respond(ctx: any, text: string, asVoice: boolean) {
  const hint = asVoice ? "\nYe reply voice note mein bola jayega: emojis mat use karo, 1-2 chhote vaakya." : "";
  await ctx.replyWithChatAction(asVoice ? "record_voice" : "typing").catch(() => {});
  const reply = await chatReply(ctx.chat.id, text, hint, false, undefined, ctx.from?.id);

  if (asVoice && (await hasGemini())) {
    const wav = await speak(reply);
    if (wav) {
      const { data, name } = toOggOpus(wav);
      try {
        await ctx.replyWithVoice(new InputFile(data, name));
        return;
      } catch {
        try {
          await ctx.replyWithAudio(new InputFile(data, name));
          return;
        } catch {}
      }
    }
  }
  await sleep(500 + Math.random() * 800);
  await ctx.reply(reply);
}

async function handleText(ctx: any, text: string, fromVoice = false) {
  if (APP_INTENT.test(text)) {
    return void (await ctx.reply(APP_INFO, { link_preview_options: { is_disabled: true } }));
  }
  if (BOT_WORDS.test(text)) {
    await ctx.react("😡").catch(() => {});
    return void (await ctx.reply(pick(ANGRY)));
  }
  if (NICE_WORDS.test(text)) {
    await ctx.react(pick(["❤", "🥰", "😍", "👍"] as const)).catch(() => {});
  }
  const asVoice = fromVoice || WANTS_VOICE.test(text) || (await voiceOn(ctx.chat.id));
  await respond(ctx, text, asVoice);
  // After the reply is out: every few messages Myra notes lasting facts about this person (see /memory, /forgetme).
  if (ctx.from) await learnAbout(ctx.from.id, ctx.chat.id).catch((e: unknown) => console.error("learnAbout:", e));
}

// chatAllowed() is false in private chats, so DMs fall through to the Join/Verify gate instead of answering.
bot.command("start", (ctx, next) => {
  if (!chatAllowed(ctx)) return next();
  // No self-introduction: a girl texting a friend doesn't announce her own name.
  const n = ctx.from?.first_name ?? "";
  return ctx.reply(pick([`heyy ${n} 🥰`, `hii ${n}, kahan the itni der se? 😒`, `oye ${n} 😏 bolo`, `arre ${n}, aao aao 🥰`]).replace("  ", " "));
});

bot.command("voice", async (ctx, next) => {
  if (!chatAllowed(ctx)) return next();
  const id = ctx.chat.id;
  if (ctx.chat.type !== "private") {
    // One person flipping voice mode would change it for the whole group, so admins only.
    if (!(await isChatAdmin(ctx, ctx.from!.id))) {
      return void (await ctx.reply("Group mein voice mode sirf admins badal sakte hain 😒. Tum bas 'myra voice mein bolo' likh do."));
    }
  }
  if (await voiceOn(id)) {
    await delKey(`v/${id}`);
    await ctx.reply("Theek hai, ab text mein baat karenge 😊");
  } else {
    await setJSON(`v/${id}`, 1);
    await ctx.reply("Ab main voice note mein bolungi 🎙️😘");
  }
});

registerStats(bot); // tracks users/groups for /stats; never blocks an update
registerReferral(bot); // /start ref_ deep links, activity points, /refer /points /leaderboard
registerGate(bot); // private chats get Join/Verify buttons instead of any reply
registerAgent(bot); // SECRET AGENT Mini App entry points (/game, /joinroom ...)
registerGames(bot); // /games /challenge /wallet /shop and the Stars payment handlers (after the gate)

// /vc, /call too: a Telegram bot cannot join a group voice chat, so people talk to Myra live through this page.
bot.command(["live", "livevoice", "vc", "voicechat", "call"], async (ctx, next) => {
  if (!chatAllowed(ctx)) return next();
  // The live page is opened from the private chat with Myra: there the Live Voice button shows up after Verify.
  const dm = `https://t.me/${ctx.me.username}?start=live`;
  await ctx.reply("🎙️ Live voice ke liye pehle Myra bot mein aao, wahan Live Voice ka button milega 👇", {
    reply_markup: new InlineKeyboard().url("🎙️ Myra bot mein kholo", dm),
  });
});

registerMarket(bot); // /price /chart /convert /alert
registerExtras(bot); // /anime and the paper trading game
registerToolMenu(bot); // /raw /id /info and the /tools buttons
registerModeration(bot);
registerModPlus(bot); // captcha, antiraid, locks, blocklist, notes, filters, custom welcome
registerDaily(bot); // /daily + message counting for top chatters (needs the moderation config loaded first)
registerTools(bot); // /tr /stt /see and photo understanding
const menu = [...registerCommands(bot), ...GAME_MENU.slice(0, 4), ...AGENT_MENU];

bot.command("modhelp", (ctx) =>
  ctx.reply(
    "👮 Moderation commands (sirf group admins, bot ko admin banana zaroori):\n\n" +
      MOD_MENU.map((m) => `/${m.command} - ${m.description}`).join("\n") +
      "\n\nAuto-mod: gaali aur spam wale msg delete hote hain, warn milta hai, limit par ban/mute. Links default mein allowed hain; delete karwane ke liye group admin /antilink on kare.",
  ),
);

/** In groups Myra only chats when addressed (mention, reply to her, or her name). */
function addressedToMe(ctx: any, text: string): boolean {
  if (!chatAllowed(ctx)) return false;
  if (ctx.chat.type === "private") return true;
  const un = ctx.me.username?.toLowerCase();
  return (
    ctx.message?.reply_to_message?.from?.id === ctx.me.id ||
    (!!un && text.toLowerCase().includes(`@${un}`)) ||
    /\bmyra\b/i.test(text)
  );
}

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  if (!addressedToMe(ctx, ctx.message.text)) return;
  await handleText(ctx, ctx.message.text);
});

bot.on("message:voice", async (ctx) => {
  if (!chatAllowed(ctx)) return;
  if (ctx.chat.type !== "private" && ctx.message.reply_to_message?.from?.id !== ctx.me.id) return;
  try {
    const file = await ctx.getFile();
    const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
    const text = await transcribe(Buffer.from(await res.arrayBuffer()));
    if (!text) return void (await ctx.reply("Awaaz saaf nahi aayi jaan, phir se bolo na 🥺"));
    await handleText(ctx, text, true);
  } catch (e) {
    console.error("voice handler:", e);
    await ctx.reply("Kuch gadbad ho gayi, dobara bolo na 🥺").catch(() => {});
  }
});

bot.catch((err) => console.error("Bot error:", err.error));

/** What "setup" registers with Telegram: allowed update types and the "/" menus. */
export const ALLOWED_UPDATES = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, "chat_member" /* not in Telegram's default list */] as const;

export async function registerMenus() {
  await bot.api.setMyCommands(menu.slice(0, 100));
  // Group admins additionally see the moderation commands in their "/" menu.
  await bot.api.setMyCommands([...MOD_MENU, ...menu].slice(0, 100), { scope: { type: "all_chat_administrators" } });
}
