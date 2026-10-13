import type { Config } from "@netlify/functions";
import { bot } from "../../src/bot.js";
import { loadGate } from "../../src/gate.js";
import { snapshotGroups } from "../../src/stats.js";
import { flush } from "../../src/store.js";

// Stores each required group's member count a few times a day; /stats uses it for the 7-day growth number.
export default async () => {
  await loadGate();
  await snapshotGroups(bot.api);
  await flush();
};

export const config: Config = { schedule: "0 */6 * * *" };
