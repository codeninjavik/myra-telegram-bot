import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { storedGeminiKeys } from "./keystore.js";
import { getJSON, setJSON } from "./store.js";
import { KeyPool } from "./keys.js";
import { ASKED_NAME, ASSISTANT_TELLS, CANNED, SELF_INTRO, SUGGESTION_WORDS, SYSTEM_PROMPT, pick } from "./persona.js";

const groq = new KeyPool(process.env.GROQ_API_KEYS);
const gemini = new KeyPool(process.env.GEMINI_API_KEYS);
/** Keys from the GEMINI_API_KEYS env var plus the ones submitted on the live page. */
export async function hasGemini(): Promise<boolean> {
  return gemini.size > 0 || (await storedGeminiKeys()).length > 0;
}

const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

type Msg = { role: "user" | "assistant"; content: string };
/** Telegram shows replies as plain text, so strip Markdown the model sometimes emits (**bold**, # heading, `code`, - bullets). */
export function cleanText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/```[a-z]*\n?|```/gi, "")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?]|$)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Model "thinking out loud" in English ("User asked same again, we can answer...") must never reach the user. */
const META_LEAK =
  /\b(the user|user (asked|said|wants|is|says|repeat)|we (can|should|need|must|will)|should (respond|answer|reply)|no question|instruction|persona|the (reply|answer|response)|as myra|system prompt|hinglish)\b/i;

/** Drops leaked meta lines/sentences; returns "" if nothing sensible is left. */
export function scrubMeta(text: string): string {
  if (!META_LEAK.test(text)) return text;
  const kept = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .filter((s) => s.trim() && !META_LEAK.test(s));
  return kept.join(" ").trim();
}

/** Removes a closing question ("tum kya kar rahe ho?") when other text remains, so replies don't always end by asking. */
export function dropTrailingQuestion(text: string, strip: boolean): string {
  if (!strip) return text;
  const parts = text.split(/(?<=[.!?…])\s+/);
  if (parts.length < 2) return text;
  const last = parts[parts.length - 1];
  if (!/\?\W*$/.test(last)) return text;
  const kept = parts.slice(0, -1).join(" ").trim();
  return kept || text;
}

const MAX_TURNS = 40;

// Per-chat history lives in Netlify Blobs so every function invocation sees the whole conversation.
async function loadHistory(chatId: number): Promise<Msg[]> {
  const saved = (await getJSON<Msg[]>(`h/${chatId}`)) ?? [];
  return saved.map((m) => (m.role === "assistant" ? { ...m, content: scrubMeta(cleanText(m.content)) || m.content } : m));
}

export async function clearHistory(chatId: number) {
  await setJSON(`h/${chatId}`, []);
}

/** Masculine first-person verb forms; Myra is a girl and must say rahi/karti/gayi/jaungi. */
const MALE_SELF =
  /\b(raha (hoon|hu|hun)|karta (hoon|hu|hun)|gaya (hoon|hu|hun)|sunta (hoon|hu|hun)|jaata (hoon|hu|hun)|aata (hoon|hu|hun)|khata (hoon|hu|hun)|jaunga|aaunga|khaunga|karunga|bolunga|dunga|lunga|dekhunga|bataunga|sounga|pahunchunga|likhunga|rahunga|milunga|bhejunga|sochunga|chalunga|banunga|samjhunga|poochunga|maanunga)\b/i;

const EMOJI = /\p{Extended_Pictographic}/gu;
const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));

/** True when a reply copies the shape of the recent ones: same emoji again and again, or mostly the same words. */
function isRepetitive(reply: string, recent: string[]): boolean {
  if (!recent.length) return false;
  const rw = words(reply);
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const r of recent) {
    if (plain(r) === plain(reply)) return true; // exact repeat, even for one-word replies
    const ow = words(r);
    const common = [...rw].filter((w) => ow.has(w)).length;
    if (rw.size >= 2 && common / Math.max(rw.size, ow.size) >= 0.6) return true;
  }
  const e = reply.match(EMOJI)?.[0];
  if (e && recent.slice(-2).length === 2 && recent.slice(-2).every((r) => r.match(EMOJI)?.includes(e))) return true;
  return false;
}

const MEMORY_RULE =
  "\nPichli saari baatein (upar ki chat history) yaad rakho. Agar user pooche 'maine kya bola/pehle kya baat hui' to history dekhkar sahi sahi batao.";

