import { InputFile, type Api, type Bot, type Context } from "grammy";
import { welcomeBanner } from "./banner.js";
import { deleteLater, raidCheck, startCaptcha, typeLock } from "./modplus.js";
import { getJSON, setJSON } from "./store.js";

// ---------- Settings (persisted per chat) ----------
export type ChatCfg = {
  antilink: boolean; // legacy flag, no longer used: it was switched on by default in every group
  linkFilter?: boolean; // links are deleted only when a group admin switched this on with /antilink on (default off)
  antiabuse: boolean;
  antiflood: boolean;
  warnLimit: number;
  action: "ban" | "mute";
  badwords: string[];
  welcome: boolean;
  banner?: boolean; // send the welcome as a picture with the member photo (default on)
  autoapprove?: boolean; // approve join requests automatically (default on)
  rules: string;
  warns: Record<string, number>;
  daily?: { summary?: boolean; greet?: boolean; chatters?: boolean }; // scheduled posts, set with /daily
  // --- modplus.ts ---
  captcha?: boolean; // new members stay muted until they press a button
  locks?: string[]; // message types deleted for non-admins: sticker, gif, photo, ...
  logChannel?: number; // moderation actions are copied here
  welcomeText?: string; // custom welcome with {name} {mention} {group} {count}
  welcomeDelete?: number; // seconds after which the welcome message is removed
  antiraid?: { on: boolean; joins: number; secs: number };
  blocklist?: { pattern: string; action: "delete" | "warn" | "mute" | "kick" | "ban" }[];
  notes?: Record<string, string>;
  filters?: Record<string, string>;
};

const DEFAULT_BADWORDS = [
  "madarchod", "bhenchod", "behenchod", "chutiya", "chutiye", "gandu", "randi", "harami", "bhosdike", "bsdk",
  "lund", "lauda", "gaand", "mc", "bc", "fuck", "fucker", "bitch", "asshole", "bastard", "slut",
];

// One blob per chat ("m/<chatId>"). loadCfg() runs at the start of every update, so cfg() can stay synchronous.
const loaded = new Map<string, ChatCfg>();

async function loadCfg(chatId: number) {
  const k = String(chatId);
  loaded.set(k, (await getJSON<ChatCfg>(`m/${k}`)) ?? {
    antilink: false, antiabuse: true, antiflood: true, warnLimit: 3, action: "ban",
    badwords: [...DEFAULT_BADWORDS], welcome: true, rules: "", warns: {},
  });
}

const save = (chatId: number) => {
  const c = loaded.get(String(chatId));
  if (c) void setJSON(`m/${chatId}`, c);
};

function cfg(chatId: number): ChatCfg {
  const c = loaded.get(String(chatId));
  if (!c) throw new Error(`moderation config for ${chatId} not loaded`);
  return c;
}

// ---------- Helpers ----------
export const isGroup = (ctx: Context) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const mention = (id: number, name: string) => `<a href="tg://user?id=${id}">${esc(name)}</a>`;

const adminCache = new Map<number, { at: number; ids: Set<number> }>();
const ANONYMOUS_ADMIN_BOT = 1087968824; // "Group" sender id when an admin posts anonymously

/**
 * Is this person an admin of the current group? Works even when Myra herself is not an admin there:
 * getChatMember is only reliable for admin bots, getChatAdministrators works for any bot that is in the group.
 */
async function isAdmin(ctx: Context, userId: number): Promise<boolean> {
  const chatId = ctx.chat!.id;
  // An admin writing anonymously ("as the group") arrives with the sender chat of the group itself.
  if (userId === ctx.from?.id && (userId === ANONYMOUS_ADMIN_BOT || ctx.message?.sender_chat?.id === chatId)) return true;
  let hit = adminCache.get(chatId);
  if (!hit || Date.now() - hit.at > 30_000) {
    try {
      const list = await ctx.api.getChatAdministrators(chatId);
      hit = { at: Date.now(), ids: new Set(list.map((a) => a.user.id)) };
      adminCache.set(chatId, hit);
    } catch (e: any) {
      console.error(`getChatAdministrators(${chatId}) failed:`, e?.description ?? e);
      return false;
    }
  }
  return hit.ids.has(userId);
}

