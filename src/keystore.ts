import { createHash } from "node:crypto";
import { delKey, getJSON, getMany, listKeys, setJSON } from "./store.js";

// Gemini keys that people submit on the live voice page. They are added to the shared pool, so every chat and
// group uses them (more keys = more free quota). Stored as "gk/<hash>"; the key itself never goes back to a browser.
export const GEMINI_KEY_RE = /^(AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_.-]{20,120})$/; // classic and the newer "AQ." keys
const MAX_KEYS = 200;

let cache: { at: number; keys: string[] } | null = null;

/** Keys people added on the live page, oldest first, with their blob id. */
export async function listGeminiKeyRows() {
  const ids = (await listKeys("gk/")).sort();
  const rows = await Promise.all(ids.map(async (id) => ({ id, ...((await getJSON<{ key: string; at: number }>(id)) ?? { key: "", at: 0 }) })));
  return rows.filter((r) => r.key).sort((a, b) => a.at - b.at);
}

export async function removeGeminiKey(id: string) {
  await delKey(id);
  cache = null;
}

export async function storedGeminiKeys(): Promise<string[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.keys;
  const rows = await getMany<{ key: string }>(await listKeys("gk/"));
  cache = { at: Date.now(), keys: rows.map((r) => r.key) };
  return cache.keys;
}

async function worksWithGemini(key: string): Promise<boolean> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${key}`, {
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function addGeminiKey(
  raw: unknown,
): Promise<{ ok: true; added: boolean; total: number } | { ok: false; error: string }> {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!GEMINI_KEY_RE.test(key)) return { ok: false, error: "Key sahi format mein nahi hai (AIza... ya AQ. se shuru hoti hai)" };
  const id = `gk/${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  const known = await storedGeminiKeys();
  if (known.includes(key) || (await getJSON(id))) return { ok: true, added: false, total: known.length };
  if (known.length >= MAX_KEYS) return { ok: false, error: "Key pool full hai" };
  if (!(await worksWithGemini(key))) return { ok: false, error: "Ye key Gemini ne accept nahi ki, check karke dobara daalo" };
  await setJSON(id, { key, at: Date.now() });
  cache = null;
  return { ok: true, added: true, total: known.length + 1 };
}
