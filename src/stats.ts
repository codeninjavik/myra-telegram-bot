import type { Api, Bot } from "grammy";
import {
  allChats, setChatInfo, countryStats, groupGrowth, languageStats, liveStats, overview, recordJoin, setChatStatus, snapshot, topUsers,
  touchChat, touchUser, type ChatRow,
} from "./db.js";
import { isAllowedManager, requiredGroups } from "./gate.js";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "0%");

/** Saves today's member count for every required group (used for growth numbers). */
export async function snapshotGroups(api: Api) {
  for (const g of requiredGroups()) {
    try {
      await snapshot(g.id, await api.getChatMemberCount(g.id));
    } catch (e: any) {
      console.error(`snapshot ${g.id}:`, e?.description ?? e);
    }
  }
}

const GONE = /kicked|not found|deactivated|forbidden|chat was deleted|bot is not a member|have no rights/i;

/**
 * Asks Telegram about every group/channel Myra has seen, so the numbers are right even for removals that happened
 * before removals were tracked. Network or rate-limit errors leave a chat's status as it was.
 */
async function refreshChats(api: Api, meId: number): Promise<ChatRow[]> {
  const chats = (await allChats()).filter((c) => c.type === "group" || c.type === "supergroup" || c.type === "channel").slice(0, 200);
  let i = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (i < chats.length) {
        const c = chats[i++];
        try {
          const m = await api.getChatMember(c.id, meId);
          if (m.status === "left" || m.status === "kicked") await setChatStatus(c, "removed");
          else {
            await setChatStatus(c, "active", m.status === "administrator" ? "admin" : "member");
            // size and a way in: public @username, or the invite link Telegram gives an admin bot
            const [info, count] = await Promise.allSettled([api.getChat(c.id), api.getChatMemberCount(c.id)]);
            const i: any = info.status === "fulfilled" ? info.value : null;
            await setChatInfo(c.id, {
              username: i?.username ?? undefined,
              link: i?.invite_link ?? undefined,
              members: count.status === "fulfilled" ? count.value : undefined,
            });
          }
        } catch (e: any) {
          if (GONE.test(String(e?.description ?? ""))) await setChatStatus(c, "removed");
        }
      }
    }),
  );
  return (await allChats()).filter((c) => c.type !== "private");
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "3. <a>Group name</a> — 1,234 members · admin" (the name is a link when Telegram gave us one). */
function groupLine(c: ChatRow, i: number, note?: string): string {
  const url = c.username ? `https://t.me/${c.username}` : c.link ?? null;
  const name = escHtml(c.title ?? String(c.id));
  const parts = [
    c.members != null ? `${c.members.toLocaleString("en-US")} members` : null,
    c.role === "admin" ? "admin" : null,
    note ?? null,
    url ? null : "link nahi",
  ].filter(Boolean);
  return `${i + 1}. ${url ? `<a href="${escHtml(url)}">${name}</a>` : name}${parts.length ? " — " + parts.join(" · ") : ""}`;
}

const ago = (sec: number) => {
  const d = Math.floor((Date.now() / 1000 - sec) / 86400);
  return d <= 0 ? "aaj" : `${d} din pehle`;
};