/** Gate for admin-only commands. Returns false (and tells the user why) when the caller can't use it. */
export async function guard(ctx: Context): Promise<boolean> {
  if (!isGroup(ctx)) {
    await ctx.reply("Ye command group mein use karo jaan 🙈");
    return false;
  }
  if (!ctx.from || !(await isAdmin(ctx, ctx.from.id))) {
    await ctx.reply("Ye sirf admins kar sakte hain 😒");
    return false;
  }
  return true;
}

type Target = { id: number; name: string };
function target(ctx: Context, arg: string): Target | null {
  const r = ctx.message?.reply_to_message?.from;
  if (r) return { id: r.id, name: r.first_name };
  const ent = ctx.message?.entities?.find((e) => e.type === "text_mention");
  if (ent && "user" in ent && ent.user) return { id: ent.user.id, name: ent.user.first_name };
  const num = arg.match(/-?\d{5,}/)?.[0];
  if (num) return { id: Number(num), name: num };
  return null;
}

async function needTarget(ctx: Context, arg: string): Promise<Target | null> {
  const t = target(ctx, arg);
  if (!t) {
    await ctx.reply("Kisi ke message ka reply karke command do (ya user ID likho) 🙂");
    return null;
  }
  if (t.id === ctx.me.id) {
    await ctx.reply("Mujhe? Main kyun? 😤");
    return null;
  }
  if (await isAdmin(ctx, t.id)) {
    await ctx.reply("Admin ko main kuch nahi kar sakti 🙄");
    return null;
  }
  return t;
}

export const MUTED = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false,
  can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false,
  can_send_other_messages: false, can_add_web_page_previews: false,
};
export const OPEN = Object.fromEntries(Object.keys(MUTED).map((k) => [k, true])) as typeof MUTED;

export const html = { parse_mode: "HTML" as const };

