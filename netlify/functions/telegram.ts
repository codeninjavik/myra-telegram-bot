import { webhookCallback } from "grammy";
import { bot } from "../../src/bot.js";
import { setPublicUrl } from "../../src/live.js";
import { flush } from "../../src/store.js";

// Telegram webhook. Netlify gives the function a fresh process per request, so all state is in Netlify Blobs
// and flush() makes sure pending writes finish before the function is frozen.
const handle = webhookCallback(bot, "std/http", {
  secretToken: process.env.WEBHOOK_SECRET || undefined,
  timeoutMilliseconds: 55_000,
  onTimeout: "return", // a thrown timeout makes Telegram retry the update and reply twice
});

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Myra webhook is up");
  setPublicUrl(new URL(req.url).origin);
  try {
    return await handle(req);
  } catch (e: any) {
    // Log the reason only: grammY error objects carry the bot token inside `ctx.api`. Answer 200 so Telegram does not
    // redeliver an update whose handler failed for a non-transient reason (no rights in that chat, chat not found).
    console.error("webhook error:", e?.name ?? "Error", e?.description ?? e?.message ?? String(e));
    return new Response("ok");
  } finally {
    await flush();
  }
};

export const config = { path: "/telegram" };
