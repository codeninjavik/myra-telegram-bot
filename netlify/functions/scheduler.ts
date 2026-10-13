import type { Config } from "@netlify/functions";
import { bot } from "../../src/bot.js";
import { runDaily } from "../../src/daily.js";
import { sweepModPlus } from "../../src/modplus.js";
import { sweepGames } from "../../src/games.js";
import { sweepAgentRooms } from "../../src/agent/api.js";
import { loadGate } from "../../src/gate.js";
import { flush } from "../../src/store.js";

// Every 15 minutes: market summary, good morning/night and top chatters for the groups that switched them on.
export default async () => {
  await loadGate();
  await runDaily(bot.api);
  await sweepModPlus(bot.api); // captcha timeouts, raid unlock, delayed deletes
  await sweepGames(bot.api); // expire stale challenges and idle matches
  await sweepAgentRooms(Date.now()); // SECRET AGENT: settle finished matches, drop old rooms
  await flush();
};

export const config: Config = { schedule: "*/15 * * * *" };