/** Copies a moderation action to the group's log channel (/setlog), if one is set. Never throws. */
export async function modLog(ctx: Context, text: string) {
  const ch = loaded.get(String(ctx.chat?.id))?.logChannel;
  if (!ch) return;
  const group = esc((ctx.chat as any)?.title ?? String(ctx.chat?.id));
  const by = ctx.from ? ` | by ${mention(ctx.from.id, ctx.from.first_name)}` : "";
  await ctx.api
    .sendMessage(ch, `📝 <b>${group}</b>${by}\n${text}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
    .catch((e) => console.error("mod log failed:", e?.description ?? e));
}

export async function punish(ctx: Context, userId: number, name: string, action: "ban" | "mute", minutes = 0) {
  if (action === "ban") {
    await ctx.banChatMember(userId);
    await modLog(ctx, `🚫 Ban: ${mention(userId, name)} (${userId})`);
    return `${mention(userId, name)} ko ban kar diya 🚫`;
  }
  const until = minutes > 0 ? Math.floor(Date.now() / 1000) + minutes * 60 : 0;
  await ctx.restrictChatMember(userId, MUTED, until ? { until_date: until } : undefined);
  await modLog(ctx, `🔇 Mute${minutes ? ` (${minutes} min)` : ""}: ${mention(userId, name)} (${userId})`);
  return `${mention(userId, name)} ko mute kar diya 🔇${minutes ? ` (${minutes} min)` : ""}`;
}

/** Adds a warning; at the limit applies the configured action and resets the count. */
export async function addWarn(ctx: Context, userId: number, name: string, reason: string) {
  await modLog(ctx, `⚠️ Warn: ${mention(userId, name)} (${userId}): ${esc(reason)}`);
  const c = cfg(ctx.chat!.id);
  const n = (c.warns[userId] = (c.warns[userId] ?? 0) + 1);
  if (n >= c.warnLimit) {
    c.warns[userId] = 0;
    save(ctx.chat!.id);
    try {
      const msg = await punish(ctx, userId, name, c.action, c.action === "mute" ? 60 : 0);
      await ctx.reply(`${msg}\nWajah: ${esc(reason)} (${c.warnLimit}/${c.warnLimit} warnings)`, html);
    } catch (e) {
      console.error("auto-punish failed:", e);
      await ctx.reply("Main isse ban/mute nahi kar pa rahi, mujhe admin banao (ban wali permission ke saath) 🥺");
    }
  } else {
    save(ctx.chat!.id);
    await ctx.reply(`⚠️ ${mention(userId, name)}, warning ${n}/${c.warnLimit}: ${esc(reason)}`, html);
  }
}

/** The member's current profile photo (small size), or null if they have none or hide it. */
async function profilePhoto(api: Api, userId: number): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const photos = await api.getUserProfilePhotos(userId, { limit: 1 });
    const sizes = photos.photos[0];
    if (!sizes?.length) return null;
    const pick = sizes.find((s) => s.width >= 300) ?? sizes[sizes.length - 1];
    const file = await api.getFile(pick.file_id);
    if (!file.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
    if (!res.ok) return null;
    return { data: Buffer.from(await res.arrayBuffer()), mime: "image/jpeg" };
  } catch {
    return null;
  }
}

/** Fills {name} {mention} {group} {count} {username} in a custom welcome text (the rest is HTML-escaped). */
export function fillWelcome(t: string, u: { id: number; first_name: string; username?: string }, group: string, count: number | null) {
  return esc(t)
    .replace(/\{mention\}/g, mention(u.id, u.first_name))
    .replace(/\{name\}/g, esc(u.first_name))
    .replace(/\{username\}/g, u.username ? "@" + esc(u.username) : esc(u.first_name))
    .replace(/\{group\}/g, esc(group))
    .replace(/\{count\}/g, count === null ? "" : String(count));
}

/**
 * Welcome for one member: a banner picture (when allowed) or text; honours /setwelcome and /welcomedelete.
 * Works from the bot api, so it can also run from a button press (captcha), not only from the join update.
 */
export async function sendWelcome(
  api: Api,
  chatId: number,
  group: string,
  u: { id: number; first_name: string; last_name?: string; username?: string },
  allowBanner = true,
) {
  const c = loaded.get(String(chatId));
  if (!c || !c.welcome) return;
  const count = await api.getChatMemberCount(chatId).catch(() => null);
  const text = c.welcomeText
    ? fillWelcome(c.welcomeText, u, group, count)
    : `Welcome ${mention(u.id, u.first_name)} 🥰` + (c.rules ? " Group ke rules ke liye /rules dekh lo, aur mast raho!" : " Mast raho!");
  let sent: { message_id: number } | null = null;
  if (c.banner !== false && allowBanner) {
    try {
      const png = await welcomeBanner({
        name: [u.first_name, u.last_name].filter(Boolean).join(" "),
        group,
        avatar: await profilePhoto(api, u.id),
        memberNo: count,
      });
      sent = await api.sendPhoto(chatId, new InputFile(png, "welcome.png"), { caption: text, ...html });
    } catch (e) {
      console.error("welcome banner failed, sending text:", e);
    }
  }
  sent ??= await api.sendMessage(chatId, text, html).catch(() => null);
  if (sent && c.welcomeDelete) await deleteLater(chatId, sent.message_id, c.welcomeDelete);
}

// ---------- Auto moderation ----------
const URL_RE = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|\b[a-z0-9-]+\.(com|in|net|org|xyz|me|io|ly|link|club|top|shop|site)\b)/i;

/** Recent message times per user, in a blob (functions are stateless, so a Map would never see 6 messages). */
async function floodCount(chatId: number, userId: number): Promise<number> {
  const key = `f/${chatId}:${userId}`;
  const now = Date.now();
  const arr = ((await getJSON<number[]>(key)) ?? []).filter((t) => now - t < 8000);
  arr.push(now);
  await setJSON(key, arr.length >= 6 ? [] : arr);
  return arr.length;
}

// Always checked, on top of the group's own /addword list (older groups keep a stale copy of the defaults).
// Single words are matched as whole words, so "Gandhi" or "Sugandh" are fine; phrases are matched as word sequences.
const BUILTIN_BAD = [
  "gand", "gaand", "gandu", "gandwa", "gandmara", "gandmarao", "bhosda", "bhosdi", "bhosdika", "bhosdike", "bhosdiwala", "chutad", "chut", "chutiya",
  "chutiye", "lawda", "lauda", "lund", "loda", "randwa", "raand", "madarchod", "mader", "maderchod", "bhenchod", "behnchod",
  "behenchod", "bkl", "bsdk", "mkc", "bkc", "tmkc", "harami", "haramkhor", "kutta", "kutti", "kamina", "kameena",
  "gand mara", "gand marao", "gand mar", "gand maar", "lund le", "teri maa ki", "teri behen ki", "maa chod", "behen chod",
];

/** Lowercase, undo look-alike digits/symbols (g4nd, g@nd), and squeeze repeated letters (gaaand -> gand). */
function squash(s: string): string {
  return s
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/[@4]/g, "a")
    .replace(/0/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/\$/g, "s")
    .replace(/([\p{L}])\1+/gu, "$1");
}

function hasBadWord(text: string, words: string[]): string | null {
  const tokens = squash(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length) return null;
  const joined = " " + tokens.join(" ") + " ";
  const single = new Set<string>();
  const phrases: string[] = [];
  for (const w of [...BUILTIN_BAD, ...words]) {
    const n = squash(w).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (n.length === 1) single.add(n[0]);
    else if (n.length > 1) phrases.push(" " + n.join(" ") + " ");
  }
  return tokens.find((t) => single.has(t)) ?? phrases.find((p) => joined.includes(p))?.trim() ?? null;
}

const modRights = new Map<number, { at: number; ok: boolean }>();

/**
 * Auto-moderation only makes sense where Myra can really delete messages. In a group where she is just a member
 * she would warn people while the message stays, so she stays quiet there until she is made an admin.
 */
export async function botCanModerate(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat!.id;
  const hit = modRights.get(chatId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  let ok = false;
  try {
    const m = await ctx.api.getChatMember(chatId, ctx.me.id);
    ok = m.status === "administrator" && (m as any).can_delete_messages !== false;
  } catch {}
  modRights.set(chatId, { at: Date.now(), ok });
  return ok;
}

/** A linked channel's post mirrored into its discussion group (sent by Telegram's service account, not a member). */
export function isChannelRelay(ctx: Context): boolean {
  const m: any = ctx.message;
  return !!m && (m.is_automatic_forward === true || ctx.from?.id === 777000 || ctx.from?.id === 136817688);
}

async function autoMod(ctx: Context): Promise<boolean> {
  if (!isGroup(ctx) || !ctx.from || !ctx.message || isChannelRelay(ctx)) return false;
  if (ctx.from.is_bot || !(await botCanModerate(ctx)) || (await isAdmin(ctx, ctx.from.id))) return false;
  const c = cfg(ctx.chat!.id);
  const text = ctx.message.text ?? ctx.message.caption ?? "";
  const name = ctx.from.first_name;
  const del = () => ctx.deleteMessage().catch(() => {});

  if (c.antiflood) {
    if ((await floodCount(ctx.chat!.id, ctx.from.id)) >= 6) {
      await del();
      try {
        const msg = await punish(ctx, ctx.from.id, name, "mute", 10);
        await ctx.reply(`${msg}\nWajah: spam/flood`, html);
      } catch {}
      return true;
    }
  }
  if (c.antiabuse) {
    const w = hasBadWord(text, c.badwords);
    if (w) {
      await del();
      await addWarn(ctx, ctx.from.id, name, "gaali/abusive language");
      return true;
    }
  }
  if (c.linkFilter === true && URL_RE.test(text)) {
    await del();
    await addWarn(ctx, ctx.from.id, name, "links allowed nahi hain");
    return true;
  }
  return false;
}

// ---------- Command registration ----------
export const MOD_MENU = [
  { command: "ban", description: "User ko ban karo (reply karke)" },
  { command: "unban", description: "User ko unban karo" },
  { command: "kick", description: "User ko nikalo (wapas aa sakta hai)" },
  { command: "mute", description: "Mute: /mute [minutes]" },
  { command: "unmute", description: "User ko unmute karo" },
  { command: "warn", description: "Warning do: /warn [wajah]" },
  { command: "unwarn", description: "Ek warning hatao" },
  { command: "warns", description: "User ki warnings dekho" },
  { command: "resetwarns", description: "Saari warnings hatao" },
  { command: "setwarn", description: "Warn limit: /setwarn 3" },
  { command: "modaction", description: "Limit par ban ya mute: /modaction ban" },
  { command: "del", description: "Reply kiya msg delete karo" },
  { command: "pin", description: "Reply kiya msg pin karo" },
  { command: "unpin", description: "Pin hatao" },
  { command: "lock", description: "Group lock (sirf admins bol sakein)" },
  { command: "unlock", description: "Group unlock" },
  { command: "antilink", description: "Link filter on/off" },
  { command: "antiabuse", description: "Gaali filter on/off" },
  { command: "antiflood", description: "Spam filter on/off" },
  { command: "addword", description: "Banned word jodo" },
  { command: "delword", description: "Banned word hatao" },
  { command: "badwords", description: "Banned words ki list" },
  { command: "welcome", description: "Welcome msg on/off" },
  { command: "autoapprove", description: "Join request auto-approve on/off" },
  { command: "setrules", description: "Group rules set karo" },
  { command: "rules", description: "Group rules dekho" },
  { command: "admins", description: "Admins ki list" },
  { command: "report", description: "Reply karke admins ko report karo" },
  { command: "modsettings", description: "Moderation settings dekho" },
  { command: "setgroup", description: "Required group jodo (promotion)" },
  { command: "addbotadmin", description: "Kisi ko bot admin banao (sirf owner)" },
  { command: "removebotadmin", description: "Bot admin hatao (sirf owner)" },
  { command: "botadmins", description: "Bot admins ki list (sirf owner)" },
  { command: "captcha", description: "Naye member ke liye captcha on/off" },
  { command: "locks", description: "Locks: /lock sticker gif link ..." },
  { command: "setlog", description: "Mod log channel set karo" },
  { command: "antiraid", description: "Raid hone par group auto-lock" },
  { command: "addblock", description: "Blocklist pattern: /addblock *casino* ban" },
  { command: "save", description: "Note save karo: /save naam text" },
  { command: "filter", description: "Keyword auto-reply: /filter shabd jawab" },
  { command: "setwelcome", description: "Custom welcome text" },
  { command: "keys", description: "Gemini keys ki list (owner)" },
  { command: "setchannel", description: "Required channel jodo (promotion)" },
  { command: "groups", description: "Required groups/channels ki list" },
  { command: "users", description: "Kitne log bot use kar rahe hain" },
  { command: "stats", description: "Users, verified, active aur group growth" },
  { command: "removegroup", description: "Required group hatao" },
  { command: "cleargroup", description: "Saare required groups hatao" },
];

const onOff = (a: string) => (/^(on|yes|1|true|haan)$/i.test(a) ? true : /^(off|no|0|false|nahi)$/i.test(a) ? false : null);

export function registerModeration(bot: Bot) {
  // Run before everything else: delete/warn offending messages and stop further handling.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") await loadCfg(ctx.chat.id);
    if (ctx.message && (await autoMod(ctx))) return;
    await next();
  });

  bot.on("message:new_chat_members", async (ctx) => {
    if (!isGroup(ctx)) return;
    const c = cfg(ctx.chat.id);
    const people = ctx.message.new_chat_members.filter((u) => !u.is_bot);
    if (people.length) await raidCheck(ctx, people.length); // many joins within seconds: lock the group
    for (const u of people) {
      // With captcha on, the welcome is sent after the member proves they are human.
      if (c.captcha && (await startCaptcha(ctx, u))) continue;
      if (c.welcome) await sendWelcome(ctx.api, ctx.chat.id, (ctx.chat as any).title ?? "this group", u, people.length <= 3);
    }
  });

  // Private / approval-required groups: Myra approves join requests herself (needs "Invite users" admin right).
  bot.on("chat_join_request", async (ctx, next) => {
    const req = ctx.chatJoinRequest;
    if (cfg(req.chat.id).autoapprove === false) return next();
    try {
      await ctx.api.approveChatJoinRequest(req.chat.id, req.from.id);
    } catch (e: any) {
      console.error(`approve join request failed in ${req.chat.id}:`, e?.description ?? e);
      return next();
    }
    // The user can be messaged for a few minutes after requesting; tell them they are in.
    await ctx.api
      .sendMessage(req.user_chat_id, `✅ ${(req.chat as any).title ?? "Group"} mein tumhari request approve ho gayi. Welcome 🥰`)
      .catch(() => {});
    return next();
  });

  const cmd = (name: string, fn: (ctx: Context, arg: string) => Promise<unknown>) =>
    bot.command(name, async (ctx) => {
      try {
        await fn(ctx, String(ctx.match ?? "").trim());
      } catch (e: any) {
        const why = String(e?.description ?? e?.message ?? e);
        console.error(`/${name} failed:`, why);
        const hint = /not enough rights|CHAT_ADMIN_REQUIRED|administrator rights/i.test(why)
          ? "Bot ke paas is kaam ki permission nahi hai. Group → Administrators → Myra → 'Ban users' ON karo."
          : /user not found|PARTICIPANT_ID_INVALID|USER_ID_INVALID/i.test(why)
            ? "Ye user ID sahi nahi lag raha. /id se pakki ID nikalo."
            : /can't remove chat owner|owner/i.test(why)
              ? "Group owner par ye nahi chal sakta."
              : "Telegram ne ye kaam mana kar diya.";
        await ctx.reply(`Ye nahi ho paya 🥺\n${hint}\n\nTelegram ka reason: ${why.slice(0, 200)}`).catch(() => {});
      }
    });

  cmd("ban", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = await needTarget(ctx, arg);
    if (!t) return;
    await ctx.reply(await punish(ctx, t.id, t.name, "ban"), html);
  });

  cmd("unban", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = target(ctx, arg);
    if (!t) return void (await ctx.reply("Reply karke ya user ID likho 🙂"));
    await ctx.unbanChatMember(t.id, { only_if_banned: true });
    await modLog(ctx, `✅ Unban: ${mention(t.id, t.name)} (${t.id})`);
    await ctx.reply(`${mention(t.id, t.name)} unban ho gaya ✅`, html);
  });

  cmd("kick", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = await needTarget(ctx, arg);
    if (!t) return;
    await ctx.banChatMember(t.id);
    await ctx.unbanChatMember(t.id);
    await modLog(ctx, `👢 Kick: ${mention(t.id, t.name)} (${t.id})`);
    await ctx.reply(`${mention(t.id, t.name)} ko group se nikaal diya 👢`, html);
  });

  cmd("mute", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = await needTarget(ctx, arg);
    if (!t) return;
    const mins = Number(arg.replace(/-?\d{5,}/, "").match(/\d+/)?.[0] ?? 0);
    await ctx.reply(await punish(ctx, t.id, t.name, "mute", mins), html);
  });

  cmd("unmute", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = target(ctx, arg);
    if (!t) return void (await ctx.reply("Reply karke ya user ID likho 🙂"));
    await ctx.restrictChatMember(t.id, OPEN);
    await ctx.reply(`${mention(t.id, t.name)} ab bol sakta hai 🔊`, html);
  });

  cmd("warn", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = await needTarget(ctx, arg);
    if (!t) return;
    const reason = arg.replace(/-?\d{5,}/, "").trim() || "rules todne ke liye";
    await addWarn(ctx, t.id, t.name, reason);
  });

  cmd("unwarn", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = target(ctx, arg);
    if (!t) return void (await ctx.reply("Reply karke ya user ID likho 🙂"));
    const c = cfg(ctx.chat!.id);
    c.warns[t.id] = Math.max(0, (c.warns[t.id] ?? 0) - 1);
    save(ctx.chat!.id);
    await ctx.reply(`${mention(t.id, t.name)}: ab ${c.warns[t.id]}/${c.warnLimit} warnings ✅`, html);
  });

  cmd("resetwarns", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = target(ctx, arg);
    if (!t) return void (await ctx.reply("Reply karke ya user ID likho 🙂"));
    cfg(ctx.chat!.id).warns[t.id] = 0;
    save(ctx.chat!.id);
    await ctx.reply(`${mention(t.id, t.name)} ki saari warnings hata di ✅`, html);
  });

  cmd("warns", async (ctx, arg) => {
    if (!isGroup(ctx)) return void (await ctx.reply("Ye group mein use karo 🙈"));
    const t = target(ctx, arg) ?? { id: ctx.from!.id, name: ctx.from!.first_name };
    const c = cfg(ctx.chat!.id);
    await ctx.reply(`${mention(t.id, t.name)}: ${c.warns[t.id] ?? 0}/${c.warnLimit} warnings`, html);
  });

  cmd("setwarn", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > 20) return void (await ctx.reply("1 se 20 ke beech number do: /setwarn 3"));
    cfg(ctx.chat!.id).warnLimit = n;
    save(ctx.chat!.id);
    await ctx.reply(`Ab ${n} warnings par action hoga ✅`);
  });

  cmd("modaction", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    if (arg !== "ban" && arg !== "mute") return void (await ctx.reply("/modaction ban  ya  /modaction mute"));
    cfg(ctx.chat!.id).action = arg;
    save(ctx.chat!.id);
    await ctx.reply(`Warn limit par ab ${arg} hoga ✅`);
  });

  cmd("del", async (ctx) => {
    if (!(await guard(ctx))) return;
    const r = ctx.message?.reply_to_message;
    if (!r) return void (await ctx.reply("Jis msg ko delete karna hai uska reply karke /del likho"));
    await ctx.api.deleteMessage(ctx.chat!.id, r.message_id);
    await ctx.deleteMessage().catch(() => {});
  });

  cmd("pin", async (ctx) => {
    if (!(await guard(ctx))) return;
    const r = ctx.message?.reply_to_message;
    if (!r) return void (await ctx.reply("Pin karne wale msg ka reply karke /pin likho"));
    await ctx.api.pinChatMessage(ctx.chat!.id, r.message_id);
  });

  cmd("unpin", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.api.unpinChatMessage(ctx.chat!.id, ctx.message?.reply_to_message?.message_id);
    await ctx.reply("Pin hata diya 📌");
  });

  cmd("lock", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    if (arg) return typeLock(ctx, arg, true); // /lock sticker gif: per message type
    await ctx.api.setChatPermissions(ctx.chat!.id, MUTED);
    await ctx.reply("Group lock ho gaya 🔒 ab sirf admins bol sakte hain");
  });

  cmd("unlock", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    if (arg) return typeLock(ctx, arg, false);
    await ctx.api.setChatPermissions(ctx.chat!.id, OPEN);
    await ctx.reply("Group unlock ho gaya 🔓");
  });

  for (const [name, key, label] of [
    ["antilink", "linkFilter", "Link filter (links delete honge)"],
    ["antiabuse", "antiabuse", "Gaali filter"],
    ["antiflood", "antiflood", "Spam/flood filter"],
    ["welcome", "welcome", "Welcome message"],
    ["welcomebanner", "banner", "Welcome banner (photo)"],
    ["autoapprove", "autoapprove", "Join request auto-approve"],
  ] as const) {
    cmd(name, async (ctx, arg) => {
      if (!(await guard(ctx))) return;
      const v = onOff(arg);
      if (v === null) return void (await ctx.reply(`/${name} on  ya  /${name} off`));
      cfg(ctx.chat!.id)[key] = v;
      save(ctx.chat!.id);
      await ctx.reply(`${label} ab ${v ? "ON ✅" : "OFF ❌"}`);
    });
  }

  cmd("addword", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const w = arg.toLowerCase().split(/\s+/)[0];
    if (!w) return void (await ctx.reply("/addword shabd"));
    const c = cfg(ctx.chat!.id);
    if (!c.badwords.includes(w)) c.badwords.push(w);
    save(ctx.chat!.id);
    await ctx.reply(`"${esc(w)}" ab banned hai 🚫`);
  });

  cmd("delword", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const w = arg.toLowerCase().split(/\s+/)[0];
    const c = cfg(ctx.chat!.id);
    c.badwords = c.badwords.filter((x) => x !== w);
    save(ctx.chat!.id);
    await ctx.reply(`"${esc(w)}" list se hata diya ✅`);
  });

  cmd("badwords", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.reply(`Banned words (${cfg(ctx.chat!.id).badwords.length}):\n${cfg(ctx.chat!.id).badwords.join(", ")}`);
  });

  cmd("setrules", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    if (!arg) return void (await ctx.reply("/setrules aapke rules yahan likho"));
    cfg(ctx.chat!.id).rules = arg;
    save(ctx.chat!.id);
    await ctx.reply("Rules save ho gaye ✅");
  });

  cmd("rules", async (ctx) => {
    if (!isGroup(ctx)) return void (await ctx.reply("Ye group mein use karo 🙈"));
    const r = cfg(ctx.chat!.id).rules;
    await ctx.reply(r ? `📜 Group Rules:\n\n${r}` : "Abhi is group ke rules set nahi hain.");
  });

  cmd("admins", async (ctx) => {
    if (!isGroup(ctx)) return void (await ctx.reply("Ye group mein use karo 🙈"));
    const list = await ctx.api.getChatAdministrators(ctx.chat!.id);
    await ctx.reply(
      "👮 Admins:\n" + list.filter((a) => !a.user.is_bot).map((a) => `• ${mention(a.user.id, a.user.first_name)}`).join("\n"),
      html,
    );
  });

  cmd("report", async (ctx) => {
    if (!isGroup(ctx)) return void (await ctx.reply("Ye group mein use karo 🙈"));
    const r = ctx.message?.reply_to_message;
    if (!r?.from) return void (await ctx.reply("Jis msg ki report karni hai uska reply karke /report likho"));
    const admins = (await ctx.api.getChatAdministrators(ctx.chat!.id)).filter((a) => !a.user.is_bot);
    await ctx.reply(
      `🚨 ${admins.map((a) => mention(a.user.id, "admin")).join(" ")} — ${mention(ctx.from!.id, ctx.from!.first_name)} ne ${mention(r.from.id, r.from.first_name)} ke msg ki report ki hai.`,
      { ...html, reply_parameters: { message_id: r.message_id } },
    );
  });

  cmd("modsettings", async (ctx) => {
    if (!(await guard(ctx))) return;
    const c = cfg(ctx.chat!.id);
    const f = (b: boolean) => (b ? "ON ✅" : "OFF ❌");
    await ctx.reply(
      `⚙️ Moderation settings\n\nLink filter: ${f(c.linkFilter === true)} (links ${c.linkFilter === true ? "delete hote hain" : "allowed hain"})\nGaali filter: ${f(c.antiabuse)}\nSpam filter: ${f(c.antiflood)}\nWelcome: ${f(c.welcome)}\nWarn limit: ${c.warnLimit}\nLimit par action: ${c.action}\nBanned words: ${c.badwords.length}`,
    );
  });
}

// ---------- used by daily.ts (scheduled posts) ----------
/** Config of the chat the current update belongs to (loaded by the first middleware of registerModeration). */
export const chatCfg = (chatId: number) => cfg(chatId);
export const saveChatCfg = (chatId: number) => save(chatId);
export const isChatAdmin = (ctx: Context, userId: number) => isAdmin(ctx, userId);