// Chat models that work with both Gemini key formats ("AIza..." and the newer "AQ.…"). The 2.5 models are closed to new keys.
const GEMINI_CHAT_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-flash-lite-latest"];

type Attempt = { kind: "groq" | "gemini"; key: string; model: string };
type LlmOpts = { fast: boolean; temperature: number; maxTokens: number };

/** Groq keys first, then every Gemini key (env + the ones added on the live page), each with a model that fits. */
async function llmAttempts(): Promise<Attempt[]> {
  gemini.add(await storedGeminiKeys());
  return [
    ...groq.live().map((key, i): Attempt => ({ kind: "groq", key, model: GROQ_MODELS[i % GROQ_MODELS.length] })),
    ...gemini.live().map((key, i): Attempt => ({ kind: "gemini", key, model: GEMINI_CHAT_MODELS[i % GEMINI_CHAT_MODELS.length] })),
  ];
}

/** One chat completion. Returns the raw text, or "" when the key/model gave nothing (key is put on cooldown on errors). */
async function llmCall(a: Attempt, system: string, turns: Msg[], o: LlmOpts): Promise<string> {
  if (a.kind === "groq") {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${a.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: a.model,
        reasoning_effort: o.fast ? "low" : "medium", // medium understands slang better; live voice needs speed
        include_reasoning: false,
        messages: [{ role: "system", content: system }, ...turns],
        temperature: o.temperature,
        max_tokens: o.maxTokens,
      }),
    });
    if (!res.ok) {
      console.error("Groq", res.status, (await res.text()).slice(0, 120));
      groq.cooldown(a.key, res.status === 429 ? 60_000 : 10 * 60_000);
      return "";
    }
    const data: any = await res.json();
    if (!data?.choices?.[0]?.message?.content) console.error("Groq empty reply", a.model, data?.choices?.[0]?.finish_reason);
    return data?.choices?.[0]?.message?.content ?? "";
  }

  // Gemini wants roles user/model, starting with a user turn; merge neighbours with the same role.
  const contents: { role: string; parts: { text: string }[] }[] = [];
  for (const m of turns) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + m.content;
    else if (last || role === "user") contents.push({ role, parts: [{ text: m.content }] });
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${a.model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": a.key, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      // maxOutputTokens also covers the model's thinking, so keep it roomy
      generationConfig: { temperature: o.temperature, maxOutputTokens: Math.max(o.maxTokens, 1024) },
    }),
  });
  if (!res.ok) {
    console.error("Gemini chat", a.model, res.status, (await res.text()).slice(0, 120));
    gemini.cooldown(a.key, res.status === 429 ? 60_000 : 10 * 60_000);
    return "";
  }
  const data: any = await res.json();
  const text: string = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
  if (!text) console.error("Gemini empty reply", a.model, data?.candidates?.[0]?.finishReason);
  return text;
}

// ---------- realism: time of day, daily mood, what she remembers about each person ----------
const MOODS = [
  "bahut khush aur chulbuli",
  "thodi sleepy aur lazy",
  "romantic mood mein",
  "thodi naraz, par jaldi maan jaane wali",
  "energetic aur masti ke mood mein",
  "shaant aur thodi thoughtful",
];

/** Same mood all day for a chat, a different one tomorrow; plus the India time so "good night" fits the hour. */
function realismLine(chatId: number): string {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const h = ist.getUTCHours();
  const part = h < 5 ? "raat ka waqt" : h < 11 ? "subah" : h < 16 ? "dopahar" : h < 20 ? "shaam" : "raat";
  const seed = [...`${ist.toISOString().slice(0, 10)}:${chatId}`].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hh = String(h).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return (
    `\nAbhi India mein ${hh}:${mm} baje hain (${part}). Isi hisaab se natural raho (raat ko "so jao", subah "chai pi?"), par har baar waqt mat batao.` +
    `\nAaj tumhara mood: ${MOODS[seed % MOODS.length]}. Ise halke se dikhao, zabardasti nahi.`
  );
}

type Memory = { facts: string[]; n: number };
const memKey = (userId: number) => `mem/${userId}`;

