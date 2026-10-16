<div align="center">

# 💜 Myra

**A Hinglish AI companion, group manager and game hub for Telegram.**
Chat · Live voice · Moderation · Market tools · Games · A 2D spy game and Ludo as a Mini App

`Telegram Bot` · `Netlify Functions` · `Netlify Blobs` · `grammY` · `TypeScript`

</div>

---

## ✨ What it does

| | |
|---|---|
| 💬 **Chat** | Myra talks like a friend in Hinglish, remembers lasting facts about each person, changes mood with the time of day, and answers in voice notes on request. |
| 🎙️ **Live voice** | A browser page opened from the bot for real-time voice chat with Gemini Live. |
| 🛡️ **Group tools** | Captcha, anti-raid, locks, blocklist, notes, filters, warnings, custom welcome with a picture card, mod-log channel. Links are allowed by default and group admins switch the filter on or off. |
| 📈 **Market** | Crypto and stock prices, charts, gainers and losers, alerts, converter, fear and greed, gas, daily summary. |
| 🧰 **Tools** | Translate, speech to text, image understanding, user and chat info, raw update JSON. |
| 🎮 **Games in chat** | Tic-Tac-Toe, Rock-Paper-Scissors, Word Battle, paper trading with virtual money, anime and manga lookup. |
| 🕵️ **SECRET AGENT** | A multiplayer 2D social-deduction Mini App: secret roles, clues, discussion, voting, bots, missions, leaderboards. |
| 🎲 **Ludo** | 2 to 4 players or against bots, four tokens each, server-side 3D dice with sound. |

> Game points and Telegram Stars items are virtual and have no cash value. There are no deposits, bets or withdrawals.

---

## 🧱 How it is built

```
Telegram ──webhook──▶  netlify/functions/telegram.ts   (grammY bot)
Browser  ──────────▶   public/live.html  ◀──▶ /api/*    (live voice)
Mini App ──────────▶   public/agent/     ◀──▶ /sa/api/* (SECRET AGENT + Ludo)
Scheduler (every 5 and 15 min)  →  alerts, daily posts, sweeps
                      all state lives in Netlify Blobs
```

| Folder | Purpose |
|---|---|
| `src/` | Bot features: AI chat, gate, moderation, market, tools, games |
| `src/agent/` | SECRET AGENT and Ludo: rules engine, API router, profiles and rewards |
| `public/agent/` | The Mini App (plain JS, Phaser for the 2D scene, procedurally drawn art) |
| `netlify/functions/` | Webhook, APIs, setup and scheduled jobs |
| `tests/` | Automated tests for rules, payments, rewards and moderation |
| `docs/` | Deeper notes: [games](docs/games.md), [SECRET AGENT and Ludo](docs/secret-agent.md) |

The server decides everything that matters (roles, dice, winners, rewards). Clients only send intentions such as "roll" or "move token 2".

---

## 🚀 Quick start

**You need:** Node 22 or newer, a Telegram bot token from [@BotFather](https://t.me/BotFather), and a Netlify account.

```bash
git clone https://github.com/codeninjavik/myra-telegram-bot.git
cd myra-telegram-bot
npm install
cp .env.example .env     # then fill in your own values (never commit this file)
npm run typecheck
npm test
```

### Environment variables

Set them in **Netlify → Site configuration → Environment variables**. See [`.env.example`](.env.example) for the full list with placeholders.

| Name | What it is |
|---|---|
| `BOT_TOKEN` | Token from BotFather |
| `WEBHOOK_SECRET` | Any long random string; protects the webhook and the setup page |
| `OWNER_ID` | Your numeric Telegram user id (owner commands) |
| `GROQ_API_KEYS` | Comma-separated Groq keys (chat) |
| `GEMINI_API_KEYS` | Comma-separated Gemini keys (voice, vision, speech) |
| `PUBLIC_URL` | Optional custom site origin |

Keys and tokens belong only in environment variables. They are never stored in this repository.

### Deploy

```bash
npm i -g netlify-cli
netlify login
netlify deploy --prod
```

Then open `https://<your-site>/setup?key=<WEBHOOK_SECRET>` once. It points Telegram at the webhook and refreshes the command menus. Repeat it after each deploy.

### In groups

Add the bot to a group, make it an admin (delete and restrict rights), and in BotFather turn **Group Privacy** off, then re-add the bot. Without that, plain `/commands` may not reach the bot in groups that have other bots. `/command@YourBot` always works.

---

## 🕹️ Play locally

```bash
npm run agent:dev -- --fast
```

Open `http://localhost:8799/agent/?uid=1`, and `?uid=2` in another tab for a second player. This development server uses an in-memory store and a fake sign-in, binds to `127.0.0.1`, and is never deployed.

---

## 🧭 Commands

<details>
<summary><b>Everyday</b></summary>

`/tools` · `/price btc` · `/chart eth 30` · `/top` · `/nifty` · `/alert btc 90000` · `/convert 100 usd inr` · `/tr hi good morning` · `/stt` · `/see` · `/memory` · `/live` · `/voice` · `/id` · `/info` · `/raw`

</details>

<details>
<summary><b>Games</b></summary>

`/games` · `/challenge` · `/matches` · `/profile` · `/gtop` · `/wallet` · `/dailygame` · `/shop` · `/game` (SECRET AGENT) · `/ludo` · `/buy btc 500` · `/portfolio` · `/anime naruto`

</details>

<details>
<summary><b>Group admins</b></summary>

`/ban` `/unban` `/kick` `/mute` `/warn` · `/captcha on` · `/antiraid on` · `/lock sticker link` · `/addblock *spam* ban` · `/antilink on|off` · `/antiabuse on|off` · `/setwelcome` · `/setlog` · `/save` `/filter` · `/daily summary on` · `/modsettings`

</details>

---

## 🧪 Tests

```bash
npm test
```

Covers game rules, privacy of secret roles, exactly-once rewards, Stars payment handling, Mini App sign-in validation, admin authorisation, moderation defaults and full simulated matches.

---

## 🔒 Security notes

- Mini App sign-in is verified on the server with Telegram's signed `initData`; ids and balances sent by the page are never trusted.
- Rewards and payments are idempotent: a retried request cannot pay twice.
- Admin actions require the owner or a bot admin and are written to an audit log.
- Never share your bot token. If it leaks, revoke it in BotFather and update the environment variable.

---

## 📄 Docs

- [Games, points and Stars shop](docs/games.md)
- [SECRET AGENT and Ludo](docs/secret-agent.md)
- [Feature backlog](docs/feature-backlog.md)

<div align="center">

Made with 💜 for people who like to talk to their bot.

</div>
