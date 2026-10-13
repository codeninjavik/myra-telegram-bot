import type { Bot, Context } from "grammy";
import { describeImage, transcribe, translate } from "./ai.js";
import { chatAllowed } from "./gate.js";

// /tr (translate), /stt (voice to text) and photo understanding. All work in groups only (DMs are gated).
const MAX_FILE = 10 * 1024 * 1024;

async function download(ctx: Context, fileId: string): Promise<Buffer | null> {
  const file = await ctx.api.getFile(fileId);
  if ((file.file_size ?? 0) > MAX_FILE || !file.file_path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

/** Spoken at Myra: her name, an @mention, or a reply to one of her messages. */
function toMyra(ctx: Context, text: string): boolean {
  const un = ctx.me.username?.toLowerCase();
  return (
    ctx.message?.reply_to_message?.from?.id === ctx.me.id ||
    (!!un && text.toLowerCase().includes(`@${un}`)) ||
    /\bmyra\b/i.test(text)
  );
}

async function lookAt(ctx: Context, fileId: string, question: string) {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const img = await download(ctx, fileId);
  if (!img) return void (await ctx.reply("Ye photo main khol nahi paa rahi 🥺 (bahut badi ho sakti hai)"));
  const answer = await describeImage(img, "image/jpeg", question);
  await ctx.reply(answer ?? "Abhi photo dekh nahi paa rahi 🥺 thodi der baad try karo.");
}

export const TOOLS_MENU = [
  { command: "tr", description: "Translate: /tr hi hello  (ya reply karke /tr en)" },
  { command: "stt", description: "Voice message ko text banao (voice ka reply karke)" },
  { command: "see", description: "Photo ke reply mein /see: Myra batayegi kya hai" },
];

export function registerTools(bot: Bot) {
  bot.command(["tr", "translate"], async (ctx, next) => {
    if (!chatAllowed(ctx)) return next();
    const arg = String(ctx.match ?? "").trim();
    const replied = ctx.message?.reply_to_message;
    const repliedText = replied?.text ?? replied?.caption ?? "";
    let to: string;
    let text: string;
    if (repliedText) {
      to = arg || "English";
      text = repliedText;
    } else {
      const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        return void (await ctx.reply("Jaise: /tr hi good morning  (hi = Hindi, en = English, ta, bn, ur, es, fr...)\nYa kisi msg ka reply karke: /tr en"));
      }
      [, to, text] = m;
    }
    await ctx.replyWithChatAction("typing").catch(() => {});
    const out = await translate(text.slice(0, 1500), to);
    await ctx.reply(out ?? "Translate nahi ho paya 🥺 thodi der baad try karo.");
  });

  bot.command(["stt", "transcribe", "totext"], async (ctx, next) => {
    if (!chatAllowed(ctx)) return next();
    const r = ctx.message?.reply_to_message;
    const media = r?.voice ?? r?.audio ?? r?.video_note;
    if (!media) return void (await ctx.reply("Kisi voice message ka reply karke /stt likho 🎙️"));
    await ctx.replyWithChatAction("typing").catch(() => {});
    const audio = await download(ctx, media.file_id);
    if (!audio) return void (await ctx.reply("Ye audio bahut badi hai ya khul nahi rahi 🥺"));
    const mime = r?.voice ? "audio/ogg" : (r?.audio?.mime_type ?? "audio/mp4");
    const text = await transcribe(audio, mime, r?.voice ? "voice.ogg" : "audio.m4a");
    await ctx.reply(text ? `📝 ${text}` : "Awaaz samajh nahi aayi 🥺");
  });

  // /see as a reply to a photo
  bot.command(["see", "look"], async (ctx, next) => {
    if (!chatAllowed(ctx)) return next();
    const photo = ctx.message?.reply_to_message?.photo?.at(-1);
    if (!photo) return void (await ctx.reply("Kisi photo ka reply karke /see likho 📷"));
    await lookAt(ctx, photo.file_id, String(ctx.match ?? ""));
  });

  // A photo with "myra ..." in the caption.
  bot.on("message:photo", async (ctx, next) => {
    const caption = ctx.message.caption ?? "";
    if (!chatAllowed(ctx) || !toMyra(ctx, caption)) return next();
    await lookAt(ctx, ctx.message.photo.at(-1)!.file_id, caption.replace(/@\w+|\bmyra\b/gi, "").trim());
  });

  // A reply to someone's photo that is addressed to Myra: "myra ye kya hai?"
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text;
    const photo = ctx.message.reply_to_message?.photo?.at(-1);
    if (!photo || text.startsWith("/") || !chatAllowed(ctx) || !/\bmyra\b/i.test(text) && !text.toLowerCase().includes(`@${ctx.me.username?.toLowerCase()}`)) {
      return next();
    }
    await lookAt(ctx, photo.file_id, text.replace(/@\w+|\bmyra\b/gi, "").trim());
  });
}
