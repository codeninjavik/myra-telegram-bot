# SECRET AGENT: 2D multiplayer spy game (Telegram Mini App)

Social-deduction game for @MyraSmartBot. Players get secret roles, explore a 2D facility, collect clues, discuss,
vote and see a result screen. One Spy hides among the agents.

Live app: `https://<your-site>/agent/` (opened from the bot with a Telegram web_app button).

## What differs from the brief, and why

The brief suggests React + Vite, Phaser, Socket.IO, PostgreSQL, Prisma and Redis. This project is a serverless
Netlify site with Netlify Blobs, so the architecture was adapted instead of adding infrastructure the owner has not
set up:

| Brief | Built | Why |
|---|---|---|
| Socket.IO real-time | HTTPS polling (`POST /sa/api/room/tick`, about 1 request per second, about 3 per second while moving) | Netlify Functions cannot hold WebSocket connections. |
| PostgreSQL + Prisma, Redis | Netlify Blobs with ETag compare-and-swap and `createOnce` idempotency keys | No database exists in this deployment. Same exactly-once guarantees, no SQL migrations. |
| React + Vite | Plain JavaScript modules and CSS, no build step; Phaser 3 for the 2D scene (CDN) | The site publishes `public/` directly. |
| Original art assets | Characters, maps and icons are drawn by code (`public/agent/art.js`) | No external or placeholder assets; nothing to license. |

Consequences to be aware of:

- **Invocation volume.** One six-player match is a few thousand function invocations. Netlify's free tier includes
  125,000 per month, so that is roughly 25 matches a month there. For real traffic, use a paid Netlify plan or move the
  `src/agent` engine to a small always-on WebSocket server (Fly.io, Render). The engine is transport-agnostic
  (`route()` in `src/agent/api.ts` takes plain data), so only the transport changes.
- **Latency.** Movement is validated server-side and shown with roughly 300 ms granularity, fine for a slow-paced
  deduction game, not for a twitch game.

## Architecture

| File | Role |
|---|---|
| `src/agent/engine.ts` | Server-authoritative game rules: rooms, roles, phases, movement, interactions, clues, abilities, voting, win conditions, bots, per-player views. Pure functions of (state, now, rng). |
| `src/agent/maps.ts` | Six maps (geometry, obstacles, objects) and ten characters. `public/agent/maps.json` is generated from it (`node scripts/agent-maps.mjs`). |
| `src/agent/meta.ts` | Profiles, coin ledger, missions, achievements, match finalisation and rewards, leaderboards, reports, admin config and audit log. |
| `src/agent/api.ts` | Transport-agnostic router with all endpoints. |
| `netlify/functions/sa.ts` | HTTP wrapper at `/sa/api/*`: verifies Telegram `initData`, then calls the router. |
| `src/agent/bot.ts` | Bot commands that open the Mini App. |
| `src/webapp.ts` | `verifyInitData()` (official HMAC procedure). |
| `public/agent/*` | Mini App: `index.html`, `app.js` (screens), `game.js` (Phaser scene), `art.js` (procedural art), `app.css`. |

### Match lifecycle (all server-side)

`lobby` → `countdown` → `briefing` (role reveal) → `explore` → `discussion` → `voting` → `result` → next round or `over`.
The clock is advanced lazily on every request (`advance()`), so a late request catches up through several phases;
no background process is needed. A scheduler sweep (every 15 minutes) settles unrewarded matches and deletes old rooms.

- **Roles**: 4 players = Spy, Detective, Hacker, Agent. 5+ adds a Guard; the rest are Agents. 7+ players allow 2 spies (10 players allow 3).
- **Privacy**: `viewFor()` is the only way state leaves the server. Other players' roles are never included until the
  match is over. Eliminated players are revealed only as "Spy / not Spy". Positions of other players are limited to a
  vision radius while exploring. Private evidence stays private until its owner shares it.
- **Movement**: a speed limit with a small tolerance, bounds and obstacle checks, and sliding along walls. A client
  that reports a teleport is moved back to the allowed distance.
- **Interactions**: distance-checked, rate-limited, one objective completion per object per round.
- **Spy**: fake tasks (no progress), Sabotage (cooldown, 4 uses, repairable), Distraction, Dash. Three unrepaired
  sabotages win the match for the Spy.
- **Clues**: verified (always true), smudged (50%), unsigned (25%) and neutral. Round one always contains a verified
  clue, so a careful team can always solve the match.
- **Voting**: plurality, a tie removes nobody, abstain allowed, vote changeable until the deadline, disconnected
  players abstain. The Guard's shield cancels one vote-out.
- **Technical failure**: if every human disconnects, the match is `cancelled` with no winner and no rewards.

### Rewards and anti-cheat

- Rewards are computed only in `finalizeMatch()` after the server decided the winner, exactly once per match
  (`sa/fin/<matchId>` marker, per-player ledger key `match:<id>`, applied-keys list on the profile).
