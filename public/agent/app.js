/* SECRET AGENT: Mini App UI. All game state lives on the server; this file renders it and sends intentions. */
(function () {
  "use strict";
  const tg = window.Telegram && window.Telegram.WebApp;
  const ART = window.SA_ART;
  const BOT = "MyraSmartBot";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = ART.icon;
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const MAPS_META = {};

  // ------------------------------------------------------------------ state
  const S = {
    profile: null, missions: null, cfg: null, admin: false, view: null, code: null, route: "home", params: {}, stack: [],
    clockOffset: 0, settings: { sound: true, music: false, reduceMotion: false, haptics: true }, game: null, polling: false,
    matchScreen: null, revealed: {}, lastSeq: -1, online: true, rewardsTries: 0, mapData: null, inMatch: false, chatDraft: "", stops: [],
  };
  try { Object.assign(S.settings, JSON.parse(localStorage.getItem("sa_settings") || "{}")); } catch (e) { /* storage unavailable */ }

  const root = $("#screen");
  const app = $("#app");
  const serverNow = () => Date.now() + S.clockOffset;

  // ------------------------------------------------------------------ audio (synthesised, optional)
  let actx = null;
  function tone(freqs, dur, type, vol) {
    if (!S.settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = actx.currentTime;
      freqs.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = type || "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * dur);
        g.gain.linearRampToValueAtTime(vol || 0.06, t0 + i * dur + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + (i + 1) * dur);
        o.connect(g).connect(actx.destination);
        o.start(t0 + i * dur);
        o.stop(t0 + (i + 1) * dur + 0.05);
      });
    } catch (e) { /* audio blocked until a user gesture */ }
  }
  // ---- dice sound, built from impacts (no recorded asset needed)
  const AUDIO = (() => {
    let noise = null;
    const noiseBuffer = (ctx) => {
      if (noise && noise.sampleRate === ctx.sampleRate) return noise;
      const n = Math.floor(ctx.sampleRate * 1.0);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let seed = 12345;
      for (let i = 0; i < n; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        d[i] = (seed / 2147483648) - 1;
      }
      noise = buf;
      return buf;
    };
    // one collision: a burst of band-passed noise (the "tick") plus a damped low sine (the "knock" of the table)
    function impact(ctx, dest, t, amp, freq, q, decay, knock) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      src.connect(bp);
      bp.connect(g);
      g.connect(dest);
      src.start(t, Math.random() * 0.5);
      src.stop(t + decay + 0.02);
      if (knock) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(knock, t);
        o.frequency.exponentialRampToValueAtTime(knock * 0.55, t + 0.06);
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.0001, t);
        og.gain.linearRampToValueAtTime(amp * 0.7, t + 0.002);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        o.connect(og);
        og.connect(dest);
        o.start(t);
        o.stop(t + 0.09);
      }
    }
    /** kind: "tumble" (while it rolls, about 0.8 s) or "land" (two or three bounces and it stops). */
    function schedule(ctx, dest, t0, kind) {
      const rnd = (a, b) => a + Math.random() * (b - a);
      if (kind === "tumble") {
        let t = t0;
        let gap = 0.03;
        for (let i = 0; i < 16; i++) {
          const fade = 1 - i / 22;
          impact(ctx, dest, t, rnd(0.18, 0.4) * fade, rnd(1800, 4600), rnd(1.2, 2.4), rnd(0.012, 0.03), rnd(180, 330));
          gap = Math.min(0.085, gap * rnd(1.04, 1.16));
          t += gap * rnd(0.7, 1.3);
        }
      } else {
        // landing: hard knock, then softer bounces closer together, then a tiny settle
        const hits = [[0, 0.9, 150], [0.105, 0.55, 190], [0.185, 0.32, 230], [0.235, 0.16, 280], [0.265, 0.07, 320]];
        for (const [dt, a, kn] of hits) impact(ctx, dest, t0 + dt, a * rnd(0.85, 1.05), rnd(900, 1700), rnd(0.9, 1.6), 0.045 + (1 - a) * 0.02, kn);
      }
    }
    return { schedule };
  })();
  window.SA_AUDIO = AUDIO;
  function playDice(kind) {
    if (!S.settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const master = actx.createGain();
      master.gain.value = 0.9;
      master.connect(actx.destination);
      AUDIO.schedule(actx, master, actx.currentTime + 0.01, kind);
    } catch (e) { /* audio blocked until a user gesture */ }
  }

  const SFX = {
    click: () => tone([520], 0.05, "triangle", 0.04), start: () => tone([392, 523, 659], 0.11, "square", 0.05), role: () => tone([196, 147, 110], 0.16, "sawtooth", 0.05),
    clue: () => tone([880, 1175], 0.07, "triangle", 0.05), alert: () => tone([300, 220, 300, 220], 0.12, "square", 0.05), tick: () => tone([660], 0.04, "square", 0.03),
    elim: () => tone([330, 247, 165], 0.18, "sawtooth", 0.06), win: () => tone([523, 659, 784, 1047], 0.13, "triangle", 0.06), lose: () => tone([330, 277, 220, 175], 0.2, "sine", 0.06),
    level: () => tone([523, 659, 784, 1047, 1319], 0.09, "triangle", 0.06),
    // dice: quick irregular clicks while it tumbles (about 0.8 s), then a soft thud as it lands
    dice: () => {
      tone([310, 190, 380, 240, 420, 200, 350, 260, 300, 220, 330], 0.07, "square", 0.035);
      setTimeout(() => tone([150, 95], 0.1, "sine", 0.1), 800);
    },
    diceRattle: () => playDice("tumble"),
    diceLand: () => playDice("land"),
  };
  const buzz = (kind) => { if (S.settings.haptics && tg && tg.HapticFeedback) { try { kind === "err" ? tg.HapticFeedback.notificationOccurred("error") : tg.HapticFeedback.impactOccurred("light"); } catch (e) { /* unsupported */ } } };

  // ------------------------------------------------------------------ api
  const ERR = {
    "already-in-room": "You are already in a room. Rejoin it from Home.", "room-full": "That room is full.", "bad-code": "That code is not valid.",
    "room-not-found": "Room not found. Check the code.", "match-started": "That match has already started.", "rate-limited": "Slow down a little.",
    maintenance: "The game is in maintenance. Try again soon.", "mode-disabled": "That mode is not available right now.", banned: "This account is suspended.",
    "too-far": "Move closer.", cooldown: "Ability is recharging.", "already-done": "That objective is already complete this round.", "too-fast": "Too fast.",
    "wrong-phase": "Not available right now.", "not-complete": "Not complete yet.", "already-claimed": "Already claimed.", "no-uses-left": "No uses left.",
    "character-taken": "Another agent already uses that character.", "need-more-players": "You need at least 4 players to start.", "host-only": "Only the host can do that.",
    "used-this-round": "Already used this round.", sabotaged: "That system is down.", "already-sabotaged": "Already sabotaged.", "bad-target": "Pick a valid player.",
    forbidden: "You do not have access to that.", "auth-missing": "Open this game from Telegram.", "auth-bad-hash": "Your session is invalid. Reopen the game from Telegram.",
    "auth-expired": "Your session expired. Reopen the game from Telegram.", locked: "Reach a higher level to unlock this character.", muted: "You are muted for this match.",
  };
  const errText = (e) => ERR[e] || "Something went wrong. Try again.";

  async function api(method, path, body, query) {
    const url = "/sa/api" + path + (query ? "?" + new URLSearchParams(query).toString() : "");
    const res = await fetch(url, {
      method, headers: { "Content-Type": "application/json", "X-Init-Data": (tg && tg.initData) || "" },
      body: method === "POST" ? JSON.stringify(body || {}) : undefined, cache: "no-store",
    });
    let data;
    try { data = await res.json(); } catch (e) { data = { ok: false, error: "bad-response" }; }
    data.status = res.status;
    if (data.view && data.view.serverNow) S.clockOffset = data.view.serverNow - Date.now();
    if (res.status === 401) throw Object.assign(new Error("auth"), { auth: true, code: data.error });
    return data;
  }

  // ------------------------------------------------------------------ ui helpers
  function toast(msg, err) {
    $$(".toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.setAttribute("role", "status");
    t.textContent = msg;
    app.appendChild(t);
    if (err) buzz("err");
    setTimeout(() => t.remove(), 2600);
  }
  function modal(html, opts) {
    const o = document.createElement("div");
    o.className = "overlay";
    o.innerHTML = `<div class="modal card file" role="dialog" aria-modal="true">${html}</div>`;
    app.appendChild(o);
    const close = () => o.remove();
    if (!opts || !opts.sticky) o.addEventListener("click", (e) => { if (e.target === o) close(); });
    return { el: o, close };
  }
  function confirmBox(title, text, yes, onYes) {
    const m = modal(`<h3>${esc(title)}</h3><p class="mute">${esc(text)}</p><div class="row" style="margin-top:14px"><button class="btn ghost grow" data-no>Cancel</button><button class="btn danger grow" data-yes>${esc(yes)}</button></div>`);
    $("[data-no]", m.el).onclick = m.close;
    $("[data-yes]", m.el).onclick = () => { m.close(); onYes(); };
  }
  function avatarCanvas(charId, pose) {
    const c = document.createElement("canvas");
    c.setAttribute("aria-hidden", "true");
    requestAnimationFrame(() => ART.portrait(c, charId, pose));
    return c;
  }
  const avatar = (charId) => `<span class="avatar" data-av="${esc(charId)}"></span>`;
  function hydrateAvatars(scope) {
    $$("[data-av]", scope || document).forEach((el) => {
      if (el.firstChild) return;
      el.appendChild(avatarCanvas(el.getAttribute("data-av"), "idle"));
    });
  }
  function hydrateSprites(scope) {
    $$("canvas[data-char]", scope || document).forEach((c) => {
      if (c.dataset.on) return;
      c.dataset.on = "1";
      if (S.settings.reduceMotion) {
        requestAnimationFrame(() => { const x = c.getContext("2d"); c.width = c.clientWidth * 2 || 128; c.height = c.clientHeight * 2 || 192; ART.drawAgent(x, ART.charById(c.dataset.char), c.dataset.pose || "idle", 0, c.width / 2, c.height - 6, Math.min(c.width / 56, c.height / 100)); });
      } else S.stops.push(ART.animate(c, c.dataset.char, c.dataset.pose || "idle"));
    });
  }
  const sprite = (charId, pose, cls) => `<canvas class="${cls || ""}" data-char="${esc(charId)}" data-pose="${pose || "idle"}" aria-hidden="true"></canvas>`;
  const releaseSprites = () => { S.stops.forEach((s) => s()); S.stops = []; };
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const roleInfo = {
    spy: { name: "Spy", cls: "role-spy", desc: "You are hiding among the agents. Sabotage systems, fake tasks and avoid being voted out.", goal: "Cause 3 sabotages, or outnumber the agents.", ability: "Sabotage, Distraction and Dash. Each one has a cooldown." },
    detective: { name: "Detective", cls: "role-good", desc: "You investigate. Inspect a nearby player once per round for signs of tampering.", goal: "Find the Spy and get them voted out.", ability: "Inspect: reveals tampering. It can be wrong." },
    hacker: { name: "Hacker", cls: "role-good", desc: "You read system logs. Scan once per round to see who used a terminal and whether it was real work.", goal: "Complete objectives and expose the Spy.", ability: "Scan: recent terminal activity and integrity checks." },
    guard: { name: "Security Guard", cls: "role-good", desc: "You protect one player. Your shield cancels one vote-out, once per match.", goal: "Keep the agents alive and find the Spy.", ability: "Shield: protect a nearby player from the next vote." },
    agent: { name: "Field Agent", cls: "role-good", desc: "Complete objectives, repair sabotage and watch for suspicious behavior.", goal: "Finish all objectives or vote out the Spy.", ability: "No special ability. Your eyes are the weapon." },
  };

  // ------------------------------------------------------------------ navigation
  const NAV = [["home", "Home", "home"], ["play", "Play", "play"], ["board", "Ranks", "rank"], ["missions", "Missions", "mission"], ["rewards", "Rewards", "reward"], ["profile", "Profile", "user"]];
  function renderNav() {
    const nav = $("#nav");
    nav.innerHTML = NAV.map(([id, label, icon]) => `<button data-nav="${id}" ${S.route === id ? 'aria-current="page"' : ""} aria-label="${label}">${ic(icon)}<span>${label}</span></button>`).join("");
    $$("[data-nav]", nav).forEach((b) => (b.onclick = () => { SFX.click(); go(b.dataset.nav); }));
  }
  const TOP = new Set(NAV.map((n) => n[0]));
  function go(name, params, opts) {
    if (S.inMatch && !(opts && opts.force)) { if (name !== "match") return toast("Finish or leave the match first."); }
    releaseGame();
    releaseSprites();
    const prev = S.route;
    if (!(opts && opts.replace) && prev !== name && !TOP.has(name)) S.stack.push({ name: prev, params: S.params });
    if (TOP.has(name)) S.stack = [];
    S.route = name;
    S.params = params || {};
    app.classList.toggle("hide-nav", name === "match");
    renderNav();
    updateBack();
    const fn = SCREENS[name] || SCREENS.home;
    root.innerHTML = "";
    fn(S.params);
  }
  function back() {
    if (S.inMatch) {
      return confirmBox("Leave this match?", "You will be removed from the mission. Rewards are only paid to players who stay.", "Leave match", leaveMatch);
    }
    const prev = S.stack.pop();
    if (prev) go(prev.name, prev.params, { replace: true });
    else go("home");
  }
  function updateBack() {
    if (!tg || !tg.BackButton) return;
    const show = S.inMatch || S.stack.length > 0 || !TOP.has(S.route) || S.route !== "home";
    try { show ? tg.BackButton.show() : tg.BackButton.hide(); } catch (e) { /* old client */ }
  }
  function page(html, cls) {
    const d = document.createElement("div");
    d.className = "page " + (cls || "");
    d.innerHTML = html;
    root.innerHTML = "";
    root.appendChild(d);
    hydrateAvatars(d);
    hydrateSprites(d);
    return d;
  }
  const header = (title, sub) => `<div class="row" style="margin-bottom:14px"><div class="grow"><h2>${esc(title)}</h2>${sub ? `<div class="mute" style="font-size:14px">${esc(sub)}</div>` : ""}</div></div>`;
  const levelBar = (p) => `<div class="bar" aria-label="Experience"><i style="width:${Math.min(100, Math.round((p.levelXp / Math.max(1, p.levelNeed)) * 100))}%"></i></div>`;

  // ------------------------------------------------------------------ data
  async function refreshMe() {
    const r = await api("GET", "/me");
    if (r.ok) {
      S.profile = r.profile; S.missions = r.missions; S.cfg = { modes: r.modes, maintenance: r.maintenance }; S.admin = !!r.admin; S.recentRoom = r.room; S.ludoRoom = r.ludo;
      Object.assign(S.settings, r.profile.settings || {});
      document.documentElement.classList.toggle("reduce-motion", !!S.settings.reduceMotion);
    }
    return r;
  }

  // ------------------------------------------------------------------ screens
  const SCREENS = {};

  SCREENS.home = async function () {
    const p = S.profile;
    const dailyDone = (S.missions || []).filter((m) => m.period === "daily" && m.claimed).length;
    const dailyTotal = (S.missions || []).filter((m) => m.period === "daily").length;
    const first = (S.missions || []).filter((m) => m.period === "daily");
    const progress = first.length ? Math.round((first.reduce((a, m) => a + m.progress / m.target, 0) / first.length) * 100) : 0;
    const d = page(`
      <div class="hero file">
        <div class="logo" aria-label="Secret Agent"><b>Secret</b><i>Agent</i></div>
        <p class="mute" style="margin:10px 0 14px">One of you is lying. Find the Spy before the mission fails.</p>
        <div class="cast">${sprite(p.char === "viper" ? "nova" : "viper", "idle")}${sprite(p.char, "alert")}</div>
        <div class="row" style="margin-top:6px;max-width:230px"><span class="chip cyan">Lv ${p.level}</span><span class="chip gold">${ic("coin", "sm")} ${fmt(p.coins)}</span></div>
      </div>
      ${S.admin && S.cfg && S.cfg.maintenance ? `<div class="alertbar" role="alert" style="margin-top:12px">Maintenance mode is ON. Players cannot play. Turn it off in Profile, Admin console.</div>` : ""}
      ${S.recentRoom && S.recentRoom.status !== "finished" ? `<button class="btn gold block" data-rejoin style="margin-top:12px">${ic("play")} Rejoin room ${esc(S.recentRoom.code)}</button>` : ""}
      <div class="stack" style="margin-top:14px">
        <button class="btn primary hero-btn block" data-quick>${ic("bolt")} Play now</button>
        <div class="grid2">
          <button class="btn block" data-create>${ic("users")} Create room</button>
          <button class="btn block" data-join>${ic("key")} Join room</button>
        </div>
        <div class="grid2"><button class="btn ghost block" data-practice>${ic("eye")} Practice</button><button class="btn ghost block" data-ludo>${ic("users")} Ludo</button></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="row between"><span class="label">LEVEL ${p.level}</span><span class="label mono">${fmt(p.levelXp)} / ${fmt(p.levelNeed)} XP</span></div>
        ${levelBar(p)}
      </div>
      <div class="grid3" style="margin-top:10px">
        <div class="stat"><div class="label">Streak</div><div class="big">${p.streak}</div></div>
        <div class="stat"><div class="label">Win rate</div><div class="big">${p.winRate}%</div></div>
        <div class="stat"><div class="label">Rank</div><div class="big" id="home-rank">-</div></div>
      </div>
      <button class="card block" data-missions style="margin-top:10px;text-align:left;cursor:pointer;width:100%">
        <div class="row between"><b>Daily missions</b><span class="chip">${dailyDone}/${dailyTotal}</span></div>
        <div class="bar" style="margin-top:8px"><i style="width:${progress}%"></i></div>
      </button>
      <div class="card file" style="margin-top:10px">
        <div class="row between"><div><b>Daily reward</b><div class="mute" style="font-size:13px">${p.daily.claimable ? "Ready to collect" : "Come back tomorrow"} · streak ${p.daily.streak}</div></div>
        <button class="btn gold sm" data-daily ${p.daily.claimable ? "" : "disabled"}>${p.daily.claimable ? "Claim" : "Claimed"}</button></div>
      </div>
      <div class="card" style="margin-top:10px" id="home-recent"><div class="label">LAST MATCH</div><div class="mute">Loading…</div></div>`);
    $("[data-quick]", d).onclick = () => startQuick();
    $("[data-create]", d).onclick = () => createRoom();
    $("[data-join]", d).onclick = () => go("join");
    $("[data-practice]", d).onclick = () => startPractice();
    $("[data-ludo]", d).onclick = () => go("ludo");
    $("[data-missions]", d).onclick = () => go("missions");
    const rj = $("[data-rejoin]", d);
    if (rj) rj.onclick = () => joinRoom(S.recentRoom.code);
    $("[data-daily]", d).onclick = claimDaily;
    api("GET", "/leaderboard", null, { board: "global", size: 5 }).then((r) => { const el = $("#home-rank"); if (el && r.ok) el.textContent = r.me ? "#" + r.me.rank : "-"; }).catch(() => {});
    api("GET", "/history").then((r) => {
      const el = $("#home-recent");
      if (!el || !r.ok) return;
      const m = r.matches[0];
      el.innerHTML = m
        ? `<div class="label">LAST MATCH</div><div class="row between"><b>${m.won ? "Victory" : "Defeat"} as ${esc((roleInfo[m.role] || {}).name || "Agent")}</b><span class="chip ${m.won ? "gold" : ""}">${esc(m.mode)}</span></div>`
        : `<div class="label">LAST MATCH</div><div class="mute">No matches yet. Your first mission is waiting.</div>`;
    }).catch(() => {});
  };

  SCREENS.play = function () {
    const modes = (S.cfg && S.cfg.modes) || {};
    const d = page(`${header("Choose a mission", "Pick how you want to play")}
      <div class="stack">
        <button class="card file row" data-m="quick" style="text-align:left;cursor:pointer;width:100%">${ic("bolt")}<div class="grow"><b>Quick match</b><div class="mute" style="font-size:13px">Jump into the next open room. Bots fill empty seats after a short wait.</div></div></button>
        <button class="card file row" data-m="create" style="text-align:left;cursor:pointer;width:100%">${ic("users")}<div class="grow"><b>Private room</b><div class="mute" style="font-size:13px">Get a code and a link to share with friends.</div></div></button>
        <button class="card file row" data-m="join" style="text-align:left;cursor:pointer;width:100%">${ic("key")}<div class="grow"><b>Join by code</b><div class="mute" style="font-size:13px">Enter a 5-character room code.</div></div></button>
        <button class="card file row" data-m="friends" style="text-align:left;cursor:pointer;width:100%">${ic("link")}<div class="grow"><b>Friends match</b><div class="mute" style="font-size:13px">A private room that opens an invite sheet straight away.</div></div></button>
        <button class="card file row" data-m="practice" style="text-align:left;cursor:pointer;width:100%">${ic("eye")}<div class="grow"><b>Practice</b><div class="mute" style="font-size:13px">Learn the rules against simulated bots. Reduced rewards.</div></div></button>
        <button class="card file row" data-m="ludo" style="text-align:left;cursor:pointer;width:100%">${ic("users")}<div class="grow"><b>Ludo</b><div class="mute" style="font-size:13px">Classic board game for 2 to 4 players, or against bots.</div></div></button>
        <button class="card file row" data-m="ranked" style="text-align:left;cursor:pointer;width:100%;${modes.ranked ? "" : "opacity:.55"}">${ic(modes.ranked ? "trophy" : "lock")}<div class="grow"><b>Ranked</b><div class="mute" style="font-size:13px">${modes.ranked ? "Separate rating, competitive." : "Opens when the core modes are proven stable."}</div></div></button>
        <button class="btn ghost block" data-chars>Choose character</button>
      </div>`);
    $$("[data-m]", d).forEach((b) => (b.onclick = () => {
      SFX.click();
      const m = b.dataset.m;
      if (m === "quick") startQuick();
      else if (m === "create") createRoom();
      else if (m === "friends") createRoom("friends");
      else if (m === "join") go("join");
      else if (m === "practice") startPractice();
      else if (m === "ludo") go("ludo");
      else if (m === "ranked") (modes.ranked ? startQuick(true) : toast("Ranked is not open yet.", true));
    }));
    $("[data-chars]", d).onclick = () => go("characters");
  };

  SCREENS.join = function () {
    const d = page(`${header("Join a room", "Enter the code your host shared")}
      <div class="stack"><input class="code-input" id="code" maxlength="5" inputmode="text" autocomplete="off" autocapitalize="characters" placeholder="K7M2P" aria-label="Room code">
      <button class="btn primary block hero-btn" id="go">Join room</button></div>`);
    const input = $("#code", d);
    if (S.params.code) input.value = S.params.code;
    input.focus();
    $("#go", d).onclick = () => joinRoom(input.value.trim().toUpperCase());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(input.value.trim().toUpperCase()); });
  };

  SCREENS.characters = async function () {
    const cfg = await api("GET", "/config");
    const unlocked = new Set(S.profile.unlocked);
    const unlockLv = (i) => (i < 4 ? 1 : 2 * (i - 3) + 1);
    const d = page(`${header("Characters", "Cosmetic only. Unlock more by leveling up.")}
      <div class="votegrid">${ART.CHARS.map((c, i) => `
        <button class="votecard" data-c="${c.id}" aria-pressed="${S.profile.char === c.id}" ${unlocked.has(c.id) ? "" : 'style="opacity:.55"'}>
          ${sprite(c.id, "idle")}<div style="font-weight:800;margin-top:4px">${esc(c.name)}</div>
          <div class="mute" style="font-size:12px">${unlocked.has(c.id) ? (S.profile.char === c.id ? "Selected" : "Unlocked") : `Reach level ${unlockLv(i)}`}</div>
        </button>`).join("")}</div>`);
    void cfg;
    $$("[data-c]", d).forEach((b) => (b.onclick = async () => {
      if (!unlocked.has(b.dataset.c)) return toast("Reach a higher level to unlock this character.", true);
      const r = await api("POST", "/profile/char", { char: b.dataset.c });
      if (r.ok) { S.profile.char = r.char; toast("Character selected"); go("characters", {}, { replace: true }); } else toast(errText(r.error), true);
    }));
  };

  // ---- leaderboard
  SCREENS.board = function () {
    let board = S.params.board || "global", page_ = 0, q = "", rows = [], total = 0, loading = false;
    const d = page(`${header("Leaderboard", "Ranked by stored match results")}
      <div class="tabs" role="tablist" id="tabs">${[["global", "Global"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["friends", "Friends"], ["ranked", "Ranked"]].map(([id, l]) => `<button role="tab" data-b="${id}" aria-selected="${id === board}">${l}</button>`).join("")}</div>
      <div class="field" style="margin:12px 0"><input type="search" id="q" placeholder="Search by name" aria-label="Search players"></div>
      <div id="list" class="stack"></div><div id="pin"></div><div class="mute" id="upd" style="font-size:12px;margin-top:10px;text-align:center"></div>`);
    const list = $("#list", d), pin = $("#pin", d);
    const rowHtml = (r, me) => `<div class="rowitem ${me ? "me" : ""}"><div class="rank ${r.rank <= 3 ? "r" + r.rank : ""}">${r.rank}</div>${avatar(r.char)}
      <div class="grow"><div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</div><div class="mute" style="font-size:12px">Lv ${r.level} · ${r.wins}W · ${r.winRate}% · streak ${r.streak}</div></div>
      <div style="text-align:right"><div class="mono" style="font-weight:700">${board === "ranked" ? r.rating : fmt(r.xp)}</div><div class="faint" style="font-size:11px">${board === "ranked" ? "rating" : "XP"}</div></div></div>`;
    async function load(reset) {
      if (loading) return;
      loading = true;
      if (reset) { page_ = 0; rows = []; list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'; }
      try {
        const r = await api("GET", "/leaderboard", null, { board, page: page_, size: 20, q });
        if (!r.ok) throw new Error(r.error);
        rows = rows.concat(r.rows);
        total = r.total;
        list.innerHTML = rows.length
          ? rows.map((x) => rowHtml(x, x.uid === S.profile.uid)).join("") + (rows.length < total ? '<button class="btn block" id="more">Show more</button>' : "")
          : `<div class="empty">${board === "friends" ? "Play private rooms with friends and they appear here." : board === "ranked" ? "No ranked matches yet." : "No results yet. Play a match to get on the board."}</div>`;
        pin.innerHTML = r.me && !rows.some((x) => x.uid === r.me.uid) ? `<div class="pin" style="margin-top:10px"><div class="label" style="margin-bottom:6px">YOUR RANK</div>${rowHtml(r.me, true)}</div>` : "";
        $("#upd", d).textContent = "Updated " + new Date(r.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        hydrateAvatars(d);
        const more = $("#more", d);
        if (more) more.onclick = () => { page_++; load(false); };
      } catch (e) {
        list.innerHTML = `<div class="empty">Could not load the leaderboard.<br><button class="btn sm" id="retry" style="margin-top:10px">Retry</button></div>`;
        $("#retry", d).onclick = () => load(true);
      }
      loading = false;
    }
    $$("[data-b]", d).forEach((b) => (b.onclick = () => { board = b.dataset.b; $$("[data-b]", d).forEach((x) => x.setAttribute("aria-selected", String(x === b))); load(true); }));
    let t = 0;
    $("#q", d).addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); load(true); }, 300); });
    load(true);
  };

  // ---- missions and rewards
  async function claimDaily() {
    const r = await api("POST", "/daily/claim");
    if (r.ok) { SFX.level(); toast(`+${r.amount} coins. Streak ${r.streak}`); await refreshMe(); go(S.route, S.params, { replace: true }); }
    else toast(errText(r.error), true);
  }
  SCREENS.missions = async function () {
    page(`${header("Missions", "Daily missions reset at 00:00 UTC")}<div class="stack"><div class="skeleton"></div><div class="skeleton"></div></div>`);
    const r = await api("GET", "/missions");
    if (!r.ok) return page(`${header("Missions")}<div class="empty">Could not load missions.</div>`);
    S.missions = r.missions;
    const card = (m) => `<div class="card"><div class="row between"><div><b>${esc(m.title)}</b><div class="mute" style="font-size:13px">${esc(m.desc)}</div></div><span class="chip gold">${ic("coin", "sm")} ${m.reward}</span></div>
      <div class="bar" style="margin:10px 0 8px"><i style="width:${Math.round((m.progress / m.target) * 100)}%"></i></div>
      <div class="row between"><span class="mono mute" style="font-size:13px">${m.progress}/${m.target}</span>
      ${m.claimed ? '<span class="chip cyan">Claimed</span>' : `<button class="btn sm ${m.progress >= m.target ? "gold" : ""}" data-claim="${m.id}" ${m.progress >= m.target ? "" : "disabled"}>Claim</button>`}</div></div>`;
    const daily = r.missions.filter((m) => m.period === "daily"), weekly = r.missions.filter((m) => m.period === "weekly");
    const left = (t) => { const ms = Math.max(0, t - Date.now()); return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`; };
    const d = page(`${header("Missions", daily[0] ? "Resets in " + left(daily[0].resetsAt) : "")}
      <div class="stack"><div class="label">DAILY</div>${daily.map(card).join("")}<div class="label" style="margin-top:6px">WEEKLY${weekly[0] ? " · resets in " + left(weekly[0].resetsAt) : ""}</div>${weekly.map(card).join("")}</div>`);
    $$("[data-claim]", d).forEach((b) => (b.onclick = async () => {
      const res = await api("POST", "/missions/claim", { id: b.dataset.claim });
      if (res.ok) { SFX.level(); toast(`+${res.reward} coins`); await refreshMe(); SCREENS.missions(); } else toast(errText(res.error), true);
    }));
  };

  SCREENS.rewards = async function () {
    page(`${header("Rewards")}<div class="stack"><div class="skeleton"></div></div>`);
    const r = await api("GET", "/missions");
    if (!r.ok) return page(`${header("Rewards")}<div class="empty">Could not load rewards.</div>`);
    const dl = r.daily;
    const days = Array.from({ length: 7 }, (_, i) => {
      const reached = dl.streak > i || (dl.claimable === false && dl.streak > i);
      return `<div class="stat" style="text-align:center;${reached ? "border-color:rgba(255,200,87,.6)" : ""}"><div class="label">Day ${i + 1}</div><div class="big" style="font-size:20px;color:${reached ? "var(--gold)" : "var(--faint)"}">+${20 + 5 * i}</div></div>`;
    }).join("");
    const d = page(`${header("Rewards", "Daily login and achievements")}
      <div class="card file"><div class="row between"><div><b>Daily login reward</b><div class="mute" style="font-size:13px">Streak ${dl.streak} days</div></div>
      <button class="btn gold" data-daily ${dl.claimable ? "" : "disabled"}>${dl.claimable ? "Claim" : "Claimed"}</button></div>
      <div class="grid3" style="margin-top:12px;grid-template-columns:repeat(4,1fr)">${days}</div></div>
      <div class="label" style="margin:16px 0 8px">ACHIEVEMENTS</div>
      <div class="stack">${r.achievements.map((a) => `<div class="rowitem" style="${a.unlockedAt ? "border-color:rgba(255,200,87,.5)" : ""}">
        <span style="color:${a.unlockedAt ? "var(--gold)" : "var(--faint)"}">${ic("trophy")}</span>
        <div class="grow"><b>${esc(a.name)}</b><div class="mute" style="font-size:13px">${esc(a.desc)}</div>
        <div class="bar" style="margin-top:6px"><i style="width:${Math.round((a.progress / a.target) * 100)}%"></i></div></div>
        <span class="chip ${a.unlockedAt ? "gold" : ""}">${a.unlockedAt ? "Unlocked" : `+${a.reward}`}</span></div>`).join("")}</div>`);
    const b = $("[data-daily]", d);
    if (b) b.onclick = claimDaily;
  };

  // ---- profile, history, settings, help
  SCREENS.profile = async function () {
    const p = S.profile;
    page(`${header("Profile")}<div class="skeleton"></div>`);
    const [full, hist] = await Promise.all([api("GET", "/profile"), api("GET", "/history")]);
    const ach = (full.achievements || []).filter((a) => a.unlockedAt);
    const d = page(`
      <div class="card file" style="text-align:center">
        <div style="width:120px;height:150px;margin:0 auto">${sprite(p.char, "idle")}</div>
        <h2 style="margin-top:6px">${esc(p.name)}</h2>
        <div class="mute mono" style="font-size:12px">ID ${p.uid}${p.username ? " · @" + esc(p.username) : ""} · since ${new Date(p.created).toLocaleDateString()}</div>
        <div class="row between" style="margin-top:12px"><span class="chip cyan">Level ${p.level}</span><span class="chip gold">${ic("coin", "sm")} ${fmt(p.coins)}</span></div>
        <div style="margin-top:8px">${levelBar(p)}</div>
      </div>
      <div class="grid3" style="margin-top:10px">
        <div class="stat"><div class="label">Matches</div><div class="big">${p.matches}</div></div>
        <div class="stat"><div class="label">Wins</div><div class="big">${p.wins}</div></div>
        <div class="stat"><div class="label">Losses</div><div class="big">${p.losses}</div></div>
        <div class="stat"><div class="label">Win rate</div><div class="big">${p.winRate}%</div></div>
        <div class="stat"><div class="label">Spy wins</div><div class="big">${p.spyWins}</div></div>
        <div class="stat"><div class="label">Agent wins</div><div class="big">${p.agentWins}</div></div>
        <div class="stat"><div class="label">Streak</div><div class="big">${p.streak}</div></div>
        <div class="stat"><div class="label">Best</div><div class="big">${p.best}</div></div>
        <div class="stat"><div class="label">Rating</div><div class="big">${p.rating}</div></div>
      </div>
      <div class="row" style="margin-top:12px"><button class="btn grow" data-chars>Characters</button><button class="btn grow" data-ach>Achievements ${ach.length}</button></div>
      <div class="label" style="margin:16px 0 8px">MATCH HISTORY</div>
      <div class="stack" id="hist">${hist.ok && hist.matches.length ? hist.matches.map((m) => `<button class="rowitem" data-m="${esc(m.matchId)}" style="text-align:left;cursor:pointer;width:100%">
        <span class="chip ${m.won ? "gold" : ""}">${m.won ? "Win" : "Loss"}</span><div class="grow"><b>${esc((roleInfo[m.role] || {}).name || "Agent")}</b><div class="mute" style="font-size:12px">${esc(m.mode)} · ${mmss(m.duration)} · ${new Date(m.endedAt || 0).toLocaleDateString()}</div></div>${ic("eye", "sm")}</button>`).join("") : '<div class="empty">No matches yet.</div>'}</div>
      <div class="row" style="margin-top:16px"><button class="btn grow" data-settings>${ic("gear")} Settings</button><button class="btn grow" data-help>${ic("help")} How to play</button></div>
      ${S.admin ? `<button class="btn ghost block" style="margin-top:10px" data-admin>${ic("shield")} Admin console</button>` : ""}`);
    $("[data-chars]", d).onclick = () => go("characters");
    $("[data-ach]", d).onclick = () => go("rewards");
    $("[data-settings]", d).onclick = () => go("settings");
    $("[data-help]", d).onclick = () => go("help");
    const a = $("[data-admin]", d);
    if (a) a.onclick = () => go("admin");
    $$("[data-m]", d).forEach((b) => (b.onclick = () => showMatch(b.dataset.m)));
  };

  async function showMatch(id) {
    const r = await api("GET", "/match", null, { id });
    if (!r.ok) return toast(errText(r.error), true);
    const m = r.match;
    const mm = modal(`<h3>${m.winner === "spy" ? "Spy victory" : "Agents victory"}</h3><div class="mute" style="font-size:13px">${esc(m.reason)}</div>
      <div class="mono faint" style="font-size:11px;margin:6px 0">Match ${esc(m.matchId)} · ${mmss(m.duration)} · ${m.rounds} rounds</div>
      <div class="stack" style="margin-top:8px">${m.players.map((p) => `<div class="rowitem" style="min-height:48px">${avatar(p.char)}<div class="grow"><b>${esc(p.name)}</b>${p.bot ? ' <span class="chip">Bot</span>' : ""}<div class="mute" style="font-size:12px">${esc((roleInfo[p.role] || {}).name)} · ${p.stats.tasks} tasks · ${p.stats.clues} clues</div></div><span class="chip ${p.won ? "gold" : ""}">${p.won ? "Won" : "Lost"}</span></div>`).join("")}</div>
      <button class="btn block" style="margin-top:12px" data-close>Close</button>`);
    hydrateAvatars(mm.el);
    $("[data-close]", mm.el).onclick = mm.close;
  }
  SCREENS.history = async function () {
    const r = await api("GET", "/history");
    const d = page(`${header("Match history")}<div class="stack">${r.ok && r.matches.length ? r.matches.map((m) => `<button class="rowitem" data-m="${esc(m.matchId)}" style="text-align:left;cursor:pointer;width:100%"><span class="chip ${m.won ? "gold" : ""}">${m.won ? "Win" : "Loss"}</span><div class="grow"><b>${esc((roleInfo[m.role] || {}).name || "Agent")}</b><div class="mute" style="font-size:12px">${esc(m.mode)} · ${mmss(m.duration)} · ${m.players} players</div></div></button>`).join("") : '<div class="empty">No matches yet.</div>'}</div>`);
    $$("[data-m]", d).forEach((b) => (b.onclick = () => showMatch(b.dataset.m)));
  };

  SCREENS.settings = function () {
    const rows = [["sound", "Sound effects"], ["music", "Music"], ["reduceMotion", "Reduce animations"], ["haptics", "Haptic feedback"]];
    const d = page(`${header("Settings")}<div class="card">${rows.map(([k, l]) => `<div class="switch"><span>${l}</span><button role="switch" data-k="${k}" aria-checked="${!!S.settings[k]}" aria-label="${l}"></button></div>`).join("")}</div>
      <p class="mute" style="font-size:13px">The game works fully with sound off.</p>
      <button class="btn block" data-help style="margin-top:8px">${ic("help")} How to play</button>
      <button class="btn ghost block" style="margin-top:10px" data-support>Report a problem</button>`);
    $$("[data-k]", d).forEach((b) => (b.onclick = async () => {
      const k = b.dataset.k;
      S.settings[k] = !S.settings[k];
      b.setAttribute("aria-checked", String(S.settings[k]));
      document.documentElement.classList.toggle("reduce-motion", !!S.settings.reduceMotion);
      try { localStorage.setItem("sa_settings", JSON.stringify(S.settings)); } catch (e) { /* ignore */ }
      await api("POST", "/settings", S.settings);
    }));
    $("[data-help]", d).onclick = () => go("help");
    $("[data-support]", d).onclick = () => (tg && tg.openTelegramLink ? tg.openTelegramLink(`https://t.me/${BOT}`) : window.open(`https://t.me/${BOT}`));
  };

  SCREENS.help = function () {
    page(`${header("How to play")}<div class="stack">
      <div class="card file"><b>The setup</b><p class="mute">Each match has agents and one hidden Spy. Roles are secret and assigned by the server.</p></div>
      <div class="card file"><b>Explore</b><p class="mute">Move around the facility, use objects to complete objectives and collect clues. Clues vary: verified logs are reliable, smudged notes are half right, unsigned tips are mostly wrong.</p></div>
      <div class="card file"><b>Discuss and vote</b><p class="mute">After each round the team talks, shares evidence and votes. A tie removes nobody. Removing the Spy wins for the agents.</p></div>
      <div class="card file"><b>The Spy wins by</b><p class="mute">Causing three unrepaired sabotages, or outnumbering the agents. The Spy can also fake tasks, create a distraction and dash.</p></div>
      <div class="card file"><b>Agents win by</b><p class="mute">Finishing all objectives, or voting the Spy out. Repair sabotaged systems to keep the alarm meter down.</p></div>
      <div class="card file"><b>Fair play</b><p class="mute">Coins and XP are virtual and have no cash value. Rewards are calculated by the server after each match. Use Report on any player who spams or cheats.</p></div>
    </div>`);
  };

  // ------------------------------------------------------------------ rooms
  async function startQuick(ranked) {
    const r = await api("POST", "/room/quick", { ranked: !!ranked });
    handleRoom(r);
  }
  async function startPractice() { handleRoom(await api("POST", "/room/practice", {})); }
  async function createRoom(mode) {
    const r = await api("POST", "/room/create", { maxPlayers: 6, mode: mode || "private" });
    handleRoom(r);
    if (r.ok && mode === "friends") setTimeout(() => shareInvite(r.code || (r.view && r.view.code)), 400);
  }
  async function joinRoom(code) {
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return toast("Enter the 5-character room code.", true);
    handleRoom(await api("POST", "/room/join", { code }));
  }
  function handleRoom(r) {
    if (!r.ok) {
      if (r.error === "already-in-room") { refreshMe().then(() => S.recentRoom && joinRoom(S.recentRoom.code)); return toast("Rejoining your room…"); }
      return toast(errText(r.error), true);
    }
    SFX.click();
    enterMatch(r.view);
  }
  function inviteLink(code) { return `https://t.me/${BOT}?start=sa_${code}`; }
  function shareInvite(code) {
    const text = `Join my SECRET AGENT room ${code}. One of us is the Spy.`;
    const url = `https://t.me/share/url?url=${encodeURIComponent(inviteLink(code))}&text=${encodeURIComponent(text)}`;
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, "_blank");
  }
  async function leaveMatch() {
    stopPolling();
    if (S.activeGame === "ludo" && window.SA_LUDO_RT) await window.SA_LUDO_RT.leave();
    else await api("POST", "/room/leave", {});
    S.activeGame = null;
    S.inMatch = false; S.view = null; S.code = null; S.revealed = {};
    try { tg && tg.disableClosingConfirmation && tg.disableClosingConfirmation(); } catch (e) { /* ignore */ }
    await refreshMe();
    go("home", {}, { force: true });
  }

  // ------------------------------------------------------------------ match flow
  function enterMatch(view) {
    S.inMatch = true;
    S.code = view.code;
    S.view = null;
    S.lastSeq = -1;
    S.matchScreen = null;
    S.rewardsTries = 0;
    try { tg && tg.enableClosingConfirmation && tg.enableClosingConfirmation(); } catch (e) { /* ignore */ }
    app.classList.add("hide-nav");
    updateBack();
    startPolling();
    onView(view);
  }

  function releaseGame() {
    if (S.game) { S.game.destroy(); S.game = null; }
  }

  let pollTimer = 0;
  function stopPolling() { S.polling = false; clearTimeout(pollTimer); }
  function startPolling() {
    if (S.polling) return;
    S.polling = true;
    const loop = async () => {
      if (!S.polling) return;
      const v = S.view;
      let wait = 1100;
      try {
        const body = { code: S.code };
        let moving = false;
        if (S.game && v && v.phase === "explore") {
          const pos = S.game.pos();
          body.x = pos.x; body.y = pos.y;
          moving = S.game.moving();
        }
        const r = await api("POST", "/room/tick", body);
        if (!S.online) { S.online = true; $$(".offline").forEach((o) => o.remove()); }
        if (r.view) onView(r.view);
        // the server answers for the position we sent; only its correction (if any) is applied, never its lag
        if (S.game && r.view && r.view.me && body.x !== undefined && r.view.phase === "explore") S.game.reconcile({ x: body.x, y: body.y }, r.view.me);
        else if (r.status === 404) { toast("The room no longer exists.", true); return abandon(); }
        else if (r.error === "not-in-room") { toast("You are no longer in that room.", true); return abandon(); }
        if (r.view && r.view.phase === "explore") wait = moving ? 140 : 800;
        else if (r.view && r.view.status === "lobby") wait = 1400;
        else if (r.view && r.view.status === "finished") {
          if (r.view.rewards || ++S.rewardsTries > 8) wait = 5000;
          else wait = 1000;
        }
        if (document.hidden) wait = Math.max(wait, 3000);
      } catch (e) {
        if (e.auth) return authFailed(e.code);
        if (S.online) {
          S.online = false;
          const o = document.createElement("div");
          o.className = "overlay offline";
          o.innerHTML = `<div class="modal card file"><h3>Reconnecting</h3><p class="mute">Connection lost. Your seat is held for a short time.</p><div class="scan"><i></i></div></div>`;
          app.appendChild(o);
        }
        wait = 2000;
      }
      pollTimer = setTimeout(loop, wait);
    };
    pollTimer = setTimeout(loop, 300);
  }
  async function abandon() {
    stopPolling();
    S.inMatch = false; S.view = null; S.code = null;
    await refreshMe().catch(() => {});
    go("home", {}, { force: true });
  }

  function onView(v) {
    const prev = S.view;
    S.view = v;
    if (v.seq === S.lastSeq && S.matchScreen && v.status !== "finished") {
      if (S.game) S.game.update(v);
      updateTimers(v);
      return;
    }
    S.lastSeq = v.seq;
    if (S.game) S.game.update(v);

    // sound cues from state changes
    if (prev) {
      if (prev.phase !== v.phase) { if (v.phase === "voting") SFX.tick(); if (v.phase === "discussion") SFX.alert(); }
      if (v.events.length && (!prev.events.length || v.events[v.events.length - 1].id !== prev.events[prev.events.length - 1].id)) {
        const e = v.events[v.events.length - 1];
        if (e.kind === "sabotage") {
          SFX.alert(); buzz("err");
          if (S.game) S.game.shake();
          if (!S.settings.reduceMotion) { app.classList.add("alarm-flash"); setTimeout(() => app.classList.remove("alarm-flash"), 900); }
        }
        if (e.kind === "eliminated") SFX.elim();
      }
      if (v.me && prev.me && v.me.clues.length > prev.me.clues.length) SFX.clue();
    }

    if (v.status === "cancelled") return showCancelled(v);
    if (v.status === "lobby") return screenLobby(v);
    if (v.status === "finished") return screenResult(v);
    switch (v.phase) {
      case "briefing": return screenReveal(v);
      case "explore": return screenGame(v);
      case "discussion": return screenDiscussion(v);
      case "voting": return screenVoting(v);
      case "result": return screenVoteResult(v);
      default: return screenLobby(v);
    }
  }

  function setMatchScreen(name) {
    const changed = S.matchScreen !== name;
    S.matchScreen = name;
    if (changed) {
      releaseSprites();
      if (name !== "game") releaseGame();
    }
    return changed;
  }

  function updateTimers(v) {
    const el = $("#timer");
    if (el && v.phaseEnd) {
      const left = v.phaseEnd - serverNow();
      el.textContent = mmss(left);
      el.classList.toggle("low", left < 10000);
    }
    const bar = $("#phasebar");
    if (bar && v.phaseEnd) bar.style.width = Math.max(0, Math.min(100, ((v.phaseEnd - serverNow()) / (v.phaseEnd - v.phaseStart)) * 100)) + "%";
  }
  setInterval(() => { if (S.view && S.inMatch) updateTimers(S.view); }, 500);

  // ---- lobby
  function screenLobby(v) {
    const first = setMatchScreen("lobby");
    const isHost = v.host === v.me.uid;
    const meP = v.players.find((p) => p.uid === v.me.uid) || {};
    const seats = [];
    for (let i = 0; i < v.settings.maxPlayers; i++) {
      const p = v.players[i];
      seats.push(p
        ? `<div class="seat ${p.ready ? "ready" : ""}">${p.host ? '<span class="host-tag">HOST</span>' : ""}${sprite(p.char, "idle")}<div class="nm">${esc(p.name)}</div><div class="st">${p.bot ? "BOT" : p.ready ? "READY" : "WAITING"}</div></div>`
        : `<div class="seat empty-seat">Open seat</div>`);
    }
    const countdown = v.phase === "countdown" ? `<div class="chip cyan" role="status">Starting in <span id="timer" class="mono">${mmss(v.phaseEnd - serverNow())}</span></div>` : "";
    const html = `${header(v.mode === "practice" ? "Practice room" : "Lobby", `${v.players.length}/${v.settings.maxPlayers} agents · needs 4 to start`)}
      <div class="card file" style="text-align:center">
        <div class="label">ROOM CODE</div><div class="roomcode" aria-label="Room code ${v.code.split("").join(" ")}">${esc(v.code)}</div>
        <div class="row" style="justify-content:center;margin-top:8px"><button class="btn sm" data-copy>${ic("link", "sm")} Copy link</button><button class="btn sm" data-share>${ic("share", "sm")} Invite</button></div>
      </div>
      <div class="roster" style="margin-top:14px">${seats.join("")}</div>
      <div style="margin-top:12px;text-align:center">${countdown}</div>
      ${isHost && v.mode !== "practice" ? `<div class="card" style="margin-top:12px"><div class="label" style="margin-bottom:8px">HOST SETTINGS</div>
        <div class="row"><span class="grow">Players</span><button class="btn sm" data-size="-1">−</button><b class="mono" id="sz">${v.settings.maxPlayers}</b><button class="btn sm" data-size="1">+</button></div>
        <div class="row" style="margin-top:8px"><span class="grow">Spies</span><button class="btn sm" data-spy="-1">−</button><b class="mono">${v.settings.spies}</b><button class="btn sm" data-spy="1">+</button></div></div>` : ""}
      <div class="stack" style="margin-top:14px">
        <button class="btn ${meP.ready ? "" : "primary"} hero-btn block" data-ready>${meP.ready ? "Not ready" : "Ready"}</button>
        ${isHost ? `<button class="btn gold block" data-start ${v.players.length < 4 ? "disabled" : ""}>Start now</button>` : ""}
        <button class="btn ghost block" data-leave>Leave room</button>
      </div>`;
    const d = page(html);
    const sig = JSON.stringify([v.players.map((p) => [p.uid, p.ready, p.char]), v.settings, v.phase]);
    S.lobbySig = sig;
    $("[data-ready]", d).onclick = async () => handleAct(await api("POST", "/room/ready", { code: v.code, ready: !meP.ready }));
    const st = $("[data-start]", d);
    if (st) st.onclick = async () => { SFX.start(); handleAct(await api("POST", "/room/start", { code: v.code })); };
    $("[data-leave]", d).onclick = () => confirmBox("Leave room?", "Your seat will be released.", "Leave", leaveMatch);
    $("[data-copy]", d).onclick = () => { try { navigator.clipboard.writeText(inviteLink(v.code)); toast("Invite link copied"); } catch (e) { toast(inviteLink(v.code)); } };
    $("[data-share]", d).onclick = () => shareInvite(v.code);
    $$("[data-size]", d).forEach((b) => (b.onclick = async () => handleAct(await api("POST", "/room/settings", { code: v.code, maxPlayers: v.settings.maxPlayers + Number(b.dataset.size) }))));
    $$("[data-spy]", d).forEach((b) => (b.onclick = async () => handleAct(await api("POST", "/room/settings", { code: v.code, spies: v.settings.spies + Number(b.dataset.spy) }))));
    void first;
  }
  function handleAct(r) {
    if (r && r.view) onView(r.view);
    if (r && !r.ok) toast(errText(r.error), true);
  }

  // ---- role reveal / briefing
  function screenReveal(v) {
    const first = setMatchScreen("reveal");
    if (!first && $(".stage")) return updateTimers(v);
    const role = (v.me && v.me.role) || "agent";
    const info = roleInfo[role] || roleInfo.agent;
    const spy = role === "spy";
    SFX.role();
    const mates = (v.me.teammates || []).map((id) => (v.players.find((p) => p.uid === id) || {}).name).filter(Boolean);
    const st = document.createElement("div");
    st.className = "stage reveal-anim " + (spy ? "pulse-red" : "");
    st.innerHTML = `<div class="dossier">
        <span class="tab">${spy ? "EYES ONLY" : "CLASSIFIED"}</span>
        <div class="label">YOUR ASSIGNMENT</div>
        <div class="role-name ${info.cls}" style="margin:6px 0 10px">${esc(info.name)}</div>
        <div class="row" style="margin-bottom:10px"><div style="width:84px;height:110px">${sprite((S.profile && S.profile.char) || "nova", spy ? "alert" : "idle")}</div>
          <div class="grow"><p style="margin:0 0 6px">${esc(info.desc)}</p></div></div>
        <table class="kv"><tr><td>Objective</td><td>${esc(info.goal)}</td></tr><tr><td>Ability</td><td>${esc(info.ability)}</td></tr>
        ${spy ? `<tr><td>Cover</td><td>Fake tasks, avoid suspicion</td></tr>` : `<tr><td>Spy identity</td><td><span class="redact" aria-label="hidden"></span></td></tr>`}
        ${mates.length ? `<tr><td>Partner</td><td>${esc(mates.join(", "))}</td></tr>` : ""}</table>
        <button class="btn primary block" id="cont" style="margin-top:14px">Continue</button>
      </div>`;
    root.innerHTML = "";
    root.appendChild(st);
    hydrateSprites(st);
    buzz();
    $("#cont", st).onclick = () => {
      SFX.click();
      const mapName = ((window.SA_MAPS || []).find((m) => m.id === v.mapId) || {}).name || "the facility";
      st.classList.remove("pulse-red");
      st.innerHTML = `<div class="dossier"><span class="tab">BRIEFING</span><div class="label">MISSION</div><h2 style="margin:6px 0 10px">${esc(mapName)}</h2>
        <table class="kv"><tr><td>Objectives</td><td>${v.progress.goal} to complete</td></tr><tr><td>Alarm limit</td><td>${v.progress.meterMax} sabotages</td></tr><tr><td>Rounds</td><td>${v.maxRounds}</td></tr><tr><td>Agents</td><td>${v.players.length}</td></tr></table>
        <p class="mute" style="font-size:14px">Use terminals and panels for objectives and clues. Anything strange: remember it, then speak up in the discussion.</p>
        <div class="row between" style="margin-top:10px"><span class="mute">Deploying in <b id="timer" class="mono">${mmss(v.phaseEnd - serverNow())}</b></span></div>
        <div class="bar" style="margin-top:8px"><i id="phasebar" style="width:100%;transition:width .5s linear"></i></div></div>`;
      updateTimers(S.view || v);
    };
  }

  // ---- game (exploration)
  function screenGame(v) {
    const first = setMatchScreen("game");
    if (!first && S.game) {
      updateHud(v);
      return;
    }
    const mapData = (window.SA_MAPS || []).find((m) => m.id === v.mapId) || (window.SA_MAPS || [])[0];
    root.innerHTML = `<div id="game"></div>
      <div class="hud">
        <div class="pill"><span class="label">R<span id="rnd">${v.round}</span>/${v.maxRounds}</span><span id="timer" class="timer mono">${mmss(v.phaseEnd - serverNow())}</span>
          <div class="grow"><div class="label">OBJECTIVES <span id="prog" class="mono"></span></div><div class="bar"><i id="progbar"></i></div></div>
          <div><div class="label" style="text-align:right">ALARM</div><div class="pips" id="pips"></div></div></div>
        <div id="alert"></div>
        <div class="row"><button class="btn sm" id="evi">${ic("search", "sm")} Evidence <span id="evn" class="chip" style="min-height:0"></span></button><button class="btn sm ghost" id="role">${ic("eye", "sm")} Role</button><span class="grow"></span><button class="btn sm ghost" id="leave">${ic("close", "sm")} Leave</button></div>
      </div>
      <div class="controls"><div id="joy" aria-label="Movement stick"><i></i></div><div class="actions" id="actions"></div></div>`;
    S.game = window.SA_GAME.start($("#game"), {
      map: mapData, char: (v.players.find((p) => p.uid === v.me.uid) || {}).char, name: "You", reduceMotion: !!S.settings.reduceMotion,
      onNear: (id) => { S.nearObj = id; renderActions(); },
      onUse: () => useObject(), isBlocked: () => !S.view || S.view.phase !== "explore",
      onWorkDone: (id) => finishWork(id),
      onWorkCancel: () => { S.working = false; toast("Task cancelled: you moved away."); renderActions(); },
    });
    S.game.update(v);
    bindJoystick();
    $("#evi").onclick = openEvidence;
    $("#role").onclick = () => { const r = roleInfo[v.me.role] || roleInfo.agent; const m = modal(`<div class="label">YOUR ROLE</div><div class="role-name ${r.cls}">${esc(r.name)}</div><p class="mute">${esc(r.desc)}</p><button class="btn block" data-c>Close</button>`); $("[data-c]", m.el).onclick = m.close; };
    $("#leave").onclick = back;
    updateHud(v);
  }
  function updateHud(v) {
    const pr = v.progress;
    const set = (id, fn) => { const e = $(id); if (e) fn(e); };
    set("#prog", (e) => (e.textContent = `${pr.done}/${pr.goal}`));
    set("#progbar", (e) => (e.style.width = Math.round((pr.done / Math.max(1, pr.goal)) * 100) + "%"));
    set("#pips", (e) => (e.innerHTML = Array.from({ length: pr.meterMax }, (_, i) => `<i class="${i < pr.meter ? "on" : ""}"></i>`).join("")));
    set("#rnd", (e) => (e.textContent = v.round));
    set("#evn", (e) => (e.textContent = String(v.me.clues.length)));
    const ev = v.events.filter((e) => (e.kind === "sabotage" || e.kind === "alert") && serverNow() - e.at < 20000).slice(-1)[0];
    set("#alert", (e) => (e.innerHTML = ev ? `<div class="alertbar" role="alert">${ic("alert", "sm")} ${esc(ev.text)}</div>` : ""));
    renderActions();
    updateTimers(v);
  }
  function renderActions() {
    const el = $("#actions");
    const v = S.view;
    if (!el || !v || !v.me) return;
    const near = S.nearObj;
    const st = near ? (v.objects.find((o) => o.id === near) || {}) : {};
    const sab = st.state === "sabotaged";
    const parts = [];
    if (v.me.abilities.includes("sabotage")) {
      const cd = v.me.cd.sabotage;
      parts.push(`<button class="act spy" data-ab="sabotage" ${near && !sab && cd <= 0 && v.me.uses.sabotage < 4 ? "" : "disabled"}>${ic("bolt")}<span>Sabotage</span><small>${cd > 0 ? Math.ceil(cd / 1000) + "s" : 4 - v.me.uses.sabotage + " left"}</small></button>`);
      parts.push(`<button class="act spy" data-ab="distract" ${v.me.cd.distract <= 0 ? "" : "disabled"}>${ic("alert")}<span>Distract</span><small>${v.me.cd.distract > 0 ? Math.ceil(v.me.cd.distract / 1000) + "s" : "ready"}</small></button>`);
      parts.push(`<button class="act spy" data-ab="dash" ${v.me.cd.dash <= 0 ? "" : "disabled"}>${ic("play")}<span>Dash</span><small>${v.me.cd.dash > 0 ? Math.ceil(v.me.cd.dash / 1000) + "s" : "ready"}</small></button>`);
    }
    if (v.me.abilities.includes("inspect")) parts.push(`<button class="act" data-ab="inspect" ${v.me.usedThisRound.inspect ? "disabled" : ""}>${ic("search")}<span>Inspect</span><small>${v.me.usedThisRound.inspect ? "used" : "nearest"}</small></button>`);
    if (v.me.abilities.includes("scan")) parts.push(`<button class="act" data-ab="scan" ${v.me.usedThisRound.scan ? "disabled" : ""}>${ic("eye")}<span>Scan</span><small>${v.me.usedThisRound.scan ? "used" : "logs"}</small></button>`);
    if (v.me.abilities.includes("shield")) parts.push(`<button class="act" data-ab="shield" ${v.me.uses.shield >= 1 ? "disabled" : ""}>${ic("shield")}<span>Shield</span><small>${v.me.uses.shield >= 1 ? "used" : "nearest"}</small></button>`);
    parts.push(`<button class="act use" data-use ${near ? "" : "disabled"}>${ic("check")}<span>${sab ? "Repair" : "Use"}</span></button>`);
    el.innerHTML = parts.join("");
    $("[data-use]", el).onclick = useObject;
    $$("[data-ab]", el).forEach((b) => (b.onclick = () => ability(b.dataset.ab)));
  }
  // Using a station takes a moment, like real work: a ring fills over the character and moving away cancels it.
  function useObject() {
    if (!S.nearObj || !S.view || S.working || !S.game) return;
    const st = S.view.objects.find((o) => o.id === S.nearObj) || {};
    const spy = S.view.me.role === "spy";
    // a fake task takes as long as a real one, so the animation never gives the Spy away
    const dur = st.state === "sabotaged" ? 1500 : spy ? 1000 : 1000;
    S.working = true;
    SFX.click(); buzz();
    S.game.setWork(S.nearObj, dur);
    renderActions();
  }
  async function finishWork(id) {
    S.working = false;
    if (!id || !S.view) return;
    const pos = S.game && S.game.pos();
    if (pos) await api("POST", "/room/tick", { code: S.code, x: pos.x, y: pos.y });
    const r = await api("POST", "/room/interact", { code: S.code, obj: id });
    if (r.view) onView(r.view);
    if (!r.ok) return toast(errText(r.error), true);
    if (r.clue) { SFX.clue(); toast("Clue collected"); }
    else toast(r.kind === "repair" ? "System repaired" : "Task complete");
    renderActions();
  }
  function nearestPlayer() {
    const v = S.view;
    if (!v || !S.game) return null;
    const me = S.game.pos();
    let best = null, bd = 90;
    for (const p of v.players) {
      if (p.uid === v.me.uid || !p.alive || p.x === undefined) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < bd) (bd = d), (best = p);
    }
    return best;
  }
  async function ability(name) {
    const v = S.view;
    const body = { code: S.code, ability: name };
    if (name === "sabotage") body.obj = S.nearObj;
    if (name === "inspect" || name === "shield") {
      const t = nearestPlayer();
      if (!t) return toast("Nobody is close enough.", true);
      body.target = t.uid;
    }
    // sync the position first so range checks use where you actually stand
    const pos = S.game && S.game.pos();
    if (pos) await api("POST", "/room/tick", { code: S.code, x: pos.x, y: pos.y });
    const r = await api("POST", "/room/ability", body);
    if (r.view) onView(r.view);
    if (!r.ok) return toast(errText(r.error), true);
    if (name === "dash" && S.game) S.game.dash(4000);
    SFX.click();
    toast(r.message || "Done");
    void v;
  }
  function bindJoystick() {
    const joy = $("#joy");
    if (!joy) return;
    const knob = $("i", joy);
    let active = false;
    const move = (e) => {
      const r = joy.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / (r.width / 2), dy = (e.clientY - cy) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) (dx /= len), (dy /= len);
      knob.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`;
      if (S.game) S.game.setInput(Math.abs(dx) < 0.12 ? 0 : dx, Math.abs(dy) < 0.12 ? 0 : dy);
    };
    joy.addEventListener("pointerdown", (e) => { active = true; joy.setPointerCapture(e.pointerId); move(e); });
    joy.addEventListener("pointermove", (e) => { if (active) move(e); });
    const end = () => { active = false; knob.style.transform = ""; if (S.game) S.game.setInput(0, 0); };
    joy.addEventListener("pointerup", end);
    joy.addEventListener("pointercancel", end);
  }
  function openEvidence() {
    const v = S.view;
    const clues = v.me.clues.map((c) => `<div class="rowitem" style="align-items:flex-start"><span class="chip ${c.tier === "verified" ? "gold" : ""}">${esc(c.tier)}</span><div class="grow">${esc(c.text)}</div></div>`).join("");
    const notes = v.me.notes.filter((n) => !n.text.startsWith("Clue:")).map((n) => `<div class="rowitem"><span class="cyan" style="color:var(--cyan)">${ic("eye", "sm")}</span><div class="grow">${esc(n.text)}</div></div>`).join("");
    const m = document.createElement("div");
    m.className = "drawer";
    m.innerHTML = `<div class="row between"><h3>Evidence</h3><button class="btn sm ghost" data-c>${ic("close", "sm")} Close</button></div>
      <p class="mute" style="font-size:13px">Only you can see this. Share clues in the discussion to put them on the record.</p>
      <div class="stack">${clues || '<div class="empty">No clues yet. Use cabinets, panels and terminals.</div>'}${notes}</div>`;
    root.appendChild(m);
    $("[data-c]", m).onclick = () => m.remove();
  }

  // ---- discussion
  function screenDiscussion(v) {
    const first = setMatchScreen("discussion");
    const alive = v.players.filter((p) => p.alive);
    const chatHtml = v.chat.map((c) => `<div class="msg ${c.kind}">${avatar(c.char)}<div class="bubble"><b style="font-size:12px;color:var(--cyan)">${esc(c.name)}</b>${c.kind === "evidence" ? ' <span class="chip gold" style="min-height:0;padding:0 6px">evidence</span>' : ""}<div>${esc(c.text)}</div></div></div>`).join("");
    if (!first && $("#chatlog")) {
      const log = $("#chatlog");
      const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
      log.innerHTML = chatHtml || '<div class="empty" style="padding:12px">Nobody has spoken yet.</div>';
      hydrateAvatars(log);
      if (atEnd) log.scrollTop = log.scrollHeight;
      updateTimers(v);
      return;
    }
    const events = v.events.filter((e) => e.kind === "sabotage" || e.kind === "alert" || e.kind === "repair" || e.kind === "eliminated").slice(-4);
    const d = page(`
      <div class="row between"><div><div class="label">DISCUSSION · ROUND ${v.round}</div><h2>Who is the Spy?</h2></div><div id="timer" class="timer mono">${mmss(v.phaseEnd - serverNow())}</div></div>
      <div class="bar" style="margin:8px 0"><i id="phasebar" style="width:100%;transition:width .5s linear"></i></div>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">${alive.map((p) => `<span class="chip">${esc(p.name)}${p.bot ? " (bot)" : ""}</span>`).join("")}</div>
      <div class="card"><div class="label">MISSION</div><div class="row between"><span>Objectives ${v.progress.done}/${v.progress.goal}</span><span>Alarm ${v.progress.meter}/${v.progress.meterMax}</span></div>
        ${events.map((e) => `<div class="mute" style="font-size:13px">• ${esc(e.text)}</div>`).join("")}</div>
      ${v.me.alive && v.me.clues.length ? `<div class="card" style="margin-top:10px"><div class="label">YOUR EVIDENCE (private)</div><div class="stack" style="margin-top:6px">${v.me.clues.map((c) => `<div class="row"><div class="grow" style="font-size:14px">${esc(c.text)}</div><button class="btn sm" data-share="${esc(c.id)}">Share</button></div>`).join("")}</div></div>` : ""}
      ${v.me.notes.filter((n) => !n.text.startsWith("Clue:")).length ? `<div class="card" style="margin-top:10px"><div class="label">YOUR NOTES (private)</div>${v.me.notes.filter((n) => !n.text.startsWith("Clue:")).map((n) => `<div style="font-size:14px">• ${esc(n.text)}</div>`).join("")}</div>` : ""}
      <div class="label" style="margin:12px 0 6px">TEAM CHAT</div>
      <div class="chatlog" id="chatlog">${chatHtml || '<div class="empty" style="padding:12px">Nobody has spoken yet.</div>'}</div>
      ${v.me.alive ? `<div class="quick" style="margin-top:10px">
        <button data-q="found">I found suspicious evidence</button><button data-q="security">Check the security room</button><button data-q="task">I was completing a task</button><button data-q="more">We need more evidence</button>
        <select id="suspect" aria-label="Suspect a player" style="min-height:40px;border-radius:999px;background:var(--panel);color:var(--paper);border:1px solid var(--edge);padding:0 10px"><option value="">I suspect…</option>${alive.filter((p) => p.uid !== v.me.uid).map((p) => `<option value="${p.uid}">${esc(p.name)}</option>`).join("")}</select></div>
        <div class="row" style="margin-top:10px"><input type="text" id="say" maxlength="120" placeholder="Say something (120 characters)" aria-label="Chat message"><button class="btn primary" id="send" aria-label="Send">${ic("send")}</button></div>`
        : '<div class="mute" style="margin-top:10px">You were removed. You can watch the discussion.</div>'}
      <div class="row" style="margin-top:12px"><button class="btn sm ghost" id="rep">${ic("flag", "sm")} Report a player</button></div>`);
    const log = $("#chatlog", d);
    log.scrollTop = log.scrollHeight;
    const send = async (body) => handleAct(await api("POST", "/room/chat", Object.assign({ code: v.code }, body)));
    $$("[data-q]", d).forEach((b) => (b.onclick = () => send({ quick: b.dataset.q })));
    const sus = $("#suspect", d);
    if (sus) sus.onchange = () => { if (sus.value) send({ quick: "suspect", target: Number(sus.value) }); sus.value = ""; };
    const say = $("#say", d);
    const sendText = () => { const t = say.value.trim(); if (t) { send({ text: t }); say.value = ""; } };
    if (say) { $("#send", d).onclick = sendText; say.addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); }); }
    $$("[data-share]", d).forEach((b) => (b.onclick = async () => { handleAct(await api("POST", "/room/share", { code: v.code, clue: b.dataset.share })); }));
    $("#rep", d).onclick = () => reportPlayer(v);
    updateTimers(v);
  }
  function reportPlayer(v) {
    const others = v.players.filter((p) => p.uid !== v.me.uid && !p.bot);
    if (!others.length) return toast("No players to report.");
    const m = modal(`<h3>Report a player</h3><div class="field"><select id="who" style="width:100%;min-height:48px;border-radius:14px;background:#0a1020;color:var(--paper);border:1px solid var(--edge);padding:0 12px">${others.map((p) => `<option value="${p.uid}">${esc(p.name)}</option>`).join("")}</select></div>
      <div class="field" style="margin-top:10px"><input type="text" id="why" maxlength="120" placeholder="What happened?"></div>
      <div class="row" style="margin-top:12px"><button class="btn ghost grow" data-c>Cancel</button><button class="btn danger grow" data-s>Send report</button></div>`);
    $("[data-c]", m.el).onclick = m.close;
    $("[data-s]", m.el).onclick = async () => {
      const r = await api("POST", "/room/report", { code: v.code, target: Number($("#who", m.el).value), reason: $("#why", m.el).value });
      m.close();
      toast(r.ok ? "Report sent. Thank you." : errText(r.error), !r.ok);
    };
  }

  // ---- voting
  function screenVoting(v) {
    const first = setMatchScreen("voting");
    const alive = v.players.filter((p) => p.alive);
    const voted = alive.filter((p) => p.voted).length;
    const mine = v.me.voted;
    if (!first && $("#votes")) {
      $("#vcount").textContent = `${voted}/${alive.length} voted`;
      $$(".votecard", root).forEach((c) => c.querySelector(".tick") && (c.querySelector(".tick").style.display = alive.find((p) => String(p.uid) === c.dataset.u && p.voted) ? "" : "none"));
      return updateTimers(v);
    }
    const d = page(`
      <div class="row between"><div><div class="label">VOTE · ROUND ${v.round}</div><h2>Remove a suspect</h2></div><div id="timer" class="timer mono">${mmss(v.phaseEnd - serverNow())}</div></div>
      <div class="bar" style="margin:8px 0"><i id="phasebar" style="width:100%;transition:width .5s linear"></i></div>
      <div class="mute" id="vcount" role="status">${voted}/${alive.length} voted</div>
      <div class="votegrid" id="votes" style="margin-top:10px">${alive.filter((p) => p.uid !== v.me.uid).map((p) => `<button class="votecard" data-u="${p.uid}" aria-pressed="${mine === p.uid}" ${v.me.alive ? "" : "disabled"}>
        <span class="tick" style="display:${p.voted ? "" : "none"}">VOTED</span>${sprite(p.char, "idle")}<div style="font-weight:800;margin-top:4px">${esc(p.name)}</div>${p.bot ? '<div class="faint" style="font-size:11px">Bot</div>' : ""}</button>`).join("")}</div>
      ${v.me.alive ? `<div class="stack" style="margin-top:14px"><button class="btn block" id="abs" aria-pressed="${mine === 0}">Abstain</button><p class="mute" style="font-size:13px;text-align:center" id="vhint">${mine === undefined ? "Pick a suspect. You can change your vote until time runs out." : "Vote locked in. You can still change it."}</p></div>` : '<div class="empty">You were removed. Watching the vote.</div>'}`);
    const cast = async (target) => {
      const r = await api("POST", "/room/vote", { code: v.code, target });
      if (r.view) S.view = r.view;
      if (!r.ok) return toast(errText(r.error), true);
      SFX.click(); buzz();
      $$(".votecard", d).forEach((c) => c.setAttribute("aria-pressed", String(Number(c.dataset.u) === target)));
      const a = $("#abs", d);
      if (a) a.setAttribute("aria-pressed", String(target === 0));
      $("#vhint", d).textContent = target === 0 ? "You abstained." : "Vote locked in. You can still change it.";
    };
    $$(".votecard", d).forEach((c) => (c.onclick = () => cast(Number(c.dataset.u))));
    const a = $("#abs", d);
    if (a) a.onclick = () => cast(0);
    updateTimers(v);
  }

  // ---- vote result / elimination
  function screenVoteResult(v) {
    const first = setMatchScreen("voteresult");
    if (!first) return;
    const r = v.lastVote;
    const out = r && r.eliminated ? v.players.find((p) => p.uid === r.eliminated) : null;
    const st = document.createElement("div");
    st.className = "stage";
    let body;
    if (out) {
      const spy = r.team === "spy";
      body = `<div class="label">VOTE RESULT</div><div class="winners">${sprite(out.char, "defeat")}</div>
        <h2>${esc(out.name)} was removed</h2><div class="stamp ${spy ? "win-gold" : "win-red"}" style="margin-top:12px">${spy ? "The Spy" : "Not the Spy"}</div>`;
      SFX.elim();
    } else {
      body = `<div class="label">VOTE RESULT</div><h2 style="margin-top:10px">${r && r.shielded ? "A shield absorbed the vote" : r && r.tie ? "Tie: nobody removed" : "No majority: nobody removed"}</h2>
        <p class="mute">The Spy is still among you.</p><div class="stamp lose-mute" style="margin-top:12px">No removal</div>`;
    }
    st.innerHTML = body + `<p class="mute" style="margin-top:14px">Next round starts in <b id="timer" class="mono">${mmss(v.phaseEnd - serverNow())}</b></p>`;
    root.innerHTML = "";
    root.appendChild(st);
    hydrateSprites(st);
  }

  function showCancelled(v) {
    setMatchScreen("cancelled");
    stopPolling();
    S.inMatch = false;
    const st = document.createElement("div");
    st.className = "stage";
    st.innerHTML = `<div class="dossier"><span class="tab">VOID</span><h2>Match cancelled</h2><p class="mute">${esc(v.cancelReason || "The match ended before a result.")} No winner was recorded and nothing was spent or earned.</p>
      <button class="btn primary block" id="home">Return home</button></div>`;
    root.innerHTML = "";
    root.appendChild(st);
    $("#home", st).onclick = async () => { await api("POST", "/room/leave", {}); await refreshMe(); go("home", {}, { force: true }); };
  }

  // ---- cinematic result page
  function screenResult(v) {
    const first = setMatchScreen("result");
    const o = v.outcome;
    const me = o.players.find((p) => p.uid === v.me.uid);
    const rw = v.rewards;
    if (!first && $("#coins")) {
      if (rw && !$("#coins").dataset.done) fillRewards(rw);
      return;
    }
    const won = !!(me && me.won);
    const spyWin = o.winner === "spy";
    const dur = (v.endedAt || serverNow()) - (v.startedAt || serverNow());
    (won ? SFX.win : SFX.lose)();
    const winners = o.players.filter((p) => p.won);
    const st = document.createElement("div");
    st.className = "stage" + (spyWin ? " pulse-red" : "");
    st.style.overflowY = "auto";
    st.style.justifyContent = "flex-start";
    st.innerHTML = `<canvas id="fx"></canvas>
      <div style="width:100%;max-width:420px;padding-top:calc(10px + var(--safe-t))">
        <div class="label">${spyWin ? "THE SPY GOT AWAY" : /objectives/i.test(o.reason) ? "MISSION COMPLETE" : "THE SPY WAS CAUGHT"}</div>
        <div class="stamp ${won ? "win-gold" : spyWin ? "win-red" : "lose-mute"}" style="margin:20px 0 12px">${won ? "Victory" : "Defeat"}</div>
        <h2 style="margin-top:6px">${spyWin ? "Spy victory" : "Agents victory"}</h2>
        <p class="mute" style="margin:4px 0 0">${esc(o.reason)}</p>
        <div class="winners">${winners.slice(0, 4).map((p) => sprite(p.char, "victory")).join("") || sprite((me || {}).char || "nova", won ? "victory" : "defeat")}</div>
        <div class="mute" style="font-size:13px">Winners: ${esc(winners.map((p) => p.name).slice(0, 4).join(", ") || "none")}</div>
        <div class="card file" style="margin-top:12px;text-align:left">
          <table class="kv"><tr><td>Your role</td><td>${esc((roleInfo[me ? me.role : "agent"] || {}).name)}</td></tr>
          <tr><td>Result</td><td>${won ? "Victory" : "Defeat"}</td></tr>
          <tr><td>Duration</td><td>${mmss(dur)}</td></tr>
          <tr><td>Objectives completed</td><td>${me ? me.stats.tasks : 0}</td></tr>
          <tr><td>Clues collected</td><td>${me ? me.stats.clues : 0}</td></tr>
          <tr><td>${me && me.role === "spy" ? "Sabotages / fake tasks" : "Correct votes"}</td><td>${me ? (me.role === "spy" ? me.stats.sabotages + " / " + me.stats.fakes : me.stats.correctVotes + "/" + me.stats.votes) : "-"}</td></tr>
          <tr><td>Match ID</td><td class="mono" style="font-size:11px">${esc(v.matchId)}</td></tr></table>
        </div>
        <div class="grid2" style="margin-top:10px">
          <div class="stat"><div class="label">XP earned</div><div class="count" id="xp">${rw ? "+0" : "…"}</div></div>
          <div class="stat"><div class="label">Coins earned</div><div class="count" id="coins" style="color:var(--gold)">${rw ? "+0" : "…"}</div></div>
        </div>
        <div id="lvl" class="stack" style="margin-top:10px"></div>
        <div class="stack" style="margin-top:14px">
          <button class="btn primary hero-btn block" id="again">${ic("play")} Play again</button>
          <div class="grid2"><button class="btn block" id="newm">${ic("bolt")} New match</button><button class="btn block" id="share">${ic("share")} Share result</button></div>
          <div class="grid2"><button class="btn block" id="details">${ic("eye")} Match details</button><button class="btn block" id="board">${ic("rank")} Leaderboard</button></div>
          <button class="btn ghost block" id="home">Return home</button>
        </div>
      </div>`;
    root.innerHTML = "";
    root.appendChild(st);
    hydrateSprites(st);
    runFx($("#fx", st), spyWin && !won ? "alert" : won ? "confetti" : "none");
    if (rw) fillRewards(rw);

    const cleanup = async (then) => {
      stopPolling();
      S.inMatch = false; S.view = null; S.matchScreen = null;
      try { tg && tg.disableClosingConfirmation && tg.disableClosingConfirmation(); } catch (e) { /* ignore */ }
      await refreshMe().catch(() => {});
      then();
    };
    const mode = v.mode;
    $("#again", st).onclick = () => cleanup(async () => {
      await api("POST", "/room/leave", {});
      if (mode === "practice") startPractice();
      else if (mode === "private" || mode === "friends") createRoom(mode);
      else startQuick(mode === "ranked");
    });
    $("#newm", st).onclick = () => cleanup(async () => { await api("POST", "/room/leave", {}); startQuick(false); });
    $("#home", st).onclick = () => cleanup(async () => { await api("POST", "/room/leave", {}); go("home", {}, { force: true }); });
    $("#board", st).onclick = () => cleanup(async () => { await api("POST", "/room/leave", {}); go("board", {}, { force: true }); });
    $("#details", st).onclick = () => {
      const mm = modal(`<h3>Match details</h3><div class="stack" style="margin-top:8px">${o.players.map((p) => `<div class="rowitem" style="min-height:48px">${avatar(p.char)}<div class="grow"><b>${esc(p.name)}</b>${p.bot ? ' <span class="chip">Bot</span>' : ""}<div class="mute" style="font-size:12px">${esc((roleInfo[p.role] || {}).name)} · ${p.stats.tasks} tasks · ${p.stats.clues} clues${p.left ? " · left" : ""}</div></div><span class="chip ${p.won ? "gold" : ""}">${p.won ? "Won" : "Lost"}</span></div>`).join("")}</div><button class="btn block" style="margin-top:12px" data-c>Close</button>`);
      hydrateAvatars(mm.el);
      $("[data-c]", mm.el).onclick = mm.close;
    };
    $("#share", st).onclick = () => shareResult(v, won, spyWin, me, rw);
  }
  function fillRewards(rw) {
    const xp = $("#xp"), coins = $("#coins"), lvl = $("#lvl");
    if (!xp || !coins) return;
    coins.dataset.done = "1";
    const run = (el, to, prefix) => {
      const t0 = performance.now();
      const step = (t) => { const k = Math.min(1, (t - t0) / 900); el.textContent = `${prefix}${Math.round(to * k)}`; if (k < 1 && !S.settings.reduceMotion) requestAnimationFrame(step); else el.textContent = `${prefix}${to}`; };
      requestAnimationFrame(step);
    };
    run(xp, rw.xp, "+");
    run(coins, rw.coins, "+");
    const bits = [];
    if (rw.skipped) bits.push(`<div class="mute" style="font-size:13px">${rw.skipped === "daily-cap" ? "Daily reward limit reached: no more XP or coins today." : "No rewards: you left the match early."}</div>`);
    if (rw.leveledUp) { SFX.level(); bits.push(`<div class="badge" style="border-color:var(--cyan);background:rgba(61,242,255,.08)">${ic("bolt")}<div><b>Level up! You are level ${rw.level}</b><div class="mute" style="font-size:13px">+${rw.levelBonus} bonus coins</div></div></div>`); }
    if (rw.ratingDelta) bits.push(`<div class="badge">${ic("trophy")}<div><b>Rating ${rw.ratingDelta > 0 ? "+" : ""}${rw.ratingDelta}</b></div></div>`);
    for (const id of rw.achievements || []) bits.push(`<div class="badge">${ic("trophy")}<div><b>Achievement unlocked</b><div class="mute" style="font-size:13px">${esc(id.replace(/_/g, " "))}</div></div></div>`);
    lvl.innerHTML = bits.join("");
  }
  function runFx(canvas, kind) {
    if (!canvas || S.settings.reduceMotion || kind === "none") return;
    const x = canvas.getContext("2d");
    const fit = () => { canvas.width = canvas.clientWidth || 360; canvas.height = canvas.clientHeight || 640; };
    fit();
    const N = kind === "confetti" ? 70 : 26;
    const cols = ["#ffc857", "#3df2ff", "#7c5cff", "#5cffc8", "#ff6fd8"];
    const ps = Array.from({ length: N }, () => ({ x: Math.random() * canvas.width, y: -Math.random() * canvas.height, v: 40 + Math.random() * 90, s: 3 + Math.random() * 5, c: cols[(Math.random() * cols.length) | 0], r: Math.random() * 6, w: Math.random() * 2 - 1 }));
    let t0 = performance.now(), last = t0;
    const loop = (t) => {
      if (!canvas.isConnected) return;
      const dt = (t - last) / 1000;
      last = t;
      x.clearRect(0, 0, canvas.width, canvas.height);
      if (kind === "alert") {
        const a = 0.08 + 0.06 * Math.sin((t - t0) / 260);
        x.fillStyle = `rgba(255,59,78,${a})`;
        x.fillRect(0, 0, canvas.width, canvas.height);
        x.fillStyle = "rgba(255,59,78,.35)";
        const y = ((t - t0) / 6) % canvas.height;
        x.fillRect(0, y, canvas.width, 2);
      } else {
        for (const p of ps) {
          p.y += p.v * dt; p.x += p.w * 30 * dt; p.r += dt * 4;
          if (p.y > canvas.height + 10) (p.y = -10), (p.x = Math.random() * canvas.width);
          x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; x.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); x.restore();
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  async function shareResult(v, won, spyWin, me, rw) {
    // A clean 1080x1080 result card drawn locally; shared through Telegram's own share sheet.
    const c = document.createElement("canvas");
    c.width = c.height = 1080;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 1080, 1080);
    g.addColorStop(0, "#060a13"); g.addColorStop(1, spyWin ? "#2a0a12" : "#0b1c33");
    x.fillStyle = g; x.fillRect(0, 0, 1080, 1080);
    x.strokeStyle = won ? "#ffc857" : "#22335a"; x.lineWidth = 8; x.strokeRect(40, 40, 1000, 1000);
    ART.drawAgent(x, ART.charById((me && me.char) || "nova"), won ? "victory" : "defeat", 1, 540, 760, 5.2);
    x.textAlign = "center";
    x.fillStyle = won ? "#ffc857" : "#8fa0bd";
    x.font = "800 150px 'Big Shoulders Display', Impact, sans-serif";
    x.fillText(won ? "VICTORY" : "DEFEAT", 540, 190);
    x.fillStyle = "#e8eef9";
    x.font = "700 44px Manrope, sans-serif";
    x.fillText(`${(roleInfo[me ? me.role : "agent"] || {}).name} · ${spyWin ? "Spy victory" : "Agents victory"}`, 540, 270);
    x.fillStyle = "#3df2ff";
    x.font = "800 52px 'Big Shoulders Display', Impact, sans-serif";
    x.fillText("SECRET AGENT", 540, 970);
    x.fillStyle = "#8fa0bd";
    x.font = "600 30px Manrope, sans-serif";
    x.fillText(rw ? `+${rw.xp} XP  ·  +${rw.coins} coins` : "", 540, 1020);
    const text = `${won ? "I won" : "I played"} SECRET AGENT as ${(roleInfo[me ? me.role : "agent"] || {}).name}. Think you can catch the Spy?`;
    try {
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const file = new File([blob], "secret-agent-result.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) return void (await navigator.share({ files: [file], text }));
    } catch (e) { /* fall back to a link */ }
    const url = `https://t.me/share/url?url=${encodeURIComponent("https://t.me/" + BOT + "?start=sa_home")}&text=${encodeURIComponent(text)}`;
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, "_blank");
  }

  // ------------------------------------------------------------------ admin
  SCREENS.admin = async function () {
    const r = await api("GET", "/admin/dashboard");
    if (!r.ok) return page(`${header("Admin")}<div class="empty">Access denied.</div>`);
    const modeRows = Object.keys(r.config.modes).map((m) => `<div class="switch"><span>${esc(m)} mode</span><button role="switch" data-mode="${esc(m)}" aria-checked="${!!r.config.modes[m]}" aria-label="${esc(m)} mode"></button></div>`).join("");
    const reward = (k) => `<div class="row" style="margin-top:6px"><span class="grow mute" style="font-size:13px">${esc(k)}</span><input type="number" data-r="${esc(k)}" value="${r.config.rewards[k]}" style="width:96px;min-height:40px"></div>`;
    const d = page(`${header("Admin console", "Restricted. Every change is audited.")}
      <div class="grid2">
        <div class="stat"><div class="label">Players</div><div class="big">${r.players}</div></div><div class="stat"><div class="label">Active 24h</div><div class="big">${r.active24h}</div></div>
        <div class="stat"><div class="label">Live matches</div><div class="big">${r.activeMatches}</div></div><div class="stat"><div class="label">Played today</div><div class="big">${r.playedToday}</div></div>
        <div class="stat"><div class="label">Completed</div><div class="big">${r.completed}</div></div><div class="stat"><div class="label">Cancelled</div><div class="big">${r.cancelled}</div></div>
        <div class="stat"><div class="label">Avg duration</div><div class="big">${mmss(r.avgDuration)}</div></div><div class="stat"><div class="label">Server errors</div><div class="big">${r.errors.n}</div></div>
      </div>
      <div class="card" style="margin-top:12px"><div class="label">POPULAR MAPS</div>${r.popularMaps.map((m) => `<div class="row between"><span>${esc(m[0])}</span><b>${m[1]}</b></div>`).join("") || '<div class="mute">No data yet.</div>'}</div>
      <div class="card" style="margin-top:12px"><div class="label">MODES AND MAINTENANCE</div>${modeRows}
        <div class="switch"><span>Maintenance mode</span><button role="switch" data-maint aria-checked="${!!r.config.maintenance}" aria-label="Maintenance mode"></button></div></div>
      <div class="card" style="margin-top:12px"><div class="label">REWARD VALUES</div>${["partCoins", "winCoins", "spyWinBonus", "xpPart", "xpWin", "xpTask", "levelUpCoins", "maxRewardedPerDay"].map(reward).join("")}
        <button class="btn primary block" id="saverw" style="margin-top:10px">Save rewards</button></div>
      <div class="card" style="margin-top:12px"><div class="label">PLAYER LOOKUP</div><div class="row"><input type="text" id="uid" placeholder="Telegram user ID" inputmode="numeric"><button class="btn" id="find">Find</button></div><div id="player"></div></div>
      <div class="card" style="margin-top:12px"><div class="row between"><div class="label">OPEN REPORTS (${r.openReports})</div><button class="btn sm" id="reps">Review</button></div><div id="replist"></div></div>
      <button class="btn block" id="aud" style="margin-top:12px">View audit log</button><div id="audlist" class="stack" style="margin-top:8px"></div>`);
    const save = async (patch) => { const x = await api("POST", "/admin/config", patch); toast(x.ok ? "Saved" : errText(x.error), !x.ok); };
    $$("[data-mode]", d).forEach((b) => (b.onclick = async () => { const on = b.getAttribute("aria-checked") !== "true"; b.setAttribute("aria-checked", String(on)); await save({ modes: { [b.dataset.mode]: on } }); }));
    $("[data-maint]", d).onclick = (e) => {
      const b = e.currentTarget;
      const on = b.getAttribute("aria-checked") !== "true";
      const apply = async () => { b.setAttribute("aria-checked", String(on)); S.cfg.maintenance = on; await save({ maintenance: on }); };
      if (on) confirmBox("Turn on maintenance?", "Every player except admins will see a maintenance page and cannot play until you turn it off.", "Turn on", apply);
      else apply();
    };
    $("#saverw", d).onclick = () => save({ rewards: Object.fromEntries($$("[data-r]", d).map((i) => [i.dataset.r, Number(i.value)])) });
    $("#find", d).onclick = async () => {
      const x = await api("GET", "/admin/player", null, { uid: $("#uid", d).value });
      const el = $("#player", d);
      if (!x.ok) return (el.innerHTML = '<div class="mute">Not found.</div>');
      const p = x.profile;
      el.innerHTML = `<div style="margin-top:8px"><b>${esc(p.name)}</b> <span class="mono faint">${p.uid}</span><div class="mute" style="font-size:13px">Lv ${p.level} · ${p.matches} matches · ${p.coins} coins ${p.banned ? "· BANNED" : ""}</div>
        <div class="row" style="margin-top:8px"><button class="btn sm danger" data-ban>${p.banned ? "Unban" : "Ban"}</button></div></div>`;
      $("[data-ban]", el).onclick = async () => { const y = await api("POST", p.banned ? "/admin/unban" : "/admin/ban", { uid: p.uid, reason: "admin action" }); toast(y.ok ? "Done" : errText(y.error), !y.ok); };
    };
    $("#reps", d).onclick = async () => {
      const x = await api("GET", "/admin/reports");
      $("#replist", d).innerHTML = x.ok && x.reports.length ? x.reports.map((q) => `<div class="rowitem" style="margin-top:6px"><div class="grow"><b>${esc(q.target)}</b> reported by ${esc(q.reporter)}<div class="mute" style="font-size:12px">${esc(q.reason)} · ${esc(q.status)}</div></div><button class="btn sm" data-res="${esc(q.id)}">Resolve</button></div>`).join("") : '<div class="mute">No reports.</div>';
      $$("[data-res]", d).forEach((b) => (b.onclick = async () => { await api("POST", "/admin/report", { id: b.dataset.res, status: "resolved" }); b.closest(".rowitem").remove(); }));
    };
    $("#aud", d).onclick = async () => {
      const x = await api("GET", "/admin/audit");
      $("#audlist", d).innerHTML = x.ok ? x.audit.map((a) => `<div class="rowitem"><div class="grow"><b>${esc(a.action)}</b> <span class="mono faint">${esc(a.target)}</span><div class="mute" style="font-size:12px">by ${esc(a.actor)} · ${new Date(a.at).toLocaleString()}</div></div></div>`).join("") || '<div class="mute">Empty.</div>' : "";
    };
  };

  // ------------------------------------------------------------------ boot
  function authFailed(code) {
    stopPolling();
    root.innerHTML = `<div class="stage"><div class="dossier"><span class="tab">LOCKED</span><h2>Open from Telegram</h2><p class="mute">${esc(errText(code))} SECRET AGENT signs you in through Telegram.</p>
      <a class="btn primary block" href="https://t.me/${BOT}?start=sa_home">Open @${BOT}</a></div></div>`;
    app.classList.add("hide-nav");
  }

  function fitViewport() {
    const h = (tg && tg.viewportStableHeight) || window.innerHeight;
    document.documentElement.style.setProperty("--vh", h + "px");
  }

  async function boot() {
    if (tg) {
      try {
        tg.ready(); tg.expand();
        tg.setHeaderColor && tg.setHeaderColor("#060a13");
        tg.setBackgroundColor && tg.setBackgroundColor("#060a13");
        tg.BackButton && tg.BackButton.onClick(back);
        tg.onEvent && tg.onEvent("viewportChanged", fitViewport);
      } catch (e) { /* older clients */ }
    }
    fitViewport();
    window.addEventListener("resize", fitViewport);
    if (!tg || !tg.initData) return authFailed("auth-missing");

    const maps = await fetch("/agent/maps.json", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    window.SA_MAPS = maps || [];
    try {
      const r = await refreshMe();
      if (r.status === 503 && r.error === "maintenance") return maintenance();
      if (!r.ok) return authFailed(r.error);
    } catch (e) {
      return e.auth ? authFailed(e.code) : toast("Cannot reach the server.", true);
    }
    $(".splash") && $(".splash").remove();
    renderNav();
    if (S.cfg && S.cfg.maintenance && !S.admin) return maintenance();

    // deep links: ?room=CODE, ?go=quick|create|..., or Telegram start_param
    const q = new URLSearchParams(location.search);
    const sp = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || "";
    const room = (q.get("room") || (sp.startsWith("sa_") ? sp.slice(3) : "")).toUpperCase();
    const goto = (q.get("go") || "").toLowerCase();
    const ludoCode = (q.get("ludo") || (sp.startsWith("sa_L") ? sp.slice(4) : "")).toUpperCase();
    if (/^[A-HJ-NP-Z2-9]{5}$/.test(ludoCode) && window.SA_LUDO_RT) {
      go("home");
      return window.SA_LUDO_RT.join(ludoCode);
    }
    if (S.ludoRoom && S.ludoRoom.status !== "finished" && S.ludoRoom.status !== "cancelled" && window.SA_LUDO_RT) {
      go("home");
      return window.SA_LUDO_RT.resume(S.ludoRoom.code);
    }
    if (/^[A-HJ-NP-Z2-9]{5}$/.test(room)) {
      go("home");
      return joinRoom(room);
    }
    if (S.recentRoom && S.recentRoom.status !== "finished" && S.recentRoom.status !== "cancelled") {
      const v = await api("POST", "/room/tick", { code: S.recentRoom.code });
      if (v.ok && v.view) { go("home"); return enterMatch(v.view); }
    }
    const map = { quick: () => startQuick(), create: () => createRoom(), profile: () => go("profile"), leaderboard: () => go("board"), missions: () => go("missions"), rewards: () => go("rewards"), history: () => go("history") };
    go("home");
    if (map[goto]) map[goto]();
  }
  function maintenance() {
    $(".splash") && $(".splash").remove();
    root.innerHTML = `<div class="stage"><div class="dossier"><span class="tab">OFFLINE</span><h2>Maintenance</h2><p class="mute">SECRET AGENT is being upgraded. Your progress is safe. Check back in a few minutes.</p></div></div>`;
    app.classList.add("hide-nav");
  }

  window.SA_APP = { S, go, esc };
  if (window.SA_LUDO) {
    window.SA_LUDO.install({ S, api, toast, esc, ic, SFX, buzz, errText, go, page, header, hydrateSprites, hydrateAvatars, sprite, root, app, confirmBox, modal, refreshMe, SCREENS, runFx });
  }
  boot();
})();
