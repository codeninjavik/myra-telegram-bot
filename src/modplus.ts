import type { Api, Bot, Context } from "grammy";
import { chatAllowed } from "./gate.js";
import {
  MUTED, OPEN, addWarn, botCanModerate, chatCfg, esc, guard, html, isChannelRelay, isChatAdmin, isGroup, mention, modLog, punish, saveChatCfg, sendWelcome,
} from "./moderation.js";
import { delKey, getJSON, listKeys, setJSON } from "./store.js";

// Rose-style group tools that sit on top of moderation.ts:
// captcha, antiraid, locks, blocklist, notes, filters, custom welcome, mod log channel.
// Scheduled clean-ups (kick unverified, unlock after a raid, delayed deletes) run from sweepModPlus() in scheduler.ts.

type User = { id: number; first_name: string; username?: string };
const CAPTCHA_MIN = 10;
const RAID_LOCK_MIN = 10;
const MAX_ITEMS = 50;

// ---------- delayed delete ----------
export async function deleteLater(chatId: number, messageId: number, afterSec: number) {
  await setJSON(`del/${chatId}/${messageId}`, { at: Date.now() + afterSec * 1000 });
}

// ---------- captcha ----------
/** Mutes the new member and asks for a button press. Returns false when that is not possible (bot not admin). */
export async function startCaptcha(ctx: Context, u: User): Promise<boolean> {
  if (!(await botCanModerate(ctx))) return false;
  try {
    await ctx.restrictChatMember(u.id, MUTED);
    const m = await ctx.reply(
      `${mention(u.id, u.first_name)}, group mein bolne ke liye neeche button dabao (${CAPTCHA_MIN} minute mein, warna hata diya jaoge) 👇`,
      {
        ...html,
        reply_markup: { inline_keyboard: [[{ text: "✅ Main insaan hoon", callback_data: `cap:${u.id}` }]] },
      },
    );
    await setJSON(`cap/${ctx.chat!.id}/${u.id}`, { at: Date.now(), msg: m.message_id, user: u });
    return true;
  } catch (e) {
    console.error("captcha failed:", e);
    return false;
  }
}

// ---------- antiraid ----------
export async function raidCheck(ctx: Context, joined: number) {
  const r = chatCfg(ctx.chat!.id).antiraid;
  if (!r?.on) return;
  const chatId = ctx.chat!.id;
  const now = Date.now();
  const key = `rw/${chatId}`;
  const win = ((await getJSON<number[]>(key)) ?? []).filter((t) => now - t < r.secs * 1000);
  for (let i = 0; i < joined; i++) win.push(now);
  await setJSON(key, win);
  if (win.length < r.joins || (await getJSON(`raid/${chatId}`))) return;
  if (!(await botCanModerate(ctx))) return;
  try {
    await ctx.api.setChatPermissions(chatId, MUTED);
    await setJSON(`raid/${chatId}`, { until: now + RAID_LOCK_MIN * 60_000 });
    await ctx.reply(`🚨 Raid ka shak: ${r.secs} second mein ${win.length} log aaye. Group ${RAID_LOCK_MIN} minute ke liye lock kar diya. Admin /unlock se pehle khol sakte hain.`);
    await modLog(ctx, `🚨 AntiRaid: ${win.length} joins in ${r.secs}s, group locked for ${RAID_LOCK_MIN} min`);
  } catch (e) {
    console.error("antiraid lock failed:", e);
  }
}

// ---------- locks ----------
const hasUrl = (m: any) => [...(m.entities ?? []), ...(m.caption_entities ?? [])].some((e: any) => e.type === "url" || e.type === "text_link");
const LOCKS: Record<string, (m: any) => boolean> = {
  sticker: (m) => !!m.sticker,
  gif: (m) => !!m.animation,
  photo: (m) => !!m.photo,
  video: (m) => !!m.video,
  document: (m) => !!m.document,
  voice: (m) => !!m.voice,
  audio: (m) => !!m.audio,
  videonote: (m) => !!m.video_note,
  forward: (m) => !!(m.forward_origin || m.forward_date),
  poll: (m) => !!m.poll,
  contact: (m) => !!m.contact,
  location: (m) => !!(m.location || m.venue),
  game: (m) => !!m.game,
  link: hasUrl,
};