export function registerStats(bot: Bot) {
  // Myra added to / removed from a chat. Passes the update on (the gate may still make her leave).
  bot.on("my_chat_member", async (ctx, next) => {
    try {
      const u = ctx.myChatMember;
      if (u.chat.type !== "private") {
        const s = u.new_chat_member.status;
        const chat = { id: u.chat.id, title: (u.chat as any).title as string | undefined, type: u.chat.type };
        await setChatStatus(chat, s === "left" || s === "kicked" ? "removed" : "active", s === "administrator" ? "admin" : "member");
        const uname = (u.chat as any).username as string | undefined;
        if (uname) await setChatInfo(u.chat.id, { username: uname }); // keeps a link for groups that later remove her
      }
    } catch (e) {
      console.error("my_chat_member tracking failed:", e);
    }
    await next();
  });

  // Track every user and chat that talks to the bot. Never blocks the update.
  bot.use(async (ctx, next) => {
    try {
      if (ctx.from && !ctx.from.is_bot) {
        await touchUser(ctx.from, { message: !!ctx.message, dm: ctx.chat?.type === "private" && !!ctx.message });
      }
      if (ctx.chat && ctx.chat.type !== "private") await touchChat({ id: ctx.chat.id, title: (ctx.chat as any).title, type: ctx.chat.type, username: (ctx.chat as any).username });
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
        await recordJoin(ctx.chat.id, u.new_chat_member.user.id);
        await touchUser(u.new_chat_member.user);
      }
    } catch (e) {
      console.error("join tracking failed:", e);
    }
    await next();
  });

  // Quick head count: how many people use the bot.
  bot.command(["users", "usercount"], async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    const [o, langs, countries] = await Promise.all([overview(), languageStats(), countryStats()]);
    const name = (type: "language" | "region", code: string) => {
      try {
        return new Intl.DisplayNames(["en"], { type }).of(code) ?? code;
      } catch {
        return code;
      }
    };
    const list = (rows: [string, number][], type: "language" | "region") =>
      rows.slice(0, 10).map(([c, n]) => `• ${c === "?" ? "Unknown" : name(type, c)}: ${n}`).join("\n");
    await ctx.reply(
      `👥 Bot use karne wale log: ${o.total}\n` +
        `💬 DM start kiya: ${o.dm}\n` +
        `✅ Verified: ${o.verified}\n` +
        `🟢 Active: aaj ${o.active24h} | 7 din ${o.active7d} | 30 din ${o.active30d}\n` +
        `🆕 Naye: aaj ${o.new24h} | 7 din ${o.new7d}\n` +
        `🏘️ Groups: ${o.groups}\n\n` +
        `🌐 Telegram language ke hisaab se (Telegram country nahi batata):\n${list(langs, "language") || "abhi data nahi"}\n\n` +
        `📍 Country (jinhone live voice page kholi):\n${list(countries, "region") || "abhi data nahi"}`,
    );
  });

  bot.command("stats", async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    await snapshotGroups(bot.api);
    const [chats, live] = await Promise.all([refreshChats(bot.api, ctx.me.id), liveStats()]);
    const o = await overview(); // after the refresh, so its group count already ignores removed groups
    const groupsNow = chats.filter((c) => c.type !== "channel" && c.status !== "removed");
    const admin = groupsNow.filter((c) => c.role === "admin").length;
    const removed = chats.filter((c) => c.status === "removed").sort((a, b) => (b.removed_at ?? 0) - (a.removed_at ?? 0));
    const groupBlock =
      `\n🏘️ Groups jahan Myra abhi hai: ${groupsNow.length} (admin ${admin} | sirf member ${groupsNow.length - admin})\n` +
      `🚪 Jinhone Myra ko hata diya/nikal diya: ${removed.length}\n` +
      `🎙️ Live voice: ${live.total} logon ne link liya, pichle 24 ghante mein ${live.last24h}\n`;

    let text =
      `📊 Myra stats\n\n` +
      `👥 Total users: ${o.total}\n` +
      `💬 DM start kiya: ${o.dm} (${pct(o.dm, o.total)})\n` +
      `✅ Verified: ${o.verified} (${pct(o.verified, o.total)}), aaj ${o.verifiedToday} naye\n\n` +
      `🟢 Active: 24 ghante ${o.active24h} | 7 din ${o.active7d} | 30 din ${o.active30d}\n` +
      `🆕 Naye users: aaj ${o.new24h} | 7 din ${o.new7d}\n` +
      `✉️ Total messages: ${o.messages}\n` +
      groupBlock;

    const groups = requiredGroups();
    if (groups.length) {
      text += `\n📌 Required groups (${groups.length}):\n`;
      for (const [i, g] of groups.entries()) {
        const name = g.title ?? String(g.id);
        try {
          const now = await bot.api.getChatMemberCount(g.id);
          const gr = await groupGrowth(g.id);
          const delta = gr.baseline7d === null ? "n/a (abhi data ban raha hai)" : `${now - gr.baseline7d >= 0 ? "+" : ""}${now - gr.baseline7d}`;
          text += `${i + 1}. ${name}: ${now} members | 7 din badlav ${delta} | joins aaj ${gr.joins24h}, 7 din ${gr.joins7d}\n`;
        } catch {
          text += `${i + 1}. ${name}: count nahi mila (bot ko group mein admin banao)\n`;
        }
      }
    } else {
      text += "\n📌 Abhi koi required group set nahi hai (/setgroup).\n";
    }

    const top = await topUsers(5);
    if (top.length) {
      text += `\n🏆 Sabse active users:\n` + top.map((u, i) => `${i + 1}. ${u.username ? "@" + u.username : u.first_name ?? u.id} (${u.messages} msgs)`).join("\n");
    }
    await ctx.reply(text, { link_preview_options: { is_disabled: true } });

    // Full group lists: the name is a tappable link (public @username or invite link) with the member count.
    const sendList = async (title: string, rows: string[]) => {
      if (!rows.length) return;
      let chunk = title;
      for (const r of rows) {
        if (chunk.length + r.length > 3600) {
          await ctx.reply(chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
          chunk = "";
        }
        chunk += "\n" + r;
      }
      await ctx.reply(chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    };
    await sendList(
      `🏘️ <b>Jahan Myra abhi hai (${groupsNow.length})</b>`,
      [...groupsNow].sort((a, b) => (b.members ?? 0) - (a.members ?? 0)).map((c, i) => groupLine(c, i)),
    );
    await sendList(
      `🚪 <b>Jinhone hata diya (${removed.length})</b>`,
      removed.map((c, i) => groupLine(c, i, c.removed_at ? ago(c.removed_at) : undefined)),
    );
  });

  // Member-count snapshots (for growth numbers) are taken by the scheduled function netlify/functions/snapshot.ts.
}