async function memoryLine(userId: number): Promise<string> {
  const m = await getJSON<Memory>(memKey(userId));
  if (!m?.facts.length) return "";
  return `\nIs insaan ke baare mein tumhe ye yaad hai (sirf zaroorat par, natural tareeke se use karo, list ki tarah mat sunao): ${m.facts.join("; ")}.`;
}

export async function getMemory(userId: number): Promise<string[]> {
  return (await getJSON<Memory>(memKey(userId)))?.facts ?? [];
}

export async function clearMemory(userId: number) {
  await setJSON(memKey(userId), { facts: [], n: 0 });
}

export async function addMemory(userId: number, fact: string) {
  const m = (await getJSON<Memory>(memKey(userId))) ?? { facts: [], n: 0 };
  m.facts = [...m.facts.filter((f) => f !== fact), fact.slice(0, 120)].slice(-15);
  await setJSON(memKey(userId), m);
}

/**
 * Every 5th message from a person, Myra reads the latest chat and keeps lasting facts about them
 * (name, city, likes, work, birthday...). Call it after the reply has been sent. /memory shows them, /forgetme clears them.
 */
export async function learnAbout(userId: number, chatId: number): Promise<void> {
  const m = (await getJSON<Memory>(memKey(userId))) ?? { facts: [], n: 0 };
  m.n += 1;
  if (m.n % 5 !== 0) return void (await setJSON(memKey(userId), m));
  const recent = (await loadHistory(chatId)).slice(-10);
  const chat = recent.map((t) => `${t.role === "user" ? "User" : "Myra"}: ${t.content}`).join("\n");
  const system =
    "You extract durable personal facts about the USER from a chat. Output ONLY a JSON array of short Hinglish strings " +
    '(e.g. ["naam Rahul hai","Delhi mein rehta hai","cricket pasand hai"]). Include only clear facts the user stated about themselves ' +
    "(name, city, job/study, family, hobbies, likes/dislikes, birthday). No guesses, no feelings of the moment, no secrets like phone numbers, " +
    "passwords or addresses. Keep old facts that are still true. Max 15 items. If nothing, output the old list unchanged.";
  for (const attempt of await llmAttempts()) {
    try {
      const out = await llmCall(
        attempt,
        system,
        [{ role: "user", content: `Old facts: ${JSON.stringify(m.facts)}\n\nChat:\n${chat}` }],
        { fast: true, temperature: 0.1, maxTokens: 500 },
      );
      const json = out.match(/\[[\s\S]*\]/)?.[0];
      if (!json) continue;
      const facts = (JSON.parse(json) as unknown[])
        .filter((f): f is string => typeof f === "string")
        .map((f) => f.trim().slice(0, 120))
        .filter((f) => f && !/\d{8,}/.test(f)) // never keep long digit strings (phone numbers, ids)
        .slice(0, 15);
      m.facts = facts;
      break;
    } catch (e) {
      console.error("learnAbout error:", e);
    }
  }
  await setJSON(memKey(userId), m);
}

// ---------- Gemini Live (realtime voice in the browser) ----------
/**
 * The browser talks to Gemini Live directly, so it must not get a real API key. This mints a one-use,
 * short-lived token from a key in the pool; the token only works for the Live API and expires in minutes.
 */
export async function createLiveToken(): Promise<string | null> {
  gemini.add(await storedGeminiKeys());
  for (const key of gemini.live()) {
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          uses: 1,
          expireTime: new Date(Date.now() + 30 * 60_000).toISOString(), // session may run this long
          newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(), // but must be opened within 2 minutes
        }),
      });
      if (!res.ok) {
        console.error("auth_tokens", res.status, (await res.text()).slice(0, 100));
        gemini.cooldown(key, res.status === 429 ? 60_000 : 10 * 60_000);
        continue;
      }
      const name = ((await res.json()) as any)?.name;
      if (typeof name === "string" && name) return name;
    } catch (e) {
      console.error("createLiveToken error:", e);
    }
  }
  return null;
}

const PERSONAS: Record<string, string> = {
  romantic: "",
  friend: "\nAaj tum ek pakki dost ki tarah ho: apnapan, masti aur sachchi salah, pyaar bhari baatein kam, dosti wali zyada.",
  funny: "\nAaj tum bahut mazaakiya ho: halke jokes, chhedna aur masti, par kisi ko bura na lage.",
  calm: "\nAaj tum shaant aur samajhdaar ho: dheere, sukoon se, dhyan se sunne wali aur dilaasa dene wali.",
};

