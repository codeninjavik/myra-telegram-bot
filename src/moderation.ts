import { readFileSync, writeFileSync } from "node:fs";
import type { Bot, Context } from "grammy";

// ---------- Settings (persisted per chat) ----------
type ChatCfg = {
  antilink: boolean;
  antiabuse: boolean;
  antiflood: boolean;
  warnLimit: number;
  action: "ban" | "mute";
  badwords: string[];
  welcome: boolean;
  autoapprove?: boolean; // approve join requests automatically (default on)
  rules: string;
  warns: Record<string, number>;
};

const FILE = "modstate.json";
const DEFAULT_BADWORDS = [
  "madarchod", "bhenchod", "behenchod", "chutiya", "chutiye", "gandu", "randi", "harami", "bhosdike", "bsdk",
  "lund", "lauda", "gaand", "mc", "bc", "fuck", "fucker", "bitch", "asshole", "bastard", "slut",
];

const state: Record<string, ChatCfg> = (() => {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
})();

const save = () => {
  try {
    writeFileSync(FILE, JSON.stringify(state));
  } catch (e) {
    console.error("modstate save failed:", e);
  }
};

function cfg(chatId: number): ChatCfg {
  const k = String(chatId);
  state[k] ??= {
    antilink: true, antiabuse: true, antiflood: true, warnLimit: 3, action: "ban",
    badwords: [...DEFAULT_BADWORDS], welcome: true, rules: "", warns: {},
  };
  return state[k];
}

// ---------- Helpers ----------
const isGroup = (ctx: Context) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mention = (id: number, name: string) => `<a href="tg://user?id=${id}">${esc(name)}</a>`;

const adminCache = new Map<string, { at: number; admin: boolean }>();
async function isAdmin(ctx: Context, userId: number): Promise<boolean> {
  const key = `${ctx.chat!.id}:${userId}`;
  const hit = adminCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.admin;
  try {
    const m = await ctx.api.getChatMember(ctx.chat!.id, userId);
    const admin = m.status === "administrator" || m.status === "creator";
    adminCache.set(key, { at: Date.now(), admin });
    return admin;
  } catch {
    return false;
  }
}

/** Gate for admin-only commands. Returns false (and tells the user why) when the caller can't use it. */
async function guard(ctx: Context): Promise<boolean> {
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

const MUTED = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false,
  can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false,
  can_send_other_messages: false, can_add_web_page_previews: false,
};
const OPEN = Object.fromEntries(Object.keys(MUTED).map((k) => [k, true])) as typeof MUTED;

const html = { parse_mode: "HTML" as const };

async function punish(ctx: Context, userId: number, name: string, action: "ban" | "mute", minutes = 0) {
  if (action === "ban") {
    await ctx.banChatMember(userId);
    return `${mention(userId, name)} ko ban kar diya 🚫`;
  }
  const until = minutes > 0 ? Math.floor(Date.now() / 1000) + minutes * 60 : 0;
  await ctx.restrictChatMember(userId, MUTED, until ? { until_date: until } : undefined);
  return `${mention(userId, name)} ko mute kar diya 🔇${minutes ? ` (${minutes} min)` : ""}`;
}

/** Adds a warning; at the limit applies the configured action and resets the count. */
async function addWarn(ctx: Context, userId: number, name: string, reason: string) {
  const c = cfg(ctx.chat!.id);
  const n = (c.warns[userId] = (c.warns[userId] ?? 0) + 1);
  if (n >= c.warnLimit) {
    c.warns[userId] = 0;
    save();
    try {
      const msg = await punish(ctx, userId, name, c.action, c.action === "mute" ? 60 : 0);
      await ctx.reply(`${msg}\nWajah: ${esc(reason)} (${c.warnLimit}/${c.warnLimit} warnings)`, html);
    } catch (e) {
      console.error("auto-punish failed:", e);
      await ctx.reply("Main isse ban/mute nahi kar pa rahi, mujhe admin banao (ban wali permission ke saath) 🥺");
    }
  } else {
    save();
    await ctx.reply(`⚠️ ${mention(userId, name)}, warning ${n}/${c.warnLimit}: ${esc(reason)}`, html);
  }
}

// ---------- Auto moderation ----------
const URL_RE = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|\b[a-z0-9-]+\.(com|in|net|org|xyz|me|io|ly|link|club|top|shop|site)\b)/i;
const flood = new Map<string, number[]>();

function hasBadWord(text: string, words: string[]): string | null {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const set = new Set(words.map((w) => w.toLowerCase()));
  return tokens.find((t) => set.has(t)) ?? null;
}

