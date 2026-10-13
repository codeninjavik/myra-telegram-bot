import { createHmac, timingSafeEqual } from "node:crypto";

// Validation of Telegram Mini App `initData`, exactly as Telegram documents it. A Mini App backend must call this
// on every request and take the user id ONLY from the result: ids or balances sent by the page are never trusted.
export type WebAppUser = { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string };

export function verifyInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSec?: number; now?: number } = {},
): { ok: true; user: WebAppUser; authDate: number } | { ok: false; reason: "missing" | "bad-hash" | "expired" | "no-user" } {
  if (!initData || !botToken) return { ok: false, reason: "missing" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing" };
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = createHmac("sha256", secret).update(check).digest();
  let given: Buffer;
  try {
    given = Buffer.from(hash, "hex");
  } catch {
    return { ok: false, reason: "bad-hash" };
  }
  if (given.length !== calc.length || !timingSafeEqual(given, calc)) return { ok: false, reason: "bad-hash" };

  const authDate = Number(params.get("auth_date") ?? 0);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!authDate || now - authDate > (opts.maxAgeSec ?? 86400)) return { ok: false, reason: "expired" };
  try {
    const user = JSON.parse(params.get("user") ?? "null") as WebAppUser | null;
    if (!user || typeof user.id !== "number") return { ok: false, reason: "no-user" };
    return { ok: true, user, authDate };
  } catch {
    return { ok: false, reason: "no-user" };
  }
}
