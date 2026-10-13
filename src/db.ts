import { getJSON, getMany, listKeys, setJSON } from "./store.js";

// Users, chats, joins and daily member-count snapshots, stored as Netlify Blobs:
//   u/<userId>  user + points   c/<chatId>  group   j/<groupId>/<ts>-<userId>  join   s/<groupId>/<day>  snapshot
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const today = () => new Date().toISOString().slice(0, 10);

type TgUser = { id: number; first_name?: string; username?: string; language_code?: string };

export type UserRow = {
  id: number; first_name: string | null; username: string | null;
  first_seen: number; last_seen: number; messages: number; dm_started: number;
  verified: number; verified_at: number | null;
  points: number; referred_by: number | null; ref_rewarded: number;
  act_day: string; act_pts: number;
  lang?: string | null; // Telegram app language; Telegram never reveals a user's country
};
export type ChatRow = {
  id: number; title: string | null; type: string; added_at: number; last_seen: number;
  status?: "active" | "removed"; // whether Myra is still in the chat (set from my_chat_member and checked in /stats)
  role?: "admin" | "member";
  removed_at?: number;
  username?: string | null; // public @username, for a t.me link
  link?: string | null; // invite link Telegram reports to the bot (private groups)
  members?: number; // member count when /stats last looked
};

const getUser = (id: number) => getJSON<UserRow>(`u/${id}`);
const putUser = (u: UserRow) => setJSON(`u/${u.id}`, u);
const allUsers = async () => getMany<UserRow>(await listKeys("u/"));

export async function touchUser(u: TgUser, opts: { message?: boolean; dm?: boolean } = {}) {
  const t = now();
  const row: UserRow = (await getUser(u.id)) ?? {
    id: u.id, first_name: null, username: null, first_seen: t, last_seen: t, messages: 0, dm_started: 0,
    verified: 0, verified_at: null, points: 0, referred_by: null, ref_rewarded: 0, act_day: "", act_pts: 0,
  };
  row.first_name = u.first_name ?? null;
  row.username = u.username ?? null;
  row.lang = u.language_code ?? row.lang ?? null;
  row.last_seen = t;
  if (opts.message) row.messages += 1;
  if (opts.dm) row.dm_started = 1;
  await putUser(row);
}

export const getUserRow = (id: number) => getUser(id);

/** Looks a person up by @username among everyone Myra has seen (Telegram cannot resolve user names for bots). */
export async function findUserByUsername(username: string) {
  const n = username.replace(/^@/, "").toLowerCase();
  return (await allUsers()).find((u) => u.username?.toLowerCase() === n) ?? null;
}

export async function touchChat(c: { id: number; title?: string; type: string; username?: string }) {
  const t = now();
  const old = await getJSON<ChatRow>(`c/${c.id}`);
  // An update from the chat means Myra is in it, so a "removed" mark from earlier is no longer true.
  await setJSON(`c/${c.id}`, {
    ...old, id: c.id, title: c.title ?? old?.title ?? null, type: c.type, added_at: old?.added_at ?? t, last_seen: t,
    username: c.username ?? old?.username, status: "active", removed_at: undefined,
  });
}

/** Records that Myra was added to / removed from a chat (my_chat_member) or found gone when /stats checked. */
export async function setChatStatus(
  c: { id: number; title?: string | null; type: string },
  status: "active" | "removed",
  role?: "admin" | "member",
) {
  const t = now();
  const old = await getJSON<ChatRow>(`c/${c.id}`);
  if (old?.status === status && (status === "removed" || old.role === role)) return;
  await setJSON(`c/${c.id}`, {
    ...old, id: c.id, title: c.title ?? old?.title ?? null, type: c.type, added_at: old?.added_at ?? t, last_seen: old?.last_seen ?? t,
    status, role: status === "active" ? role ?? old?.role : undefined,
    removed_at: status === "removed" ? old?.removed_at ?? t : undefined,
  });
}

/** Link and size details learned while Myra could still see the chat. */
export async function setChatInfo(id: number, info: { username?: string | null; link?: string | null; members?: number }) {
  const old = await getJSON<ChatRow>(`c/${id}`);
  if (old) await setJSON(`c/${id}`, { ...old, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) });
}

export async function allChats() {
  return getMany<ChatRow>(await listKeys("c/"));
}

/** How many people opened the live voice page (a link is made per chat, valid for a day). */
export async function liveStats() {
  const [people, tokens] = await Promise.all([
    listKeys("tc/"),
    listKeys("t/").then((k) => getMany<{ chatId: number; at: number }>(k)),
  ]);
  const since = Date.now() - 24 * 3600_000;
  return { total: people.length, last24h: new Set(tokens.filter((x) => x.at > since).map((x) => x.chatId)).size };
}

export async function markVerified(userId: number) {
  const u = await getUser(userId);
  if (!u) return;
  u.verified = 1;
  u.verified_at ??= now();
  await putUser(u);
}

export async function recordJoin(groupId: number, userId: number) {
  await setJSON(`j/${groupId}/${now()}-${userId}`, 1);
}

export async function snapshot(groupId: number, members: number) {
  await setJSON(`s/${groupId}/${today()}`, { members });
}

