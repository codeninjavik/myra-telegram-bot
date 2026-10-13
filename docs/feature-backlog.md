# Myra bot: feature backlog

Ideas and research kept for later. Nothing here is built yet unless marked **done**.
Last updated: 2026-10-12.

## Priority list (suggested order)

1. **CAPTCHA for new members**: mute until the button is pressed (Rose, Shieldy have it).
2. **Notes / filters**: `/save rules ...`, `/filter keyword reply`, `#note` shortcuts (Rose).
3. **Locks**: lock sticker / forward / media / links per group (Rose).
4. **Mod log channel**: every ban / warn / mute is written to a private channel (Rose `log_channel`).
5. **`/setwelcome`** custom welcome text and auto-delete, plus placeholders `{name}` `{group}` `{count}`.
6. **AntiRaid**: lock the group automatically when many people join within seconds (Rose).
7. **Blocklist with glob patterns and actions** (warn / mute / kick / ban per word).
8. **`/anime <name>`** via the free AniList API (Lucyna bot has this).
9. **`/keys` and `/delkey`** (owner): count and remove Gemini keys that came from the live page popup.
10. **Paper trading game**: virtual 1,00,000, `/buy` `/sell` `/portfolio`, leaderboard.

## Research: other Telegram bots

| Bot | Type | Features worth copying |
|---|---|---|
| Rose (MissRose) | all-in-one moderation | locks, blocklists (glob patterns, per-word action), CAPTCHA, antiflood (`/setflood`, `/setfloodtimer`, kick/ban/tban/mute), AntiRaid, federations (`/fban` across many groups), notes, filters, welcome, reports, purge |
| Combot | moderation + analytics | stats dashboard (activity, growth), CAS global spam list |
| Shieldy | captcha | human verification of new members |
| Group Help | anti-spam | (details not found) |
| Controller Bot | channel manager | post scheduling, engagement, paid posts (not group moderation) |
| Gojo Satoru, Natsuki | anime themed group bots | anime fun modules, anti-spam |
| Lucyna (LucynaBot) | grammY chat management | AniList anime info, welcome card with the member's profile photo |
| Shinobu (@Shinobu_robot) | "AI integrated anime themed group management bot" | about 17k monthly users, support @Shinobu_Support, feature list not public |
| @TriviaBot, @PollBot | games | group quiz competitions, polls |
| Farhan-RoseBot (fork) | Rose-style modules | admin, afk, antiflood, backups, bans, blacklist, connection, cust_filters, disable, global_bans, locks, log_channel, msg_deleting, muting, notes, reporting, rss, rules, sed, translation, userinfo, warns, welcome |

Ideas taken from the module names above that Myra does not have yet:
`afk` (away status), `backups` (export/import group settings), `connection` (manage a group from DM),
`disable` (turn single commands off per group), `global_bans` / federations, `rss` (feed posts), `sed` (regex edit),
`purge` (delete many messages), `userinfo`.

Sources: metricgram.com/blog/telegram-group-management-tools-compared, mava.app/blog/best-bots-on-telegram,
missrose.org/docs/anti-spam, github.com/ryukaizen/Faye, t.me/Shinobu_robot, gitea.com/alvinstdio/Farhan-RoseBot.
Most are vendor blogs; feature lists may be dated. Check each bot's own `/help` before copying.

## More ideas by area

**Myra (AI)**: `/imagine` image generation (Gemini image model), `/say <text>` as a voice note, `/recap` summary of the last
messages, birthdays with auto wishes, `/remind 30m ...`, per-user mood and nicknames.

**Trading**: `/watchlist`, `/hold` portfolio with P and L, pump/dump alerts, coin to coin `/convert`, `/news`, `/calc`.

**Games**: Wordle, trivia battle, tic-tac-toe, antakshari, couple of the day, daily quiz with points.

**Utilities**: cricket `/score`, `/weather`, `/qr`, `/poll`, `/meaning`, `/unit`.

**Growth and admin**: broadcast to verified users, giveaway with channel-join check, weekly referral contest,
link tracker per referral, owner web dashboard, scheduled announcements, anti-forward / sticker / media filters.

## Known gaps in what exists

- Privacy mode of the bot must be off in BotFather for plain "myra ..." messages, auto-mod and top chatters to work in groups.
- Welcome banner and the Linux ffmpeg bundle have not been verified on the live Netlify deploy.
- Photo understanding, `/stt` and the scheduled daily posts were tested locally only.
- Old `myra.db` / `gate.json` / `history.json` data was never migrated into Netlify Blobs (`npm run migrate`).

