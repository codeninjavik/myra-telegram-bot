import type { Bot } from "grammy";
import { groupGrowth, overview, recordJoin, snapshot, topUsers, touchChat, touchUser } from "./db.js";
import { isAllowedManager, requiredGroups } from "./gate.js";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "0%");

/** Saves today's member count for every required group (used for growth numbers). */
async function snapshotGroups(bot: Bot) {
  for (const g of requiredGroups()) {
    try {
      snapshot(g.id, await bot.api.getChatMemberCount(g.id));
    } catch (e: any) {
      console.error(`snapshot ${g.id}:`, e?.description ?? e);
    }
  }
}

export function registerStats(bot: Bot) {
  // Track every user and chat that talks to the bot. Never blocks the update.
  bot.use(async (ctx, next) => {
    try {
      if (ctx.from && !ctx.from.is_bot) {
        touchUser(ctx.from, { message: !!ctx.message, dm: ctx.chat?.type === "private" && !!ctx.message });
      }
      if (ctx.chat && ctx.chat.type !== "private") touchChat({ id: ctx.chat.id, title: (ctx.chat as any).title, type: ctx.chat.type });
    } catch (e) {
      console.error("tracking failed:", e);
    }
    await next();
  });

  // Group joins (needs the bot to be admin in the group; "chat_member" updates are requested in bot.start).
  bot.on("chat_member", async (ctx, next) => {
    try {
      const u = ctx.chatMember;
      const wasOut = u.old_chat_member.status === "left" || u.old_chat_member.status === "kicked";
      const isIn = ["member", "administrator", "creator"].includes(u.new_chat_member.status);
      if (wasOut && isIn && !u.new_chat_member.user.is_bot) {
        recordJoin(ctx.chat.id, u.new_chat_member.user.id);
        touchUser(u.new_chat_member.user);
      }
    } catch (e) {
      console.error("join tracking failed:", e);
    }
    await next();
  });

  bot.command("stats", async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    await snapshotGroups(bot);
    const o = overview();

    let text =
      `📊 Myra stats\n\n` +
      `👥 Total users: ${o.total}\n` +
      `💬 DM start kiya: ${o.dm} (${pct(o.dm, o.total)})\n` +
      `✅ Verified: ${o.verified} (${pct(o.verified, o.total)}), aaj ${o.verifiedToday} naye\n\n` +
      `🟢 Active: 24 ghante ${o.active24h} | 7 din ${o.active7d} | 30 din ${o.active30d}\n` +
      `🆕 Naye users: aaj ${o.new24h} | 7 din ${o.new7d}\n` +
      `✉️ Total messages: ${o.messages}\n` +
      `🏘️ Groups jahan bot hai: ${o.groups}\n`;

    const groups = requiredGroups();
    if (groups.length) {
      text += `\n📌 Required groups (${groups.length}):\n`;
      for (const [i, g] of groups.entries()) {
        const name = g.title ?? String(g.id);
        try {
          const now = await bot.api.getChatMemberCount(g.id);
          const gr = groupGrowth(g.id);
          const delta = gr.baseline7d === null ? "n/a (abhi data ban raha hai)" : `${now - gr.baseline7d >= 0 ? "+" : ""}${now - gr.baseline7d}`;
          text += `${i + 1}. ${name}: ${now} members | 7 din badlav ${delta} | joins aaj ${gr.joins24h}, 7 din ${gr.joins7d}\n`;
        } catch {
          text += `${i + 1}. ${name}: count nahi mila (bot ko group mein admin banao)\n`;
        }
      }
    } else {
      text += "\n📌 Abhi koi required group set nahi hai (/setgroup).\n";
    }

    const top = topUsers(5);
    if (top.length) {
      text += `\n🏆 Sabse active users:\n` + top.map((u, i) => `${i + 1}. ${u.username ? "@" + u.username : u.first_name ?? u.id} (${u.messages} msgs)`).join("\n");
    }
    await ctx.reply(text, { link_preview_options: { is_disabled: true } });
  });

  // Daily-ish member-count snapshots so growth can be computed.
  setTimeout(() => snapshotGroups(bot), 15_000);
  setInterval(() => snapshotGroups(bot), 6 * 60 * 60 * 1000);
}