export async function overview() {
  const t = now();
  const [users, chats] = await Promise.all([allUsers(), listKeys("c/").then((k) => getMany<ChatRow>(k))]);
  const count = (f: (u: UserRow) => boolean) => users.filter(f).length;
  return {
    total: users.length,
    dm: count((u) => u.dm_started === 1),
    verified: count((u) => u.verified === 1),
    verifiedToday: count((u) => (u.verified_at ?? 0) >= t - DAY),
    active24h: count((u) => u.last_seen >= t - DAY),
    active7d: count((u) => u.last_seen >= t - 7 * DAY),
    active30d: count((u) => u.last_seen >= t - 30 * DAY),
    new24h: count((u) => u.first_seen >= t - DAY),
    new7d: count((u) => u.first_seen >= t - 7 * DAY),
    messages: users.reduce((s, u) => s + u.messages, 0),
    groups: chats.filter((c) => (c.type === "group" || c.type === "supergroup") && c.status !== "removed").length,
  };
}

/** Users per Telegram app language (the closest thing to "where from" Telegram exposes), biggest first. */
export async function languageStats() {
  const n = new Map<string, number>();
  for (const u of await allUsers()) n.set(u.lang ?? "?", (n.get(u.lang ?? "?") ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
}

/** People who opened the live voice page, per country (Netlify geo-locates the visit). Key g/<chatId>. */
export async function countryStats() {
  const n = new Map<string, number>();
  for (const g of await getMany<{ country: string }>(await listKeys("g/"))) n.set(g.country, (n.get(g.country) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
}

export async function topUsers(limit = 5) {
  return (await allUsers())
    .filter((u) => u.messages > 0)
    .sort((a, b) => b.messages - a.messages)
    .slice(0, limit)
    .map(({ id, first_name, username, messages }) => ({ id, first_name, username, messages }));
}

export async function groupGrowth(groupId: number) {
  const t = now();
  const joinTimes = (await listKeys(`j/${groupId}/`)).map((k) => Number(k.split("/").pop()!.split("-")[0]));
  const weekAgoDay = new Date(Date.now() - 7 * DAY * 1000).toISOString().slice(0, 10);
  const snapKey = (await listKeys(`s/${groupId}/`)).sort().find((k) => k.split("/").pop()! >= weekAgoDay);
  const base = snapKey ? await getJSON<{ members: number }>(snapKey) : null;
  return {
    joins24h: joinTimes.filter((x) => x >= t - DAY).length,
    joins7d: joinTimes.filter((x) => x >= t - 7 * DAY).length,
    baseline7d: base?.members ?? null,
  };
}

// ---------- points + referrals ----------
export const REF_POINTS = 50; // referrer, when the invited friend joins all required groups and verifies
export const WELCOME_POINTS = 10; // the invited friend
export const DAILY_ACTIVITY_CAP = 30; // max "chatting in the group" points per user per day

export async function addPoints(userId: number, delta: number) {
  const u = await getUser(userId);
  if (!u) return;
  u.points += delta;
  await putUser(u);
}

/** Remember who invited this user. Only for brand-new users, only once, never self. */
export async function setReferrer(userId: number, referrerId: number): Promise<boolean> {
  if (userId === referrerId) return false;
  const [u, ref] = await Promise.all([getUser(userId), getUser(referrerId)]);
  if (!u || !ref || u.referred_by !== null || u.first_seen < now() - 600) return false;
  u.referred_by = referrerId;
  await putUser(u);
  return true;
}

/** Called once a user is verified. Pays the referrer and the invited friend a single time. */
export async function rewardReferral(userId: number) {
  const u = await getUser(userId);
  if (!u || !u.verified || u.referred_by === null || u.ref_rewarded) return null;
  u.ref_rewarded = 1;
  u.points += WELCOME_POINTS;
  await putUser(u);
  await addPoints(u.referred_by, REF_POINTS);
  return { referrer: u.referred_by, name: u.first_name ?? u.username ?? String(userId), refPoints: REF_POINTS, welcomePoints: WELCOME_POINTS };
}

/** +1 point for chatting in a required group, up to DAILY_ACTIVITY_CAP per day. */
export async function activityPoint(userId: number): Promise<boolean> {
  const u = await getUser(userId);
  if (!u) return false;
  const day = today();
  if (u.act_day !== day) {
    u.act_day = day;
    u.act_pts = 0;
  }
  if (u.act_pts >= DAILY_ACTIVITY_CAP) return false;
  u.act_pts += 1;
  u.points += 1;
  await putUser(u);
  return true;
}

export async function profile(userId: number) {
  const users = await allUsers();
  const u = users.find((x) => x.id === userId);
  if (!u) return { points: 0, rank: null as number | null, referrals: 0, pending: 0 };
  return {
    points: u.points,
    rank: u.points > 0 ? users.filter((x) => x.points > u.points).length + 1 : null,
    referrals: users.filter((x) => x.referred_by === userId && x.ref_rewarded === 1).length,
    pending: users.filter((x) => x.referred_by === userId && x.ref_rewarded === 0).length,
  };
}

export async function leaderboard(limit = 10) {
  return (await allUsers())
    .filter((u) => u.points > 0)
    .sort((a, b) => b.points - a.points || a.id - b.id)
    .slice(0, limit)
    .map(({ id, first_name, username, points }) => ({ id, first_name, username, points }));
}
