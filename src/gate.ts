import type { Bot, Context } from "grammy";
import { findUserByUsername, getUserRow, markVerified, rewardReferral } from "./db.js";
import { listGeminiKeyRows, removeGeminiKey } from "./keystore.js";
import { liveLink } from "./live.js";
import { getJSON, setJSON } from "./store.js";

// Required groups: users must join ALL of them before they can add Myra to their own group.
// Myra chats only inside these groups; private chats only show the Join/Verify buttons.
type Group = { id: number; link?: string; title?: string; channel?: boolean };
type GateState = { groups: Group[] };
const KEY = "gate";

// Reloaded at the start of every update (see loadGate); each function invocation is a fresh process.
const state: GateState = { groups: [] };

export async function loadGate() {
  const raw = await getJSON<any>(KEY);
  let groups: Group[] = [];
  if (Array.isArray(raw?.groups)) groups = raw.groups;
  else if (typeof raw?.groupId === "number") groups = [{ id: raw.groupId, link: raw.link, title: raw.title }]; // legacy
  if (!groups.length && process.env.GROUP_CHAT_ID) groups = [{ id: Number(process.env.GROUP_CHAT_ID), link: process.env.GROUP_LINK }];
  state.groups = groups;
  botAdmins.clear();
  for (const id of (await getJSON<number[]>(ADMINS_KEY)) ?? []) botAdmins.add(id);
}

const save = () => setJSON(KEY, state);

// Bot admins: people the owner trusts with the owner commands (/stats, /users, /setgroup, /setchannel...). Reloaded per update.
const botAdmins = new Set<number>();
const ADMINS_KEY = "botadmins";

export const gateConfigured = () => state.groups.length > 0;
export const isHomeGroup = (id: number) => state.groups.some((g) => g.id === id);
const ownerId = () => (process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null);

/**
 * Can Myra chat here? Never in private (DMs only show Join/Verify). In every group: users who passed the gate
 * add her to their own groups, and she must work there too. The required groups only matter for the gate itself.
 */