/** System prompt for a realtime session: persona + time/mood + what Myra remembers + the last turns of this chat. */
export async function realtimeSystem(chatId: number, base: string, persona = "romantic"): Promise<string> {
  const recent = (await loadHistory(chatId)).slice(-10);
  const history = recent.length
    ? "\nPichli baat-cheet (yaad rakho, dohrao mat):\n" +
      recent.map((t) => `${t.role === "user" ? "User" : "Myra"}: ${t.content.slice(0, 200)}`).join("\n")
    : "";
  return base + (PERSONAS[persona] ?? "") + realismLine(chatId) + (await memoryLine(chatId)) + history;
}

/** One finished live turn (what the person said, what Myra said) goes into the same history the chat uses. */
export async function appendTurn(chatId: number, user: string, assistant: string) {
  const turns = await loadHistory(chatId);
  if (user.trim()) turns.push({ role: "user", content: user.trim().slice(0, 1000) });
  if (assistant.trim()) turns.push({ role: "assistant", content: scrubMeta(cleanText(assistant)).slice(0, 1500) || assistant.trim().slice(0, 1500) });
  await setJSON(`h/${chatId}`, turns.slice(-MAX_TURNS));
}

/** Text reply via Groq, falling back to Gemini (rotates keys on 401/429/5xx). */
export async function chatReply(
  chatId: number,
  text: string,
  extraSystem = "",
  fast = false,
  systemOverride?: string,
  userId?: number,
): Promise<string> {
  const turns = await loadHistory(chatId);
  const realism = realismLine(chatId) + (userId ? await memoryLine(userId) : "");
  const plainText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // Same question asked again: remember how it was answered so the new answer is worded differently.
  let earlierAnswer = "";
  for (let i = turns.length - 2; i >= 0; i--) {
    if (turns[i].role === "user" && plainText(turns[i].content) === plainText(text) && turns[i + 1]?.role === "assistant") {
      earlierAnswer = turns[i + 1].content;
      break;
    }
  }
  turns.push({ role: "user", content: text });
  let nudge = earlierAnswer
    ? `\nIMPORTANT: user ne ye sawal pehle bhi pucha hai aur tumne kaha tha: "${earlierAnswer.slice(0, 200)}". Ab bilkul alag shabdon aur andaaz mein jawab do, wahi baat dohrao mat. Chaho to pyaar se chhedo ki "phir wahi sawal?" aur naye tareeke se batao.`
    : "";
  let retries = 0;
  for (const attempt of await llmAttempts()) {
    try {
      const raw = await llmCall(
        attempt,
        (systemOverride ?? SYSTEM_PROMPT) + MEMORY_RULE + realism + extraSystem + nudge,
        turns.slice(systemOverride ? -8 : -MAX_TURNS),
        { fast, temperature: 0.95, maxTokens: fast ? 500 : 700 },
      );
      const reply = scrubMeta(cleanText(raw));
      if (!reply) continue;
      const recent = turns.filter((m) => m.role === "assistant").slice(-8).map((m) => m.content);
      const problem =
        retries >= 2 ? null
        : ASSISTANT_TELLS.test(reply)
          ? "pichla reply assistant jaisa tha. Ab bilkul girlfriend ki tarah, chhota aur pyaara, bina help offer kiye bolo."
        : SELF_INTRO.test(reply) && !ASKED_NAME.test(text)
          ? "Tumne bina pooche apna naam/introduction de diya ('main Myra hoon'). Aisa kabhi mat bolo, bas user ki baat ka jawab do."
        : MALE_SELF.test(reply)
          ? "Tum ladki ho: apne liye hamesha female grammar use karo (rahi hoon, karti hoon, gayi, khaungi, aaungi, bolungi). 'raha/karta/gaya/jaunga' mat bolo."
        : /[ऀ-ॿ]/.test(reply)
          ? "Devanagari (हिंदी) script mat use karo. Sirf Roman Hinglish (English letters) mein likho."
        : SUGGESTION_WORDS.test(reply) && !SUGGESTION_WORDS.test(text)
          ? "pichle reply mein tumne bina pooche game/drama/movie jaisa suggest kiya. Sirf user ki baat ka natural jawab do, koi suggestion nahi."
        : isRepetitive(reply, recent)
          ? "pichle replies jaisa hi style/emoji/vaakya banawat hai. Ab bilkul alag tareeke se jawab do: alag emoji (ya bina emoji), alag shabd, user ki baat ke hisaab se."
        : null;
      if (problem) {
        // Regenerate with a firmer instruction (at most twice).
        retries += 1;
        nudge += `\nIMPORTANT: ${problem}`;
        continue;
      }
      const prev = [...turns].reverse().find((m) => m.role === "assistant")?.content ?? "";
      const final = dropTrailingQuestion(reply, /\?\W*$/.test(prev) || Math.random() < 0.6);
      turns.push({ role: "assistant", content: final });
      await setJSON(`h/${chatId}`, turns.slice(-MAX_TURNS));
      return final;
    } catch (e) {
      console.error("LLM error:", e);
    }
  }
  turns.pop();
  return pick(CANNED);
}