/** /lock <type> and /unlock <type> (the bare /lock still locks the whole group; see moderation.ts). */
export async function typeLock(ctx: Context, arg: string, on: boolean) {
  const types = arg.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const bad = types.filter((t) => !(t in LOCKS));
  if (bad.length || !types.length) {
    return void (await ctx.reply(`Ye types hain: ${Object.keys(LOCKS).join(", ")}\nJaise: /lock sticker gif`));
  }
  const c = chatCfg(ctx.chat!.id);
  const set = new Set(c.locks ?? []);
  for (const t of types) on ? set.add(t) : set.delete(t);
  c.locks = [...set];
  saveChatCfg(ctx.chat!.id);
  await ctx.reply(`${on ? "🔒 Lock" : "🔓 Unlock"}: ${types.join(", ")}\nAbhi locked: ${c.locks.join(", ") || "kuch nahi"}`);
  await modLog(ctx, `${on ? "🔒" : "🔓"} ${on ? "Lock" : "Unlock"}: ${esc(types.join(", "))}`);
}

// ---------- blocklist / filters helpers ----------
const globToRegex = (p: string) =>
  new RegExp(p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."), "i");

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
function hasWord(text: string, kw: string): boolean {
  const t = text.toLowerCase();
  const k = kw.toLowerCase();
  for (let i = t.indexOf(k); i >= 0; i = t.indexOf(k, i + 1)) {
    if (!isWordChar(t[i - 1]) && !isWordChar(t[i + k.length])) return true;
  }
  return false;
}

const ACTIONS = ["delete", "warn", "mute", "kick", "ban"] as const;
type Action = (typeof ACTIONS)[number];

async function applyAction(ctx: Context, action: Action, why: string) {
  const u = ctx.from!;
  await ctx.deleteMessage().catch(() => {});
  if (action === "delete") return;
  if (action === "warn") return void (await addWarn(ctx, u.id, u.first_name, why));
  if (action === "mute") return void (await ctx.reply(`${await punish(ctx, u.id, u.first_name, "mute", 30)}\nWajah: ${esc(why)}`, html));
  if (action === "ban") return void (await ctx.reply(`${await punish(ctx, u.id, u.first_name, "ban")}\nWajah: ${esc(why)}`, html));
  await ctx.banChatMember(u.id);
  await ctx.unbanChatMember(u.id);
  await modLog(ctx, `👢 Kick: ${mention(u.id, u.first_name)} (${esc(why)})`);
}

// ---------- registration ----------
export function registerModPlus(bot: Bot) {
  // Messages: locks, blocklist, then notes (#name) and filters. Admins are never touched.
  bot.use(async (ctx, next) => {
    const m: any = ctx.message;
    if (!m || !isGroup(ctx) || !ctx.from || ctx.from.is_bot || isChannelRelay(ctx)) return next();
    const c = chatCfg(ctx.chat!.id);
    const text: string = m.text ?? m.caption ?? "";
    const admin = await isChatAdmin(ctx, ctx.from.id);

    if (!admin && (c.locks?.length || c.blocklist?.length) && (await botCanModerate(ctx))) {
      for (const t of c.locks ?? []) {
        if (LOCKS[t]?.(m)) {
          await ctx.deleteMessage().catch(() => {});
          return; // deleted: nothing else should see it
        }
      }
      for (const b of c.blocklist ?? []) {
        if (text && globToRegex(b.pattern).test(text)) {
          await modLog(ctx, `🧱 Blocklist "${esc(b.pattern)}" (${b.action}): ${mention(ctx.from.id, ctx.from.first_name)}`);
          await applyAction(ctx, b.action, `blocked word: ${b.pattern}`);
          return;
        }
      }
    }

    if (text && !text.startsWith("/") && chatAllowed(ctx)) {
      const note = text.match(/^#([\p{L}\p{N}_]{1,32})\b/u)?.[1]?.toLowerCase();
      if (note && c.notes?.[note]) {
        await ctx.reply(c.notes[note], { reply_parameters: { message_id: m.message_id } });
        return;
      }
      for (const [kw, reply] of Object.entries(c.filters ?? {})) {
        if (hasWord(text, kw)) {
          await ctx.reply(reply, { reply_parameters: { message_id: m.message_id } });
          break;
        }
      }
    }
    return next();
  });

  // Captcha button
  bot.callbackQuery(/^cap:(\d+)$/, async (ctx) => {
    const target = Number(ctx.match[1]);
    if (ctx.from.id !== target) return void (await ctx.answerCallbackQuery({ text: "Ye button tumhare liye nahi hai 🙂", show_alert: true }));
    const chatId = ctx.chat!.id;
    const pending = await getJSON<{ user: User; msg: number }>(`cap/${chatId}/${target}`);
    try {
      await ctx.api.restrictChatMember(chatId, target, OPEN);
    } catch (e) {
      console.error("captcha unrestrict failed:", e);
    }
    await delKey(`cap/${chatId}/${target}`).catch(() => {});
    await ctx.answerCallbackQuery({ text: "Verify ho gaye ✅" });
    await ctx.deleteMessage().catch(() => {});
    const u = pending?.user ?? { id: target, first_name: ctx.from.first_name, username: ctx.from.username };
    await sendWelcome(ctx.api, chatId, (ctx.chat as any).title ?? "this group", u, true);
  });

  const onOff = (a: string) => (/^(on|yes|1|true|haan)$/i.test(a) ? true : /^(off|no|0|false|nahi)$/i.test(a) ? false : null);

  const adminCmd = (names: string | string[], fn: (ctx: Context, arg: string) => Promise<unknown>) =>
    bot.command(names, async (ctx) => {
      if (!(await guard(ctx))) return;
      try {
        await fn(ctx, String(ctx.match ?? "").trim());
      } catch (e: any) {
        console.error("modplus command failed:", e?.description ?? e);
        await ctx.reply("Ye nahi ho paya 🥺 mujhe group mein admin banao aur zaroori permissions do.").catch(() => {});
      }
    });
  const anyCmd = (names: string | string[], fn: (ctx: Context, arg: string) => Promise<unknown>) =>
    bot.command(names, async (ctx, next) => {
      if (!isGroup(ctx)) return next();
      await fn(ctx, String(ctx.match ?? "").trim());
    });

  adminCmd("captcha", async (ctx, arg) => {
    const v = onOff(arg);
    if (v === null) return void (await ctx.reply("/captcha on  ya  /captcha off\nNaya member button dabane tak mute rahega (bot ko admin banana zaroori)."));
    chatCfg(ctx.chat!.id).captcha = v;
    saveChatCfg(ctx.chat!.id);
    await ctx.reply(`Captcha ab ${v ? "ON ✅" : "OFF ❌"}`);
  });

  adminCmd("antiraid", async (ctx, arg) => {
    const [state, joins, secs] = arg.toLowerCase().split(/\s+/);
    const v = onOff(state ?? "");
    if (v === null) return void (await ctx.reply("/antiraid on [kitne log] [kitne second]\nJaise: /antiraid on 8 30  (30 second mein 8 join to group lock)\n/antiraid off"));
    const c = chatCfg(ctx.chat!.id);
    c.antiraid = { on: v, joins: Math.min(Math.max(Number(joins) || c.antiraid?.joins || 8, 3), 100), secs: Math.min(Math.max(Number(secs) || c.antiraid?.secs || 30, 5), 600) };
    saveChatCfg(ctx.chat!.id);
    await ctx.reply(v ? `AntiRaid ON ✅: ${c.antiraid.secs} second mein ${c.antiraid.joins} join par group ${RAID_LOCK_MIN} min lock hoga.` : "AntiRaid OFF ❌");
  });

  adminCmd("unlockall", async (ctx) => {
    await ctx.api.setChatPermissions(ctx.chat!.id, OPEN);
    await delKey(`raid/${ctx.chat!.id}`).catch(() => {});
    await ctx.reply("Group khol diya 🔓");
  });

  anyCmd("locks", async (ctx) => {
    const l = chatCfg(ctx.chat!.id).locks ?? [];
    await ctx.reply(`🔒 Locked: ${l.join(", ") || "kuch nahi"}\n\nAvailable: ${Object.keys(LOCKS).join(", ")}\nAdmin: /lock sticker  /unlock sticker`);
  });

  adminCmd("setlog", async (ctx, arg) => {
    if (!arg) return void (await ctx.reply("Log channel ka @username ya ID do:\n/setlog @mylogchannel\nPehle mujhe us channel ka admin banao. Band karne ke liye /unsetlog"));
    const chat = await ctx.api.getChat(/^-?\d+$/.test(arg) ? Number(arg) : arg.startsWith("@") ? arg : "@" + arg.replace(/^https?:\/\/t\.me\//, ""));
    await ctx.api.sendMessage(chat.id, `✅ Ye channel ab ${esc((ctx.chat as any).title ?? "group")} ka mod log hai.`, html);
    chatCfg(ctx.chat!.id).logChannel = chat.id;
    saveChatCfg(ctx.chat!.id);
    await ctx.reply("Mod log set ho gaya ✅ ab ban, mute, warn wagairah wahan likhe jayenge.");
  });
  adminCmd("unsetlog", async (ctx) => {
    delete chatCfg(ctx.chat!.id).logChannel;
    saveChatCfg(ctx.chat!.id);
    await ctx.reply("Mod log band ❌");
  });

  // blocklist
  adminCmd("addblock", async (ctx, arg) => {
    const parts = arg.split(/\s+/).filter(Boolean);
    const last = parts[parts.length - 1]?.toLowerCase();
    const action: Action = (ACTIONS as readonly string[]).includes(last) && parts.length > 1 ? (last as Action) : "delete";
    const pattern = (action === last ? parts.slice(0, -1) : parts).join(" ").trim();
    if (!pattern) return void (await ctx.reply(`/addblock <shabd ya pattern> [${ACTIONS.join("|")}]\nJaise: /addblock *casino* ban\n* kuch bhi, ? ek akshar`));
    const c = chatCfg(ctx.chat!.id);
    c.blocklist = (c.blocklist ?? []).filter((b) => b.pattern !== pattern.toLowerCase());
    if (c.blocklist.length >= MAX_ITEMS) return void (await ctx.reply(`Max ${MAX_ITEMS} patterns.`));
    c.blocklist.push({ pattern: pattern.toLowerCase(), action });
    saveChatCfg(ctx.chat!.id);
    await ctx.reply(`🧱 Block: "${esc(pattern)}" → ${action}`);
  });
  adminCmd("unblock", async (ctx, arg) => {
    const c = chatCfg(ctx.chat!.id);
    const before = c.blocklist?.length ?? 0;
    c.blocklist = (c.blocklist ?? []).filter((b) => b.pattern !== arg.toLowerCase());
    saveChatCfg(ctx.chat!.id);
    await ctx.reply(before === c.blocklist.length ? "Ye pattern list mein nahi tha." : "Hata diya ✅");
  });
  anyCmd("blocklist", async (ctx) => {
    const b = chatCfg(ctx.chat!.id).blocklist ?? [];
    await ctx.reply(b.length ? "🧱 Blocklist:\n" + b.map((x) => `• ${x.pattern} → ${x.action}`).join("\n") : "Blocklist khaali hai. Admin: /addblock *shabd* ban");
  });

  // notes
  adminCmd(["save", "note"], async (ctx, arg) => {
    const m = arg.match(/^(\S+)\s*([\s\S]*)$/);
    const body = m?.[2]?.trim() || (ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption ?? "");
    if (!m || !body) return void (await ctx.reply("/save naam text likho, ya kisi msg ka reply karke /save naam\nPhir koi #naam likhega to wo text aayega."));
    const c = chatCfg(ctx.chat!.id);
    c.notes ??= {};
    const name = m[1].replace(/^#/, "").toLowerCase().slice(0, 32);
    if (!c.notes[name] && Object.keys(c.notes).length >= MAX_ITEMS) return void (await ctx.reply(`Max ${MAX_ITEMS} notes.`));
    c.notes[name] = body.slice(0, 1500);
    saveChatCfg(ctx.chat!.id);
    await ctx.reply(`📝 Note save: #${name}`);
  });
  anyCmd("get", async (ctx, arg) => {
    const n = chatCfg(ctx.chat!.id).notes?.[arg.replace(/^#/, "").toLowerCase()];
    await ctx.reply(n ?? "Ye note nahi mila. /notes dekho.");
  });
  anyCmd("notes", async (ctx) => {
    const n = Object.keys(chatCfg(ctx.chat!.id).notes ?? {});
    await ctx.reply(n.length ? "📝 Notes:\n" + n.map((x) => "#" + x).join("  ") : "Koi note nahi. Admin: /save naam text");
  });
  adminCmd("clear", async (ctx, arg) => {
    const c = chatCfg(ctx.chat!.id);
    const name = arg.replace(/^#/, "").toLowerCase();
    if (!c.notes?.[name]) return void (await ctx.reply("Ye note nahi mila."));
    delete c.notes[name];
    saveChatCfg(ctx.chat!.id);
    await ctx.reply("Note hata diya ✅");
  });

  // filters (auto-reply on a keyword)
  adminCmd("filter", async (ctx, arg) => {
    const m = arg.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) return void (await ctx.reply("/filter shabd jawab\nJaise: /filter price Price 500 rupaye hai"));
    const c = chatCfg(ctx.chat!.id);
    c.filters ??= {};
    const kw = m[1].toLowerCase().slice(0, 32);
    if (!c.filters[kw] && Object.keys(c.filters).length >= MAX_ITEMS) return void (await ctx.reply(`Max ${MAX_ITEMS} filters.`));
    c.filters[kw] = m[2].slice(0, 1500);
    saveChatCfg(ctx.chat!.id);
    await ctx.reply(`🔎 Filter set: "${esc(kw)}"`);
  });
  adminCmd("stop", async (ctx, arg) => {
    const c = chatCfg(ctx.chat!.id);
    if (!c.filters?.[arg.toLowerCase()]) return void (await ctx.reply("Ye filter nahi mila."));
    delete c.filters[arg.toLowerCase()];
    saveChatCfg(ctx.chat!.id);
    await ctx.reply("Filter hata diya ✅");
  });
  anyCmd("filters", async (ctx) => {
    const f = Object.keys(chatCfg(ctx.chat!.id).filters ?? {});
    await ctx.reply(f.length ? "🔎 Filters: " + f.join(", ") : "Koi filter nahi. Admin: /filter shabd jawab");
  });

  // custom welcome
  adminCmd("setwelcome", async (ctx, arg) => {
    if (!arg) {
      return void (await ctx.reply("/setwelcome text\nPlaceholders: {mention} {name} {username} {group} {count}\nJaise: /setwelcome Welcome {mention} to {group}! Tum {count}wen member ho 🎉"));
    }
    const c = chatCfg(ctx.chat!.id);
    c.welcomeText = arg.slice(0, 800);
    c.welcome = true;
    saveChatCfg(ctx.chat!.id);
    await ctx.reply("Welcome text set ✅ (/resetwelcome se default)");
  });
  adminCmd("resetwelcome", async (ctx) => {
    delete chatCfg(ctx.chat!.id).welcomeText;
    saveChatCfg(ctx.chat!.id);
    await ctx.reply("Welcome text default par wapas ✅");
  });
  adminCmd("welcomedelete", async (ctx, arg) => {
    const c = chatCfg(ctx.chat!.id);
    if (/^(off|0|no)$/i.test(arg)) delete c.welcomeDelete;
    else {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 10 || n > 86400) return void (await ctx.reply("/welcomedelete 60  (second, 10 se 86400)\n/welcomedelete off"));
      c.welcomeDelete = Math.round(n);
    }
    saveChatCfg(ctx.chat!.id);
    await ctx.reply(c.welcomeDelete ? `Welcome msg ${c.welcomeDelete} second baad hat jayega ✅` : "Welcome msg auto-delete band ❌");
  });
}

// ---------- scheduled clean-up (called every 15 minutes) ----------
export async function sweepModPlus(api: Api) {
  const now = Date.now();

  // unverified members are removed after the captcha time is up
  for (const key of await listKeys("cap/")) {
    const v = await getJSON<{ at: number; msg: number; user: User }>(key);
    if (!v) continue;
    if (now - v.at < CAPTCHA_MIN * 60_000) continue;
    const [, chat, user] = key.split("/");
    await api.banChatMember(Number(chat), Number(user)).then(() => api.unbanChatMember(Number(chat), Number(user))).catch(() => {});
    await api.deleteMessage(Number(chat), v.msg).catch(() => {});
    await delKey(key);
  }

  // raid locks expire
  for (const key of await listKeys("raid/")) {
    const v = await getJSON<{ until: number }>(key);
    if (!v || v.until > now) continue;
    const chat = Number(key.split("/")[1]);
    await api.setChatPermissions(chat, OPEN).catch(() => {});
    await api.sendMessage(chat, "🔓 Raid ka time khatam, group khol diya.").catch(() => {});
    await delKey(key);
  }

  // delayed deletes (welcome messages)
  for (const key of await listKeys("del/")) {
    const v = await getJSON<{ at: number }>(key);
    if (!v || v.at > now) continue;
    const [, chat, msg] = key.split("/");
    await api.deleteMessage(Number(chat), Number(msg)).catch(() => {});
    await delKey(key);
  }
}
