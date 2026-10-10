import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { KeyPool } from "./keys.js";
import { ASKED_NAME, ASSISTANT_TELLS, CANNED, SELF_INTRO, SUGGESTION_WORDS, SYSTEM_PROMPT, pick } from "./persona.js";

const groq = new KeyPool(process.env.GROQ_API_KEYS);
const gemini = new KeyPool(process.env.GEMINI_API_KEYS);
export const hasGemini = gemini.size > 0;

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

const HISTORY_FILE = "history.json";
const MAX_TURNS = 40;

// Persisted to disk so restarts don't make Myra forget the conversation.
const history = new Map<number, Msg[]>();
try {
  const saved = JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as Record<string, Msg[]>;
  for (const [id, msgs] of Object.entries(saved)) {
    history.set(Number(id), msgs.map((m) => (m.role === "assistant" ? { ...m, content: scrubMeta(cleanText(m.content)) || m.content } : m)));
  }
} catch {}

function saveHistory() {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(history)));
  } catch (e) {
    console.error("history save failed:", e);
  }
}

export function clearHistory(chatId: number) {
  history.delete(chatId);
  saveHistory();
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

/** Text reply via Groq (rotates keys on 401/429/5xx). */
export async function chatReply(
  chatId: number,
  text: string,
  extraSystem = "",
  fast = false,
  systemOverride?: string,
): Promise<string> {
  const turns = history.get(chatId) ?? [];
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
  for (const [i, key] of groq.live().entries()) {
    const modelIdx = i % GROQ_MODELS.length;
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GROQ_MODELS[modelIdx],
          reasoning_effort: fast ? "low" : "medium", // medium understands slang better; live voice needs speed
          include_reasoning: false,
          messages: [{ role: "system", content: (systemOverride ?? SYSTEM_PROMPT) + MEMORY_RULE + extraSystem + nudge }, ...turns.slice(systemOverride ? -8 : -MAX_TURNS)],
          temperature: 0.95,
          max_tokens: fast ? 500 : 700,
        }),
      });
      if (!res.ok) {
        console.error("Groq", res.status, (await res.text()).slice(0, 120));
        groq.cooldown(key, res.status === 429 ? 60_000 : 10 * 60_000);
        continue;
      }
      const data: any = await res.json();
      const reply: string | undefined = scrubMeta(cleanText(data?.choices?.[0]?.message?.content));
      if (!reply) {
        console.error("Groq empty reply", GROQ_MODELS[modelIdx], data?.choices?.[0]?.finish_reason);
        continue;
      }
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
      history.set(chatId, turns.slice(-MAX_TURNS));
      saveHistory();
      return final;
    } catch (e) {
      console.error("Groq error:", e);
    }
  }
  turns.pop();
  return pick(CANNED);
}

/** Stateless one-off generation in Myra's voice (used by /commands). Returns fallback on failure. */
export async function oneShot(task: string, fallback: string): Promise<string> {
  for (const [i, key] of groq.live().entries()) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GROQ_MODELS[i % GROQ_MODELS.length],
          reasoning_effort: "low",
          include_reasoning: false,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `[Task, chat message nahi] ${task}\nSirf final message likho, Myra ki tarah, Hinglish mein.` },
          ],
          temperature: 1,
          max_tokens: 500,
        }),
      });
      if (!res.ok) {
        groq.cooldown(key, res.status === 429 ? 60_000 : 10 * 60_000);
        continue;
      }
      const data: any = await res.json();
      const out: string | undefined = scrubMeta(cleanText(data?.choices?.[0]?.message?.content));
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
  return null;
}

// Same voice models the earlier Zara bot used, plus the public preview names as fallback.
const TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-pro-tts",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
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

/** Telegram only renders a proper voice bubble (with duration) for OGG/Opus; WAV shows 0:00. */
export function toOggOpus(wav: Buffer): { data: Buffer; name: string } {
  try {
    const r = spawnSync(
      "ffmpeg",
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

export function getHistory(chatId: number): { role: string; content: string }[] {
  return (history.get(chatId) ?? []).slice(-30);
}

/** Gemini TTS -> WAV buffer, or null if every model/key fails. */
export async function speak(text: string, voiceName = "Aoede", preferredModel?: string): Promise<Buffer | null> {
  const clean = text.replace(/\p{Extended_Pictographic}|️/gu, "").trim();
  if (!clean) return null;
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