## Already done (for reference)

Moderation (warn / mute / ban, anti-link, anti-gaali, anti-flood), required groups and channels with Join and Verify,
referral points and leaderboard, `/stats` and `/users`, bot admins (`/addbotadmin`), welcome banner, `/price` `/chart`
`/alert` `/convert` `/top` `/nifty` `/fear` `/gas`, `/daily` posts, `/tr` `/stt` `/see`, per-user memory (`/memory`),
realtime Gemini Live voice page with themes, personas and tools.

## Research round 2: what users actually use (utility bots)

Data quality is weak. The numbers below come from marketing blogs (controlhippo.com, qualtir.com, mirrorreview.com,
ambcrypto.com) and could not be verified; one list even attributes a bot to a company without proof. Use them as a
map of categories, not as rankings. tlmtr.io has real MAU dashboards but needs a login.

| Category | Typical bots (claimed users) | Could Myra do it? |
|---|---|---|
| Weather | weather bots (claimed 12M+) | yes, `/weather <city>` with Open-Meteo (already used in the live page) |
| AI assistant / writer | general AI chat bots (claimed 3M to 25M) | already the core of Myra |
| AI images | image generation bots (claimed 3M+) | yes, `/imagine` with a Gemini image model |
| Music search, lyrics | music / lyrics bots (claimed 5M to 15M) | search and links yes; downloading copyrighted music is a legal and ToS risk, skip |
| Video downloaders | Instagram / YouTube / TikTok savers (claimed 3M to 15M) | technically possible, but ToS and copyright risk; skip or limit to links the user owns |
| QR, URL shortener, calculator | small utility bots (claimed 4M to 8M) | yes, cheap: `/qr`, `/short`, `/calc` |
| File converters | converters (claimed 5M+) | image/PDF conversion is possible but heavy for serverless |
| Reminders | @skeddybot style natural-language reminders | yes, `/remind 30m ...` with a scheduled function |
| Search bots | channel / group search (claimed 300k to 600k) | not a fit |
| Trading bots | Trojan style (claimed 2M) | execution is high risk; price / alerts / news / paper trading are the safe part (already partly built) |

Best value for the effort: `/weather`, `/imagine`, `/remind`, `/qr`, `/calc`, `/short`.

## Built from this backlog (code written, NOT deployed yet)

Priority items 1 to 10 are in the code; run `netlify deploy --prod` and then open `/setup?key=<WEBHOOK_SECRET>` to publish.

| Item | Where | Commands |
|---|---|---|
| CAPTCHA | `src/modplus.ts` (+ sweep in `netlify/functions/scheduler.ts`) | `/captcha on|off` |
| Notes / filters | `src/modplus.ts` | `/save` `/get` `#name` `/notes` `/clear`, `/filter` `/stop` `/filters` |
| Locks | `src/modplus.ts` | `/lock sticker gif link ...`, `/unlock ...`, `/locks` (bare `/lock` still locks the whole group) |
| Mod log channel | `src/moderation.ts` `modLog()` | `/setlog @channel`, `/unsetlog` (logs ban, mute, warn, kick, unban, lock, blocklist, raid) |
| Custom welcome | `src/moderation.ts` `sendWelcome()` | `/setwelcome` with `{mention} {name} {username} {group} {count}`, `/resetwelcome`, `/welcomedelete 60` |
| AntiRaid | `src/modplus.ts` | `/antiraid on 8 30`, `/unlockall` |
| Blocklist (glob + action) | `src/modplus.ts` | `/addblock *casino* ban`, `/unblock`, `/blocklist` (actions: delete, warn, mute, kick, ban) |
| `/anime`, `/manga` | `src/extras.ts` | AniList |
| Gemini keys admin | `src/gate.ts` | `/keys`, `/delkey <n>` (owner only) |
| Paper trading | `src/extras.ts` | `/buy` `/sell` `/portfolio` `/tradelb` `/resetpaper` (virtual 10,000 USD) |

Notes: captcha needs the bot to be admin with "restrict members"; locks and blocklist only act where the bot can delete messages.

## Also built (not deployed yet): RawDataBot-style tools and the tool menu

`src/toolmenu.ts`: `/raw` (the exact Telegram update as 4-space JSON in a code block, a file when longer than about 3600 characters),
`/id`, `/info`, and `/tools` (also `/list`, `/menu`) which shows every tool as buttons grouped by category.
The verified DM keyboard has a "Tools" button too. To change what the menu lists, edit `CATALOG` in that file.
