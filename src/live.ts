import { randomBytes } from "node:crypto";
import {
  addMemory, appendTurn, chatReply, clearMemory, createLiveToken, getHistory, getMemory, learnAbout,
  realtimeSystem, speak, transcribe, TTS_MODELS, usedTtsModel, VOICES,
} from "./ai.js";
import { addGeminiKey } from "./keystore.js";
import { getJSON, setJSON } from "./store.js";

// Live voice page: /live/<token> is the static page (public/live.html), /api/* is handled by handleApi().
// Tokens map a link to a Telegram chat: "t/<token>" -> { chatId, at }, "tc/<chatId>" -> token (to reuse a fresh link).
const TOKEN_TTL = 24 * 60 * 60 * 1000;
type TokenInfo = { chatId: number; at: number };

// The https address of this site. Set PUBLIC_URL, or the webhook function fills it from the request it receives.
let publicBase = process.env.PUBLIC_URL?.replace(/\/$/, "") || "";
export function setPublicUrl(origin: string) {
  if (!process.env.PUBLIC_URL) publicBase = origin.replace(/\/$/, "");
}

/** Returns the browser link for this chat's live voice page. */
export async function liveLink(chatId: number): Promise<{ url: string }> {
  let token = await getJSON<string>(`tc/${chatId}`);
  const info = token ? await getJSON<TokenInfo>(`t/${token}`) : null;
  if (!token || !info || Date.now() - info.at > TOKEN_TTL / 2) {
    token = randomBytes(16).toString("hex");
    await Promise.all([setJSON(`t/${token}`, { chatId, at: Date.now() }), setJSON(`tc/${chatId}`, token)]);
  }
  return { url: `${publicBase}/live/${token}` };
}

async function lookup(token: string): Promise<number | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const info = await getJSON<TokenInfo>(`t/${token}`);
  if (!info || Date.now() - info.at > TOKEN_TTL) return null;
  return info.chatId;
}

// Best-effort limiter: only counts requests that land on the same warm instance.
const hits = new Map<string, number[]>();
function limited(token: string): boolean {
  const now = Date.now();
  const arr = (hits.get(token) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(token, arr);
  return arr.length > 150;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

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
// Live models that speak natively, fastest first. The page tries them in order if one is refused.
const LIVE_MODELS = ["gemini-3.1-flash-live-preview", "gemini-3.8-live", "gemini-2.5-flash-native-audio-preview-12-2025"];
const REALTIME_RULES = `

Ye live baat-cheet hai: user beech mein bol sakta hai, to jawab chhote rakho (1 se 3 vaakya) aur rokne par turant ruk jao.
Agar user kuch dhoondhne, YouTube par chalane ya website kholne ko kahe to tools use karo. Mausam poochhe to get_weather tool use karo.
User apne baare mein kuch pakka bataye (naam, shehar, pasand) to remember tool se yaad rakh lo.`;
const VOICE_HINT = "";
const okVoice = (v: unknown) => (typeof v === "string" && VOICES.includes(v) ? v : "Aoede");
const okModel = (m: unknown) => (typeof m === "string" && TTS_MODELS.includes(m) ? m : undefined);

/** Text only: the page fetches audio per sentence from /api/tts so the first words play quickly. */
async function reply(chatId: number, text: string) {
  const answer = await chatReply(chatId, text, VOICE_HINT, true, LIVE_PROMPT, chatId);
  // Spoken replies: drop emoji so the voice never reads them out.
  return { reply: answer.replace(/\p{Extended_Pictographic}|️/gu, "").replace(/\s{2,}/g, " ").trim() };
}

const WMO = (c: number) =>
  c === 0 ? "saaf aasmaan" : c <= 3 ? "thode baadal" : c <= 48 ? "kohra" : c <= 57 ? "halki bundaa-baandi" : c <= 67 ? "baarish"
  : c <= 77 ? "barf" : c <= 82 ? "baarish ki bauchhaar" : c >= 95 ? "toofan aur bijli" : "mausam badalta hua";

/** Current weather from Open-Meteo (no key). By city name, or by coordinates from the browser. */
async function weather(city: string | null, lat: string | null, lon: string | null) {
  try {
    let la = Number(lat), lo = Number(lon), place = "";
    if (city) {
      const g: any = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city.slice(0, 60))}&count=1&language=en`, { signal: AbortSignal.timeout(6000) })).json();
      const r = g?.results?.[0];
      if (!r) return { error: `"${city}" shehar nahi mila` };
      la = r.latitude; lo = r.longitude; place = [r.name, r.country].filter(Boolean).join(", ");
    } else if (!Number.isFinite(la) || !Number.isFinite(lo) || !lat || !lon) {
      return { error: "shehar ka naam batao" };
    }
    const f: any = await (await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`,
      { signal: AbortSignal.timeout(6000) },
    )).json();
    const c = f?.current;
    if (!c) return { error: "mausam ka data nahi mila" };
    return {
      place: place || "aapki location",
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_percent: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      condition: WMO(Number(c.weather_code)),
    };
  } catch {
    return { error: "mausam abhi nahi mil paya" };
  }
}

