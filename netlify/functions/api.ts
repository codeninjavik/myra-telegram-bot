import type { Context } from "@netlify/functions";
import { handleApi } from "../../src/live.js";
import { flush } from "../../src/store.js";

// Backend of the live voice page (public/live.html): chat, voice upload, text-to-speech.
export default async (req: Request, context: Context): Promise<Response> => {
  try {
    return await handleApi(req, context.geo?.country?.code);
  } catch (e) {
    console.error("live api:", e);
    return new Response(JSON.stringify({ error: "server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  } finally {
    await flush();
  }
};

export const config = { path: "/api/*" };
