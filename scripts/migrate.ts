// One-off: copies the old local data (myra.db, gate.json, history.json, modstate.json, live-tokens skipped)
// into the Netlify Blobs store the deployed site uses.
//
//   NETLIFY_SITE_ID=<site id> NETLIFY_AUTH_TOKEN=<personal access token> npm run migrate [-- <folder with the old files>]
import { getStore } from "@netlify/blobs";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error("Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN first.");
  process.exit(1);
}
const store = getStore({ name: "myra", siteID, token, consistency: "strong" });
const file = (n: string) => join(dir, n);
let written = 0;
const put = async (key: string, value: unknown) => {
  await store.setJSON(key, value);
  written++;
};

if (existsSync(file("myra.db"))) {
  const db = new DatabaseSync(file("myra.db"), { readOnly: true });
  const act = new Map<number, { day: string; pts: number }>();
  try {
    for (const a of db.prepare("select user_id, day, pts from activity order by day").all() as any[]) act.set(a.user_id, { day: a.day, pts: a.pts });
  } catch {}
  for (const u of db.prepare("select * from users").all() as any[]) {
    const a = act.get(u.id);
    await put(`u/${u.id}`, {
      id: u.id, first_name: u.first_name, username: u.username, first_seen: u.first_seen, last_seen: u.last_seen,
      messages: u.messages, dm_started: u.dm_started, verified: u.verified, verified_at: u.verified_at,
      points: u.points ?? 0, referred_by: u.referred_by ?? null, ref_rewarded: u.ref_rewarded ?? 0,
      act_day: a?.day ?? "", act_pts: a?.pts ?? 0,
    });
  }
  for (const c of db.prepare("select * from chats").all() as any[]) await put(`c/${c.id}`, c);
  for (const j of db.prepare("select * from joins").all() as any[]) await put(`j/${j.group_id}/${j.at}-${j.user_id}`, 1);
  for (const s of db.prepare("select * from snapshots").all() as any[]) await put(`s/${s.group_id}/${s.day}`, { members: s.members });
  db.close();
}

if (existsSync(file("gate.json"))) await put("gate", JSON.parse(readFileSync(file("gate.json"), "utf8")));

if (existsSync(file("history.json"))) {
  for (const [chatId, msgs] of Object.entries(JSON.parse(readFileSync(file("history.json"), "utf8")))) await put(`h/${chatId}`, msgs);
}

if (existsSync(file("modstate.json"))) {
  for (const [chatId, cfg] of Object.entries(JSON.parse(readFileSync(file("modstate.json"), "utf8")))) await put(`m/${chatId}`, cfg);
}

console.log(`Done: ${written} records copied.`);
