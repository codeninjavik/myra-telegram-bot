process.env.MYRA_MEM_STORE = "1";
process.env.BOT_TOKEN = "123:TEST";
process.env.OWNER_ID = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { bot } from "../src/bot.js";
import { setJSON } from "../src/store.js";

// The full bot (all middleware) with a fake Telegram API: links are allowed in a new group, only a group admin can
// switch the link filter on, and old saved settings that had the old default-on flag no longer delete links.
bot.botInfo = {
  id: 123, is_bot: true, first_name: "Myra", username: "MyraSmartBot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_write_in_private_chat: true, can_manage_bots: false,
} as any;

const ADMIN = 7001;
const MEMBER = 7002;
let calls: { method: string; payload: any }[] = [];
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  let result: any = true;
  if (method === "sendMessage") result = { message_id: calls.length, chat: { id: (payload as any).chat_id, type: "supergroup" }, date: 0 };
  else if (method === "getChatMember") {
    // Myra is an admin who can delete messages; everyone else is a plain member
    result = (payload as any).user_id === 123
      ? { status: "administrator", user: { id: 123 }, can_delete_messages: true, can_restrict_members: true }
      : { status: "member", user: { id: (payload as any).user_id } };
  } else if (method === "getChatAdministrators") result = [{ status: "creator", user: { id: ADMIN, is_bot: false, first_name: "Admin" } }];
  else if (method === "getChatMemberCount") result = 5;
  return { ok: true, result } as any;
});
await setJSON("gate", { groups: [{ id: -1001, title: "Home", link: "https://t.me/x" }] });

let uid = 500;
async function say(chat: number, from: number, text: string) {
  calls = [];
  const sp = text.indexOf(" ");
  await bot.handleUpdate({
    update_id: ++uid,
    message: {
      message_id: uid, date: 0, chat: { id: chat, type: "supergroup", title: "G" }, from: { id: from, is_bot: false, first_name: from === ADMIN ? "Admin" : "Member" }, text,
      entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: sp < 0 ? text.length : sp }] : [],
    },
  } as any);
  return { deleted: calls.some((c) => c.method === "deleteMessage"), replies: calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text)) };
}

test("a new group allows links by default", async () => {
  const r = await say(-100801, MEMBER, "check this https://example.com/offer and t.me/somegroup");
  assert.equal(r.deleted, false);
});

test("only a group admin can switch the link filter on, and it can be switched off again", async () => {
  const chat = -100802;
  assert.equal((await say(chat, MEMBER, "/antilink on")).replies.some((t) => /sirf admins/i.test(t)), true, "a plain member is refused");
  assert.equal((await say(chat, MEMBER, "see https://example.com")).deleted, false, "refused command changed nothing");

  const on = await say(chat, ADMIN, "/antilink on");
  assert.ok(on.replies.some((t) => /ON/.test(t)));
  assert.equal((await say(chat, MEMBER, "see https://example.com")).deleted, true, "links are deleted once the admin turned the filter on");
  assert.equal((await say(chat, ADMIN, "admin posts https://example.com too")).deleted, false, "admins are never touched");

  const off = await say(chat, ADMIN, "/antilink off");
  assert.ok(off.replies.some((t) => /OFF/.test(t)));
  assert.equal((await say(chat, MEMBER, "see https://example.com")).deleted, false);
});

test("groups saved before this change (old default-on flag) now allow links too", async () => {
  const chat = -100803;
  await setJSON(`m/${chat}`, {
    antilink: true, antiabuse: true, antiflood: true, warnLimit: 3, action: "ban", badwords: [], welcome: true, rules: "", warns: {},
  });
  assert.equal((await say(chat, MEMBER, "see https://example.com")).deleted, false);
});

test("the settings page tells the admin whether links are allowed", async () => {
  const chat = -100804;
  const r = await say(chat, ADMIN, "/modsettings");
  const text = r.replies.join(" ");
  if (text) assert.match(text, /Link filter: OFF/);
});