async function autoMod(ctx: Context): Promise<boolean> {
  if (!isGroup(ctx) || !ctx.from || !ctx.message) return false;
  if (ctx.from.is_bot || (await isAdmin(ctx, ctx.from.id))) return false;
  const c = cfg(ctx.chat!.id);
  const text = ctx.message.text ?? ctx.message.caption ?? "";
  const name = ctx.from.first_name;
  const del = () => ctx.deleteMessage().catch(() => {});

  if (c.antiflood) {
    const key = `${ctx.chat!.id}:${ctx.from.id}`;
    const now = Date.now();
    const arr = (flood.get(key) ?? []).filter((t) => now - t < 8000);
    arr.push(now);
    flood.set(key, arr);
    if (arr.length >= 6) {
      flood.delete(key);
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
  if (c.antilink && URL_RE.test(text)) {
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
  { command: "groups", description: "Required groups ki list" },
  { command: "stats", description: "Users, verified, active aur group growth" },
  { command: "removegroup", description: "Required group hatao" },
  { command: "cleargroup", description: "Saare required groups hatao" },
];

const onOff = (a: string) => (/^(on|yes|1|true|haan)$/i.test(a) ? true : /^(off|no|0|false|nahi)$/i.test(a) ? false : null);

export function registerModeration(bot: Bot) {
  // Run before everything else: delete/warn offending messages and stop further handling.
  bot.use(async (ctx, next) => {
    if (ctx.message && (await autoMod(ctx))) return;
    await next();
  });

  bot.on("message:new_chat_members", async (ctx) => {
    if (!isGroup(ctx)) return;
    const c = cfg(ctx.chat.id);
    if (!c.welcome) return;
    for (const u of ctx.message.new_chat_members) {
      if (u.is_bot) continue;
      await ctx.reply(
        `Welcome ${mention(u.id, u.first_name)} 🥰 Group ke rules ke liye /rules dekh lo, aur mast raho!`,
        html,
      );
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
        console.error(`/${name} failed:`, e?.description ?? e);
        await ctx.reply("Ye nahi ho paya. Mujhe group mein admin banao aur zaroori permissions (ban, delete, pin) do 🥺").catch(() => {});
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
    await ctx.reply(`${mention(t.id, t.name)} unban ho gaya ✅`, html);
  });

  cmd("kick", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = await needTarget(ctx, arg);
    if (!t) return;
    await ctx.banChatMember(t.id);
    await ctx.unbanChatMember(t.id);
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
    save();
    await ctx.reply(`${mention(t.id, t.name)}: ab ${c.warns[t.id]}/${c.warnLimit} warnings ✅`, html);
  });

  cmd("resetwarns", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const t = target(ctx, arg);
    if (!t) return void (await ctx.reply("Reply karke ya user ID likho 🙂"));
    cfg(ctx.chat!.id).warns[t.id] = 0;
    save();
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
    save();
    await ctx.reply(`Ab ${n} warnings par action hoga ✅`);
  });

  cmd("modaction", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    if (arg !== "ban" && arg !== "mute") return void (await ctx.reply("/modaction ban  ya  /modaction mute"));
    cfg(ctx.chat!.id).action = arg;
    save();
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

  cmd("lock", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.api.setChatPermissions(ctx.chat!.id, MUTED);
    await ctx.reply("Group lock ho gaya 🔒 ab sirf admins bol sakte hain");
  });

  cmd("unlock", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.api.setChatPermissions(ctx.chat!.id, OPEN);
    await ctx.reply("Group unlock ho gaya 🔓");
  });

  for (const [name, key, label] of [
    ["antilink", "antilink", "Link filter"],
    ["antiabuse", "antiabuse", "Gaali filter"],
    ["antiflood", "antiflood", "Spam/flood filter"],
    ["welcome", "welcome", "Welcome message"],
    ["autoapprove", "autoapprove", "Join request auto-approve"],
  ] as const) {
    cmd(name, async (ctx, arg) => {
      if (!(await guard(ctx))) return;
      const v = onOff(arg);
      if (v === null) return void (await ctx.reply(`/${name} on  ya  /${name} off`));
      cfg(ctx.chat!.id)[key] = v;
      save();
      await ctx.reply(`${label} ab ${v ? "ON ✅" : "OFF ❌"}`);
    });
  }

  cmd("addword", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const w = arg.toLowerCase().split(/\s+/)[0];
    if (!w) return void (await ctx.reply("/addword shabd"));
    const c = cfg(ctx.chat!.id);
    if (!c.badwords.includes(w)) c.badwords.push(w);
    save();
    await ctx.reply(`"${esc(w)}" ab banned hai 🚫`);
  });

  cmd("delword", async (ctx, arg) => {
    if (!(await guard(ctx))) return;
    const w = arg.toLowerCase().split(/\s+/)[0];
    const c = cfg(ctx.chat!.id);
    c.badwords = c.badwords.filter((x) => x !== w);
    save();
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
    save();
    await ctx.reply("Rules save ho gaye ✅");
  });

  cmd("rules", async (ctx) => {
    if (!isGroup(ctx)) return void (await ctx.reply("Ye group mein use karo 🙈"));
    const r = cfg(ctx.chat!.id).rules;
    await ctx.reply(r ? `📜 Group Rules:\n\n${r}` : "Abhi koi rules set nahi hain. Admin /setrules se set kar sakte hain.");
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
      `⚙️ Moderation settings\n\nLink filter: ${f(c.antilink)}\nGaali filter: ${f(c.antiabuse)}\nSpam filter: ${f(c.antiflood)}\nWelcome: ${f(c.welcome)}\nWarn limit: ${c.warnLimit}\nLimit par action: ${c.action}\nBanned words: ${c.badwords.length}`,
    );
  });
}