- Practice and small matches pay reduced rewards. Daily caps apply (20 rewarded matches, 3 practice matches).
  Players who left early get nothing.
- Missions, the daily reward and achievements are claimed through ledger keys, so a repeat claim is refused.
- Coins are virtual game points. There are no deposits, wagers, cash prizes, withdrawals or transfers.
- Client-submitted balances, roles, winners and phases are ignored; the body fields are not used for identity.

### Admin

`/admin/*` endpoints require an owner or bot admin (checked server-side from the verified Telegram id). The console is
in the Profile tab for those users: stats, reward values, mode toggles (Ranked is off by default), maintenance mode,
player lookup, ban/unban, reports and the audit log. Every change is audited.

## Commands

`/game`, `/spyplay`, `/createroom`, `/joinroom CODE`, `/agentprofile`, `/agentboard`, `/missions`, `/rewards`,
`/agenthistory`. `/start sa_<CODE>` opens a room invite. `/start`, `/help`, `/profile`, `/leaderboard` and `/play` keep
their existing Myra meanings; the game uses the prefixed names above so nothing existing breaks.
Web-app buttons work only in private chats; in a group the bot links to its private chat first.

## Setup

No new environment variables are required (`BOT_TOKEN` is used to verify `initData`). Optional: `PUBLIC_URL`, the site
origin the bot should open (defaults to the Netlify site).

1. Deploy (`netlify deploy --prod`), then run `/setup?key=<WEBHOOK_SECRET>` so the command menu refreshes.
2. In Telegram, send `/game` to the bot. The button opens the Mini App.
3. Optional: in BotFather create a Mini App (`/newapp`) pointing at `https://<site>/agent/` for a `t.me/<bot>/<app>`
   link and a menu button.

Local play without Telegram: `npm run agent:dev -- --fast`, then open `http://localhost:8799/agent/?uid=1` (and `?uid=2` in
another tab for a second player). This tool lives in `scripts/` (never deployed), binds to 127.0.0.1, uses an in-memory
store and a fake sign-in taken from `?uid=`; production code has no authentication bypass. `npm test` runs the automated
tests; `npm run agent:maps` regenerates `public/agent/maps.json` after editing `src/agent/maps.ts`.

## Tests

`npm test` (compiles to `.build-test` and runs `node --test`): rules, privacy, phase validation, movement, clue
fairness, voting and ties, win conditions, disconnects and cancellation, reward exactly-once, mission and daily
duplicate claims, admin authorisation, maintenance mode, ban, reports, leaderboards, a full 4-client match from lobby
to result, and Mini App `initData` validation.

Mobile layout was checked in headless Chromium at 390x844 against a local server using the compiled engine.
Real Telegram clients, real multi-device play and Telegram's own `initData` were not exercised in this environment.

## Ludo (second game in the same app)

Classic Ludo for 2 to 4 players, or against bots, inside the Mini App (Play, then Ludo, or the Ludo button on Home;
bot command: /ludo or /ludo CODE; invite link: t.me/<bot>?start=sa_L<CODE>).

- **Rules** (src/agent/ludo.ts, server-authoritative): 52-cell track, 6 to leave the yard, exact roll to finish, capture
  by landing on a non-safe cell, safe cells are the start squares and stars, a 6 / capture / reaching home gives another
  roll, three sixes in a row lose the turn. Quick mode uses 2 tokens each (about 1 to 3 minutes against a bot), Classic
  uses 4.
- **Dice and moves** are decided on the server. The client sends only 'roll' and 'move token N'; it cannot choose a
  value, move out of turn, or move a token that has no legal move.
- **Turn timer** 20 seconds. A human who times out is played for; after 3 timeouts, or after leaving, a bot takes the
  colour. If every human leaves, the game is cancelled with no result.
- **Rewards** use the same exactly-once pipeline as SECRET AGENT (finalizeCore): practice pays reduced XP, private matches
  pay coins and XP, daily caps apply. Ludo does not touch the Spy/Agent win counters. Achievement: Ludo Champion.
- **Dice sound** is synthesised from impacts (band-passed noise ticks plus a low knock, irregular spacing while it tumbles,
  softer and closer bounces when it lands), so no audio asset ships with the app. docs/dice-roll-preview.wav is an offline
  render of the same code for listening.
- **Tests**: tests/ludo.test.ts (rules, capture, safe cells, bots, timeouts, random full games) and
  tests/ludo-api.test.ts (rooms, turn validation, rewards once).

## Known limitations

- No WebSocket transport (see above), so no sub-second synchronisation and a function-invocation cost per player.
- Friends match is a private room with an invite sheet; it does not read the Telegram contact list.
- Ranked mode exists (rating changes, own leaderboard) but is disabled until enabled by an admin.
- Emotes, music tracks, per-character unlock items beyond the character itself, and an in-app image share to Telegram
  chats are not implemented. Result sharing uses the device share sheet or a Telegram share link.
- Audio is synthesised tones; there are no recorded sound assets.
- Match history and leaderboards scan all profiles; fine for thousands of players, not for millions.
