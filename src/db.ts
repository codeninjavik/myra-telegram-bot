import { DatabaseSync } from "node:sqlite";

// Local SQLite file; keeps users, chats, group joins and daily member-count snapshots.
const db = new DatabaseSync(process.env.DB_FILE ?? "myra.db");
db.exec(`
  create table if not exists users(
    id integer primary key, first_name text, username text,
    first_seen integer not null, last_seen integer not null,
    messages integer not null default 0, dm_started integer not null default 0,
    verified integer not null default 0, verified_at integer
  );
  create table if not exists chats(
    id integer primary key, title text, type text, added_at integer not null, last_seen integer not null
  );
  create table if not exists joins(group_id integer not null, user_id integer not null, at integer not null);
  create table if not exists snapshots(group_id integer not null, day text not null, members integer not null, primary key(group_id, day));
  create index if not exists idx_users_seen on users(last_seen);
  create index if not exists idx_joins_group on joins(group_id, at);
`);

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

type TgUser = { id: number; first_name?: string; username?: string };

const upsertUser = db.prepare(`
  insert into users(id, first_name, username, first_seen, last_seen, messages, dm_started)
  values (?, ?, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    first_name = excluded.first_name, username = excluded.username, last_seen = excluded.last_seen,
    messages = messages + excluded.messages, dm_started = max(dm_started, excluded.dm_started)
`);
export function touchUser(u: TgUser, opts: { message?: boolean; dm?: boolean } = {}) {
  const t = now();
  upsertUser.run(u.id, u.first_name ?? null, u.username ?? null, t, t, opts.message ? 1 : 0, opts.dm ? 1 : 0);
}

const upsertChat = db.prepare(`
  insert into chats(id, title, type, added_at, last_seen) values (?, ?, ?, ?, ?)
  on conflict(id) do update set title = excluded.title, type = excluded.type, last_seen = excluded.last_seen
`);
export function touchChat(c: { id: number; title?: string; type: string }) {
  const t = now();
  upsertChat.run(c.id, c.title ?? null, c.type, t, t);
}

const setVerified = db.prepare("update users set verified = 1, verified_at = coalesce(verified_at, ?) where id = ?");
export function markVerified(userId: number) {
  setVerified.run(now(), userId);
}

const insJoin = db.prepare("insert into joins(group_id, user_id, at) values (?, ?, ?)");
export function recordJoin(groupId: number, userId: number) {
  insJoin.run(groupId, userId, now());
}

const putSnap = db.prepare(`
  insert into snapshots(group_id, day, members) values (?, ?, ?)
  on conflict(group_id, day) do update set members = excluded.members
`);
export function snapshot(groupId: number, members: number) {
  putSnap.run(groupId, new Date().toISOString().slice(0, 10), members);
}

const one = <T>(sql: string, ...args: any[]) => db.prepare(sql).get(...args) as T;

export function overview() {
  const t = now();
  const c = (sql: string, ...a: any[]) => one<{ n: number }>(sql, ...a).n;
  return {
    total: c("select count(*) n from users"),
    dm: c("select count(*) n from users where dm_started = 1"),
    verified: c("select count(*) n from users where verified = 1"),
    verifiedToday: c("select count(*) n from users where verified_at >= ?", t - DAY),
    active24h: c("select count(*) n from users where last_seen >= ?", t - DAY),
    active7d: c("select count(*) n from users where last_seen >= ?", t - 7 * DAY),
    active30d: c("select count(*) n from users where last_seen >= ?", t - 30 * DAY),
    new24h: c("select count(*) n from users where first_seen >= ?", t - DAY),
    new7d: c("select count(*) n from users where first_seen >= ?", t - 7 * DAY),
    messages: c("select coalesce(sum(messages),0) n from users"),
    groups: c("select count(*) n from chats where type in ('group','supergroup')"),
  };
}

export function topUsers(limit = 5) {
  return db
    .prepare("select id, first_name, username, messages from users where messages > 0 order by messages desc limit ?")
    .all(limit) as { id: number; first_name: string | null; username: string | null; messages: number }[];
}

