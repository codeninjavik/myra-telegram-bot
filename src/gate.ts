import { readFileSync, writeFileSync } from "node:fs";
import type { Bot, Context } from "grammy";
import { markVerified, rewardReferral } from "./db.js";

// Required groups: users must join ALL of them before they can add Myra to their own group.
// Myra chats only inside these groups; private chats only show the Join/Verify buttons.
type Group = { id: number; link?: string; title?: string };
type GateState = { groups: Group[] };
const FILE = "gate.json";

const state: GateState = (() => {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    if (Array.isArray(raw.groups)) return { groups: raw.groups as Group[] };
    // legacy single-group format
    if (typeof raw.groupId === "number") return { groups: [{ id: raw.groupId, link: raw.link, title: raw.title }] };
  } catch {}
  return { groups: [] };
})();
if (!state.groups.length && process.env.GROUP_CHAT_ID) {
  state.groups.push({ id: Number(process.env.GROUP_CHAT_ID), link: process.env.GROUP_LINK });
}

const save = () => {
  try {
    writeFileSync(FILE, JSON.stringify(state));
  } catch (e) {
    console.error("gate save failed:", e);
  }
};

export const gateConfigured = () => state.groups.length > 0;
const isHomeGroup = (id: number) => state.groups.some((g) => g.id === id);
const ownerId = () => (process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null);

/** Can Myra chat here? Never in private. Groups: only the required groups (any group until one is set). */
export function chatAllowed(ctx: Context): boolean {
  if (ctx.chat?.type === "private") return false;
  if (!gateConfigured()) return true;
  return isHomeGroup(ctx.chat!.id);
}

// ---------- membership ----------
const IN = new Set(["member", "administrator", "creator"]);

async function inGroup(ctx: Context, g: Group, userId: number): Promise<boolean | null> {
  try {
    const m = await ctx.api.getChatMember(g.id, userId);
    return IN.has(m.status) || (m.status === "restricted" && (m as any).is_member === true);
  } catch (e: any) {
    console.error(`gate getChatMember(${g.id}):`, e?.description ?? e);
    return null; // bot can't see that group (not added / not admin)
  }
}

/** missing = confirmed not joined; unknown = bot could not check. */
async function check(ctx: Context, userId: number) {
  const missing: Group[] = [];
  const unknown: Group[] = [];
  for (const g of state.groups) {
    const r = await inGroup(ctx, g, userId);
    if (r === false) missing.push(g);
    else if (r === null) unknown.push(g);
  }
  return { missing, unknown, ok: missing.length === 0 && unknown.length === 0 };
}

// ---------- keyboards (Telegram colours buttons through "style": danger = red, success = green) ----------
type Btn = { text: string; url?: string; callback_data?: string; style: "danger" | "success" | "primary" };
const label = (g: Group, i: number) => `👥 Join ${g.title ? g.title.slice(0, 24) : "Group " + (i + 1)}`;

function joinKeyboard(toJoin: Group[]) {
  const rows: Btn[][] = [];
  toJoin.forEach((g, i) => {
    if (g.link) rows.push([{ text: label(g, i), url: g.link, style: "danger" }]);
  });
  rows.push([{ text: "✅ Verify", callback_data: "gate:verify", style: "danger" }]);
  return { inline_keyboard: rows } as any;
}

function addKeyboard(botUsername: string | undefined) {
  const rows: Btn[][] = [];
  if (botUsername) {
    const rights = "delete_messages+restrict_members+pin_messages+invite_users";
    rows.push([{ text: "➕ Add to Group", url: `https://t.me/${botUsername}?startgroup=true&admin=${rights}`, style: "success" }]);
  }
  rows.push([
    { text: "🔗 Referral Link", callback_data: "ref:link", style: "primary" },
    { text: "🏆 Points", callback_data: "ref:points", style: "primary" },
  ]);
  return { inline_keyboard: rows } as any;
}

function promptText(toJoin: Group[]) {
  const n = toJoin.length;
  return (
    (n > 1 ? `Pehle ye ${n} groups join karo, tabhi tumhe access milega 🙈\n\n` : "Pehle hamare group ko join karo, tabhi tumhe access milega 🙈\n\n") +
    `1️⃣ Neeche ke 👥 Join buttons se ${n > 1 ? "saare groups" : "group"} join karo\n2️⃣ phir ✅ Verify dabao\n\n` +
    "⚠️ Jab tak join nahi karoge, ➕ Add to Group nahi milega aur main kisi aur group mein nahi rahungi."
  );
}
const VERIFIED_TEXT = "✅ Verify ho gaye! Ab ➕ Add to Group dabao aur mujhe apne group mein add karo 💕";