/** Stateless one-off generation in Myra's voice (used by /commands). Returns fallback on failure. */
export async function oneShot(task: string, fallback: string): Promise<string> {
  const prompt: Msg[] = [
    { role: "user", content: `[Task, chat message nahi] ${task}\nSirf final message likho, Myra ki tarah, Hinglish mein.` },
  ];
  for (const attempt of await llmAttempts()) {
    try {
      const out = scrubMeta(cleanText(await llmCall(attempt, SYSTEM_PROMPT, prompt, { fast: true, temperature: 1, maxTokens: 500 })));
      if (out) return out;
    } catch (e) {
      console.error("oneShot error:", e);
    }
  }
  return fallback;
}

/** Speech-to-text for incoming voice notes (Groq Whisper). */
export async function transcribe(audio: Buffer, mime = "audio/ogg", filename = "voice.ogg"): Promise<string | null> {
  for (const key of groq.live()) {
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), filename);
      form.append("model", "whisper-large-v3-turbo");
      const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) {
        groq.cooldown(key, 60_000);
        continue;
      }
      const data: any = await res.json();
      return (data?.text as string)?.trim() || null;
    } catch (e) {
      console.error("Whisper error:", e);
    }
  }
  // No Groq key left (or all failed): Gemini can transcribe audio too.
  const out = await geminiMedia(
    "Transcribe this audio exactly as spoken, in the original language (Hinglish in Roman letters if Hindi). Output only the transcript.",
    audio,
    mime.split(";")[0] || "audio/ogg",
  );
  return out?.trim() || null;
}

/** One Gemini call with an inline file (image or audio). Tries every key and model; returns null if all fail. */
async function geminiMedia(prompt: string, data: Buffer, mime: string, system?: string): Promise<string | null> {
  gemini.add(await storedGeminiKeys());
  for (const [i, key] of gemini.live().entries()) {
    const model = GEMINI_CHAT_MODELS[i % GEMINI_CHAT_MODELS.length];
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: data.toString("base64") } }, { text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 1500 },
        }),
      });
      if (!res.ok) {
        console.error("Gemini media", model, res.status, (await res.text()).slice(0, 100));
        gemini.cooldown(key, res.status === 429 ? 60_000 : 10 * 60_000);
        continue;
      }
      const j: any = await res.json();
      const text: string = (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      if (text.trim()) return text;
    } catch (e) {
      console.error("Gemini media error:", e);
    }
  }
  return null;
}

/** Myra looks at a photo and answers in her own style. Null when no Gemini key works. */
export async function describeImage(image: Buffer, mime: string, question: string): Promise<string | null> {
  const ask = question.trim() || "Is photo mein kya hai? Apne andaaz mein batao.";
  const out = await geminiMedia(
    `User ne ye photo bheji hai aur kaha: "${ask}". Photo dekhkar usi ke hisaab se Myra ki tarah jawab do. Chhota (2-4 vaakya), Hinglish, bina markdown.`,
    image,
    mime,
    SYSTEM_PROMPT,
  );
  return out ? scrubMeta(cleanText(out)) : null;
}

