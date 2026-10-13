/* SECRET AGENT: the 2D exploration scene (Phaser 3). It renders and collects input only: positions, roles, tasks and
   results all come from the server. Movement is predicted locally for a smooth feel and reconciled against the
   position the server accepted for the exact request we sent, so slow networks never cause rubber-banding. */
(function () {
  "use strict";
  const ART = window.SA_ART;
  const W = 800, H = 480, RADIUS = 12, SPEED = 150, VISION = 300;

  function walkable(map, x, y) {
    if (x < 24 || y < 24 || x > W - 24 || y > H - 24) return false;
    for (const o of map.obstacles) if (x > o.x - RADIUS && x < o.x + o.w + RADIUS && y > o.y - RADIUS && y < o.y + o.h + RADIUS) return false;
    return true;
  }

  function start(parent, opts) {
    if (!window.Phaser) {
      parent.innerHTML = '<div class="empty">The game engine could not load. Check your connection and reopen the game.</div>';
      return { update() {}, destroy() {}, setInput() {}, moveTo() {}, reconcile() {}, shake() {}, setWork() {}, dash() {}, pos: () => ({ x: 0, y: 0 }), moving: () => false, near: () => null };
    }
    const map = opts.map;
    const state = {
      view: null, me: { x: 400, y: 240 }, vel: { x: 0, y: 0 }, target: null, input: { x: 0, y: 0 }, others: new Map(), near: null,
      moving: false, dashUntil: 0, init: false, work: null, stepAcc: 0, dust: [], motes: null, lastPhase: "", face: 1,
    };
    let scene;

    // Render at the device pixel ratio so sprites and the map are sharp on phone screens.
    const DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const cssW = () => parent.clientWidth || 360;
    const cssH = () => parent.clientHeight || 640;
    const config = {
      type: Phaser.AUTO, parent, backgroundColor: "#060a13", transparent: false,
      scale: { mode: Phaser.Scale.NONE, width: cssW() * DPR, height: cssH() * DPR, zoom: 1 / DPR },
      render: { antialias: true, pixelArt: false, powerPreference: "low-power" },
      fps: { target: 60 },
      scene: {
        create() {
          scene = this;
          const blank = document.createElement("canvas");
          blank.width = blank.height = 1;
          if (!this.textures.exists("blank")) this.textures.addCanvas("blank", blank);
          const tex = ART.renderMap(map);
          if (!this.textures.exists("map-" + map.id)) this.textures.addCanvas("map-" + map.id, tex);
          this.add.image(0, 0, "map-" + map.id).setOrigin(0, 0).setScale(0.5).setDepth(0);

          this.fxBelow = this.add.graphics().setDepth(1);   // dust
          this.objGfx = this.add.graphics().setDepth(2);    // object states, hints
          this.fxAbove = this.add.graphics().setDepth(30);  // motes, work ring
          this.labels = map.objects.map((o) => this.add.text(o.x, o.y + 26, o.label, { fontFamily: "Manrope, sans-serif", fontSize: "9px", color: "#e8eef9", fontStyle: "700", resolution: 2 }).setOrigin(0.5, 0).setAlpha(0.5).setDepth(2));

          // vision mask: dark everywhere except a soft circle around the local player
          const c = document.createElement("canvas");
          c.width = c.height = 512;
          const x = c.getContext("2d");
          const g = x.createRadialGradient(256, 256, 60, 256, 256, 256);
          g.addColorStop(0, "rgba(4,7,14,0)");
          g.addColorStop(0.5, "rgba(4,7,14,0)");
          g.addColorStop(1, "rgba(4,7,14,.86)");
          x.fillStyle = g; x.fillRect(0, 0, 512, 512);
          this.textures.addCanvas("vision", c);
          this.vision = this.add.image(400, 240, "vision").setDisplaySize(VISION * 4.4, VISION * 4.4).setDepth(20);

          // ambient motes drifting through the room
          state.motes = Array.from({ length: 36 }, () => ({ x: Math.random() * W, y: Math.random() * H, v: 4 + Math.random() * 9, r: 0.6 + Math.random() * 1.4, p: Math.random() * 6 }));

          this.me = makeSprite(this, opts.char, opts.name, true);
          this.me.setPosition(state.me.x, state.me.y);
          // a little room beyond the walls, so the character can sit in the middle of the free area between the HUD
          // at the top and the controls at the bottom even when standing next to a wall
          this.cameras.main.setBounds(-50, -120, W + 100, H + 270);
          this.cameras.main.startFollow(this.me.root, true, 0.2, 0.2);
          const applyZoom = () => {
            const w = this.scale.width / DPR, h = this.scale.height / DPR; // CSS pixels
            // phone: about 390 world units across; desktop: a wider window onto the map, never so close that the room is lost
            const z = Math.min(2.2, Math.max(1, Math.min(w / 420, h / 380)));
            this.cameras.main.setZoom(z * DPR);
          };
          applyZoom();
          this.scale.on("resize", applyZoom);
          if (window.ResizeObserver) {
            this.ro = new ResizeObserver(() => { if (cssW() > 0 && cssH() > 0) this.scale.resize(cssW() * DPR, cssH() * DPR); });
            this.ro.observe(parent);
          }

          this.input.on("pointerdown", (p) => {
            if (opts.isBlocked && opts.isBlocked()) return;
            if (p.y / DPR > this.scale.height / DPR - 170 && p.x / DPR < 170) return; // joystick area
            const wp = this.cameras.main.getWorldPoint(p.x, p.y);
            state.target = { x: Phaser.Math.Clamp(wp.x, 30, W - 30), y: Phaser.Math.Clamp(wp.y, 30, H - 30) };
          });
          const kb = this.input.keyboard;
          if (kb) this.k = kb.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT,E,SPACE");
        },

        update(time, delta) {
          const dt = Math.min(0.05, delta / 1000);
          const v = state.view;
          if (!v || !v.me) return;
          const alive = v.me.alive;
          const exploring = v.phase === "explore" && v.status === "playing";

          // ---- input
          let kx = 0, ky = 0;
          if (this.k) {
            kx = (this.k.D.isDown || this.k.RIGHT.isDown ? 1 : 0) - (this.k.A.isDown || this.k.LEFT.isDown ? 1 : 0);
            ky = (this.k.S.isDown || this.k.DOWN.isDown ? 1 : 0) - (this.k.W.isDown || this.k.UP.isDown ? 1 : 0);
            if ((Phaser.Input.Keyboard.JustDown(this.k.E) || Phaser.Input.Keyboard.JustDown(this.k.SPACE)) && opts.onUse) opts.onUse();
          }
          let dx = state.input.x + kx, dy = state.input.y + ky;
          if (dx || dy) state.target = null;
          if (!dx && !dy && state.target) {
            const tx = state.target.x - state.me.x, ty = state.target.y - state.me.y;
            const d = Math.hypot(tx, ty);
            if (d < 5) state.target = null;
            else (dx = tx / d), (dy = ty / d);
          }
          if (state.work && (dx || dy)) {
            // moving cancels a task in progress
            state.work = null;
            if (opts.onWorkCancel) opts.onWorkCancel();
          }
          const blocked = !exploring || !alive || state.work || (opts.isBlocked && opts.isBlocked());
          const len = Math.hypot(dx, dy);
          if (len > 1) (dx /= len), (dy /= len);
          const speed = SPEED * (Date.now() < state.dashUntil ? 1.8 : 1);
          const wantX = blocked ? 0 : dx * speed, wantY = blocked ? 0 : dy * speed;

          // ---- velocity smoothing (accelerate and brake instead of snapping)
          const k = 1 - Math.exp(-dt * 14);
          state.vel.x += (wantX - state.vel.x) * k;
          state.vel.y += (wantY - state.vel.y) * k;
          const sp = Math.hypot(state.vel.x, state.vel.y);
          state.moving = sp > 8;
          if (sp > 1) {
            const nx = state.me.x + state.vel.x * dt, ny = state.me.y + state.vel.y * dt;
            if (walkable(map, nx, ny)) (state.me.x = nx), (state.me.y = ny);
            else if (walkable(map, nx, state.me.y)) (state.me.x = nx), (state.vel.y = 0);
            else if (walkable(map, state.me.x, ny)) (state.me.y = ny), (state.vel.x = 0);
            else (state.vel.x = 0), (state.vel.y = 0), (state.target = null);
          }
          if (Math.abs(state.vel.x) > 12) state.face = state.vel.x < 0 ? -1 : 1;
          this.me.face = state.face;

          // a new round (or reconnect) starts from where the server says we are
          if (v.phase !== state.lastPhase) {
            if (v.phase === "explore") (state.me.x = v.me.x), (state.me.y = v.me.y), (state.vel.x = state.vel.y = 0);
            state.lastPhase = v.phase;
          }

          // ---- me
          this.me.setPosition(state.me.x, state.me.y);
          this.me.setPose(!alive ? "defeat" : v.status === "finished" ? "victory" : state.moving ? "walk" : "idle", time / 1000, sp / SPEED);
          this.me.root.setAlpha(alive ? 1 : 0.35);
          this.vision.setPosition(state.me.x, state.me.y);
          this.vision.setVisible(exploring && alive);

          // ---- footstep dust
          if (state.moving && !state.work) {
            state.stepAcc += dt;
            if (state.stepAcc > 0.14) {
              state.stepAcc = 0;
              state.dust.push({ x: state.me.x + (Math.random() - 0.5) * 6, y: state.me.y - 1, life: 0.5, r: 2 + Math.random() * 2 });
              if (opts.onStep) opts.onStep();
            }
          }
          const fx = this.fxBelow;
          fx.clear();
          for (const d of state.dust) {
            d.life -= dt;
            const a = Math.max(0, d.life / 0.5);
            fx.fillStyle(0xcfe6ff, a * 0.35);
            fx.fillCircle(d.x, d.y - (1 - a) * 6, d.r * (1.4 - a * 0.4));
          }
          state.dust = state.dust.filter((d) => d.life > 0);

          // ---- other players
          const seen = new Set();
          for (const p of v.players) {
            if (p.uid === v.me.uid) continue;
            if (p.x === undefined || !p.alive || !(v.phase === "explore" || v.phase === "briefing")) continue;
            seen.add(p.uid);
            let o = state.others.get(p.uid);
            if (!o) {
              o = makeSprite(this, p.char, p.name, false);
              o.setPosition(p.x, p.y);
              state.others.set(p.uid, o);
            }
            const ex = p.x - o.root.x, ey = p.y - o.root.y;
            const kk = 1 - Math.exp(-dt * 7);
            const mv = Math.hypot(ex, ey) > 3;
            o.setPosition(o.root.x + ex * kk, o.root.y + ey * kk);
            if (Math.abs(ex) > 1.5) o.face = ex < 0 ? -1 : 1;
            o.setPose(mv ? "walk" : "idle", time / 1000, mv ? 1 : 0);
          }
          for (const [uid, o] of state.others) {
            if (!seen.has(uid)) {
              o.destroy();
              state.others.delete(uid);
            }
          }

          // ---- objects: state rings, screens, nearest highlight, objective hint
          const g = this.objGfx;
          g.clear();
          let near = null, best = 62, hint = null, hd = 1e9;
          for (const o of map.objects) {
            const st = v.objects.find((q) => q.id === o.id) || {};
            const d = Math.hypot(o.x - state.me.x, o.y - state.me.y);
            if (d < best && exploring && alive) (best = d), (near = o.id);
            if (st.state === "sabotaged") {
              const a = 0.5 + 0.5 * Math.sin(time / 160);
              g.lineStyle(3, 0xff3b4e, 0.5 + 0.5 * a);
              g.strokeCircle(o.x, o.y, 26 + a * 5);
              g.fillStyle(0xff3b4e, 0.1 + 0.14 * a);
              g.fillCircle(o.x, o.y, 28);
              if (d < hd) (hd = d), (hint = o);
            } else if (st.done) {
              g.lineStyle(2, 0x5cffc8, 0.8);
              g.strokeCircle(o.x, o.y, 24);
              g.fillStyle(0x5cffc8, 0.9);
              g.fillCircle(o.x + 17, o.y - 17, 4);
            } else {
              // a soft blinking light shows which stations still need work
              const a = 0.35 + 0.35 * Math.sin(time / 420 + o.x);
              g.fillStyle(Phaser.Display.Color.HexStringToColor(ART.KIND_COLOR[o.kind] || "#3df2ff").color, a * 0.5);
              g.fillCircle(o.x, o.y, 22);
              if (d < hd) (hd = d), (hint = o);
            }
          }
          if (near) {
            const o = map.objects.find((q) => q.id === near);
            g.lineStyle(2, 0x3df2ff, 0.95);
            g.strokeCircle(o.x, o.y, 30 + Math.sin(time / 150) * 2);
          }
          // gold arrow around the player pointing at the closest unfinished station
          if (hint && exploring && alive && hd > 60) {
            const ang = Math.atan2(hint.y - state.me.y, hint.x - state.me.x);
            const ax = state.me.x + Math.cos(ang) * 40, ay = state.me.y + Math.sin(ang) * 40;
            g.fillStyle(0xffc857, 0.9);
            g.beginPath();
            g.moveTo(ax + Math.cos(ang) * 8, ay + Math.sin(ang) * 8);
            g.lineTo(ax + Math.cos(ang + 2.5) * 6, ay + Math.sin(ang + 2.5) * 6);
            g.lineTo(ax + Math.cos(ang - 2.5) * 6, ay + Math.sin(ang - 2.5) * 6);
            g.closePath();
            g.fillPath();
          }
          if (near !== state.near) {
            state.near = near;
            if (opts.onNear) opts.onNear(near);
          }

          // ---- task progress ring and ambient motes
          const top = this.fxAbove;
          top.clear();
          if (state.work) {
            const t = Math.min(1, (Date.now() - state.work.t0) / state.work.dur);
            top.lineStyle(5, 0x0a1020, 0.8);
            top.strokeCircle(state.me.x, state.me.y - 118, 14);
            top.lineStyle(5, 0x3df2ff, 1);
            top.beginPath();
            top.arc(state.me.x, state.me.y - 118, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t, false);
            top.strokePath();
            if (t >= 1) {
              const id = state.work.obj;
              state.work = null;
              if (opts.onWorkDone) opts.onWorkDone(id);
            }
          }
          if (!opts.reduceMotion) {
            for (const m of state.motes) {
              m.y -= m.v * dt;
              m.x += Math.sin(time / 1700 + m.p) * 4 * dt;
              if (m.y < 0) (m.y = H), (m.x = Math.random() * W);
              top.fillStyle(0xcfe6ff, 0.16 + 0.12 * Math.sin(time / 600 + m.p));
              top.fillCircle(m.x, m.y, m.r);
            }
          }
        },
      },
    };
    const game = new Phaser.Game(config);

    function makeSprite(sc, charId, name, isMe) {
      const root = sc.add.container(0, 0).setDepth(10);
      const img = sc.add.image(0, 0, "blank").setOrigin(0.5, 1);
      const label = sc.add.text(0, -92, name.length > 12 ? name.slice(0, 11) + "." : name, {
        fontFamily: "Manrope, sans-serif", fontSize: "11px", color: isMe ? "#3df2ff" : "#e8eef9", fontStyle: "800", backgroundColor: "rgba(6,10,19,.7)", padding: { x: 4, y: 1 }, resolution: 2,
      }).setOrigin(0.5, 1);
      root.add([img, label]);
      const api = {
        root, face: 1,
        setPosition(x, y) { root.setPosition(x, y); root.setDepth(10 + y / 100); },
        setPose(pose, t, speedK) {
          // walk cycle speed follows the real speed so feet do not slide
          const rate = pose === "walk" ? 6 + 4 * Math.min(1.6, speedK || 1) : 3;
          const step = pose === "walk" ? Math.floor(t * rate) % 6 : Math.floor(t * rate) % 4;
          const key = `ag|${charId}|${pose}|${step}`;
          if (!sc.textures.exists(key)) sc.textures.addCanvas(key, ART.frame(charId, pose, step, 2));
          if (img.texture.key !== key) img.setTexture(key);
          img.setScale(this.face * 0.55, 0.55);
        },
        destroy() { root.destroy(); },
      };
      return api;
    }

    return {
      update(view) {
        state.view = view;
        if (view.me && !state.init) {
          state.init = true;
          state.me.x = view.me.x;
          state.me.y = view.me.y;
        }
      },
      /** Applies the server's decision for the request we sent: only the difference is corrected, so latency never rubber-bands. */
      reconcile(sent, server) {
        if (!sent || !server) return;
        const dx = server.x - sent.x, dy = server.y - sent.y;
        if (Math.hypot(dx, dy) > 1.5) (state.me.x += dx), (state.me.y += dy);
      },
      setInput(x, y) { state.input.x = x; state.input.y = y; },
      moveTo(x, y) { state.target = { x, y }; },
      dash(ms) { state.dashUntil = Date.now() + ms; },
      shake() { try { scene && scene.cameras.main.shake(220, 0.006); } catch (e) { /* ignore */ } },
      setWork(obj, dur) {
        state.work = obj ? { obj, dur, t0: Date.now() } : null;
        if (obj) state.target = null;
      },
      pos: () => ({ x: Math.round(state.me.x * 10) / 10, y: Math.round(state.me.y * 10) / 10 }),
      moving: () => state.moving,
      near: () => state.near,
      destroy() { try { if (scene && scene.ro) scene.ro.disconnect(); game.destroy(true); } catch (e) { /* already gone */ } },
    };
  }

  window.SA_GAME = { start };
})();