export function groupGrowth(groupId: number) {
  const t = now();
  const n = (sql: string, ...a: any[]) => one<{ n: number }>(sql, ...a).n;
  const weekAgoDay = new Date(Date.now() - 7 * DAY * 1000).toISOString().slice(0, 10);
  const base = db
    .prepare("select members from snapshots where group_id = ? and day >= ? order by day asc limit 1")
    .get(groupId, weekAgoDay) as { members: number } | undefined;
  return {
    joins24h: n("select count(*) n from joins where group_id = ? and at >= ?", groupId, t - DAY),
    joins7d: n("select count(*) n from joins where group_id = ? and at >= ?", groupId, t - 7 * DAY),
    baseline7d: base?.members ?? null,
  };
}

// ---------- points + referrals ----------
export const REF_POINTS = 50; // referrer, when the invited friend joins all required groups and verifies
export const WELCOME_POINTS = 10; // the invited friend
export const DAILY_ACTIVITY_CAP = 30; // max "chatting in the group" points per user per day

const userCols = (db.prepare("pragma table_info(users)").all() as { name: string }[]).map((c) => c.name);
if (!userCols.includes("points")) db.exec("alter table users add column points integer not null default 0");
if (!userCols.includes("referred_by")) db.exec("alter table users add column referred_by integer");
if (!userCols.includes("ref_rewarded")) db.exec("alter table users add column ref_rewarded integer not null default 0");
db.exec(`
  create table if not exists activity(user_id integer not null, day text not null, pts integer not null, primary key(user_id, day));
  create index if not exists idx_users_points on users(points);
  create index if not exists idx_users_ref on users(referred_by);
`);

type UserRow = {
  id: number; first_name: string | null; username: string | null; first_seen: number;
  points: number; referred_by: number | null; ref_rewarded: number; verified: number;
};
const getUser = (id: number) => db.prepare("select * from users where id = ?").get(id) as UserRow | undefined;

export function addPoints(userId: number, delta: number) {
  db.prepare("update users set points = points + ? where id = ?").run(delta, userId);
}

/** Remember who invited this user. Only for brand-new users, only once, never self. */
export function setReferrer(userId: number, referrerId: number): boolean {
  if (userId === referrerId) return false;
  const u = getUser(userId);
  if (!u || u.referred_by !== null || u.first_seen < now() - 600) return false;
  if (!getUser(referrerId)) return false;
  db.prepare("update users set referred_by = ? where id = ?").run(referrerId, userId);
  return true;
}

/** Called once a user is verified. Pays the referrer and the invited friend a single time. */
export function rewardReferral(userId: number) {
  const u = getUser(userId);
  if (!u || !u.verified || u.referred_by === null || u.ref_rewarded) return null;
  db.prepare("update users set ref_rewarded = 1 where id = ?").run(userId);
  addPoints(u.referred_by, REF_POINTS);
  addPoints(userId, WELCOME_POINTS);
  return { referrer: u.referred_by, name: u.first_name ?? u.username ?? String(userId), refPoints: REF_POINTS, welcomePoints: WELCOME_POINTS };
}

/** +1 point for chatting in a required group, up to DAILY_ACTIVITY_CAP per day. */
export function activityPoint(userId: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare("select pts from activity where user_id = ? and day = ?").get(userId, day) as { pts: number } | undefined;
  if ((row?.pts ?? 0) >= DAILY_ACTIVITY_CAP) return false;
  db.prepare(
    "insert into activity(user_id, day, pts) values (?, ?, 1) on conflict(user_id, day) do update set pts = pts + 1",
  ).run(userId, day);
  addPoints(userId, 1);
  return true;
}

export function profile(userId: number) {
  const u = getUser(userId);
  if (!u) return { points: 0, rank: null as number | null, referrals: 0, pending: 0 };
  const n = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as { n: number }).n;
  return {
    points: u.points,
    rank: u.points > 0 ? n("select count(*) + 1 n from users where points > ?", u.points) : null,
    referrals: n("select count(*) n from users where referred_by = ? and ref_rewarded = 1", userId),
    pending: n("select count(*) n from users where referred_by = ? and ref_rewarded = 0", userId),
  };
}

export function leaderboard(limit = 10) {
  return db
    .prepare("select id, first_name, username, points from users where points > 0 order by points desc, id asc limit ?")
    .all(limit) as { id: number; first_name: string | null; username: string | null; points: number }[];
}