/** Plain translation (no persona). `to` can be a code ("hi") or a name ("hindi"). */
export async function translate(text: string, to: string): Promise<string | null> {
  const system =
    "You are a translation engine. Translate the user's text into the target language and output ONLY the translation, " +
    "no quotes, no explanations. If the target is Hindi, write in Devanagari unless the target is given as 'hinglish'.";
  for (const attempt of await llmAttempts()) {
    try {
      const out = await llmCall(attempt, system, [{ role: "user", content: `Target language: ${to}\n\nText:\n${text}` }], {
        fast: true,
        temperature: 0.2,
        maxTokens: 800,
      });
      if (out.trim()) return out.trim();
    } catch (e) {
      console.error("translate error:", e);
    }
  }
  return null;
}

// Same voice models the earlier Zara bot used, plus the public preview names as fallback.
const TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-tts",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
  "gemini-3.8-flash-tts",
];

function pcmToWav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Netlify has no system ffmpeg. The site is deployed from Windows, where ffmpeg-static would only bring an .exe,
 * so the Linux build comes from its own package. Zip files lose the executable bit, hence the copy to /tmp.
 */
function ffmpegBin(): string {
  const req = createRequire(import.meta.url);
  if (process.platform === "linux") {
    try {
      const dst = "/tmp/ffmpeg";
      if (!existsSync(dst)) {
        copyFileSync(join(dirname(req.resolve("@ffmpeg-installer/linux-x64/package.json")), "ffmpeg"), dst);
        chmodSync(dst, 0o755);
      }
      return dst;
    } catch (e) {
      console.error("bundled linux ffmpeg unavailable:", e);
    }
  }
  return "ffmpeg"; // local development: whatever is on PATH
}

/** Telegram only renders a proper voice bubble (with duration) for OGG/Opus; WAV shows 0:00. */
export function toOggOpus(wav: Buffer): { data: Buffer; name: string } {
  try {
    const r = spawnSync(
      ffmpegBin(),
      ["-v", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"],
      { input: wav, maxBuffer: 32 * 1024 * 1024 },
    );
    if (r.status === 0 && r.stdout.length > 100) return { data: r.stdout, name: "myra.ogg" };
    console.error("ffmpeg failed:", r.stderr?.toString().slice(0, 200));
  } catch (e) {
    console.error("ffmpeg unavailable:", e);
  }
  return { data: wav, name: "myra.wav" };
}

let goodModel: string | null = null;
let lastUsedModel: string | null = null;
export const usedTtsModel = () => lastUsedModel;

export { TTS_MODELS };
export const VOICES = [
  "Aoede", "Kore", "Leda", "Callirrhoe", "Autonoe", "Despina", "Erinome", "Laomedeia", "Achernar", "Pulcherrima",
  "Gacrux", "Vindemiatrix", "Sulafat", "Zephyr", "Puck", "Charon", "Fenrir", "Orus", "Enceladus", "Iapetus",
  "Umbriel", "Algieba", "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Achird", "Zubenelgenubi", "Sadachbia", "Sadaltager",
];

export async function getHistory(chatId: number): Promise<{ role: string; content: string }[]> {
  return (await loadHistory(chatId)).slice(-30);
}

/** Gemini TTS -> WAV buffer, or null if every model/key fails. */
export async function speak(text: string, voiceName = "Aoede", preferredModel?: string): Promise<Buffer | null> {
  const clean = text.replace(/\p{Extended_Pictographic}|️/gu, "").trim();
  if (!clean) return null;
  gemini.add(await storedGeminiKeys());
  const first = preferredModel && TTS_MODELS.includes(preferredModel) ? preferredModel : goodModel;
  const models = first ? [first, ...TTS_MODELS.filter((m) => m !== first)] : TTS_MODELS;
  for (const model of models) {
    for (const key of gemini.live()) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Say warmly, in a natural sweet young Indian girl voice: ${clean}` }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
              },
            }),
          },
        );
        if (res.status === 404) break; // model not available -> try next model
        if (!res.ok) {
          console.error(`TTS ${model} ${res.status}`);
          if (res.status === 429 || res.status === 400 || res.status === 403) gemini.cooldown(key, 60_000);
          continue;
        }
        const data: any = await res.json();
        const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
        const b64: string | undefined = parts.find((p) => p.inlineData)?.inlineData?.data;
        if (!b64) continue;
        goodModel = model;
        lastUsedModel = model;
        return pcmToWav(Buffer.from(b64, "base64"));
      } catch (e) {
        console.error("TTS error:", e);
      }
    }
  }
  return null;
}
