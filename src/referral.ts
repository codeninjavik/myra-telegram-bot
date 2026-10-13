import type { Bot, Context } from "grammy";
import { DAILY_ACTIVITY_CAP, REF_POINTS, WELCOME_POINTS, activityPoint, leaderboard, profile, setReferrer } from "./db.js";
import { chatAllowed, isHomeGroup } from "./gate.js";

const who = (u: { first_name: string | null; username: string | null; id: number }) =>
  u.username ? `@${u.username}` : u.first_name ?? String(u.id);

export function referralLink(botUsername: string | undefined, userId: number) {
  return `https://t.me/${botUsername}?start=ref_${userId}`;
}

export async function referText(botUsername: string | undefined, userId: number) {
  const p = await profile(userId);
  return (
    `🔗 Tumhara referral link:\n${referralLink(botUsername, userId)}\n\n` +
    `Jo bhi dost is link se aakar saare required groups join karke Verify kare, tumhe +${REF_POINTS} points milte hain ` +
    `(aur use +${WELCOME_POINTS} welcome points) 🎁\n\n` +
    `👥 Ab tak ${p.referrals} dost verified` + (p.pending ? `, ${p.pending} abhi pending` : "") + "."
  );
}

export async function pointsText(userId: number) {
  const p = await profile(userId);
  return (
    `🏆 Tumhare points: ${p.points}\n` +
    `📈 Rank: ${p.rank ? "#" + p.rank : "abhi nahi (pehle points kamao)"}\n` +
    `👥 Referrals: ${p.referrals}` + (p.pending ? ` (+${p.pending} pending)` : "") + "\n\n" +
    `Points kaise milte hain:\n• Dost ko invite karo: +${REF_POINTS}\n• Group mein baat karo: +1 per message (roz max ${DAILY_ACTIVITY_CAP})`
  );
}

export async function leaderboardText(myId?: number) {
  const top = await leaderboard(10);
  if (!top.length) return "Abhi leaderboard khali hai. Pehle points kamao, group mein baat karo ya dosto ko invite karo 🏁";
  const medals = ["🥇", "🥈", "🥉"];
  let text = "🏆 Leaderboard (top 10)\n\n" + top.map((u, i) => `${medals[i] ?? `${i + 1}.`} ${who(u)} — ${u.points}`).join("\n");
  if (myId && !top.some((u) => u.id === myId)) {
    const p = await profile(myId);
    if (p.rank) text += `\n\nTumhara rank: #${p.rank} (${p.points} points)`;
  }
  return text;
}

const shareButton = (url: string) =>
  ({
    inline_keyboard: [
      [{ text: "📤 Dosto ko bhejo", url: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent("Myra se baat karo, join karo 💕")}`, style: "primary" }],
    ],
  }) as any;

export function registerReferral(bot: Bot) {
  // 1) Deep link /start ref_<id> in DM: remember who invited this (new) user. Never blocks the update.
  // 2) Chatting in a required group earns a point (daily cap).
  bot.use(async (ctx, next) => {
    try {
      const text = ctx.message?.text ?? "";
      if (ctx.chat?.type === "private" && ctx.from) {
        const m = text.match(/^\/start(?:@\w+)?\s+ref_(\d+)/);
        if (m) await setReferrer(ctx.from.id, Number(m[1]));
      } else if (ctx.chat && ctx.from && !ctx.from.is_bot && ctx.message && text && !text.startsWith("/") && chatAllowed(ctx) && isHomeGroup(ctx.chat.id)) {
        await activityPoint(ctx.from.id);
      }
    } catch (e) {
      console.error("referral tracking failed:", e);
    }
    await next();
  });

  // Group commands (DM is gated, so DM users use the buttons that appear after verifying).
  const groupOnly = (ctx: Context) => chatAllowed(ctx);

  bot.command(["refer", "invite", "mylink"], async (ctx, next) => {
    if (!groupOnly(ctx)) return next();
    const link = referralLink(ctx.me.username, ctx.from!.id);
    await ctx.reply(await referText(ctx.me.username, ctx.from!.id), { reply_markup: shareButton(link), link_preview_options: { is_disabled: true } });
  });

  bot.command(["points", "mypoints", "me"], async (ctx, next) => {
    if (!groupOnly(ctx)) return next();
    await ctx.reply(await pointsText(ctx.from!.id));
  });

  bot.command(["leaderboard", "lb"], async (ctx, next) => {
    if (!groupOnly(ctx)) return next();
    await ctx.reply(await leaderboardText(ctx.from!.id));
  });

  // Buttons shown in DM after Verify (the DM itself never chats).
  bot.callbackQuery("ref:link", async (ctx) => {
    await ctx.answerCallbackQuery();
    const link = referralLink(ctx.me.username, ctx.from.id);
    await ctx.reply(await referText(ctx.me.username, ctx.from.id), { reply_markup: shareButton(link), link_preview_options: { is_disabled: true } });
  });
  bot.callbackQuery("ref:points", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply((await pointsText(ctx.from.id)) + "\n\n" + (await leaderboardText(ctx.from.id)));
  });
}
