import type { Context } from "@netlify/functions";
import { route } from "../../src/agent/api.js";
import { loadGate, isBotManager } from "../../src/gate.js";
import { verifyInitData } from "../../src/webapp.js";
import { flush, casUpdate } from "../../src/store.js";

// Backend of the SECRET AGENT Mini App (public/agent/). Every request carries Telegram's signed initData; the user id
// comes only from the verified signature.
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req: Request, _ctx: Context): Promise<Response> => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/sa\/api/, "") || "/";
    const token = process.env.BOT_TOKEN;
    if (!token) return json(500, { ok: false, error: "server-misconfigured" });

    const auth = verifyInitData(req.headers.get("x-init-data") ?? "", token, { maxAgeSec: 24 * 3600 });
    if (!auth.ok) return json(401, { ok: false, error: `auth-${auth.reason}` });

    await loadGate();
    const name = [auth.user.first_name, auth.user.last_name].filter(Boolean).join(" ") || auth.user.username || `Agent ${auth.user.id}`;
    let body: unknown = undefined;
    if (req.method === "POST") {
      const text = await req.text();
      if (text.length > 4096) return json(413, { ok: false, error: "payload-too-large" });
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return json(400, { ok: false, error: "bad-json" });
      }
    }
    const res = await route(req.method, path, Object.fromEntries(url.searchParams), body, {
      user: { id: auth.user.id, name, username: auth.user.username },
      now: Date.now(),
      isAdmin: isBotManager(auth.user.id),
    });
    return json(res.status, res.body);
  } catch (e: any) {
    console.error("sa api:", e);
    await casUpdate<{ n: number; last?: string }>("sa/err", (c) => ({ n: (c?.n ?? 0) + 1, last: String(e?.message ?? e).slice(0, 160) })).catch(() => {});
    return json(500, { ok: false, error: "server-error" });
  } finally {
    await flush();
  }
};

export const config = { path: "/sa/api/*" };
