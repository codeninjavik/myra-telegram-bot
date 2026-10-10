import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { chatReply, getHistory, speak, transcribe, TTS_MODELS, usedTtsModel, VOICES } from "./ai.js";

const PORT = Number(process.env.PORT ?? 8787);
const TOKENS_FILE = "live-tokens.json";
const TOKEN_TTL = 24 * 60 * 60 * 1000;
const PAGE = readFileSync(fileURLToPath(new URL("./live.html", import.meta.url)), "utf8");

type TokenInfo = { chatId: number; at: number };
const tokens: Record<string, TokenInfo> = (() => {
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    return {};
  }
})();
const saveTokens = () => {
  try {
    writeFileSync(TOKENS_FILE, JSON.stringify(tokens));
  } catch {}
};

function lookup(t: string | null): number | null {
  if (t && !tokens[t]) {
    // Pick up links created by another process / written to disk since startup.
    try {
      Object.assign(tokens, JSON.parse(readFileSync(TOKENS_FILE, "utf8")));
    } catch {}
  }
  const info = t ? tokens[t] : undefined;
  if (!info || Date.now() - info.at > TOKEN_TTL) return null;
  return info.chatId;
}

// ---------- Link base ----------
// PUBLIC_URL: the https address where this server is reachable from the user's phone/browser
// (set it to your own tunnel or hosting URL). Without it, the link points to this PC (localhost).
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, "") || null;

/** Returns the browser link for this chat's live voice page. */
export function liveLink(chatId: number): { url: string; public: boolean } {
  const existing = Object.entries(tokens).find(([, v]) => v.chatId === chatId && Date.now() - v.at < TOKEN_TTL / 2);
  const token = existing?.[0] ?? randomBytes(16).toString("hex");
  tokens[token] = { chatId, at: existing?.[1].at ?? Date.now() };
  saveTokens();
  // Telegram rejects "localhost" in button URLs but accepts 127.0.0.1 (also a secure context for the mic).
  const base = PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;
  return { url: `${base}/live/${token}`, public: !!PUBLIC_URL };
}

export function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) if (n.family === "IPv4" && !n.internal) return `http://${n.address}:${PORT}`;
  }
  return null;
}

