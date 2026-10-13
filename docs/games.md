# Myra games, game points and Stars shop

Multiplayer games for @MyraSmartBot: Tic-Tac-Toe, Rock-Paper-Scissors and Word Battle, with profiles, rankings,
a non-cash game-points wallet and Telegram Stars purchases for digital cosmetics.

## Architecture (adapted to this project)

The bot runs on Netlify Functions with Netlify Blobs, so there is no SQL database and no row locking.
The guarantees come from two primitives in `src/store.ts`:

| Primitive | What it does | Used for |
|---|---|---|
| `createOnce(key, value)` | create only if the key does not exist (`onlyIfNew`) | idempotency keys, payment charge ids, settle markers |
| `casUpdate(key, fn)` | read value + ETag, write with `onlyIfMatch`, retry on conflict | balances, match state, daily counters |

| File | Role |
|---|---|
| `src/gamecore.ts` | Pure game rules (no Telegram, no storage). Server-authoritative. |
| `src/gamesvc.ts` | Profiles, ledger, matches, settlement, anti-farming, orders, payments, audit log. |
| `src/games.ts` | Commands, inline-keyboard UI, callbacks, Stars handlers, `/gadmin`, scheduler sweep. |
| `src/webapp.ts` | `verifyInitData()` for Telegram Mini App authentication (official HMAC procedure). |
| `tests/*.test.ts` | 50 automated tests (`npm test`). |

Storage keys: `gp/<telegramId>` player, `gl/<telegramId>/<idempotencyKey>` ledger, `gm/<id>` match,
`gr/<telegramId>` recent matches, `gact` active-match index, `gset/<matchId>` settle marker,
`gday/...` daily counters, `go/<orderId>` order, `gs/<chargeId>` Stars payment, `ga/...` audit log, `gcfg` config.

## Commands

Players: `/games` `/challenge` (reply to a user, or send a user id / @username Myra has seen) `/matches` `/profile`
`/gtop` (game rankings) `/wallet` `/transactions` `/purchases` `/dailygame` `/shop` `/theme` `/gsettings` `/cancel`
`/paysupport` `/gamehelp`.

`/leaderboard` is unchanged: it still shows the old referral points ranking. Game rankings are `/gtop`.

Admin (owner or `/addbotadmin`): `/gadmin stats | ban <id> | unban <id> | game on|off <ttt|rps|word> |
grant <id> <amt> <reason> | take <id> <amt> <reason> | reconcile <id> [fix] | refund <charge_id> | audit |
cfg [key value] | announce <text>`. Every financial or moderation action writes an audit record; grants need a reason.

## Games

- **Tic-Tac-Toe**: inline 3x3 board, server validates turn, occupied cells and membership. Win, draw, resign, timeout.
- **Rock-Paper-Scissors**: best of 3 or 5. A pick is acknowledged only with a private pop-up (callback toast); it is
  never in the message until the round resolves, and it cannot be changed. Ties are replayed, capped so a match ends.
- **Word Battle**: vocabulary quiz, word scramble, guess-the-word; easy/medium/hard; 3/5/7 rounds. Question bank is
  server-side (`BANKS` in gamecore.ts, shaped per language so Hindi can be added). First correct answer wins the round;
  a wrong answer locks that player out of the round. Buttons carry the round number so stale buttons are harmless.
- Challenges work in groups (open or targeted) and in DMs (share link). They expire after 10 minutes; active matches
  after 10 minutes of inactivity (tic-tac-toe: the player to move loses; RPS: whoever picked wins; otherwise abandoned
  with no stats or points).

## Money model

| Unit | Where | Notes |
|---|---|---|
| **Game points** | `gp/` balance + `gl/` ledger | Non-cash. Earned by playing, daily bonus, admin grants. Cannot be withdrawn or transferred. |
| **Telegram Stars (XTR)** | paid directly to Telegram | Spent on digital cosmetics only (themes, VIP badge, pro stats). Not stored as a balance. Own ledger unit. |
| **Cash** | disabled | `/deposit /withdraw /cashout /tournament` answer "unavailable". No payment flow exists in code. |

`realMoney` is forced to `false` in `getConfig()`; it cannot be switched on from config or admin commands. Enabling real
money needs the compliance review listed in the project brief (law, payment provider, Telegram policy, age/KYC/AML,
tax, geography) and new code. Do not treat Stars as a cash gateway.

### Ledger guarantees

1. Ledger entry created with `createOnce` on `gl/<user>/<idempotencyKey>`.
2. Balance changed in one `casUpdate` that also records the key in the player's `applied` list, so a retry after a crash
   cannot apply twice.
3. Entry marked `completed`. Debits never take a balance below zero; a rejected debit leaves no ledger line.
4. `/gadmin reconcile <id>` recomputes the balance from completed ledger entries and can fix a mismatch (audited).

Rewards: win 20, draw 8, loss 3, daily bonus 50 (editable with `/gadmin cfg`). Anti-farming: at most 15 rewarded
matches per player per day and 4 rewarded matches per pair per day; stats and rating still count. Rating is Elo-style.

### Stars payments

1. `/shop` (DM) creates an order `go/<id>` and sends an XTR invoice (`sendInvoice`, empty provider token).
2. `pre_checkout_query`: approved only if the order exists, is pending, belongs to the payer, amount and currency match,
   the account is active and the item is not already owned. It is answered immediately.
3. `successful_payment`: the only place an item is granted. Idempotent on `telegram_payment_charge_id`; redelivery does
   nothing. A payment that matches no order is recorded as `unmatched` and grants nothing.
4. Refunds: `/gadmin refund <charge_id>` calls `refundStarPayment`, revokes the item and writes a ledger line.
   `/paysupport` is the payment-support command Telegram requires.

Prices are in `PRODUCTS` in `src/gamesvc.ts`. Themes can also be bought with game points.

## Setup

No new environment variables are required. Existing ones are used: `BOT_TOKEN`, `OWNER_ID`, `WEBHOOK_SECRET`.
Telegram Stars needs no provider token. After deploying run `/setup?key=<WEBHOOK_SECRET>` once so the webhook receives
`pre_checkout_query` updates (they are in Telegram's default update types) and the "/" menu refreshes.
Group games work only in groups where Myra is a member; DM features require the user to be verified through the
existing Join/Verify gate.

Local: `npm install`, `npm run typecheck`, `npm test`. Deploy: `netlify deploy --prod` (see README / project notes).
Backups: Blobs have no built-in export; use `netlify blobs:list myra --prefix gp/` and `netlify blobs:get` or the
`/gadmin stats` summary. Roll back by redeploying a previous Netlify deploy; data keys are additive.

## Known limitations

- **No Mini App UI.** Inline keyboards carry all three games. `src/webapp.ts` contains and tests the authentication
  needed if a Mini App is added later, but no Mini App pages or endpoints exist yet.
- **Word chain** mode is not implemented (it needs free-text answers); three multiple-choice modes are.
- **Timeouts** are enforced when someone presses a button and by the scheduler sweep every 15 minutes, not to the second.
- **Notifications** are limited to challenge invites, accept/decline and payment/refund messages, and only to users
  who started the bot privately. There are no turn reminders or daily-challenge pushes.
- **Leaderboard and `/gadmin stats`** read all player keys; fine for thousands of players, not for millions.
- **Real-money mode** is intentionally absent.
- Stars purchases and the webhook flow were tested with simulated Telegram updates only; no real payment was made.
