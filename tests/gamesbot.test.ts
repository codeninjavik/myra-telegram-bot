process.env.MYRA_MEM_STORE = "1";
process.env.OWNER_ID = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Bot } from "grammy";
import { registerGames } from "../src/games.js";
import { createOrder, ensurePlayer, getMatch, getPlayer, getConfig, movePoints } from "../src/gamesvc.js";
import { verifyInitData } from "../src/webapp.js";

type Call = { method: string; payload: any };
let seq = 100;

function makeBot() {
  const bot = new Bot("123:TEST", {
    botInfo: { id: 123, is_bot: true, first_name: "Myra", username: "MyraSmartBot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_write_in_private_chat: true, can_manage_bots: false },
  } as any);
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const result =
      method === "sendMessage" || method === "sendInvoice"
        ? { message_id: ++seq, chat: { id: (payload as any).chat_id, type: "private" }, date: 0 }
        : true;
    return { ok: true, result } as any;
  });
  registerGames(bot);
  return { bot, calls };
}

let updateId = 1;
const privateUser = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });
function cmdUpdate(from: number, text: string, chat = from) {
  const space = text.indexOf(" ");
  const len = space < 0 ? text.length : space;
  return {
    update_id: ++updateId,
    message: {
      message_id: ++updateId, date: 0, chat: { id: chat, type: chat > 0 ? "private" : "supergroup", title: "G" }, from: privateUser(from), text,
      entities: [{ type: "bot_command", offset: 0, length: len }],
    },
  } as any;
}
const sent = (calls: Call[]) => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));

test("/gadmin is silent for normal users and works for the owner", async () => {
  const { bot, calls } = makeBot();
  await bot.handleUpdate(cmdUpdate(555, "/gadmin stats"));
  assert.equal(sent(calls).length, 0, "no reply at all for a non-admin");
  await bot.handleUpdate(cmdUpdate(1, "/gadmin stats"));
  assert.match(sent(calls)[0], /Game stats/);
});

test("a normal user cannot grant points, ban or refund through /gadmin", async () => {
  const { bot } = makeBot();
  const p = await ensurePlayer({ id: 777001, first_name: "Cheater" });
  await bot.handleUpdate(cmdUpdate(777001, "/gadmin grant 777001 9999 because"));
  assert.equal((await getPlayer(777001))!.points, 0);
  assert.equal(p.status, "active");
});

test("admin grants need a reason and are audited", async () => {
  const { bot, calls } = makeBot();
  await ensurePlayer({ id: 777002, first_name: "Target" });
  await bot.handleUpdate(cmdUpdate(1, "/gadmin grant 777002 40"));
  assert.match(sent(calls).pop()!, /Reason zaroori/);
  assert.equal((await getPlayer(777002))!.points, 0);
  await bot.handleUpdate(cmdUpdate(1, "/gadmin grant 777002 40 contest winner"));
  assert.equal((await getPlayer(777002))!.points, 40);
  await bot.handleUpdate(cmdUpdate(1, "/gadmin audit"));
  assert.match(sent(calls).pop()!, /grant points:777002/);
});

test("real-money features answer 'unavailable' and expose no payment flow", async () => {
  const { bot, calls } = makeBot();
  for (const c of ["/deposit", "/withdraw", "/cashout", "/tournament"]) await bot.handleUpdate(cmdUpdate(777003, c));
  const out = sent(calls);
  assert.equal(out.length, 4);
  assert.ok(out.every((t) => /abhi available nahi/.test(t)));
  assert.equal(calls.filter((c) => c.method === "sendInvoice").length, 0);
  assert.equal((await getConfig()).realMoney, false);
});

test("/wallet keeps points, Stars and cash separate", async () => {
  const { bot, calls } = makeBot();
  await bot.handleUpdate(cmdUpdate(777004, "/wallet"));
  const t = sent(calls)[0];
  assert.match(t, /Game points/);
  assert.match(t, /Telegram Stars/);
  assert.match(t, /Cash wallet/);
  assert.match(t, /unavailable/);
});

test("banned users cannot use game commands", async () => {
  const { bot, calls } = makeBot();
  await ensurePlayer({ id: 777005, first_name: "Bad" });
  await bot.handleUpdate(cmdUpdate(1, "/gadmin ban 777005 cheating"));
  await bot.handleUpdate(cmdUpdate(777005, "/games"));
  assert.match(sent(calls).pop()!, /restrict/);
});

// ---- full challenge flow through callbacks
function cbUpdate(from: number, data: string, chat: number, msgId: number) {
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId), from: privateUser(from), chat_instance: "x", data,
      message: { message_id: msgId, date: 0, chat: { id: chat, type: "supergroup", title: "G" }, text: "x" },
    },
  } as any;
}