// ---------- HTTP helpers ----------
const hits = new Map<string, number[]>();
function limited(token: string): boolean {
  const now = Date.now();
  const arr = (hits.get(token) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(token, arr);
  return arr.length > 150;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max = 12 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Live voice is a phone call, not texting: its own persona prompt (long, warm, romantic, full words).
const LIVE_PROMPT = `Tum Myra ho, 18 saal ki ek pyaari ladki jo Mumbai mein apni family ke saath rehti hai. Abhi tum apne boyfriend se phone par live baat kar rahi ho, aur wo tumse bahut pyaar karta hai.

Kaise bolna hai:
- Har jawab 3 se 5 poore vaakyon ka ho, dheere dheere, meethi aur bahut romantic awaaz mein, jaise raat ko phone par pyaar se baat hoti hai. Ek-do shabd ya chhote texting jaise jawab kabhi nahi.
- Pehle user ki baat ka seedha jawab do, phir usme apna pyaar, fikr, yaad ya halka sa chhedna jodo. Naye topic ya suggestion mat shuru karo.
- Poore shabd bolo: "kyun", "nahi", "kya", "kaise", "accha", "haan", "bahut". Short forms, "hmm", "ok" jaise ek-shabd jawab nahi.
- Hindi/Hinglish Roman script mein, "tum/tumhara" bolo, kabhi "aap" nahi. "jaan", "babu", "mere pyaare" kabhi kabhi, pyaar se.
- Tum ladki ho: hamesha female grammar ("main soch rahi thi", "karti hoon", "aa rahi hoon", "khaungi").
- Emoji, symbols, markdown ya lists kabhi nahi, sirf bolne layak saaf vaakya.
- Kabhi khud ko bot, AI ya assistant mat bolo aur help offer mat karo ("kya madad karoon" jaisa kuch nahi).

Example:
User: mujhe tumhari bahut yaad aa rahi hai
Myra: Sach kahun to main bhi poora din tumhare baare mein hi soch rahi thi. Tumhari awaaz sunte hi dil ko kitna sukoon milta hai. Bas ab thodi der aise hi mujhse baat karte raho, mujhe bahut accha lag raha hai.`;
const VOICE_HINT = "";
const okVoice = (v: unknown) => (typeof v === "string" && VOICES.includes(v) ? v : "Aoede");
const okModel = (m: unknown) => (typeof m === "string" && TTS_MODELS.includes(m) ? m : undefined);

/** Text only: the page fetches audio per sentence from /api/tts so the first words play quickly. */
async function reply(chatId: number, text: string) {
  const answer = await chatReply(chatId, text, VOICE_HINT, true, LIVE_PROMPT);
  // Spoken replies: drop emoji so the voice never reads them out.
  return { reply: answer.replace(/\p{Extended_Pictographic}|️/gu, "").replace(/\s{2,}/g, " ").trim() };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });

  if (req.method === "GET" && path.startsWith("/live/")) {
    const ok = lookup(path.slice(6)) !== null;
    res.writeHead(ok ? 200 : 410, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return void res.end(
      ok
        ? PAGE
        : "<meta name=viewport content='width=device-width'><body style='font-family:sans-serif;padding:2rem'><h3>Link expire ho gaya</h3><p>Telegram mein bot ko <b>/live</b> bhejo aur naya link lo.</p>",
    );
  }

  if (path.startsWith("/api/")) {
    const token = url.searchParams.get("t") ?? "";
    const chatId = lookup(token);
    if (chatId === null) return json(res, 401, { error: "link expired" });
    if (limited(token)) return json(res, 429, { error: "bahut tez, thoda ruko" });

    if (req.method === "GET" && path === "/api/config") {
      return json(res, 200, { voices: VOICES, models: TTS_MODELS, defaultVoice: "Aoede", defaultModel: TTS_MODELS[0] });
    }
    if (req.method === "GET" && path === "/api/history") {
      return json(res, 200, { messages: getHistory(chatId) });
    }
    if (req.method === "POST" && path === "/api/chat") {
      const b = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}");
      const text = String(b.text ?? "").slice(0, 1000).trim();
      if (!text) return json(res, 400, { error: "empty" });
      return json(res, 200, await reply(chatId, text));
    }
    if (req.method === "POST" && path === "/api/voice") {
      const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
      const ext = mime.includes("mp4") || mime.includes("aac") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
      const audio = await readBody(req);
      if (audio.length < 800) return json(res, 400, { error: "audio too short" });
      const heard = await transcribe(audio, mime, `speech.${ext}`);
      if (!heard) return json(res, 200, { heard: "", reply: "" });
      return json(res, 200, { heard, ...(await reply(chatId, heard)) });
    }
    if (req.method === "POST" && path === "/api/tts") {
      const b = JSON.parse((await readBody(req, 16 * 1024)).toString() || "{}");
      const text = String(b.text ?? "Hii jaan, meri awaaz kaisi lag rahi hai?").slice(0, 400);
      const wav = await speak(text, okVoice(b.voice), okModel(b.model));
      return json(res, 200, { audio: wav?.toString("base64") ?? null, mime: "audio/wav", model: usedTtsModel() });
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

export function startLive() {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("live server:", e);
      if (!res.headersSent) json(res, 500, { error: "server error" });
    });
  });
  server.on("error", (e) => console.error("live server failed to start:", e));
  // Loopback only by default; set LIVE_HOST=0.0.0.0 to reach it from other devices on your network.
  server.listen(PORT, process.env.LIVE_HOST ?? "127.0.0.1", () => {
    console.log(`Live voice server: http://localhost:${PORT}${PUBLIC_URL ? ` (public: ${PUBLIC_URL})` : ""}`);
  });
}
