/* SECRET AGENT: Ludo. Board drawing, dice and screens. All rules run on the server (src/agent/ludo.ts): this file only
   renders the state it is given and sends "roll" or "move token N". */
(function () {
  "use strict";

  // ---------------------------------------------------------------- board geometry (15 x 15 grid)
  const COLORS = ["red", "green", "yellow", "blue"];
  const PAL = {
    red: { main: "#ff3b4e", dark: "#9a1226", light: "#ff8a96" },
    green: { main: "#3ddc84", dark: "#12703a", light: "#9affc0" },
    yellow: { main: "#ffc857", dark: "#a67a10", light: "#ffe7a8" },
    blue: { main: "#4da3ff", dark: "#1a5aa8", light: "#a8d2ff" },
  };
  const START = [0, 13, 26, 39];
  const SAFE = new Set([0, 13, 26, 39, 8, 21, 34, 47]);
  const TRACK = [];
  for (let x = 1; x <= 5; x++) TRACK.push([x, 6]);
  for (let y = 5; y >= 0; y--) TRACK.push([6, y]);
  TRACK.push([7, 0], [8, 0]);
  for (let y = 1; y <= 5; y++) TRACK.push([8, y]);
  for (let x = 9; x <= 14; x++) TRACK.push([x, 6]);
  TRACK.push([14, 7], [14, 8]);
  for (let x = 13; x >= 9; x--) TRACK.push([x, 8]);
  for (let y = 9; y <= 14; y++) TRACK.push([8, y]);
  TRACK.push([7, 14], [6, 14]);
  for (let y = 13; y >= 9; y--) TRACK.push([6, y]);
  for (let x = 5; x >= 0; x--) TRACK.push([x, 8]);
  TRACK.push([0, 7], [0, 6]);
  const HOME_COL = [
    [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
    [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
    [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
    [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
  ];
  const YARD_BASE = [[0, 0], [9, 0], [9, 9], [0, 9]];
  const YARD_SLOT = [[2, 2], [4, 2], [2, 4], [4, 4]];
  const FINISH = [[6.85, 7.5], [7.5, 6.85], [8.15, 7.5], [7.5, 8.15]];

  /** Board position of token `p` (see ludo.ts) of colour `k`, in grid units. */
  function pos(k, p, ti) {
    if (p === -1) return [YARD_BASE[k][0] + YARD_SLOT[ti][0], YARD_BASE[k][1] + YARD_SLOT[ti][1]];
    if (p <= 50) { const c = TRACK[(START[k] + p) % 52]; return [c[0] + 0.5, c[1] + 0.5]; }
    if (p <= 55) { const c = HOME_COL[k][p - 51]; return [c[0] + 0.5, c[1] + 0.5]; }
    return [FINISH[k][0] + ((ti % 2) - 0.5) * 0.28, FINISH[k][1] + (Math.floor(ti / 2) - 0.5) * 0.28];
  }

  window.SA_LUDO = { install };

  function install(UI) {
    const { S, api, toast, esc, ic, SFX, buzz, errText, go, page, header, hydrateSprites, hydrateAvatars, sprite, root, app, confirmBox, modal, refreshMe, SCREENS } = UI;
    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
    const L = { code: null, view: null, poll: 0, running: false, anim: new Map(), raf: 0, dice: null, rolling: 0, shown: -1, finishedShown: false };

    const rt = {
      async leave() {
        stop();
        await api("POST", "/ludo/leave", {});
        L.code = null; L.view = null;
      },
    };
    window.SA_LUDO_RT = rt;

    // ---------------------------------------------------------------- menu
    SCREENS.ludo = function () {
      const d = page(`${header("Ludo", "2 to 4 players. First to bring every token home wins.")}
        <div class="stack">
          <div class="card file"><b>Play with friends</b><div class="mute" style="font-size:13px;margin:4px 0 10px">Create a room and share the code.</div>
            <div class="grid3"><button class="btn" data-n="2">2 players</button><button class="btn" data-n="3">3 players</button><button class="btn" data-n="4">4 players</button></div></div>
          <div class="card file"><b>Join with a code</b><div class="row" style="margin-top:10px"><input type="text" id="lcode" class="code-input" maxlength="5" placeholder="K7M2P" aria-label="Ludo room code" autocapitalize="characters"><button class="btn primary" id="ljoin">Join</button></div></div>
          <div class="card file"><b>Practice against bots</b><div class="mute" style="font-size:13px;margin:4px 0 10px">Starts at once. Four tokens each. Reduced rewards.</div>
            <div class="grid2"><button class="btn" data-p="2">1 bot (2 players)</button><button class="btn" data-p="4">3 bots (4 players)</button></div></div>
          <div class="card"><b>How it works</b><p class="mute" style="font-size:14px;margin:6px 0 0">Roll a 6 to bring a token out. Land on an opponent to send them back. Stars and start squares are safe. A 6, a capture or reaching home gives another roll. You need the exact number to finish.</p></div>
        </div>`);
      const len = 4; // every player gets four tokens
      $$("[data-n]", d).forEach((b) => (b.onclick = async () => open(await api("POST", "/ludo/create", { players: Number(b.dataset.n), tokens: len }))));
      $("#ljoin", d).onclick = async () => open(await api("POST", "/ludo/join", { code: $("#lcode", d).value.trim().toUpperCase() }));
      $$("[data-p]", d).forEach((b) => (b.onclick = async () => open(await api("POST", "/ludo/practice", { tokens: len, players: Number(b.dataset.p) }))));
      if (S.params && S.params.code) $("#lcode", d).value = S.params.code;
    };

    function open(r) {
      if (!r.ok) {
        if (r.error === "already-in-room") return refreshMe().then(() => S.ludoRoom && resume(S.ludoRoom.code));
        return toast(errText(r.error), true);
      }
      SFX.click();
      enter(r.view);
    }

    async function resume(code) {
      const r = await api("POST", "/ludo/tick", { code });
      if (r.view) enter(r.view);
      else toast("That room no longer exists.", true);
    }
    rt.resume = resume;
    rt.diceValue = () => L.dice; // test hook: the value the cube is showing
    // test hook: client coordinates of the tokens that can move right now
    rt.legalPoints = () => {
      const v = L.view, cv = $("#lboard");
      if (!v || !cv) return [];
      const r = cv.getBoundingClientRect(), u = r.width / 15;
      return v.legal.map((i) => { const p = tokenPos(v, v.me, i); return { token: i, x: r.left + p[0] * u, y: r.top + p[1] * u }; });
    };
    rt.join = async (code) => open(await api("POST", "/ludo/join", { code }));

    // ---------------------------------------------------------------- session
    function enter(view) {
      S.inMatch = true;
      S.activeGame = "ludo";
      app.classList.add("hide-nav");
      L.code = view.code;
      L.view = null;
      L.shown = -1;
      L.finishedShown = false;
      L.anim.clear();
      try { window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.enableClosingConfirmation && window.Telegram.WebApp.enableClosingConfirmation(); } catch (e) { /* ignore */ }
      render(view);
      start();
    }
    function start() {
      if (L.running) return;
      L.running = true;
      const loop = async () => {
        if (!L.running) return;
        let wait = 1000;
        try {
          const r = await api("POST", "/ludo/tick", { code: L.code });
          if (r.view) render(r.view);
          else if (r.status === 404 || r.error === "not-in-room") { stop(); toast("You are no longer in that room.", true); finish(); return; }
          const v = r.view;
          if (v && v.status === "playing") wait = v.me === v.turn ? 1200 : 450;
          if (v && v.status === "finished") wait = v.rewards || L.rewardTries++ > 8 ? 4000 : 900;
        } catch (e) {
          if (e.auth) return;
          wait = 2000;
        }
        L.poll = setTimeout(loop, wait);
      };
      L.rewardTries = 0;
      L.poll = setTimeout(loop, 500);
    }
    function stop() { L.running = false; clearTimeout(L.poll); cancelAnimationFrame(L.raf); }
    async function finish() {
      S.inMatch = false; S.activeGame = null;
      try { window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.disableClosingConfirmation && window.Telegram.WebApp.disableClosingConfirmation(); } catch (e) { /* ignore */ }
      await refreshMe().catch(() => {});
      go("home", {}, { force: true });
    }

    // ---------------------------------------------------------------- rendering by state
    function render(v) {
      const prev = L.view;
      if (prev && prev.code === v.code && v.seq < prev.seq) return; // a slower, older answer: ignore it
      L.view = v;
      if (v.status === "cancelled") return cancelled(v);
      if (v.status === "lobby") {
        const sig = JSON.stringify([v.seats.map((q) => [q.uid, q.char, q.color]), v.maxPlayers, v.host]);
        if (sig === L.sig && $(".roomcode")) return; // nothing changed: do not rebuild the page every poll
        L.sig = sig;
        return lobby(v);
      }
      if (v.status === "finished" && !prev) { /* opened a finished room */ }
      if (v.status === "finished") return result(v);
      table(v, prev);
    }

    // ---- lobby
    function lobby(v) {
      const isHost = v.host === (v.seats[v.me] || {}).uid;
      const seats = [];
      for (let i = 0; i < v.maxPlayers; i++) {
        const s = v.seats[i];
        seats.push(s
          ? `<div class="seat ready" style="border-color:${PAL[s.colorName].main}">${s.uid === v.host ? '<span class="host-tag">HOST</span>' : ""}${sprite(s.char, "idle")}<div class="nm">${esc(s.name)}</div><div class="st" style="color:${PAL[s.colorName].main}">${s.bot ? "BOT" : s.colorName.toUpperCase()}</div></div>`
          : '<div class="seat empty-seat">Open seat</div>');
      }
      const d = page(`${header("Ludo lobby", `${v.seats.length}/${v.maxPlayers} players`)}
        <div class="card file" style="text-align:center"><div class="label">ROOM CODE</div><div class="roomcode">${esc(v.code)}</div>
          <div class="row" style="justify-content:center;margin-top:8px"><button class="btn sm" data-copy>${ic("link", "sm")} Copy link</button><button class="btn sm" data-share>${ic("share", "sm")} Invite</button></div></div>
        <div class="roster" style="margin-top:14px">${seats.join("")}</div>
        <div class="stack" style="margin-top:14px">
          ${isHost ? `<button class="btn" data-bot ${v.seats.length >= v.maxPlayers ? "disabled" : ""}>${ic("users")} Add a bot</button>
          <button class="btn primary hero-btn" data-start ${v.seats.length < 2 ? "disabled" : ""}>Start game</button>` : '<div class="mute" style="text-align:center">Waiting for the host to start…</div>'}
          <button class="btn ghost" data-leave>Leave room</button>
        </div>`);
      const link = `https://t.me/MyraSmartBot?start=sa_L${v.code}`;
      $("[data-copy]", d).onclick = () => { try { navigator.clipboard.writeText(link); toast("Invite link copied"); } catch (e) { toast(link); } };
      $("[data-share]", d).onclick = () => {
        const u = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Join my Ludo room " + v.code)}`;
        const tg = window.Telegram && window.Telegram.WebApp;
        tg && tg.openTelegramLink ? tg.openTelegramLink(u) : window.open(u, "_blank");
      };
      const bot = $("[data-bot]", d), st = $("[data-start]", d);
      if (bot) bot.onclick = async () => { const r = await api("POST", "/ludo/addbot", { code: v.code }); if (r.view) render(r.view); if (!r.ok) toast(errText(r.error), true); };
      if (st) st.onclick = async () => { SFX.click(); const r = await api("POST", "/ludo/start", { code: v.code }); if (r.view) render(r.view); if (!r.ok) toast(errText(r.error), true); };
      $("[data-leave]", d).onclick = () => confirmBox("Leave room?", "Your seat will be released.", "Leave", async () => { await rt.leave(); finish(); });
    }

    // ---- the table
    function table(v, prev) {
      const first = !$("#lboard");
      if (first) {
        root.innerHTML = `<div class="page" style="padding-bottom:12px">
          <div class="row between" style="margin-bottom:8px"><div><div class="label">LUDO · ROOM ${esc(v.code)}</div><b id="lstatus" style="font-size:18px"></b></div><button class="btn sm ghost" id="lleave">${ic("close", "sm")} Leave</button></div>
          <div id="lplayers" class="grid2" style="margin-bottom:8px"></div>
          <div class="lwrap"><canvas id="lboard" aria-label="Ludo board"></canvas></div>
          <div class="row" style="margin-top:10px;gap:12px;align-items:center"><div class="dice3d" aria-label="Dice"><div class="dshadow"></div><div class="cube" id="lcube">${DICE_FACES}</div></div>
            <div class="grow"><button class="btn primary hero-btn block" id="lroll">Roll dice</button><div class="mute" id="lhint" style="font-size:13px;margin-top:6px"></div></div></div>
          <div id="llog" class="mute" style="font-size:12px;margin-top:8px;min-height:32px"></div>
        </div>`;
        $("#lleave").onclick = () => confirmBox("Leave this game?", "A bot will play your colour.", "Leave", async () => { await rt.leave(); finish(); });
        $("#lroll").onclick = roll;
        L.cubeAt = 0; L.cubeRot = [0, 0];
        setCube(v.lastRoll ? v.lastRoll.value : 1, false);
        const cv = $("#lboard");
        cv.addEventListener("pointerdown", onBoardTap);
        sizeBoard();
        window.addEventListener("resize", sizeBoard);
        loopDraw();
      }
      updatePanels(v);
      if (v.lastMove && (!prev || !prev.lastMove || prev.lastMove.at !== v.lastMove.at || prev.seq === undefined)) animateMove(v.lastMove, prev);
      if (first && v.lastRoll) {
        // opened mid-game: show the last value without tumbling
        L.shown = v.lastRoll.at;
        L.dice = v.lastRoll.value;
      } else if (v.lastRoll && L.shown !== v.lastRoll.at) {
        L.shown = v.lastRoll.at;
        rollAnim(v.lastRoll.value);
      }
    }

    function sizeBoard() {
      const cv = $("#lboard");
      if (!cv) return;
      const w = Math.min(cv.parentElement.clientWidth || 360, 520);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.style.width = w + "px";
      cv.style.height = w + "px";
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(w * dpr);
    }

    function updatePanels(v) {
      const me = v.me;
      const mine = v.turn === me;
      const cur = v.seats[v.turn];
      const status = $("#lstatus");
      if (status) status.textContent = v.status === "playing" ? (mine ? (v.phase === "roll" ? "Your turn: roll" : "Your turn: pick a token") : `${cur.name}'s turn`) : "";
      const pl = $("#lplayers");
      if (pl) {
        pl.innerHTML = v.seats.map((s, i) => {
          const active = i === v.turn && v.status === "playing";
          const col = PAL[s.colorName];
          return `<div class="rowitem" style="min-height:48px;padding:6px 10px;border-color:${active ? col.main : "var(--edge)"};${active ? `box-shadow:0 0 14px ${col.main}55` : ""}">
            <span style="width:14px;height:14px;border-radius:50%;background:${col.main};flex:none"></span>
            <div class="grow" style="min-width:0"><div style="font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}${i === me ? " (you)" : ""}</div>
            <div class="mute" style="font-size:11px">${s.home}/${s.tokens.length} home${s.bot ? " · bot" : s.auto ? " · away" : ""}</div></div>
            ${active ? `<span class="mono" style="font-size:12px" data-lt>${Math.max(0, Math.ceil((v.deadline - (Date.now() + S.clockOffset)) / 1000))}s</span>` : ""}</div>`;
        }).join("");
      }
      const roll = $("#lroll");
      if (roll) {
        const can = v.status === "playing" && mine && v.phase === "roll";
        roll.disabled = !can;
        roll.textContent = can ? "Roll dice" : mine ? "Choose a token" : "Waiting…";
      }
      const hint = $("#lhint");
      if (hint) {
        const who = v.lastRoll ? `${v.seats[v.lastRoll.seat].name} rolled ${v.lastRoll.value}. ` : "";
        hint.textContent = who + (mine && v.phase === "move" ? (v.legal.length === 1 ? "Only one move is possible." : "Tap a glowing character.") : v.sixes ? `Sixes in a row: ${v.sixes}` : "");
      }
      const lg = $("#llog");
      if (lg) lg.innerHTML = v.log.slice(-2).map((e) => `• ${esc(e.text)}`).join("<br>");
    }
    setInterval(() => {
      const v = L.view;
      if (!v || v.status !== "playing") return;
      const el = $("[data-lt]");
      if (el) el.textContent = Math.max(0, Math.ceil((v.deadline - (Date.now() + S.clockOffset)) / 1000)) + "s";
    }, 500);

    // ---- actions
    async function roll() {
      const v = L.view;
      if (!v || v.status !== "playing" || v.turn !== v.me || v.phase !== "roll" || L.free) return;
      buzz();
      freeSpin(); // tumble right away, do not wait for the network
      const r = await api("POST", "/ludo/roll", { code: v.code });
      if (r.view) render(r.view);
      if (!r.ok) {
        stopFree();
        setCube(L.dice || 1, false);
        toast(errText(r.error), true);
      }
    }
    async function moveToken(i) {
      const v = L.view;
      if (!v || v.turn !== v.me || v.phase !== "move" || !v.legal.includes(i)) return;
      buzz();
      const r = await api("POST", "/ludo/move", { code: v.code, token: i });
      if (r.view) render(r.view);
      if (!r.ok) toast(errText(r.error), true);
    }
    function onBoardTap(e) {
      const v = L.view;
      if (!v || v.turn !== v.me || v.phase !== "move") return;
      const cv = $("#lboard");
      const rect = cv.getBoundingClientRect();
      const u = rect.width / 15;
      const gx = (e.clientX - rect.left) / u, gy = (e.clientY - rect.top) / u;
      const seat = v.seats[v.me];
      let best = null, bd = 1.1;
      for (const i of v.legal) {
        const p = tokenPos(v, v.me, i);
        const d = Math.hypot(p[0] - gx, p[1] - gy);
        if (d < bd) (bd = d), (best = i);
      }
      // one possible move: any tap on the board plays it
      if (best === null && v.legal.length === 1) best = v.legal[0];
      if (best !== null) moveToken(best);
      void seat;
    }

    // ---------------------------------------------------------------- animation state
    function tokenPos(v, si, ti) {
      const a = L.anim.get(si + ":" + ti);
      const s = v.seats[si];
      if (a) {
        const t = (Date.now() - a.t0) / a.dur;
        if (t < 1) {
          const n = a.path.length - 1;
          const f = Math.max(0, t) * n;
          const i = Math.min(n - 1, Math.floor(f));
          const k = f - i;
          const p0 = a.path[i], p1 = a.path[i + 1];
          return [p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k - Math.sin(k * Math.PI) * 0.25];
        }
        L.anim.delete(si + ":" + ti);
      }
      return pos(s.color, s.tokens[ti], ti);
    }
    function animateMove(m, prev) {
      const v = L.view;
      if (!prev) return; // opening mid-game: no replay
      const s = v.seats[m.seat];
      const path = [];
      if (m.from === -1) path.push(pos(s.color, -1, m.token), pos(s.color, 0, m.token));
      else for (let p = m.from; p <= m.to; p++) path.push(pos(s.color, p, m.token));
      if (path.length > 1) L.anim.set(m.seat + ":" + m.token, { path, t0: Date.now(), dur: Math.min(1100, 160 * (path.length - 1)) });
      // captured tokens fly back to the yard
      for (const c of m.captured || []) {
        const cs = v.seats[c.seat];
        const was = prev.seats[c.seat].tokens[c.token];
        if (was >= 0) L.anim.set(c.seat + ":" + c.token, { path: [pos(cs.color, was, c.token), pos(cs.color, -1, c.token)], t0: Date.now() + 200, dur: 500 });
      }
      if ((m.captured || []).length) { SFX.elim(); buzz("err"); } else SFX.tick();
    }
    // ---- the 3D dice: a CSS cube that tumbles to the rolled value
    const DICE_FACE_ORDER = [[1, "front"], [6, "back"], [3, "right"], [4, "left"], [2, "top"], [5, "bottom"]];
    const PIP_ON = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    const DICE_FACES = DICE_FACE_ORDER.map(([n, cls]) => `<div class="face ${cls}">${Array.from({ length: 9 }, (_, i) => `<i class="${PIP_ON[n].includes(i) ? "on" : ""}"></i>`).join("")}</div>`).join("");
    // rotation (degrees) that brings value n to the front of the cube
    const SHOW = { 1: [0, 0], 6: [0, 180], 3: [0, -90], 4: [0, 90], 2: [-90, 0], 5: [90, 0] };
    function setCube(value, spin) {
      const cube = $("#lcube");
      if (!cube) return;
      const [rx, ry] = SHOW[value] || SHOW[1];
      if (!spin || (window.SA_APP && window.SA_APP.S.settings.reduceMotion)) {
        cube.style.transition = "none";
        cube.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
        L.cubeRot = [rx, ry];
        return;
      }
      // add whole turns so it always tumbles, and finish exactly on the target face
      const turnsX = 2 + Math.floor(Math.random() * 2), turnsY = 3 + Math.floor(Math.random() * 2);
      const tx = L.cubeRot[0] + 360 * turnsX + ((rx - L.cubeRot[0]) % 360 + 360) % 360;
      const ty = L.cubeRot[1] + 360 * turnsY + ((ry - L.cubeRot[1]) % 360 + 360) % 360;
      cube.style.transition = "transform 850ms cubic-bezier(.15,.7,.2,1)";
      cube.style.transform = `rotateX(${tx}deg) rotateY(${ty}deg) rotateZ(0deg)`;
      L.cubeRot = [tx, ty];
      const wrap = cube.parentElement;
      wrap.classList.remove("tumble");
      void wrap.offsetWidth;
      wrap.classList.add("tumble");
    }
    // free tumble while we wait for the server's number
    function freeSpin() {
      const cube = $("#lcube");
      if (!cube || L.free) return;
      if (window.SA_APP && window.SA_APP.S.settings.reduceMotion) return;
      SFX.diceRattle();
      const st = { a: L.cubeRot[0], b: L.cubeRot[1], last: performance.now(), raf: 0, t0: performance.now() };
      L.free = st;
      const step = (t) => {
        if (L.free !== st) return;
        const dt = Math.min(50, t - st.last);
        st.last = t;
        st.a += dt * 0.95;
        st.b += dt * 1.35;
        cube.style.transition = "none";
        cube.style.transform = `rotateX(${st.a}deg) rotateY(${st.b}deg)`;
        const wrap = cube.parentElement;
        wrap.style.transform = `translateY(${-Math.abs(Math.sin((t - st.t0) / 140)) * 16}px)`;
        if (t - st.t0 > 6000) return stopFree(); // never spin forever
        st.raf = requestAnimationFrame(step);
      };
      st.raf = requestAnimationFrame(step);
    }
    function stopFree() {
      const st = L.free;
      if (!st) return;
      cancelAnimationFrame(st.raf);
      L.free = null;
      L.cubeRot = [st.a % 360, st.b % 360];
      const cube = $("#lcube");
      if (cube) cube.parentElement.style.transform = "";
    }
    function rollAnim(final) {
      L.dice = final;
      const wasFree = !!L.free;
      stopFree();
      if (!wasFree) SFX.diceRattle(); // opponent or bot rolled: rattle from here
      const cube = $("#lcube");
      if (cube) {
        // freeze at the current angle, then settle on the rolled face
        cube.style.transition = "none";
        cube.style.transform = `rotateX(${L.cubeRot[0]}deg) rotateY(${L.cubeRot[1]}deg)`;
        void cube.offsetWidth;
      }
      setTimeout(() => SFX.diceLand(), 780);
      setCube(final, true);
    }

    // ---------------------------------------------------------------- drawing
    function loopDraw() {
      cancelAnimationFrame(L.raf);
      const frame = () => {
        if (!L.running && !$("#lboard")) return;
        drawBoard();
        L.raf = requestAnimationFrame(frame);
      };
      L.raf = requestAnimationFrame(frame);
    }

    function drawBoard() {
      const cv = $("#lboard");
      const v = L.view;
      if (!cv || !v) return;
      const x = cv.getContext("2d");
      const u = cv.width / 15;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, cv.width, cv.height);
      // board plate
      x.fillStyle = "#0b1322";
      roundRect(x, 0, 0, cv.width, cv.height, u * 0.5); x.fill();
      // yards
      for (let k = 0; k < 4; k++) {
        const [bx, by] = YARD_BASE[k];
        const c = PAL[COLORS[k]];
        const g = x.createLinearGradient(bx * u, by * u, (bx + 6) * u, (by + 6) * u);
        g.addColorStop(0, c.dark); g.addColorStop(1, shadeCol(c.main, -0.35));
        x.fillStyle = g;
        roundRect(x, bx * u + 2, by * u + 2, 6 * u - 4, 6 * u - 4, u * 0.6); x.fill();
        x.fillStyle = "#0a1020";
        roundRect(x, (bx + 1) * u, (by + 1) * u, 4 * u, 4 * u, u * 0.5); x.fill();
        for (let i = 0; i < 4; i++) {
          x.fillStyle = c.main + "33";
          x.beginPath(); x.arc((bx + YARD_SLOT[i][0]) * u, (by + YARD_SLOT[i][1]) * u, u * 0.5, 0, 7); x.fill();
          x.strokeStyle = c.main + "88"; x.lineWidth = 2; x.stroke();
        }
      }
      // track cells
      for (let i = 0; i < 52; i++) {
        const [cx, cy] = TRACK[i];
        const startOf = START.indexOf(i);
        x.fillStyle = startOf >= 0 ? PAL[COLORS[startOf]].main : "#16233d";
        x.globalAlpha = startOf >= 0 ? 0.85 : 1;
        roundRect(x, cx * u + 1.5, cy * u + 1.5, u - 3, u - 3, u * 0.2); x.fill();
        x.globalAlpha = 1;
        x.strokeStyle = "rgba(255,255,255,.08)"; x.lineWidth = 1; x.stroke();
        if (SAFE.has(i) && startOf < 0) star(x, (cx + 0.5) * u, (cy + 0.5) * u, u * 0.28, "#ffc857");
        if (startOf >= 0) star(x, (cx + 0.5) * u, (cy + 0.5) * u, u * 0.24, "rgba(255,255,255,.9)");
      }
      // home columns and centre
      for (let k = 0; k < 4; k++) {
        const c = PAL[COLORS[k]];
        for (const [cx, cy] of HOME_COL[k]) {
          x.fillStyle = c.main; x.globalAlpha = 0.55;
          roundRect(x, cx * u + 1.5, cy * u + 1.5, u - 3, u - 3, u * 0.2); x.fill();
          x.globalAlpha = 1;
        }
      }
      const cxp = 7.5 * u, cyp = 7.5 * u;
      const tri = [[6, 6, 6, 9, "red"], [6, 6, 9, 6, "green"], [9, 6, 9, 9, "yellow"], [6, 9, 9, 9, "blue"]];
      tri.forEach(([ax, ay, bx2, by2, name]) => {
        x.fillStyle = PAL[name].main;
        x.beginPath(); x.moveTo(ax * u, ay * u); x.lineTo(bx2 * u, by2 * u); x.lineTo(cxp, cyp); x.closePath(); x.fill();
      });
      x.strokeStyle = "#0b1322"; x.lineWidth = 2;
      x.strokeRect(6 * u, 6 * u, 3 * u, 3 * u);

      // legal targets glow
      const mine = v.status === "playing" && v.turn === v.me && v.phase === "move";
      const t = Date.now() / 300;
      // tokens, drawn bottom to top; tokens sharing a cell are fanned out a little
      const items = [];
      v.seats.forEach((s, si) => s.tokens.forEach((_, ti) => items.push({ si, ti, p: tokenPos(v, si, ti) })));
      const groups = new Map();
      for (const it of items) {
        const key = Math.round(it.p[0] * 4) + ":" + Math.round(it.p[1] * 4);
        const arr = groups.get(key) || [];
        arr.push(it);
        groups.set(key, arr);
      }
      for (const arr of groups.values()) arr.forEach((it, i) => { if (arr.length > 1) { it.p = [it.p[0] + (i - (arr.length - 1) / 2) * 0.3, it.p[1] - i * 0.05]; it.shrink = 0.82; } });
      items.sort((a, b) => a.p[1] - b.p[1]);
      for (const it of items) {
        const s = v.seats[it.si];
        const c = PAL[s.colorName];
        const movable = mine && it.si === v.me && v.legal.includes(it.ti);
        const px = it.p[0] * u, py = it.p[1] * u;
        const lift = movable ? Math.sin(t + it.ti) * u * 0.06 : 0;
        if (movable) {
          x.strokeStyle = "#ffffff"; x.lineWidth = 3;
          x.globalAlpha = 0.6 + 0.4 * Math.sin(t * 1.5);
          x.beginPath(); x.arc(px, py, u * (0.5 + 0.05 * Math.sin(t * 2)), 0, 7); x.stroke();
          x.globalAlpha = 1;
          // where it would land
          const to = destination(s, it.ti, v.dice);
          if (to) {
            const tp = pos(s.color, to, it.ti);
            x.strokeStyle = c.light; x.setLineDash([4, 4]); x.lineWidth = 2;
            x.beginPath(); x.arc(tp[0] * u, tp[1] * u, u * 0.36, 0, 7); x.stroke(); x.setLineDash([]);
          }
        }
        charToken(x, px, py - lift, u, c, s.char, it.shrink || 1);
      }
    }

    function destination(seat, ti, dice) {
      const p = seat.tokens[ti];
      if (dice === null || dice === undefined) return null;
      if (p === -1) return dice === 6 ? 0 : null;
      const to = p + dice;
      return to > 56 ? null : to;
    }

    /** A token is the player's own 2D character standing on a coloured base, so each colour is still obvious. */
    function charToken(x, px, py, u, c, charId, scale) {
      const ART = window.SA_ART;
      const h = u * 1.55 * (scale || 1);
      // coloured base
      x.fillStyle = "rgba(0,0,0,.45)";
      x.beginPath(); x.ellipse(px, py + u * 0.3, u * 0.4, u * 0.17, 0, 0, 7); x.fill();
      const g = x.createLinearGradient(px - u * 0.35, py, px + u * 0.35, py);
      g.addColorStop(0, c.dark); g.addColorStop(0.5, c.main); g.addColorStop(1, c.dark);
      x.fillStyle = g;
      x.beginPath(); x.ellipse(px, py + u * 0.27, u * 0.36, u * 0.15, 0, 0, 7); x.fill();
      x.strokeStyle = "rgba(255,255,255,.7)"; x.lineWidth = Math.max(1.5, u * 0.04);
      x.stroke();
      if (ART && ART.frame) {
        const img = ART.frame(charId, "idle", 0, 2);
        const w = h * (img.width / img.height);
        // the sprite's feet sit 4/96 above its bottom edge
        x.drawImage(img, px - w / 2, py + u * 0.3 - h + h * (4 / 96), w, h);
      } else pawn(x, px, py, u, c);
    }

    function pawn(x, px, py, u, c) {
      x.fillStyle = "rgba(0,0,0,.45)";
      x.beginPath(); x.ellipse(px + u * 0.05, py + u * 0.26, u * 0.3, u * 0.12, 0, 0, 7); x.fill();
      const g = x.createRadialGradient(px - u * 0.1, py - u * 0.2, u * 0.03, px, py - u * 0.05, u * 0.38);
      g.addColorStop(0, c.light); g.addColorStop(0.5, c.main); g.addColorStop(1, c.dark);
      x.fillStyle = g;
      x.beginPath(); x.moveTo(px - u * 0.3, py + u * 0.24); x.quadraticCurveTo(px - u * 0.28, py - u * 0.02, px, py - u * 0.02);
      x.quadraticCurveTo(px + u * 0.28, py - u * 0.02, px + u * 0.3, py + u * 0.24); x.closePath(); x.fill();
      x.beginPath(); x.arc(px, py - u * 0.2, u * 0.2, 0, 7); x.fill();
      x.strokeStyle = "rgba(255,255,255,.55)"; x.lineWidth = Math.max(1, u * 0.04);
      x.beginPath(); x.arc(px, py - u * 0.2, u * 0.2, Math.PI * 1.1, Math.PI * 1.7); x.stroke();
    }

    function star(x, cx, cy, r, color) {
      x.fillStyle = color;
      x.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
        x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      x.closePath(); x.fill();
    }
    function roundRect(x, X, Y, W, H, r) {
      x.beginPath();
      x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath();
    }
    function shadeCol(hex, f) {
      const n = parseInt(hex.slice(1), 16);
      const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
      return `rgb(${c(((n >> 16) & 255) * (1 + f))},${c(((n >> 8) & 255) * (1 + f))},${c((n & 255) * (1 + f))})`;
    }

    const PIPS = { 1: [[0.5, 0.5]], 2: [[0.28, 0.28], [0.72, 0.72]], 3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]], 4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
      5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]], 6: [[0.28, 0.25], [0.72, 0.25], [0.28, 0.5], [0.72, 0.5], [0.28, 0.75], [0.72, 0.75]] };
    function drawDice() {
      const cv = $("#ldice");
      const v = L.view;
      if (!cv || !v) return;
      const x = cv.getContext("2d");
      const W = cv.width;
      x.clearRect(0, 0, W, W);
      const val = L.dice || v.dice || 1;
      const rolling = L.rolling && L.dice !== null && Date.now() % 1000 < 0; // placeholder for future spin
      void rolling;
      const col = PAL[(v.seats[v.turn] || { colorName: "red" }).colorName];
      const g = x.createLinearGradient(0, 0, W, W);
      g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#cfd8e8");
      x.fillStyle = g;
      roundRect(x, 8, 8, W - 16, W - 16, 22); x.fill();
      x.strokeStyle = col.main; x.lineWidth = 6; x.stroke();
      x.fillStyle = "#0b1322";
      for (const [px, py] of PIPS[val]) { x.beginPath(); x.arc(8 + px * (W - 16), 8 + py * (W - 16), 9, 0, 7); x.fill(); }
    }

    // ---- result and cancelled
    function result(v) {
      if (L.finishedShown && $("#lagain")) {
        const rw = v.rewards;
        if (rw && !$("#lxp").dataset.done) fillReward(rw);
        return;
      }
      L.finishedShown = true;
      cancelAnimationFrame(L.raf);
      const won = v.winner === v.me;
      (won ? SFX.win : SFX.lose)();
      const st = document.createElement("div");
      st.className = "stage";
      st.style.overflowY = "auto";
      st.style.justifyContent = "flex-start";
      const winner = v.seats[v.winner];
      st.innerHTML = `<canvas id="fx"></canvas><div style="width:100%;max-width:420px;padding-top:calc(10px + var(--safe-t))">
        <div class="label">LUDO</div>
        <div class="stamp ${won ? "win-gold" : "lose-mute"}" style="margin:18px 0 12px">${won ? "Victory" : "Defeat"}</div>
        <h2>${esc(winner.name)} wins</h2>
        <div class="winners">${sprite(winner.char, "victory")}</div>
        <div class="card file" style="text-align:left"><table class="kv">${(v.standings || []).map((s, i) => `<tr><td>${i + 1}. ${esc(s.name)}${s.bot ? " (bot)" : ""}</td><td>${s.home}/${v.tokensPer || 4} home</td></tr>`).join("")}</table></div>
        <div class="grid2" style="margin-top:10px"><div class="stat"><div class="label">XP earned</div><div class="count" id="lxp">…</div></div><div class="stat"><div class="label">Coins earned</div><div class="count" id="lcoins" style="color:var(--gold)">…</div></div></div>
        <div id="lextra" class="stack" style="margin-top:10px"></div>
        <div class="stack" style="margin-top:14px"><button class="btn primary hero-btn block" id="lagain">${ic("play")} Play again</button>
          <button class="btn ghost block" id="lhome">Return home</button></div></div>`;
      root.innerHTML = "";
      root.appendChild(st);
      hydrateSprites(st);
      if (won) UI.runFx($("#fx", st), "confetti");
      if (v.rewards) fillReward(v.rewards);
      const mode = v.mode;
      const cleanup = async (then) => { stop(); await api("POST", "/ludo/leave", {}); S.inMatch = false; S.activeGame = null; await refreshMe().catch(() => {}); then(); };
      $("#lagain", st).onclick = () => cleanup(async () => { go("ludo", {}, { force: true }); });
      $("#lhome", st).onclick = () => cleanup(() => go("home", {}, { force: true }));
    }
    function fillReward(rw) {
      const xp = $("#lxp"), coins = $("#lcoins");
      if (!xp) return;
      xp.dataset.done = "1";
      xp.textContent = "+" + rw.xp;
      coins.textContent = "+" + rw.coins;
      const bits = [];
      if (rw.skipped) bits.push(`<div class="mute" style="font-size:13px">${rw.skipped === "daily-cap" ? "Daily reward limit reached." : "No rewards: you left the match early."}</div>`);
      if (rw.leveledUp) bits.push(`<div class="badge" style="border-color:var(--cyan)">${ic("bolt")}<div><b>Level up! Level ${rw.level}</b></div></div>`);
      for (const id of rw.achievements || []) bits.push(`<div class="badge">${ic("trophy")}<div><b>Achievement unlocked</b><div class="mute" style="font-size:13px">${esc(id.replace(/_/g, " "))}</div></div></div>`);
      $("#lextra").innerHTML = bits.join("");
    }
    function cancelled(v) {
      stop();
      S.inMatch = false; S.activeGame = null;
      root.innerHTML = `<div class="stage"><div class="dossier"><span class="tab">VOID</span><h2>Game cancelled</h2><p class="mute">${esc(v.cancelReason || "The game ended before a result.")} Nothing was earned or lost.</p><button class="btn primary block" id="lh">Return home</button></div></div>`;
      $("#lh").onclick = async () => { await api("POST", "/ludo/leave", {}); await refreshMe().catch(() => {}); go("home", {}, { force: true }); };
    }
  }
})();