test("tic-tac-toe challenge: accept, turn validation, win, rematch, settlement", async () => {
  const { bot, calls } = makeBot();
  const A = 880001, B = 880002, C = 880003, chat = -1009;
  await bot.handleUpdate(cmdUpdate(A, "/challenge", chat)); // open challenge menu
  await bot.handleUpdate(cbUpdate(A, "gs:ttt:0", chat, 1));
  const post = calls.filter((c) => c.method === "sendMessage").pop()!;
  assert.match(post.payload.text, /challenge/i);
  const kb = JSON.stringify(post.payload.reply_markup);
  const id = /gx:acc:(\w+)/.exec(kb)![1];

  await bot.handleUpdate(cbUpdate(A, `gx:acc:${id}`, chat, 2)); // cannot accept own challenge
  assert.equal((await getMatch(id))!.status, "pending");
  await bot.handleUpdate(cbUpdate(B, `gx:acc:${id}`, chat, 2));
  assert.equal((await getMatch(id))!.status, "active");

  const play = async (who: number, cell: number) => bot.handleUpdate(cbUpdate(who, `gt:${id}:${cell}`, chat, 2));
  await play(B, 0); // not B's turn
  assert.equal(((await getMatch(id))!.state as any).board[0], null);
  await play(C, 0); // outsider
  assert.equal(((await getMatch(id))!.state as any).board[0], null);
  await play(A, 0);
  await play(A, 1); // A again: rejected
  assert.equal(((await getMatch(id))!.state as any).board[1], null);
  await play(B, 3);
  await play(A, 1);
  await play(B, 4);
  await play(A, 2); // A wins the top row
  const m = (await getMatch(id))!;
  assert.equal(m.status, "done");
  assert.equal(m.winner, A);
  assert.equal(m.settled, true);
  assert.equal((await getPlayer(A))!.wins, 1);
  assert.equal((await getPlayer(A))!.points, 20);

  // replaying the winning callback changes nothing
  await play(A, 2);
  assert.equal((await getPlayer(A))!.wins, 1);

  await bot.handleUpdate(cbUpdate(B, `gx:rem:${id}`, chat, 2));
  const re = calls.filter((c) => c.method === "sendMessage").pop()!;
  assert.match(String(re.payload.text), /challenge/i);
});

test("rps: choices are private (toast only) and locked", async () => {
  const { bot, calls } = makeBot();
  const A = 880011, B = 880012, chat = -1010;
  await bot.handleUpdate(cbUpdate(A, "gn:rps:0:3", chat, 1));
  const kb = JSON.stringify(calls.filter((c) => c.method === "sendMessage").pop()!.payload.reply_markup);
  const id = /gx:acc:(\w+)/.exec(kb)![1];
  await bot.handleUpdate(cbUpdate(B, `gx:acc:${id}`, chat, 2));
  await bot.handleUpdate(cbUpdate(A, `gr:${id}:rock`, chat, 2));
  const toast = calls.filter((c) => c.method === "answerCallbackQuery").pop()!.payload.text as string;
  assert.match(toast, /lock/i);
  // the board text must never contain the pick before the round is resolved
  const edits = calls.filter((c) => c.method === "editMessageText").map((c) => String(c.payload.text));
  assert.ok(edits.length > 0);
  assert.ok(!edits[edits.length - 1].includes("✊ vs"));
  await bot.handleUpdate(cbUpdate(A, `gr:${id}:paper`, chat, 2)); // change attempt
  assert.equal(((await getMatch(id))!.state as any).picks.a, "rock");
});

test("word battle: scramble match through callbacks, answers validated by the server", async () => {
  const { bot, calls } = makeBot();
  const A = 880021, B = 880022, chat = -1011;
  await bot.handleUpdate(cbUpdate(A, "gn:word:0:scramble:easy:3", chat, 1));
  const kb = JSON.stringify(calls.filter((c) => c.method === "sendMessage").pop()!.payload.reply_markup);
  const id = /gx:acc:(\w+)/.exec(kb)![1];
  await bot.handleUpdate(cbUpdate(B, `gx:acc:${id}`, chat, 2));
  let m = (await getMatch(id))!;
  assert.equal(m.status, "active");

  // an out-of-range option and a stale round number are ignored
  await bot.handleUpdate(cbUpdate(A, `gq:${id}:9:1`, chat, 2));
  await bot.handleUpdate(cbUpdate(A, `gq:${id}:0:7`, chat, 2));
  assert.deepEqual(((await getMatch(id))!.state as any).score, { a: 0, b: 0 });

  // B answers wrong (locked out of the round), A answers right
  const wrong = ((m.state as any).q.answer + 1) % 4;
  await bot.handleUpdate(cbUpdate(B, `gq:${id}:${wrong}:1`, chat, 2));
  await bot.handleUpdate(cbUpdate(B, `gq:${id}:${(m.state as any).q.answer}:1`, chat, 2)); // already answered
  assert.equal(((await getMatch(id))!.state as any).score.b, 0);
  await bot.handleUpdate(cbUpdate(A, `gq:${id}:${(m.state as any).q.answer}:1`, chat, 2));
  m = (await getMatch(id))!;
  assert.equal((m.state as any).score.a, 1);
  assert.equal((m.state as any).round, 2);

  // A wins the next round: the lead can no longer be caught, so the match ends early
  await bot.handleUpdate(cbUpdate(A, `gq:${id}:${(m.state as any).q.answer}:2`, chat, 2));
  m = (await getMatch(id))!;
  assert.equal(m.status, "done");
  assert.equal(m.winner, A);
  assert.equal((await getPlayer(A))!.wins, 1);
  assert.equal((await getPlayer(B))!.losses, 1);
});

