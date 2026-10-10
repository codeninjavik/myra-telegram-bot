import { API_CONSTANTS, Bot, InlineKeyboard, InputFile } from "grammy";
import { liveLink, startLive } from "./live.js";
import { chatReply, hasGemini, speak, toOggOpus, transcribe } from "./ai.js";
import { registerCommands } from "./commands.js";
import { chatAllowed, registerGate } from "./gate.js";
import { registerReferral } from "./referral.js";
import { registerStats } from "./stats.js";
import { MOD_MENU, registerModeration } from "./moderation.js";
import { ANGRY, APP_INFO, APP_INTENT, BOT_WORDS, NICE_WORDS, pick } from "./persona.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN missing. Copy .env.example to .env and set it.");
  process.exit(1);
}

const bot = new Bot(token);
const voiceMode = new Set<number>(); // chats where Myra always answers in voice
const WANTS_VOICE = /\b(voice|audio|bol ke|bolo|sunao|awaaz|awaz|aawaz)\b/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function respond(ctx: any, text: string, asVoice: boolean) {
  const hint = asVoice ? "\nYe reply voice note mein bola jayega: emojis mat use karo, 1-2 chhote vaakya." : "";
  await ctx.replyWithChatAction(asVoice ? "record_voice" : "typing").catch(() => {});
  const reply = await chatReply(ctx.chat.id, text, hint);

  if (asVoice && hasGemini) {
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
  const asVoice = fromVoice || voiceMode.has(ctx.chat.id) || WANTS_VOICE.test(text);
  await respond(ctx, text, asVoice);
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
    const m = await ctx.getChatMember(ctx.from!.id).catch(() => null);
    if (!m || (m.status !== "administrator" && m.status !== "creator")) {
      return void (await ctx.reply("Group mein voice mode sirf admins badal sakte hain 😒. Tum bas 'myra voice mein bolo' likh do."));
    }
  }
  if (voiceMode.has(id)) {
    voiceMode.delete(id);
    await ctx.reply("Theek hai, ab text mein baat karenge 😊");
  } else {
    voiceMode.add(id);
    await ctx.reply("Ab main voice note mein bolungi 🎙️😘");
  }
});

registerStats(bot); // tracks users/groups for /stats; never blocks an update
registerReferral(bot); // /start ref_ deep links, activity points, /refer /points /leaderboard
registerGate(bot); // private chats get Join/Verify buttons instead of any reply

// /vc, /call too: a Telegram bot cannot join a group voice chat, so people talk to Myra live through this page.
bot.command(["live", "livevoice", "vc", "voicechat", "call"], async (ctx, next) => {
  if (!chatAllowed(ctx)) return next();
  const { url, public: isPublic } = liveLink(ctx.chat.id);
  const text =
    "🎙️ Myra se live baat karo: neeche wala button dabao, browser mein Myra ki screen khulegi aur mic se seedha baat kar sakte ho.\n" +
    "(Group ke voice chat mein main join nahi kar sakti, isliye live baat yahan hoti hai.)";
  try {
    await ctx.reply(text, { reply_markup: new InlineKeyboard().url("🎙️ Live Voice Baat Karo", url) });
  } catch {
    // Telegram refuses localhost URLs on buttons, so send the plain link instead.
    await ctx.reply(`${text}\n\n${url}`);
  }
  if (!isPublic) {
    await ctx.reply(
      "ℹ️ Ye button sirf us PC ke browser mein khulega jahan bot chal raha hai. Phone par kholne ke liye .env mein PUBLIC_URL (apna https tunnel/hosting URL) set karo.",
    );
  }
});

registerModeration(bot);
const menu = registerCommands(bot);

bot.command("modhelp", (ctx) =>
  ctx.reply(
    "👮 Moderation commands (sirf group admins, bot ko admin banana zaroori):\n\n" +
      MOD_MENU.map((m) => `/${m.command} - ${m.description}`).join("\n") +
      "\n\nAuto-mod: link, gaali aur spam wale msg delete hote hain, warn milta hai, limit par ban/mute.",
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
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    const text = await transcribe(Buffer.from(await res.arrayBuffer()));
    if (!text) return void (await ctx.reply("Awaaz saaf nahi aayi jaan, phir se bolo na 🥺"));
    await handleText(ctx, text, true);
  } catch (e) {
    console.error("voice handler:", e);
    await ctx.reply("Kuch gadbad ho gayi, dobara bolo na 🥺").catch(() => {});
  }
});

bot.catch((err) => console.error("Bot error:", err.error));
bot.start({
  // chat_member (who joined which group) is not in Telegram's default update list
  allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, "chat_member"],
  onStart: async (me) => {
    startLive();
    console.log(`Myra (@${me.username}) online hai, ${menu.length} commands`);
    await bot.api.setMyCommands(menu).catch((e) => console.error("setMyCommands:", e));
    // Group admins additionally see the moderation commands in their "/" menu.
    await bot.api
      .setMyCommands([...MOD_MENU, ...menu].slice(0, 100), { scope: { type: "all_chat_administrators" } })
      .catch((e) => console.error("setMyCommands(admins):", e));
  },
});
