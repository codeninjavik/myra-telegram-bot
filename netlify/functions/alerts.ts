import type { Config } from "@netlify/functions";
import { bot } from "../../src/bot.js";
import { checkAlerts } from "../../src/market.js";
import { flush } from "../../src/store.js";

// Every 5 minutes: compare the saved /alert targets with the live price and notify the chat.
export default async () => {
  await checkAlerts(bot.api);
  await flush();
};

export const config: Config = { schedule: "*/5 * * * *" };
