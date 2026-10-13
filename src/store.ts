import { getStore } from "@netlify/blobs";

// Netlify functions are stateless and may run in parallel, so everything that must survive lives in Netlify Blobs
// (one JSON value per key). Writes are collected and awaited by flush() before the function returns.
const blobs = () => getStore({ name: "myra", consistency: "strong" });
const pending = new Set<Promise<unknown>>();

// Tests set MYRA_MEM_STORE=1 to run against an in-memory store with the same compare-and-swap semantics.
const mem = new Map<string, { v: string; etag: number }>();
let memEtag = 0;
const useMem = () => process.env.MYRA_MEM_STORE === "1";

export async function getJSON<T>(key: string): Promise<T | null> {
  if (useMem()) {
    const e = mem.get(key);
    return e ? (JSON.parse(e.v) as T) : null;
  }
  return ((await blobs().get(key, { type: "json" })) as T | null) ?? null;
}

export function setJSON(key: string, value: unknown): Promise<void> {
  if (useMem()) {
    mem.set(key, { v: JSON.stringify(value), etag: ++memEtag });
    return Promise.resolve();
  }
  const p: Promise<void> = blobs()
    .setJSON(key, value)
    .then(() => undefined)
    .catch((e) => console.error(`blob write ${key} failed:`, e))
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

export async function delKey(key: string): Promise<void> {
  if (useMem()) {
    mem.delete(key);
    return;
  }
  await blobs().delete(key);
}

export async function listKeys(prefix: string): Promise<string[]> {
  if (useMem()) return [...mem.keys()].filter((k) => k.startsWith(prefix)).sort();
  const out: string[] = [];
  for await (const page of blobs().list({ prefix, paginate: true })) out.push(...page.blobs.map((b) => b.key));
  return out;
}

/**
 * Creates `key` only if it does not exist yet. Returns false when it was already there. This is the idempotency
 * primitive: a retried webhook or a double tap creates the same key a second time and gets false.
 */
export async function createOnce(key: string, value: unknown): Promise<boolean> {
  if (useMem()) {
    if (mem.has(key)) return false;
    mem.set(key, { v: JSON.stringify(value), etag: ++memEtag });
    return true;
  }
  const r = await blobs().setJSON(key, value, { onlyIfNew: true });
  return r.modified;
}

/**
 * Atomic read-modify-write. `fn` receives the current value (or null) and returns the new one, or undefined to
 * leave it unchanged. Concurrent writers are detected through the ETag and retried, so no update is lost.
 */
export async function casUpdate<T>(key: string, fn: (cur: T | null) => T | undefined | Promise<T | undefined>, tries = 40): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    if (useMem()) {
      const e = mem.get(key);
      const cur = e ? (JSON.parse(e.v) as T) : null;
      const next = await fn(cur ? structuredClone(cur) : null);
      if (next === undefined) return cur;
      const now = mem.get(key); // changed while fn awaited: retry like a failed ETag match
      if ((now?.etag ?? 0) !== (e?.etag ?? 0)) {
        await new Promise((res) => setTimeout(res, Math.random() * 4));
        continue;
      }
      mem.set(key, { v: JSON.stringify(next), etag: ++memEtag });
      return next;
    }
    const entry = await blobs().getWithMetadata(key, { type: "json" });
    const cur = (entry?.data as T | undefined) ?? null;
    const next = await fn(cur ? structuredClone(cur) : null);
    if (next === undefined) return cur;
    const r = entry ? await blobs().setJSON(key, next, { onlyIfMatch: entry.etag }) : await blobs().setJSON(key, next, { onlyIfNew: true });
    if (r.modified) return next;
    await new Promise((res) => setTimeout(res, 10 + Math.random() * Math.min(400, 30 * (i + 1))));
  }
  throw new Error(`casUpdate(${key}): too much contention`);
}

/** Reads many keys, a few at a time. Missing keys are skipped. */
export async function getMany<T>(keys: string[], concurrency = 16): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
      while (i < keys.length) {
        const v = await getJSON<T>(keys[i++]);
        if (v) out.push(v);
      }
    }),
  );
  return out;
}

/** Waits for every write started during this invocation. Call before returning from a function. */
export async function flush() {
  while (pending.size) await Promise.allSettled([...pending]);
}