// ---------- helpers for owner commands ----------
export const requiredGroups = (): Group[] => state.groups;

/** First time a referred user is verified: pay the referrer (once) and tell them. */
function payReferral(ctx: Context, userId: number) {
  try {
    const r = rewardReferral(userId);
    if (!r) return;
    ctx.api
      .sendMessage(r.referrer, `🎉 ${r.name} tumhare link se join karke verify ho gaya! +${r.refPoints} points mile 🏆`)
      .catch(() => {});
  } catch (e) {
    console.error("referral reward failed:", e);
  }
}

export async function isAllowedManager(ctx: Context): Promise<boolean> {
  const owner = ownerId();
  if (owner) return ctx.from?.id === owner;
  if (ctx.chat?.type === "private" || !ctx.from) return false;
  const m = await ctx.getChatMember(ctx.from.id).catch(() => null);
  return !!m && (m.status === "administrator" || m.status === "creator");
}

/** Resolve "@name", "https://t.me/name" or "-100123..." to a group; returns an error string on failure. */
async function resolveGroup(ctx: Context, arg: string): Promise<Group | string> {
  const ref = arg.replace(/^https?:\/\//i, "").replace(/^t\.me\//i, "").replace(/^@/, "").split(/[/?]/)[0];
  if (!ref || ref.startsWith("+") || ref.toLowerCase() === "joinchat") {
    return "Private invite link se group ID nahi milti. Public username do (@mygroup), ya us group ke andar /setgroup chalao.";
  }
  try {
    const chat = await ctx.api.getChat(/^-?\d+$/.test(ref) ? Number(ref) : `@${ref}`);
    if (chat.type === "private") return "Ye group/channel nahi hai.";
    const username = (chat as any).username as string | undefined;
    return { id: chat.id, title: (chat as any).title, link: username ? `https://t.me/${username}` : undefined };
  } catch (e: any) {
    return `Group nahi mila: ${e?.description ?? "pata nahi kya hua"}`;
  }
}

function addGroup(g: Group) {
  const i = state.groups.findIndex((x) => x.id === g.id);
  if (i >= 0) state.groups[i] = { ...state.groups[i], ...g, link: g.link ?? state.groups[i].link };
  else state.groups.push(g);
  save();
}

const listText = () =>
  state.groups.length
    ? state.groups.map((g, i) => `${i + 1}. ${g.title ?? g.id}${g.link ? "\n   " + g.link : "\n   (link nahi, join button nahi dikhega)"}`).join("\n")
    : "Abhi koi group set nahi hai.";

export function registerGate(bot: Bot) {
  // Add a required group. In DM (owner): /setgroup https://t.me/mygroup. Inside a group: /setgroup adds that group.
  bot.command(["setgroup", "addgroup"], async (ctx, next) => {
    const arg = String(ctx.match ?? "").trim();
    if (ctx.chat.type === "private" && (!arg || !(await isAllowedManager(ctx)))) return next();
    if (!(await isAllowedManager(ctx))) return void (await ctx.reply("Ye sirf owner/group admins kar sakte hain 😒"));

    let g: Group | string;
    if (ctx.chat.type === "private" || arg) {
      g = await resolveGroup(ctx, arg);
    } else {
      const username = (ctx.chat as any).username as string | undefined;
      let link: string | undefined = username ? `https://t.me/${username}` : undefined;
      if (!link) link = await ctx.api.exportChatInviteLink(ctx.chat.id).catch(() => undefined);
      g = { id: ctx.chat.id, title: (ctx.chat as any).title, link };
    }
    if (typeof g === "string") return void (await ctx.reply(g));

    addGroup(g);
    const botIn = await ctx.api.getChatMember(g.id, ctx.me.id).then((m) => m.status !== "left" && m.status !== "kicked").catch(() => false);
    await ctx.reply(
      `✅ Group add ho gaya: ${g.title ?? g.id}\n\nAbhi required groups (${state.groups.length}):\n${listText()}` +
        (g.link ? "" : "\n\n⚠️ Is group ka link nahi mila, Join button nahi dikhega. Mujhe group mein admin banao (invite permission) aur wahan /setgroup chalao.") +
        (botIn ? "" : "\n⚠️ Bot abhi us group mein nahi hai, verify check ke liye bot ko wahan admin banao."),
    );
  });

  bot.command("groups", async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    await ctx.reply(`📋 Required groups (${state.groups.length}):\n\n${listText()}`, { link_preview_options: { is_disabled: true } });
  });

  // /removegroup <number | @username | -100id>   (inside a group with no argument: removes that group)
  bot.command(["removegroup", "delgroup"], async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    const arg = String(ctx.match ?? "").trim();
    let idx = -1;
    if (/^\d{1,3}$/.test(arg)) idx = Number(arg) - 1;
    else if (arg) {
      const r = await resolveGroup(ctx, arg);
      if (typeof r !== "string") idx = state.groups.findIndex((g) => g.id === r.id);
    } else if (ctx.chat.type !== "private") idx = state.groups.findIndex((g) => g.id === ctx.chat.id);
    if (idx < 0 || idx >= state.groups.length) {
      return void (await ctx.reply(`Kaunsa group hataun? Number ya link do:\n\n${listText()}\n\nJaise: /removegroup 2`, { link_preview_options: { is_disabled: true } }));
    }
    const [gone] = state.groups.splice(idx, 1);
    save();
    await ctx.reply(`🗑️ Hata diya: ${gone.title ?? gone.id}\n\nBache hue groups (${state.groups.length}):\n${listText()}`, { link_preview_options: { is_disabled: true } });
  });

  bot.command("cleargroup", async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    state.groups = [];
    save();
    await ctx.reply("Saare required groups hata diye. Ab group set nahi hai.");
  });

  // Verify button: user must be in every required group.
  bot.callbackQuery("gate:verify", async (ctx) => {
    if (!gateConfigured()) return void (await ctx.answerCallbackQuery({ text: "Abhi koi group set nahi hai." }));
    const r = await check(ctx, ctx.from.id);
    if (r.missing.length) {
      await ctx.answerCallbackQuery({
        text: `Pehle ${r.missing.length > 1 ? r.missing.length + " groups" : "group"} join karo, phir Verify dabao 🙈`,
        show_alert: true,
      });
      // refresh the message so only the groups still left to join are shown
      return void (await ctx.editMessageText(promptText(r.missing), { reply_markup: joinKeyboard(r.missing) }).catch(() => {}));
    }
    if (r.unknown.length) {
      return void (await ctx.answerCallbackQuery({
        text: "Main group check nahi kar paa rahi. Owner se kaho mujhe sabhi groups mein admin banaye.",
        show_alert: true,
      }));
    }
    markVerified(ctx.from.id);
    payReferral(ctx, ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Verify ho gaye ✅" });
    await ctx.editMessageText(VERIFIED_TEXT, { reply_markup: addKeyboard(ctx.me.username) }).catch(() => {});
  });

  // Enforcement: an "Add to Group" link can't be revoked, so the bot checks who added it.
  // Added by someone who has not joined all required groups -> warn with Join buttons and leave.
  bot.on("my_chat_member", async (ctx, next) => {
    const u = ctx.myChatMember;
    const chat = u.chat;
    const wasOut = u.old_chat_member.status === "left" || u.old_chat_member.status === "kicked";
    const isIn = u.new_chat_member.status === "member" || u.new_chat_member.status === "administrator";
    if (chat.type === "private" || !wasOut || !isIn || !gateConfigured() || isHomeGroup(chat.id)) return next();
    if (ownerId() && u.from.id === ownerId()) return next();
    const r = await check(ctx, u.from.id);
    if (r.missing.length === 0) return next(); // joined all (or could not check) -> allow
    await ctx.api
      .sendMessage(chat.id, "Pehle hamare group(s) ko join karo, tabhi main apne group mein reh paungi 🙈\nJoin karke wapas mujhe add karo 💕", {
        reply_markup: joinKeyboard(r.missing),
      })
      .catch(() => {});
    await ctx.api.leaveChat(chat.id).catch((e) => console.error("leaveChat failed:", e?.description ?? e));
  });

  // Private chat: never a chat reply, whatever the user sends. Only the Join + Verify message.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.message) return next();
    if (!gateConfigured()) {
      const isOwner = ownerId() !== null && ctx.from!.id === ownerId();
      return void (await ctx.reply(
        isOwner
          ? "Owner, abhi koi group set nahi hai, isliye users ko Join button nahi mil raha.\n\n" +
              "1) Mujhe apne group mein admin banao\n2) Mujhe yahan bhejo:\n/setgroup https://t.me/tumhare_group_ka_username\n\n" +
              "Aur groups jodne ke liye yehi command dobara chalao."
          : "Abhi group set nahi hua hai, thodi der baad try karo 🙈",
      ));
    }
    const r = await check(ctx, ctx.from!.id);
    if (r.ok) {
      markVerified(ctx.from!.id);
      payReferral(ctx, ctx.from!.id);
      await ctx.reply(VERIFIED_TEXT, { reply_markup: addKeyboard(ctx.me.username) });
    } else {
      const toJoin = [...r.missing, ...r.unknown];
      await ctx.reply(promptText(toJoin), { reply_markup: joinKeyboard(toJoin), link_preview_options: { is_disabled: true } });
    }
  });
}