// ---- Stars payment handlers
function preCheckout(from: number, payload: string, amount: number, currency = "XTR") {
  return { update_id: ++updateId, pre_checkout_query: { id: `pq${++updateId}`, from: privateUser(from), currency, total_amount: amount, invoice_payload: payload } } as any;
}
function paid(from: number, payload: string, amount: number, charge: string) {
  return {
    update_id: ++updateId,
    message: {
      message_id: ++updateId, date: 0, chat: { id: from, type: "private" }, from: privateUser(from),
      successful_payment: { currency: "XTR", total_amount: amount, invoice_payload: payload, telegram_payment_charge_id: charge, provider_payment_charge_id: "" },
    },
  } as any;
}

test("pre_checkout is approved only for a matching, pending order of the same user", async () => {
  const { bot, calls } = makeBot();
  const u = 990001;
  await ensurePlayer({ id: u, first_name: "Buyer" });
  const order = (await createOrder(u, "badge_vip"))!;
  const answers = () => calls.filter((c) => c.method === "answerPreCheckoutQuery").map((c) => c.payload.ok);

  await bot.handleUpdate(preCheckout(u, `ord:${order.id}`, 50));
  await bot.handleUpdate(preCheckout(u, `ord:${order.id}`, 5)); // wrong amount
  await bot.handleUpdate(preCheckout(u + 1, `ord:${order.id}`, 50)); // someone else's order
  await bot.handleUpdate(preCheckout(u, "ord:nope", 50)); // unknown order
  await bot.handleUpdate(preCheckout(u, `ord:${order.id}`, 50, "USD")); // wrong currency
  assert.deepEqual(answers(), [true, false, false, false, false]);
});

test("successful_payment grants the item once, even if Telegram redelivers it", async () => {
  const { bot, calls } = makeBot();
  const u = 990010;
  await ensurePlayer({ id: u, first_name: "Buyer" });
  const order = (await createOrder(u, "stats_pro"))!;
  const upd = paid(u, `ord:${order.id}`, 40, "charge-xyz");
  await bot.handleUpdate(upd);
  await bot.handleUpdate({ ...upd, update_id: ++updateId });
  await bot.handleUpdate({ ...upd, update_id: ++updateId });
  assert.deepEqual((await getPlayer(u))!.items, ["stats_pro"]);
  assert.equal(sent(calls).filter((t) => /Payment mil gayi/.test(t)).length, 1, "one confirmation only");
});

test("a payment that matches no order is recorded but grants nothing", async () => {
  const { bot } = makeBot();
  const u = 990020;
  await ensurePlayer({ id: u, first_name: "Odd" });
  await bot.handleUpdate(paid(u, "ord:ghost", 25, "charge-ghost"));
  assert.deepEqual((await getPlayer(u))!.items, []);
});

test("points are not accepted as an invoice and buying a theme with points works end to end", async () => {
  const { bot, calls } = makeBot();
  const u = 990030;
  await ensurePlayer({ id: u, first_name: "Saver" });
  await movePoints(u, 450, "credit", "daily", "seed");
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: { id: "p1", from: privateUser(u), chat_instance: "x", data: "gbp:theme_neon", message: { message_id: 1, date: 0, chat: { id: u, type: "private" }, text: "x" } },
  } as any);
  assert.deepEqual((await getPlayer(u))!.items, ["theme_neon"]);
  assert.equal((await getPlayer(u))!.points, 50);
  assert.equal(calls.filter((c) => c.method === "sendInvoice").length, 0);
});

// ---- Mini App authentication
function signed(params: Record<string, string>, token: string) {
  const check = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

test("Mini App initData: valid signature accepted, tampering and expiry rejected", () => {
  const token = "123:SECRET";
  const now = 1_800_000_000_000;
  const base = { auth_date: String(Math.floor(now / 1000) - 60), query_id: "AAH", user: JSON.stringify({ id: 4242, first_name: "Ann" }) };
  const good = signed(base, token);
  const r = verifyInitData(good, token, { now });
  assert.ok(r.ok && r.user.id === 4242);

  assert.deepEqual(verifyInitData(good, "123:OTHER", { now }), { ok: false, reason: "bad-hash" });
  const forged = good.replace("4242", "1");
  assert.deepEqual(verifyInitData(forged, token, { now }), { ok: false, reason: "bad-hash" });
  assert.deepEqual(verifyInitData("", token, { now }), { ok: false, reason: "missing" });
  assert.deepEqual(verifyInitData(good, token, { now: now + 3 * 86400_000 }), { ok: false, reason: "expired" });
  const noHash = new URLSearchParams(base).toString();
  assert.deepEqual(verifyInitData(noHash, token, { now }), { ok: false, reason: "missing" });
});
