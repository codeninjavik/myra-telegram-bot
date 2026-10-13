import { ALLOWED_UPDATES, BOT_TOKEN, bot, registerMenus } from "../../src/bot.js";

// One-time (and after every change to commands): open  https://<your-site>/setup?key=<WEBHOOK_SECRET>
// It points Telegram's webhook at /telegram and refreshes the "/" command menus.
export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const secret = process.env.WEBHOOK_SECRET;
  if (!BOT_TOKEN) return new Response("BOT_TOKEN env var is not set", { status: 500 });
  if (!secret) return new Response("Set the WEBHOOK_SECRET env var first (any long random string).", { status: 500 });
  if (url.searchParams.get("key") !== secret) return new Response("forbidden", { status: 403 });

  const hook = `${url.origin}/telegram`;
  try {
    await bot.api.setWebhook(hook, {
      secret_token: secret,
      allowed_updates: [...ALLOWED_UPDATES],
      drop_pending_updates: false,
    });
    await registerMenus();
    const info = await bot.api.getWebhookInfo();
    return Response.json({ ok: true, webhook: hook, info });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.description ?? String(e) }, { status: 500 });
  }
};

export const config = { path: "/setup" };