export function chatAllowed(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
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
const label = (g: Group, i: number) =>
  `${g.channel ? "📢" : "👥"} Join ${g.title ? g.title.slice(0, 24) : (g.channel ? "Channel " : "Group ") + (i + 1)}`;

function joinKeyboard(toJoin: Group[]) {
  const rows: Btn[][] = [];
  toJoin.forEach((g, i) => {
    if (g.link) rows.push([{ text: label(g, i), url: g.link, style: "danger" }]);
  });
  rows.push([{ text: "✅ Verify", callback_data: "gate:verify", style: "danger" }]);
  return { inline_keyboard: rows } as any;
}

function addKeyboard(botUsername: string | undefined, liveUrl?: string) {
  const rows: Btn[][] = [];
  if (liveUrl) rows.push([{ text: "🎙️ Live Voice Baat Karo", url: liveUrl, style: "primary" }]);
  if (botUsername) {
    const rights = "delete_messages+restrict_members+pin_messages+invite_users";
    rows.push([{ text: "➕ Add to Group", url: `https://t.me/${botUsername}?startgroup=true&admin=${rights}`, style: "success" }]);
  }
  rows.push([{ text: "🧰 Tools", callback_data: "tl:new", style: "primary" }]);
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

/** Game commands that verified users may run in the DM (handled by games.ts). */
const GAME_DM =
  /^\/(games|play|challenge|matches|profile|gtop|toplayers|wallet|transactions|purchases|shop|theme|dailygame|gsettings|paysupport|gamehelp|cancel|deposit|withdraw|cashout|tournament|gadmin|game|spyplay|createroom|joinroom|agentprofile|agentboard|missions|rewards|agenthistory|ludo)(@\w+)?(\s|$)|^\/start(@\w+)?\s+(gch_|gm_|sa_)/i;

// ---------- helpers for owner commands ----------
export const requiredGroups = (): Group[] => state.groups;

/** First time a referred user is verified: pay the referrer (once) and tell them. */
async function payReferral(ctx: Context, userId: number) {
  try {
    const r = await rewardReferral(userId);
    if (!r) return;
    await ctx.api
      .sendMessage(r.referrer, `🎉 ${r.name} tumhare link se join karke verify ho gaya! +${r.refPoints} points mile 🏆`)
      .catch(() => {});
  } catch (e) {
    console.error("referral reward failed:", e);
  }
}

/** Owner or a bot admin (/addbotadmin). Used by the game admin tools. */
export const isBotManager = (userId: number) => botAdmins.has(userId) || userId === ownerId();

export async function isAllowedManager(ctx: Context): Promise<boolean> {
  if (ctx.from && botAdmins.has(ctx.from.id)) return true;
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
    return { id: chat.id, title: (chat as any).title, link: username ? `https://t.me/${username}` : undefined, channel: chat.type === "channel" };
  } catch (e: any) {
    return `Group nahi mila: ${e?.description ?? "pata nahi kya hua"}`;
  }
}

async function addGroup(g: Group) {
  const i = state.groups.findIndex((x) => x.id === g.id);
  if (i >= 0) state.groups[i] = { ...state.groups[i], ...g, link: g.link ?? state.groups[i].link };
  else state.groups.push(g);
  await save();
}

const listText = () =>
  state.groups.length
    ? state.groups.map((g, i) => `${i + 1}. ${g.channel ? "📢" : "👥"} ${g.title ?? g.id}${g.link ? "\n   " + g.link : "\n   (link nahi, join button nahi dikhega)"}`).join("\n")
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

    await addGroup(g);
    const botIn = await ctx.api.getChatMember(g.id, ctx.me.id).then((m) => m.status !== "left" && m.status !== "kicked").catch(() => false);
    await ctx.reply(
      `✅ Group add ho gaya: ${g.title ?? g.id}\n\nAbhi required groups (${state.groups.length}):\n${listText()}` +
        (g.link ? "" : "\n\n⚠️ Is group ka link nahi mila, Join button nahi dikhega. Mujhe group mein admin banao (invite permission) aur wahan /setgroup chalao.") +
        (botIn ? "" : "\n⚠️ Bot abhi us group mein nahi hai, verify check ke liye bot ko wahan admin banao."),
    );
  });

  // Add a required CHANNEL (DM, owner): /setchannel @mychannel  or  /setchannel -1001234567890 https://t.me/+invite
  // The bot must be an admin of the channel, otherwise it cannot check who joined and nobody could ever verify.
  bot.command(["setchannel", "addchannel"], async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    const [ref, inviteLink] = String(ctx.match ?? "").trim().split(/\s+/);
    if (!ref) {
      return void (await ctx.reply(
        "Channel ka username ya link do:\n/setchannel @mychannel\n/setchannel https://t.me/mychannel\n\n" +
          "Private channel ho to ID aur invite link:\n/setchannel -1001234567890 https://t.me/+abcdef\n\n" +
          "Pehle mujhe us channel mein admin banao.",
      ));
    }
    const g = await resolveGroup(ctx, ref);
    if (typeof g === "string") return void (await ctx.reply(g));
    if (!g.channel) return void (await ctx.reply("Ye channel nahi hai. Group ke liye /setgroup use karo."));
    if (inviteLink && /^https:\/\/t\.me\//.test(inviteLink)) g.link = inviteLink;

    const me = await ctx.api.getChatMember(g.id, ctx.me.id).catch(() => null);
    if (!me || me.status !== "administrator") {
      return void (await ctx.reply(
        `⚠️ Main ${g.title ?? "us channel"} mein admin nahi hoon, isliye check nahi kar paungi ki kisne join kiya. ` +
          "Channel ke Administrators mein mujhe add karo, phir /setchannel dobara chalao.",
      ));
    }
    await addGroup(g);
    await ctx.reply(
      `✅ Channel add ho gaya: ${g.title ?? g.id}\n\nAbhi required groups/channels (${state.groups.length}):\n${listText()}` +
        (g.link ? "" : `\n\n⚠️ Channel ka public username ya invite link nahi mila, Join button nahi dikhega. /setchannel ${g.id} https://t.me/+invite chalao.`),
      { link_preview_options: { is_disabled: true } },
    );
  });

  // ---------- bot admins (owner only) ----------
  /** Who is meant: a replied-to message, a text mention, a numeric id, or an @username of someone Myra has seen. */
  async function whoIs(ctx: Context, arg: string): Promise<{ id: number; name: string } | null> {
    const r = ctx.message?.reply_to_message?.from;
    if (r && !r.is_bot) return { id: r.id, name: r.first_name };
    const ent = ctx.message?.entities?.find((e) => e.type === "text_mention");
    if (ent && "user" in ent && ent.user) return { id: ent.user.id, name: ent.user.first_name };
    const num = arg.match(/^-?\d{5,}$/)?.[0];
    if (num) {
      const row = await getUserRow(Number(num));
      return { id: Number(num), name: row?.first_name ?? num };
    }
    const un = arg.match(/^@?([A-Za-z0-9_]{4,32})$/)?.[1];
    if (un) {
      const row = await findUserByUsername(un);
      if (row) return { id: row.id, name: row.first_name ?? "@" + un };
    }
    return null;
  }
  const isOwner = (ctx: Context) => ownerId() !== null && ctx.from?.id === ownerId();

  bot.command(["addbotadmin", "addadmin"], async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const target = await whoIs(ctx, String(ctx.match ?? "").trim());
    if (!target) {
      return void (await ctx.reply(
        "Kisko admin banau? Uske msg ka reply karke /addbotadmin likho, ya:\n/addbotadmin @username  (jisne bot use kiya ho)\n/addbotadmin 123456789  (user ID)",
      ));
    }
    if (target.id === ownerId()) return void (await ctx.reply("Tum to owner ho hi 😄"));
    if (botAdmins.has(target.id)) return void (await ctx.reply(`${target.name} pehle se bot admin hai ✅`));
    botAdmins.add(target.id);
    await setJSON(ADMINS_KEY, [...botAdmins]);
    await ctx.reply(`✅ ${target.name} (${target.id}) ab bot admin hai.\nWo /stats, /users, /setgroup, /setchannel, /groups jaise commands chala sakta hai.`);
    await ctx.api.sendMessage(target.id, "🎉 Tumhe Myra bot ka admin bana diya gaya hai. Ab tum /stats, /users aur /groups jaise admin commands chala sakte ho.").catch(() => {});
  });

  bot.command(["removebotadmin", "deladmin"], async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const target = await whoIs(ctx, String(ctx.match ?? "").trim());
    if (!target) return void (await ctx.reply("Kisko hataun? Reply karke /removebotadmin ya /removebotadmin @username ya user ID likho."));
    if (!botAdmins.delete(target.id)) return void (await ctx.reply(`${target.name} bot admin nahi hai.`));
    await setJSON(ADMINS_KEY, [...botAdmins]);
    await ctx.reply(`🗑️ ${target.name} ab bot admin nahi raha.`);
  });

  bot.command("botadmins", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    if (!botAdmins.size) return void (await ctx.reply("Abhi koi bot admin nahi hai. /addbotadmin se jodo."));
    const rows = await Promise.all(
      [...botAdmins].map(async (id, i) => {
        const u = await getUserRow(id);
        return `${i + 1}. ${u?.first_name ?? id}${u?.username ? " (@" + u.username + ")" : ""} - ${id}`;
      }),
    );
    await ctx.reply(`👮 Bot admins (${rows.length}):\n\n${rows.join("\n")}`);
  });

  // Gemini keys added through the live page popup (owner only: they are secrets).
  const mask = (k: string) => k.slice(0, 4) + "…" + k.slice(-4);
  bot.command("keys", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const env = (process.env.GEMINI_API_KEYS ?? "").split(",").filter((k) => k.trim()).length;
    const rows = await listGeminiKeyRows();
    const lines = rows.map((r, i) => `${i + 1}. ${mask(r.key)}  (${Math.max(0, Math.floor((Date.now() - r.at) / 86400000))} din pehle)`);
    await ctx.reply(
      `🔑 Gemini keys: env ke ${env}, live page se ${rows.length}\n\n` +
        (rows.length ? lines.join("\n") + "\n\nHatane ke liye: /delkey 1" : "Popup se abhi koi key nahi aayi."),
    );
  });
  bot.command("delkey", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const rows = await listGeminiKeyRows();
    const n = Number(String(ctx.match ?? "").trim());
    if (!Number.isInteger(n) || n < 1 || n > rows.length) return void (await ctx.reply("Number do: /delkey 1  (list ke liye /keys)"));
    await removeGeminiKey(rows[n - 1].id);
    await ctx.reply(`🗑️ ${mask(rows[n - 1].key)} hata di. (Chal rahe instance ko band hone mein kuch minute lag sakte hain.)`);
  });

  bot.command(["groups", "channels"], async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    await ctx.reply(`📋 Required groups (${state.groups.length}):\n\n${listText()}`, { link_preview_options: { is_disabled: true } });
  });

  // /removegroup <number | @username | -100id>   (inside a group with no argument: removes that group)
  bot.command(["removegroup", "delgroup", "removechannel", "delchannel"], async (ctx, next) => {
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
    await save();
    await ctx.reply(`🗑️ Hata diya: ${gone.title ?? gone.id}\n\nBache hue groups (${state.groups.length}):\n${listText()}`, { link_preview_options: { is_disabled: true } });
  });

  bot.command("cleargroup", async (ctx, next) => {
    if (!(await isAllowedManager(ctx))) return next();
    state.groups = [];
    await save();
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
    await markVerified(ctx.from.id);
    await payReferral(ctx, ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Verify ho gaye ✅" });
    const { url } = await liveLink(ctx.from.id);
    await ctx.editMessageText(VERIFIED_TEXT, { reply_markup: addKeyboard(ctx.me.username, url) }).catch(() => {});
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
    // A Stars payment confirmation must always reach the payment handler.
    if (ctx.message.successful_payment) return next();
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
      await markVerified(ctx.from!.id);
      await payReferral(ctx, ctx.from!.id);
      if (GAME_DM.test(ctx.message.text ?? "")) return next(); // verified users may use the game commands in DM
      const { url } = await liveLink(ctx.chat.id);
      const wantsLive = /^\/(live|livevoice|vc|voicechat|call)\b|^\/start(@\w+)?\s+live\b/i.test(ctx.message.text ?? "");
      await ctx.reply(wantsLive ? "🎙️ Myra se live baat karne ke liye neeche wala button dabao 💕" : VERIFIED_TEXT, {
        reply_markup: addKeyboard(ctx.me.username, url),
      });
    } else {
      const toJoin = [...r.missing, ...r.unknown];
      await ctx.reply(promptText(toJoin), { reply_markup: joinKeyboard(toJoin), link_preview_options: { is_disabled: true } });
    }
  });
}
