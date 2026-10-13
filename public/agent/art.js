/* SECRET AGENT: procedural art. Every character, map and icon is drawn from code, so the game ships original art
   with no borrowed or placeholder assets. Shared by the Phaser scene and the DOM screens. */
(function () {
  "use strict";

  const CHARS = [
    { id: "nova", name: "Agent Nova", color: "#3df2ff", colorName: "cyan", suit: "#1a8fa8", trim: "#3df2ff", skin: "#f1c9a5", hair: "#2a3350", trait: "visor" },
    { id: "raven", name: "Detective Raven", color: "#8f6cff", colorName: "violet", suit: "#4a3a9a", trim: "#b9a3ff", skin: "#d9a982", hair: "#15131f", trait: "hat" },
    { id: "pixel", name: "Hacker Pixel", color: "#5cffc8", colorName: "mint", suit: "#1f8f6e", trim: "#5cffc8", skin: "#f1c9a5", hair: "#1c3a52", trait: "headset" },
    { id: "atlas", name: "Guardian Atlas", color: "#4da3ff", colorName: "blue", suit: "#2a5fa8", trim: "#9ccbff", skin: "#a8744f", hair: "#10151f", trait: "helmet" },
    { id: "phantom", name: "Spy Phantom", color: "#e8eef9", colorName: "white", suit: "#5a6478", trim: "#e8eef9", skin: "#e8c3a0", hair: "#d8dde8", trait: "mask" },
    { id: "echo", name: "Analyst Echo", color: "#ffc857", colorName: "gold", suit: "#a8801f", trim: "#ffe29a", skin: "#7c4f35", hair: "#2a1a10", trait: "glasses" },
    { id: "viper", name: "Shadow Viper", color: "#ff3b4e", colorName: "red", suit: "#9a1f2e", trim: "#ff7a88", skin: "#f1c9a5", hair: "#1a0f14", trait: "scarf" },
    { id: "orion", name: "Commander Orion", color: "#ff9d3d", colorName: "orange", suit: "#a85d1f", trim: "#ffc48a", skin: "#c58b63", hair: "#3a2a1a", trait: "cap" },
    { id: "cipher", name: "Courier Cipher", color: "#ff6fd8", colorName: "pink", suit: "#9a2f85", trim: "#ffa8ea", skin: "#e8c3a0", hair: "#3a1030", trait: "bun" },
    { id: "rook", name: "Sentinel Rook", color: "#b8ff5c", colorName: "lime", suit: "#5a8f1f", trim: "#d8ff9a", skin: "#8a5a3a", hair: "#10200f", trait: "shades" },
  ];
  const charById = (id) => CHARS.find((c) => c.id === id) || CHARS[0];

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Draws one frame of a character into a 64x84 box whose bottom centre is (cx, by). pose: idle | walk | alert | victory | defeat */
  function drawAgent(ctx, ch, pose, t, cx, by, scale, opts) {
    opts = opts || {};
    const s = scale || 1;
    const bob = pose === "idle" ? Math.sin(t * 2.4) * 1.5 : pose === "walk" ? Math.abs(Math.sin(t * 9)) * 3 : pose === "victory" ? -Math.abs(Math.sin(t * 5)) * 8 : 0;
    const sway = pose === "alert" ? Math.sin(t * 24) * 1.4 : 0;
    const swing = pose === "walk" ? Math.sin(t * 9) : 0;
    const dead = pose === "defeat";
    ctx.save();
    ctx.translate(cx + sway * s, by);
    ctx.scale(s * (opts.flip ? -1 : 1), s);
    if (dead) ctx.globalAlpha *= 0.92;

    // ground shadow
    ctx.fillStyle = "rgba(0,0,0,.38)";
    ctx.beginPath();
    ctx.ellipse(0, -2, 17, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    const suit = dead ? "#4b5266" : ch.suit;
    const trim = dead ? "#8a93a8" : ch.trim;
    const y0 = -bob;

    // legs
    ctx.fillStyle = dead ? "#2c3140" : "#141c30";
    rr(ctx, -10 + swing * 4, y0 - 20, 8, 20, 3); ctx.fill();
    rr(ctx, 2 - swing * 4, y0 - 20, 8, 20, 3); ctx.fill();
    ctx.fillStyle = trim;
    rr(ctx, -11 + swing * 4, y0 - 4, 10, 4, 2); ctx.fill();
    rr(ctx, 1 - swing * 4, y0 - 4, 10, 4, 2); ctx.fill();

    // arms
    const armUp = pose === "victory" ? -1 : 0;
    ctx.fillStyle = suit;
    if (armUp) {
      rr(ctx, -21, y0 - 58, 7, 26, 3); ctx.fill();
      rr(ctx, 14, y0 - 58, 7, 26, 3); ctx.fill();
      ctx.fillStyle = ch.skin;
      ctx.beginPath(); ctx.arc(-17.5, y0 - 59, 4, 0, 7); ctx.arc(17.5, y0 - 59, 4, 0, 7); ctx.fill();
    } else {
      const a = dead ? 0 : swing * 5;
      rr(ctx, -21, y0 - 42 + a * 0.4, 7, 24, 3); ctx.fill();
      rr(ctx, 14, y0 - 42 - a * 0.4, 7, 24, 3); ctx.fill();
      ctx.fillStyle = ch.skin;
      ctx.beginPath(); ctx.arc(-17.5, y0 - 18 + a * 0.4, 4, 0, 7); ctx.arc(17.5, y0 - 18 - a * 0.4, 4, 0, 7); ctx.fill();
    }

    // torso
    ctx.fillStyle = suit;
    rr(ctx, -15, y0 - 46, 30, 30, 8); ctx.fill();
    ctx.fillStyle = trim;
    rr(ctx, -15, y0 - 31, 30, 4, 1); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.14)";
    rr(ctx, -12, y0 - 44, 8, 22, 4); ctx.fill();
    if (ch.trait === "scarf") {
      ctx.fillStyle = trim;
      rr(ctx, -13, y0 - 49, 26, 8, 4); ctx.fill();
      rr(ctx, 6, y0 - 46, 6, 16, 3); ctx.fill();
    }

    // head
    const hy = y0 - (dead ? 55 : 63) + (dead ? 4 : 0);
    ctx.fillStyle = ch.skin;
    ctx.beginPath(); ctx.arc(0, hy, 15, 0, Math.PI * 2); ctx.fill();

    // hair / headgear per character
    const hair = dead ? "#3a3f4f" : ch.hair;
    ctx.fillStyle = hair;
    const T = ch.trait;
    if (T === "hat") {
      ctx.beginPath(); ctx.ellipse(0, hy - 8, 22, 5, 0, 0, 7); ctx.fill();
      rr(ctx, -12, hy - 24, 24, 17, 5); ctx.fill();
      ctx.fillStyle = trim; rr(ctx, -12, hy - 12, 24, 3, 1); ctx.fill();
    } else if (T === "helmet") {
      ctx.fillStyle = dead ? "#4b5266" : ch.suit;
      ctx.beginPath(); ctx.arc(0, hy - 2, 17, Math.PI, 0); ctx.fill();
      ctx.fillStyle = trim; rr(ctx, -17, hy - 3, 34, 4, 2); ctx.fill();
    } else if (T === "cap") {
      ctx.fillStyle = dead ? "#4b5266" : ch.suit;
      ctx.beginPath(); ctx.arc(0, hy - 4, 16, Math.PI, 0); ctx.fill();
      rr(ctx, -4, hy - 6, 24, 5, 2); ctx.fill();
      ctx.fillStyle = trim; ctx.beginPath(); ctx.arc(0, hy - 14, 3, 0, 7); ctx.fill();
    } else if (T === "bun") {
      ctx.beginPath(); ctx.arc(0, hy - 5, 16, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
      ctx.beginPath(); ctx.arc(0, hy - 22, 7, 0, 7); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(0, hy - 4, 16, Math.PI * 1.02, Math.PI * 1.98); ctx.fill();
      rr(ctx, -16, hy - 10, 6, 14, 3); ctx.fill();
    }

    // face
    const eyeY = hy + 1;
    const wide = pose === "alert" ? 2.6 : 2;
    ctx.fillStyle = "#0a0f1c";
    if (T === "shades") {
      rr(ctx, -12, eyeY - 4, 24, 8, 3); ctx.fill();
      ctx.fillStyle = trim; ctx.fillRect(-10, eyeY - 2, 8, 2); ctx.fillRect(2, eyeY - 2, 8, 2);
    } else if (T === "visor") {
      rr(ctx, -13, eyeY - 5, 26, 9, 4); ctx.fill();
      ctx.fillStyle = trim; ctx.globalAlpha *= 0.9; rr(ctx, -11, eyeY - 3, 22, 5, 2); ctx.fill(); ctx.globalAlpha /= 0.9;
    } else {
      if (dead) {
        ctx.strokeStyle = "#0a0f1c"; ctx.lineWidth = 1.6;
        for (const ex of [-5, 5]) { ctx.beginPath(); ctx.moveTo(ex - 2, eyeY - 2); ctx.lineTo(ex + 2, eyeY + 2); ctx.moveTo(ex + 2, eyeY - 2); ctx.lineTo(ex - 2, eyeY + 2); ctx.stroke(); }
      } else {
        ctx.beginPath(); ctx.arc(-5, eyeY, wide, 0, 7); ctx.arc(5, eyeY, wide, 0, 7); ctx.fill();
      }
      if (T === "glasses") {
        ctx.strokeStyle = trim; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(-5, eyeY, 5, 0, 7); ctx.arc(5, eyeY, 5, 0, 7); ctx.moveTo(-0.5, eyeY); ctx.lineTo(0.5, eyeY); ctx.stroke();
      }
    }
    if (T === "mask") {
      ctx.fillStyle = dead ? "#8a93a8" : "#e8eef9";
      ctx.beginPath(); ctx.arc(0, hy + 3, 12, 0.1, Math.PI - 0.1); ctx.fill();
    } else if (!dead) {
      ctx.strokeStyle = "rgba(10,15,28,.7)"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(0, hy + 6, pose === "victory" ? 5 : 3, 0.15, Math.PI - 0.15); ctx.stroke();
    }
    if (T === "headset") {
      ctx.strokeStyle = trim; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(0, hy - 2, 16, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
      ctx.fillStyle = trim; rr(ctx, 12, hy - 2, 6, 8, 3); ctx.fill();
      ctx.beginPath(); ctx.moveTo(15, hy + 6); ctx.lineTo(8, hy + 11); ctx.stroke();
    }

    // alert mark
    if (pose === "alert" && !opts.noMark) {
      ctx.fillStyle = "#ff3b4e";
      ctx.font = "900 20px 'Big Shoulders Display', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("!", 0, hy - 26);
    }
    ctx.restore();
  }

  const spriteCache = new Map();
  /* Returns a canvas with one frame (cached). */
  function frame(charId, pose, step, size) {
    const key = charId + "|" + pose + "|" + step + "|" + (size || 1);
    let c = spriteCache.get(key);
    if (c) return c;
    c = document.createElement("canvas");
    const k = size || 1;
    c.width = Math.round(64 * k);
    c.height = Math.round(96 * k);
    const x = c.getContext("2d");
    // one animation cycle is spread over 6 (walk) or 4 (idle) frames
    const t = pose === "walk" ? (step / 6) * ((Math.PI * 2) / 9) : (step / 4) * ((Math.PI * 2) / 2.4);
    drawAgent(x, charById(charId), pose, t, c.width / 2, c.height - 4 * k, k);
    spriteCache.set(key, c);
    return c;
  }

  /* Portrait: head-and-shoulders crop on a tinted card, drawn straight into a canvas element. */
  function portrait(canvas, charId, pose) {
    const ch = charById(charId);
    const w = (canvas.width = canvas.clientWidth ? Math.round(canvas.clientWidth * 2) : 160);
    const h = (canvas.height = canvas.clientHeight ? Math.round(canvas.clientHeight * 2) : 160);
    const x = canvas.getContext("2d");
    const g = x.createRadialGradient(w / 2, h * 0.35, 4, w / 2, h * 0.5, w * 0.8);
    g.addColorStop(0, ch.color + "55");
    g.addColorStop(1, "rgba(6,10,19,0)");
    x.fillStyle = "#0b1322";
    x.fillRect(0, 0, w, h);
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    const scale = Math.min(w / 56, h / 70);
    drawAgent(x, ch, pose || "idle", 0, w / 2, h - 2, scale, { noMark: true });
  }

  /* Animated portrait: keeps drawing until the canvas leaves the document. Returns a stop function. */
  function animate(canvas, charId, pose) {
    let raf = 0, stop = false;
    const ch = charById(charId);
    const loop = (ts) => {
      if (stop || !canvas.isConnected) return;
      const w = (canvas.width = Math.min(480, canvas.clientWidth ? Math.round(canvas.clientWidth * 2) : 200));
      const h = (canvas.height = Math.min(640, canvas.clientHeight ? Math.round(canvas.clientHeight * 2) : 240));
      const x = canvas.getContext("2d");
      x.clearRect(0, 0, w, h);
      drawAgent(x, ch, pose, ts / 1000, w / 2, h - 6, Math.min(w / 56, h / 100));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { stop = true; cancelAnimationFrame(raf); };
  }

  // ---------------------------------------------------------------- maps
  const KIND_COLOR = { terminal: "#3df2ff", console: "#7c5cff", cabinet: "#ffc857", panel: "#4da3ff", power: "#ff9d3d", door: "#ff3b4e", lab: "#5cffc8" };

  function drawObjectIcon(x, o, theme) {
    const c = KIND_COLOR[o.kind] || theme.accent;
    x.save();
    x.translate(o.x, o.y);
    x.fillStyle = "rgba(0,0,0,.45)";
    x.beginPath(); x.ellipse(0, 16, 20, 6, 0, 0, 7); x.fill();
    x.fillStyle = "#0a1020";
    x.strokeStyle = c;
    x.lineWidth = 2;
    const box = (bx, by, bw, bh, r) => { rr(x, bx, by, bw, bh, r); x.fill(); x.stroke(); };
    switch (o.kind) {
      case "terminal": box(-16, -18, 32, 24, 4); x.fillStyle = c; x.fillRect(-11, -13, 22, 3); x.fillRect(-11, -7, 14, 3); x.fillStyle = "#0a1020"; box(-8, 6, 16, 8, 2); break;
      case "console": box(-20, -4, 40, 16, 3); x.fillStyle = c; for (let i = 0; i < 5; i++) x.fillRect(-16 + i * 7, 2, 4, 5); box(-12, -22, 24, 18, 3); x.fillStyle = c; x.fillRect(-8, -18, 16, 2); break;
      case "cabinet": box(-14, -20, 28, 36, 3); x.fillStyle = c; for (let i = 0; i < 3; i++) { x.fillRect(-9, -15 + i * 11, 18, 2); x.fillRect(-3, -11 + i * 11, 6, 3); } break;
      case "panel": box(-20, -18, 40, 28, 3); x.fillStyle = c; for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) x.fillRect(-16 + j * 12, -14 + i * 12, 9, 8); break;
      case "power": box(-14, -18, 28, 32, 4); x.fillStyle = c; x.beginPath(); x.moveTo(2, -14); x.lineTo(-7, 2); x.lineTo(0, 2); x.lineTo(-3, 11); x.lineTo(8, -5); x.lineTo(1, -5); x.closePath(); x.fill(); break;
      case "door": box(-12, -24, 24, 40, 3); x.fillStyle = c; x.beginPath(); x.arc(6, -2, 2.4, 0, 7); x.fill(); x.fillRect(-4, -26, 8, 3); break;
      case "lab": x.beginPath(); x.moveTo(-5, -18); x.lineTo(5, -18); x.lineTo(5, -6); x.lineTo(14, 12); x.lineTo(-14, 12); x.lineTo(-5, -6); x.closePath(); x.fill(); x.stroke(); x.fillStyle = c; x.globalAlpha = 0.7; x.fillRect(-9, 4, 18, 6); x.globalAlpha = 1; break;
    }
    x.restore();
  }

  // ---------------------------------------------------------------- realistic map rendering
  const mapCache = new Map();
  const hashStr = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return f >= 0 ? `rgb(${c(r + (255 - r) * f)},${c(g + (255 - g) * f)},${c(b + (255 - b) * f)})` : `rgb(${c(r * (1 + f))},${c(g * (1 + f))},${c(b * (1 + f))})`;
  }
  /* Soft additive light. `color` is an rgba template with "A" where the alpha goes. */
  function glow(x, cx, cy, r, color, a, mode) {
    x.save();
    x.globalCompositeOperation = mode || "lighter";
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color.replace("A", String(a)));
    g.addColorStop(1, color.replace("A", "0"));
    x.fillStyle = g;
    x.fillRect(cx - r, cy - r, r * 2, r * 2);
    x.restore();
  }
  const tpl = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},A)`; };

  // ---- floors: each map has its own material
  function floorTile(x, W, H, th, rnd, opts) {
    const s = opts.size || 40;
    for (let ty = 0; ty < H; ty += s) {
      for (let tx = 0; tx < W; tx += s) {
        const v = (rnd() - 0.5) * 0.09;
        x.fillStyle = shade(((tx / s + ty / s) & 1) ? th.floor : th.floor2, v);
        x.fillRect(tx, ty, s, s);
        const g = x.createLinearGradient(tx, ty, tx + s, ty + s);
        g.addColorStop(0, "rgba(255,255,255,.07)");
        g.addColorStop(0.45, "rgba(255,255,255,0)");
        x.fillStyle = g;
        x.fillRect(tx, ty, s, s);
      }
    }
    x.strokeStyle = "rgba(0,0,0,.45)";
    x.lineWidth = 1.2;
    for (let tx = 0; tx <= W; tx += s) { x.beginPath(); x.moveTo(tx, 0); x.lineTo(tx, H); x.stroke(); }
    for (let ty = 0; ty <= H; ty += s) { x.beginPath(); x.moveTo(0, ty); x.lineTo(W, ty); x.stroke(); }
  }
  function floorCarpet(x, W, H, th, rnd) {
    x.fillStyle = th.floor; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 9000; i++) {
      x.fillStyle = rnd() < 0.5 ? "rgba(255,255,255,.035)" : "rgba(0,0,0,.09)";
      x.fillRect(rnd() * W, rnd() * H, 1.5, 1.5);
    }
    x.fillStyle = "rgba(255,255,255,.025)";
    for (let tx = 0; tx < W; tx += 20) x.fillRect(tx, 0, 10, H);
  }
  function floorConcrete(x, W, H, th, rnd) {
    x.fillStyle = th.floor; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 7000; i++) {
      x.fillStyle = rnd() < 0.5 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.14)";
      x.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    x.strokeStyle = "rgba(0,0,0,.4)"; x.lineWidth = 1.5;
    for (let tx = 100; tx < W; tx += 200) { x.beginPath(); x.moveTo(tx, 0); x.lineTo(tx, H); x.stroke(); }
    for (let ty = 80; ty < H; ty += 160) { x.beginPath(); x.moveTo(0, ty); x.lineTo(W, ty); x.stroke(); }
    x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      let px = rnd() * W, py = rnd() * H;
      x.beginPath(); x.moveTo(px, py);
      for (let k = 0; k < 6; k++) { px += (rnd() - 0.5) * 40; py += (rnd() - 0.2) * 24; x.lineTo(px, py); }
      x.stroke();
    }
    for (let i = 0; i < 4; i++) glow(x, rnd() * W, rnd() * H, 30 + rnd() * 30, "rgba(0,0,0,A)", 0.35, "source-over");
  }
  function floorMetal(x, W, H, th) {
    x.fillStyle = th.floor; x.fillRect(0, 0, W, H);
    for (let ty = 0; ty < H; ty += 20) {
      for (let tx = 0; tx < W; tx += 20) {
        x.fillStyle = ((tx / 20 + ty / 20) & 1) ? "rgba(255,255,255,.035)" : "rgba(0,0,0,.14)";
        x.fillRect(tx, ty, 20, 20);
        x.fillStyle = "rgba(255,255,255,.06)";
        x.fillRect(tx + 3, ty + 9, 14, 2);
      }
    }
    x.strokeStyle = "rgba(0,0,0,.55)"; x.lineWidth = 2;
    for (let tx = 0; tx <= W; tx += 160) { x.beginPath(); x.moveTo(tx, 0); x.lineTo(tx, H); x.stroke(); }
    for (let ty = 0; ty <= H; ty += 160) { x.beginPath(); x.moveTo(0, ty); x.lineTo(W, ty); x.stroke(); }
  }
  function floorGround(x, W, H, th, rnd) {
    x.fillStyle = th.floor; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 9000; i++) {
      x.fillStyle = rnd() < 0.4 ? "rgba(70,110,60,.18)" : rnd() < 0.5 ? "rgba(0,0,0,.16)" : "rgba(160,170,190,.07)";
      x.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 2);
    }
    x.lineCap = "round";
    x.strokeStyle = "rgba(0,0,0,.22)"; x.lineWidth = 7;
    x.beginPath(); x.moveTo(0, 250); x.bezierCurveTo(200, 230, 300, 300, 400, 280); x.bezierCurveTo(520, 260, 640, 330, 800, 300); x.stroke();
    x.strokeStyle = "rgba(0,0,0,.14)"; x.lineWidth = 3;
    for (const o of [-9, 9]) { x.beginPath(); x.moveTo(0, 250 + o); x.bezierCurveTo(200, 230 + o, 300, 300 + o, 400, 280 + o); x.bezierCurveTo(520, 260 + o, 640, 330 + o, 800, 300 + o); x.stroke(); }
  }
  const FLOORS = { hq: "carpet", lab: "tile", under: "concrete", office: "carpet", control: "metal", night: "ground" };

  // ---- blocking props (top-down, lit from the top left, soft shadow to the bottom right)
  function drawProp(x, o, th) {
    x.save();
    x.fillStyle = "rgba(0,0,0,.4)";
    x.filter = "blur(5px)";
    x.fillRect(o.x + 6, o.y + 9, o.w, o.h);
    x.restore();
    const X = o.x, Y = o.y, Wd = o.w, Ht = o.h;
    const top = (c1, c2, r) => {
      const g = x.createLinearGradient(X, Y, X, Y + Ht);
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      x.fillStyle = g; rr(x, X, Y, Wd, Ht, r); x.fill();
    };
    const edge = (c) => { x.strokeStyle = c; x.lineWidth = 1.5; rr(x, X + 0.75, Y + 0.75, Wd - 1.5, Ht - 1.5, 4); x.stroke(); };
    switch (o.kind) {
      case "desk": {
        top("#7a5a3c", "#5a3f28", 5); edge("rgba(255,220,170,.35)");
        for (let i = 0; i < 6; i++) { x.fillStyle = "rgba(0,0,0,.08)"; x.fillRect(X + 4, Y + 6 + i * (Ht / 6), Wd - 8, 1); }
        const mx = X + Wd * 0.5;
        x.fillStyle = "#0b1020"; rr(x, mx - 18, Y + 8, 36, 22, 3); x.fill();
        x.fillStyle = th.accent; x.globalAlpha = 0.85; x.fillRect(mx - 15, Y + 11, 30, 3); x.fillRect(mx - 15, Y + 17, 20, 3); x.globalAlpha = 1;
        x.fillStyle = "#1a2236"; rr(x, mx - 16, Y + 36, 32, 9, 2); x.fill();
        x.fillStyle = "#e8eef9"; x.fillRect(X + 10, Y + Ht - 18, 14, 10);
        x.fillStyle = "#c9d3e6"; x.fillRect(X + 13, Y + Ht - 16, 14, 10);
        x.fillStyle = "#ffc857"; x.beginPath(); x.arc(X + Wd - 14, Y + Ht - 14, 5, 0, 7); x.fill();
        break;
      }
      case "couch": {
        top("#2b3a5c", "#1c2742", 10); edge("rgba(160,190,255,.25)");
        x.fillStyle = "rgba(255,255,255,.07)";
        for (let i = 0; i < 3; i++) { rr(x, X + 6 + (i * (Wd - 12)) / 3, Y + 5, (Wd - 12) / 3 - 4, Ht - 10, 6); x.fill(); }
        break;
      }
      case "shelf": {
        top("#3a3f4a", "#262a33", 3); edge("rgba(255,255,255,.18)");
        const cols = ["#ff6fd8", "#3df2ff", "#ffc857", "#b8ff5c", "#ff9d3d"];
        x.globalAlpha = 0.7;
        for (let i = 0; i < 5; i++) { x.fillStyle = cols[i % 5]; x.fillRect(X + 5, Y + 8 + (i * (Ht - 14)) / 5, Wd - 10, (Ht - 14) / 5 - 4); }
        x.globalAlpha = 1;
        break;
      }
      case "bench": {
        top("#b5bfcc", "#8a95a6", 4); edge("rgba(255,255,255,.55)");
        x.fillStyle = "rgba(255,255,255,.35)"; x.fillRect(X + 3, Y + 3, Wd - 6, 3);
        const n = Math.floor(Wd / 40);
        for (let i = 0; i < n; i++) {
          const cx = X + 20 + i * 40, cy = Y + Ht / 2;
          x.fillStyle = "rgba(255,255,255,.55)"; x.beginPath(); x.arc(cx, cy, 8, 0, 7); x.fill();
          x.fillStyle = i % 2 ? "#5cffc8" : "#3df2ff"; x.globalAlpha = 0.85; x.beginPath(); x.arc(cx, cy, 5, 0, 7); x.fill(); x.globalAlpha = 1;
        }
        break;
      }
      case "rack": {
        top("#10131c", "#0a0c13", 3); edge("rgba(120,140,180,.35)");
        const horiz = Wd > Ht;
        const rows = Math.floor((horiz ? Wd : Ht) / 14);
        for (let i = 0; i < rows; i++) {
          const px = horiz ? X + 5 + i * 14 : X + 6, py = horiz ? Y + 6 : Y + 5 + i * 14;
          x.fillStyle = "#1a2030"; x.fillRect(px, py, horiz ? 10 : Wd - 12, horiz ? Ht - 12 : 10);
          x.fillStyle = ["#5cffc8", "#3df2ff", "#ffc857"][i % 3];
          x.fillRect(px + 2, py + 2, 3, 3);
          x.fillRect(px + (horiz ? 2 : 8), py + (horiz ? 7 : 2), 3, 3);
        }
        break;
      }
      case "pillar": {
        top("#5a6478", "#3c4558", 3); edge("rgba(255,255,255,.3)");
        x.save();
        x.beginPath(); x.rect(X, Y, Wd, Ht); x.clip();
        x.fillStyle = "rgba(255,200,87,.8)";
        for (let k = -Wd; k < Ht + Wd; k += 26) { x.beginPath(); x.moveTo(X, Y + k); x.lineTo(X + Wd, Y + k - Wd); x.lineTo(X + Wd, Y + k - Wd + 9); x.lineTo(X, Y + k + 9); x.fill(); }
        x.restore();
        break;
      }
      case "crate": {
        top("#8a6a3e", "#6a4f2c", 3); edge("rgba(255,230,180,.4)");
        x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = 2;
        for (let k = 0; k < Wd; k += 46) { x.beginPath(); x.moveTo(X + k, Y); x.lineTo(X + k, Y + Ht); x.stroke(); }
        x.beginPath(); x.moveTo(X, Y); x.lineTo(X + Math.min(46, Wd), Y + Ht); x.stroke();
        x.fillStyle = "rgba(0,0,0,.38)"; x.font = "800 9px Manrope, sans-serif"; x.textAlign = "center"; x.fillText("FRAGILE", X + Wd / 2, Y + Ht / 2 + 3);
        break;
      }
      case "console": {
        top("#1c2742", "#121a2e", 6); edge("rgba(61,242,255,.45)");
        const n = Math.floor(Wd / 54);
        for (let i = 0; i < n; i++) {
          const px = X + 10 + i * 54;
          x.fillStyle = "#050810"; rr(x, px, Y + 6, 44, 24, 3); x.fill();
          x.fillStyle = [th.accent, "#5cffc8", "#ffc857"][i % 3]; x.globalAlpha = 0.8;
          x.fillRect(px + 4, Y + 10, 36, 3); x.fillRect(px + 4, Y + 16, 24, 3); x.fillRect(px + 4, Y + 22, 30, 3); x.globalAlpha = 1;
          x.fillStyle = "#2c3a5c"; rr(x, px + 2, Y + 36, 40, 14, 3); x.fill();
          for (let b = 0; b < 4; b++) { x.fillStyle = b % 2 ? "#ff3b4e" : "#3df2ff"; x.fillRect(px + 6 + b * 9, Y + 40, 5, 5); }
        }
        break;
      }
      case "tent": {
        top("#5b6e52", "#445a42", 12);
        x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = 2;
        x.beginPath(); x.moveTo(X + Wd / 2, Y + 2); x.lineTo(X + Wd / 2, Y + Ht - 2); x.stroke();
        x.fillStyle = "rgba(255,255,255,.1)"; x.fillRect(X + 3, Y + 3, Wd / 2 - 3, Ht - 6);
        x.fillStyle = "rgba(0,0,0,.2)"; x.fillRect(X + Wd / 2, Y + 3, Wd / 2 - 3, Ht - 6);
        break;
      }
      case "truck": {
        top("#4c5a40", "#38452e", 8); edge("rgba(255,255,255,.2)");
        x.fillStyle = "#2a3326"; rr(x, X + Wd * 0.6, Y + 6, Wd * 0.34, Ht - 12, 6); x.fill();
        x.fillStyle = "rgba(160,220,255,.7)"; rr(x, X + Wd * 0.82, Y + 12, Wd * 0.1, Ht - 24, 3); x.fill();
        x.strokeStyle = "rgba(0,0,0,.4)"; x.lineWidth = 2;
        for (let k = 14; k < Wd * 0.55; k += 16) { x.beginPath(); x.moveTo(X + k, Y + 6); x.lineTo(X + k, Y + Ht - 6); x.stroke(); }
        break;
      }
      default: top(th.wall, shade(th.wall, -0.3), 5); edge(th.accent + "66");
    }
  }

  // ---- non-blocking decor, per map: [type, x, y, a, b]
  const DECOR = {
    hq: [["rug", 400, 255, 260, 150], ["plant", 60, 60], ["plant", 740, 60], ["plant", 740, 440], ["plant", 60, 440], ["lamp", 200, 240], ["lamp", 600, 240], ["lamp", 400, 90]],
    lab: [["lamp", 200, 220], ["lamp", 600, 220], ["lamp", 400, 380], ["vent", 420, 40], ["hazard", 560, 440, 150], ["puddle", 330, 250], ["puddle", 640, 330]],
    under: [["pipe", 0, 40, 800], ["pipe", 0, 440, 800], ["lamp", 140, 330], ["lamp", 660, 120], ["lamp", 400, 240], ["barrel", 740, 60], ["barrel", 60, 440], ["puddle", 300, 220], ["hazard", 520, 446, 150]],
    office: [["rug", 400, 250, 520, 170], ["plant", 40, 60], ["plant", 760, 60], ["lamp", 160, 240], ["lamp", 640, 240], ["lamp", 400, 260], ["window", 150, 8], ["window", 400, 8], ["window", 650, 8]],
    control: [["lamp", 150, 100], ["lamp", 650, 380], ["lamp", 400, 250], ["hazard", 40, 440, 160], ["vent", 400, 40], ["cable", 120, 250, 300, 20]],
    night: [["fire", 600, 330], ["lamp", 250, 350], ["lamp", 100, 90], ["barrel", 772, 170], ["barrel", 746, 188], ["tree", 34, 250], ["tree", 768, 250], ["tree", 30, 340], ["cable", 90, 90, 140, 20]],
  };
  const FLOOR_DECOR = new Set(["rug", "stripe", "hazard", "vent", "cable", "puddle", "pipe"]);
  const TALL_DECOR = new Set(["plant", "barrel", "tree", "fire", "window"]);

  function drawDecor(x, d, th) {
    const [t, a, b, c, e] = d;
    switch (t) {
      case "rug": {
        x.save(); x.translate(a, b);
        x.fillStyle = "rgba(124,92,255,.22)"; rr(x, -c / 2, -e / 2, c, e, 18); x.fill();
        x.strokeStyle = "rgba(255,200,87,.35)"; x.lineWidth = 3; rr(x, -c / 2 + 8, -e / 2 + 8, c - 16, e - 16, 14); x.stroke();
        x.strokeStyle = "rgba(61,242,255,.22)"; x.lineWidth = 1.5; rr(x, -c / 2 + 18, -e / 2 + 18, c - 36, e - 36, 10); x.stroke();
        x.restore(); break;
      }
      case "plant": {
        x.fillStyle = "rgba(0,0,0,.35)"; x.beginPath(); x.ellipse(a + 4, b + 8, 16, 7, 0, 0, 7); x.fill();
        x.fillStyle = "#5a3f28"; x.beginPath(); x.arc(a, b, 11, 0, 7); x.fill();
        for (let i = 0; i < 9; i++) { const ang = (i / 9) * 6.28; x.fillStyle = i % 2 ? "#2f8f4a" : "#3fae5c"; x.beginPath(); x.ellipse(a + Math.cos(ang) * 9, b + Math.sin(ang) * 9, 9, 5, ang, 0, 7); x.fill(); }
        break;
      }
      case "lamp": glow(x, a, b, 130, "rgba(255,214,150,A)", 0.07); glow(x, a, b, 44, "rgba(255,225,170,A)", 0.07); break;
      case "vent": {
        x.fillStyle = "#0a0d16"; rr(x, a - 26, b - 8, 52, 18, 3); x.fill();
        x.strokeStyle = "rgba(255,255,255,.18)"; x.lineWidth = 1.5;
        for (let i = -20; i <= 20; i += 8) { x.beginPath(); x.moveTo(a + i, b - 5); x.lineTo(a + i, b + 7); x.stroke(); }
        break;
      }
      case "hazard": {
        x.save(); x.beginPath(); x.rect(a, b, c, 10); x.clip();
        x.fillStyle = "#ffc857"; x.fillRect(a, b, c, 10);
        x.fillStyle = "rgba(10,14,24,.9)";
        for (let k = -10; k < c + 10; k += 16) { x.beginPath(); x.moveTo(a + k, b + 10); x.lineTo(a + k + 8, b + 10); x.lineTo(a + k + 18, b); x.lineTo(a + k + 10, b); x.fill(); }
        x.restore(); break;
      }
      case "puddle": {
        x.fillStyle = "rgba(100,170,255,.14)"; x.beginPath(); x.ellipse(a, b, 34, 14, 0.2, 0, 7); x.fill();
        x.strokeStyle = "rgba(220,240,255,.28)"; x.lineWidth = 1.5; x.beginPath(); x.ellipse(a - 6, b - 2, 18, 6, 0.2, 0, 7); x.stroke();
        break;
      }
      case "pipe": {
        const g = x.createLinearGradient(0, b - 7, 0, b + 7);
        g.addColorStop(0, "#6a7488"); g.addColorStop(0.5, "#aeb8cc"); g.addColorStop(1, "#4a5266");
        x.fillStyle = g; x.fillRect(a, b - 7, c, 14);
        x.fillStyle = "#2a3040";
        for (let k = 60; k < c; k += 140) x.fillRect(a + k, b - 9, 8, 18);
        break;
      }
      case "barrel": {
        x.fillStyle = "rgba(0,0,0,.4)"; x.beginPath(); x.ellipse(a + 4, b + 6, 15, 7, 0, 0, 7); x.fill();
        const g = x.createRadialGradient(a - 4, b - 4, 2, a, b, 14); g.addColorStop(0, "#d86a4a"); g.addColorStop(1, "#7a2a1a");
        x.fillStyle = g; x.beginPath(); x.arc(a, b, 13, 0, 7); x.fill();
        x.strokeStyle = "rgba(0,0,0,.4)"; x.lineWidth = 2; x.beginPath(); x.arc(a, b, 8, 0, 7); x.stroke();
        break;
      }
      case "window": {
        x.fillStyle = "rgba(120,170,255,.35)"; rr(x, a - 38, b, 76, 22, 3); x.fill();
        x.strokeStyle = "rgba(255,255,255,.4)"; x.lineWidth = 2; rr(x, a - 38, b, 76, 22, 3); x.stroke();
        x.beginPath(); x.moveTo(a, b); x.lineTo(a, b + 22); x.stroke();
        glow(x, a, b + 60, 70, "rgba(160,200,255,A)", 0.12);
        break;
      }
      case "cable": {
        x.lineCap = "round";
        x.strokeStyle = "rgba(0,0,0,.6)"; x.lineWidth = 4;
        x.beginPath(); x.moveTo(a, b); x.bezierCurveTo(a + c * 0.3, b + e, a + c * 0.6, b - e, a + c, b + e * 0.4); x.stroke();
        x.strokeStyle = "rgba(255,59,78,.55)"; x.lineWidth = 1.5;
        x.beginPath(); x.moveTo(a, b); x.bezierCurveTo(a + c * 0.3, b + e, a + c * 0.6, b - e, a + c, b + e * 0.4); x.stroke();
        break;
      }
      case "fire": {
        x.fillStyle = "#2a2a2a"; x.beginPath(); x.arc(a, b, 14, 0, 7); x.fill();
        x.fillStyle = "#6a6a6a"; for (let i = 0; i < 8; i++) { x.beginPath(); x.arc(a + Math.cos(i * 0.8) * 13, b + Math.sin(i * 0.8) * 13, 3.5, 0, 7); x.fill(); }
        glow(x, a, b, 110, "rgba(255,150,60,A)", 0.5); glow(x, a, b, 22, "rgba(255,230,160,A)", 0.9);
        x.fillStyle = "#ffb03a"; x.beginPath(); x.moveTo(a, b - 12); x.quadraticCurveTo(a + 8, b, a, b + 6); x.quadraticCurveTo(a - 8, b, a, b - 12); x.fill();
        break;
      }
      case "tree": {
        x.fillStyle = "rgba(0,0,0,.35)"; x.beginPath(); x.ellipse(a + 8, b + 10, 30, 12, 0, 0, 7); x.fill();
        for (let i = 0; i < 4; i++) {
          const g = x.createRadialGradient(a - 6, b - 6, 2, a, b, 30 - i * 5);
          g.addColorStop(0, "#3d7a42"); g.addColorStop(1, "#1d4a2a");
          x.fillStyle = g; x.beginPath(); x.arc(a + (i - 1.5) * 4, b + (i % 2) * 5 - 4, 28 - i * 4, 0, 7); x.fill();
        }
        break;
      }
    }
  }

  function renderMap(map) {
    if (mapCache.has(map.id)) return mapCache.get(map.id);
    const W = 800, H = 480, K = 2; // drawn at 2x so it stays crisp when the camera zooms in
    const c = document.createElement("canvas");
    c.width = W * K; c.height = H * K;
    const x = c.getContext("2d");
    x.scale(K, K);
    const th = map.theme;
    const rnd = mulberry(hashStr(map.id));
    const decor = DECOR[map.id] || [];

    // 1) floor material
    const kind = FLOORS[map.id] || "tile";
    if (kind === "tile") floorTile(x, W, H, th, rnd, { size: 40 });
    else if (kind === "carpet") floorCarpet(x, W, H, th, rnd);
    else if (kind === "concrete") floorConcrete(x, W, H, th, rnd);
    else if (kind === "metal") floorMetal(x, W, H, th);
    else floorGround(x, W, H, th, rnd);

    // 2) zone tint and labels
    for (const z of map.zones) {
      glow(x, z.x, z.y, 95, tpl(th.glow), 0.16);
      x.fillStyle = "rgba(232,238,249,.42)";
      x.font = "800 9px Manrope, sans-serif";
      x.textAlign = "center";
      x.fillText(z.name.toUpperCase(), z.x, z.y + 56);
    }
    // 3) things lying on the floor, then blocking props with shadows, then tall decor
    for (const d of decor) if (FLOOR_DECOR.has(d[0])) drawDecor(x, d, th);
    for (const o of map.obstacles) drawProp(x, o, th);
    for (const d of decor) if (TALL_DECOR.has(d[0])) drawDecor(x, d, th);

    // 4) walls: thick panel band with a lit inner edge
    const wall = 26;
    const wg = (x0, y0, x1, y1) => { const g = x.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, shade(th.wall, 0.18)); g.addColorStop(1, shade(th.wall, -0.35)); return g; };
    x.fillStyle = wg(0, 0, 0, wall); x.fillRect(0, 0, W, wall);
    x.fillStyle = wg(0, H, 0, H - wall); x.fillRect(0, H - wall, W, wall);
    x.fillStyle = wg(0, 0, wall, 0); x.fillRect(0, 0, wall, H);
    x.fillStyle = wg(W, 0, W - wall, 0); x.fillRect(W - wall, 0, wall, H);
    x.strokeStyle = "rgba(0,0,0,.45)"; x.lineWidth = 1;
    for (let k = 0; k < W; k += 50) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k, wall); x.moveTo(k, H - wall); x.lineTo(k, H); x.stroke(); }
    for (let k = 0; k < H; k += 50) { x.beginPath(); x.moveTo(0, k); x.lineTo(wall, k); x.moveTo(W - wall, k); x.lineTo(W, k); x.stroke(); }
    x.strokeStyle = th.accent; x.lineWidth = 2; x.globalAlpha = 0.9;
    x.strokeRect(wall, wall, W - wall * 2, H - wall * 2);
    x.globalAlpha = 1;
    const edges = [[0, wall, 0, wall + 26, wall, wall, W - 2 * wall, 26], [0, H - wall, 0, H - wall - 26, wall, H - wall - 26, W - 2 * wall, 26], [wall, 0, wall + 26, 0, wall, wall, 26, H - 2 * wall], [W - wall, 0, W - wall - 26, 0, W - wall - 26, wall, 26, H - 2 * wall]];
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of edges) {
      const g = x.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, "rgba(0,0,0,.5)"); g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g; x.fillRect(rx, ry, rw, rh);
    }
    // 5) interactive stations, then ceiling lights and the overall grade
    for (const o of map.objects) drawObjectIcon(x, o, th);
    for (const d of decor) if (d[0] === "lamp") drawDecor(x, d, th);
    for (const o of map.objects) glow(x, o.x, o.y, 54, tpl(KIND_COLOR[o.kind] || th.accent), 0.2);
    const v = x.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.66);
    v.addColorStop(0, "rgba(6,10,19,0)");
    v.addColorStop(1, "rgba(6,10,19,.66)");
    x.fillStyle = v;
    x.fillRect(0, 0, W, H);
    mapCache.set(map.id, c);
    return c;
  }

  // ---------------------------------------------------------------- icons (inline SVG, no emoji)
  const ICON = {
    home: '<path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    rank: '<path d="M5 20V10h4v10zM10 20V4h4v16zM15 20v-7h4v7z"/>',
    mission: '<path d="M5 4h14v4H5zM5 10h14v10H5z"/><path d="M8 14h8M8 17h5" stroke-linecap="round"/>',
    reward: '<path d="M4 9h16v4H4zM6 13h12v7H6zM12 9v11"/><path d="M12 9S9 8 9 6a2 2 0 0 1 3-1.5M12 9s3-1 3-3a2 2 0 0 0-3-1.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0z"/>',
    back: '<path d="m14 6-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/>',
    coin: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10.5h5M9.5 13.5h5" stroke-linecap="round"/>',
    bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5" stroke-linecap="round"/>',
    send: '<path d="M4 12 20 4l-4 16-4-6z"/>',
    flag: '<path d="M6 21V4M6 5h11l-2 4 2 4H6" stroke-linecap="round" stroke-linejoin="round"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke-linecap="round"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01" stroke-linecap="round"/>',
    shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" stroke-linecap="round"/>',
    share: '<path d="M12 4v11M8 8l4-4 4 4M5 14v5h14v-5" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/>',
    trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M10 14h4v3h-4zM8 20h8" stroke-linecap="round"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17h.01" stroke-linecap="round"/>',
    users: '<circle cx="9" cy="9" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0zM16 6.2a3.3 3.3 0 0 1 0 5.6M17.5 20a6 6 0 0 0-3-5.2" stroke-linecap="round"/>',
    key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2" stroke-linecap="round"/>',
  };
  const icon = (name, cls) => `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${ICON[name] || ""}</svg>`;

  window.SA_ART = { CHARS, charById, drawAgent, frame, portrait, animate, renderMap, icon, KIND_COLOR };
})();