async function jsonBody(req: Request, max: number): Promise<any> {
  const text = await req.text();
  if (text.length > max) throw new Error("too large");
  return JSON.parse(text || "{}");
}

export async function handleApi(req: Request, country?: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/health") return json(200, { ok: true });

  const token = url.searchParams.get("t") ?? "";
  const chatId = await lookup(token);
  if (chatId === null) return json(401, { error: "link expired" });
  if (limited(token)) return json(429, { error: "bahut tez, thoda ruko" });

  if (req.method === "GET" && path === "/api/config") {
    return json(200, { voices: VOICES, models: TTS_MODELS, defaultVoice: "Aoede", defaultModel: TTS_MODELS[0] });
  }
  if (req.method === "GET" && path === "/api/history") {
    if (country) void setJSON(`g/${chatId}`, { country, at: Date.now() }); // once per page load, for /users
    return json(200, { messages: await getHistory(chatId) });
  }
  if (req.method === "GET" && path === "/api/weather") {
    return json(200, await weather(url.searchParams.get("city"), url.searchParams.get("lat"), url.searchParams.get("lon")));
  }
  // Realtime voice: the browser connects to Gemini Live itself with a short-lived token minted here.
  if (req.method === "POST" && path === "/api/live-token") {
    const b = await jsonBody(req, 4 * 1024);
    const accessToken = await createLiveToken();
    if (!accessToken) return json(503, { error: "Gemini key available nahi ya limit khatam, thodi der baad try karo" });
    const persona = typeof b.persona === "string" ? b.persona : "romantic";
    return json(200, {
      token: accessToken,
      models: LIVE_MODELS,
      voice: okVoice(b.voice),
      system: await realtimeSystem(chatId, LIVE_PROMPT + REALTIME_RULES, persona),
    });
  }
  if (req.method === "POST" && path === "/api/live-turn") {
    const b = await jsonBody(req, 16 * 1024);
    const user = String(b.user ?? "").slice(0, 1000);
    const assistant = String(b.assistant ?? "").slice(0, 1500);
    if (user.trim() || assistant.trim()) {
      await appendTurn(chatId, user, assistant);
      await learnAbout(chatId, chatId).catch((e) => console.error("learnAbout:", e));
    }
    return json(200, { ok: true });
  }
  if (req.method === "GET" && path === "/api/memory") return json(200, { facts: await getMemory(chatId) });
  if (req.method === "POST" && path === "/api/memory") {
    const b = await jsonBody(req, 2 * 1024);
    const fact = String(b.fact ?? "").trim().slice(0, 120);
    if (!fact || /\d{8,}/.test(fact)) return json(400, { error: "invalid" });
    await addMemory(chatId, fact);
    return json(200, { ok: true });
  }
  if (req.method === "POST" && path === "/api/memory/clear") {
    await clearMemory(chatId);
    return json(200, { ok: true });
  }
  if (req.method === "POST" && path === "/api/gemini-key") {
    const b = await jsonBody(req, 4 * 1024);
    const r = await addGeminiKey(b.key);
    return json(r.ok ? 200 : 400, r);
  }
  if (req.method === "POST" && path === "/api/chat") {
    const b = await jsonBody(req, 64 * 1024);
    const text = String(b.text ?? "").slice(0, 1000).trim();
    if (!text) return json(400, { error: "empty" });
    return json(200, await reply(chatId, text));
  }
  if (req.method === "POST" && path === "/api/voice") {
    const mime = String(req.headers.get("content-type") ?? "audio/webm").split(";")[0];
    const ext = mime.includes("mp4") || mime.includes("aac") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
    const audio = Buffer.from(await req.arrayBuffer());
    if (audio.length < 800) return json(400, { error: "audio too short" });
    const heard = await transcribe(audio, mime, `speech.${ext}`);
    if (!heard) return json(200, { heard: "", reply: "" });
    return json(200, { heard, ...(await reply(chatId, heard)) });
  }
  if (req.method === "POST" && path === "/api/tts") {
    const b = await jsonBody(req, 16 * 1024);
    const text = String(b.text ?? "Hii jaan, meri awaaz kaisi lag rahi hai?").slice(0, 400);
    const wav = await speak(text, okVoice(b.voice), okModel(b.model));
    return json(200, { audio: wav?.toString("base64") ?? null, mime: "audio/wav", model: usedTtsModel() });
  }
  return json(404, { error: "not found" });
}
