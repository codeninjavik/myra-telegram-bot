// SECRET AGENT maps. Coordinates are in a virtual 800x480 space shared by server and client. The server uses the
// obstacles for movement validation and the objects for interaction checks; the client draws the same data.

export type Rect = { x: number; y: number; w: number; h: number };
/** A blocking prop. `kind` only changes how the client draws it; the server uses the rectangle. */
export type Obstacle = Rect & { kind: "desk" | "couch" | "shelf" | "bench" | "rack" | "pillar" | "crate" | "console" | "tent" | "truck" };
export type ObjKind = "terminal" | "console" | "cabinet" | "panel" | "power" | "door" | "lab";
export type MapObject = { id: string; kind: ObjKind; x: number; y: number; label: string; room: string };
export type GameMap = {
  id: string;
  name: string;
  theme: { floor: string; floor2: string; wall: string; accent: string; glow: string };
  obstacles: Obstacle[];
  objects: MapObject[];
  spawns: { x: number; y: number }[];
  zones: { name: string; x: number; y: number }[];
};

export const WORLD = { w: 800, h: 480, margin: 24, radius: 12 };

const KIND_LABEL: Record<ObjKind, string> = {
  terminal: "Security terminal", console: "Computer console", cabinet: "Evidence cabinet", panel: "Surveillance panel",
  power: "Power control", door: "Locked door", lab: "Sample analyzer",
};

function obj(id: string, kind: ObjKind, x: number, y: number, room: string, label?: string): MapObject {
  return { id, kind, x, y, room, label: label ?? KIND_LABEL[kind] };
}

const ring = (cx: number, cy: number, r: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ x: Math.round(cx + Math.cos((i / n) * Math.PI * 2) * r), y: Math.round(cy + Math.sin((i / n) * Math.PI * 2) * r) }));

export const MAPS: GameMap[] = [
  {
    id: "hq", name: "Headquarters Lobby",
    theme: { floor: "#0e1a2e", floor2: "#122240", wall: "#1d2e4d", accent: "#3df2ff", glow: "#3df2ff" },
    obstacles: [{ x: 340, y: 190, w: 120, h: 100, kind: "desk" }, { x: 80, y: 90, w: 140, h: 40, kind: "couch" }, { x: 590, y: 340, w: 130, h: 40, kind: "couch" }, { x: 60, y: 330, w: 40, h: 90, kind: "shelf" }],
    objects: [
      obj("o1", "terminal", 150, 160, "Reception"), obj("o2", "console", 650, 120, "Operations"), obj("o3", "cabinet", 120, 400, "Archive"),
      obj("o4", "panel", 400, 90, "Atrium"), obj("o5", "power", 700, 420, "Utility"), obj("o6", "door", 560, 260, "Vault door"),
      obj("o7", "console", 270, 360, "Briefing desk"),
    ],
    spawns: ring(400, 240, 150, 10),
    zones: [{ name: "Reception", x: 150, y: 160 }, { name: "Operations", x: 650, y: 120 }, { name: "Archive", x: 120, y: 400 }, { name: "Utility", x: 700, y: 420 }],
  },
  {
    id: "lab", name: "Research Laboratory",
    theme: { floor: "#0c1f26", floor2: "#10303a", wall: "#1a4350", accent: "#5cffc8", glow: "#5cffc8" },
    obstacles: [{ x: 120, y: 120, w: 160, h: 50, kind: "bench" }, { x: 520, y: 120, w: 160, h: 50, kind: "bench" }, { x: 300, y: 300, w: 200, h: 50, kind: "bench" }, { x: 40, y: 260, w: 50, h: 120, kind: "rack" }],
    objects: [
      obj("o1", "lab", 200, 215, "Sample bay"), obj("o2", "lab", 600, 215, "Sample bay"), obj("o3", "terminal", 400, 70, "Control"),
      obj("o4", "cabinet", 130, 410, "Cold storage"), obj("o5", "panel", 700, 380, "Observation"), obj("o6", "power", 400, 420, "Reactor feed"),
      obj("o7", "console", 700, 60, "Analysis"),
    ],
    spawns: ring(400, 250, 160, 10),
    zones: [{ name: "Sample bay", x: 200, y: 215 }, { name: "Control", x: 400, y: 70 }, { name: "Cold storage", x: 130, y: 410 }, { name: "Reactor feed", x: 400, y: 420 }],
  },
  {
    id: "under", name: "Underground Facility",
    theme: { floor: "#15131f", floor2: "#1c1830", wall: "#2b2346", accent: "#a78bff", glow: "#7c5cff" },
    obstacles: [{ x: 180, y: 80, w: 30, h: 220, kind: "pillar" }, { x: 590, y: 180, w: 30, h: 220, kind: "pillar" }, { x: 330, y: 330, w: 140, h: 40, kind: "crate" }, { x: 330, y: 110, w: 140, h: 40, kind: "crate" }],
    objects: [
      obj("o1", "power", 90, 90, "Generator"), obj("o2", "terminal", 400, 230, "Tunnel junction"), obj("o3", "door", 700, 90, "Blast door"),
      obj("o4", "panel", 100, 400, "Camera nest"), obj("o5", "cabinet", 690, 420, "Lockers"), obj("o6", "console", 280, 410, "Maintenance"),
      obj("o7", "console", 520, 80, "Signal room"),
    ],
    spawns: ring(400, 245, 120, 10),
    zones: [{ name: "Generator", x: 90, y: 90 }, { name: "Blast door", x: 700, y: 90 }, { name: "Lockers", x: 690, y: 420 }, { name: "Maintenance", x: 280, y: 410 }],
  },
  {
    id: "office", name: "Intelligence Office",
    theme: { floor: "#101826", floor2: "#16233a", wall: "#243556", accent: "#ffc857", glow: "#ffc857" },
    obstacles: [{ x: 100, y: 100, w: 120, h: 70, kind: "desk" }, { x: 340, y: 100, w: 120, h: 70, kind: "desk" }, { x: 580, y: 100, w: 120, h: 70, kind: "desk" }, { x: 220, y: 310, w: 120, h: 70, kind: "desk" }, { x: 460, y: 310, w: 120, h: 70, kind: "desk" }],
    objects: [
      obj("o1", "console", 160, 200, "Analyst row"), obj("o2", "console", 400, 200, "Analyst row"), obj("o3", "console", 640, 200, "Analyst row"),
      obj("o4", "cabinet", 70, 420, "Records"), obj("o5", "terminal", 730, 420, "Mail room"), obj("o6", "panel", 400, 60, "Wall display"),
      obj("o7", "door", 400, 440, "Director's door"),
    ],
    spawns: ring(400, 255, 170, 10),
    zones: [{ name: "Analyst row", x: 400, y: 200 }, { name: "Records", x: 70, y: 420 }, { name: "Mail room", x: 730, y: 420 }, { name: "Wall display", x: 400, y: 60 }],
  },
  {
    id: "control", name: "Security Control Room",
    theme: { floor: "#0d141f", floor2: "#111c2c", wall: "#1f2c44", accent: "#ff3b4e", glow: "#ff3b4e" },
    obstacles: [{ x: 250, y: 150, w: 300, h: 60, kind: "console" }, { x: 250, y: 280, w: 300, h: 60, kind: "console" }, { x: 40, y: 40, w: 50, h: 150, kind: "rack" }, { x: 710, y: 290, w: 50, h: 150, kind: "rack" }],
    objects: [
      obj("o1", "panel", 400, 120, "Camera wall"), obj("o2", "panel", 400, 370, "Camera wall"), obj("o3", "terminal", 120, 250, "Dispatch"),
      obj("o4", "power", 690, 240, "Breaker room"), obj("o5", "cabinet", 130, 420, "Armory"), obj("o6", "door", 700, 90, "Lockdown door"),
      obj("o7", "console", 400, 245, "Command seat"),
    ],
    spawns: ring(400, 245, 180, 10),
    zones: [{ name: "Camera wall", x: 400, y: 120 }, { name: "Dispatch", x: 120, y: 250 }, { name: "Breaker room", x: 690, y: 240 }, { name: "Armory", x: 130, y: 420 }],
  },
  {
    id: "night", name: "Night Mission Base",
    theme: { floor: "#0a1220", floor2: "#0f1a30", wall: "#1a2744", accent: "#4da3ff", glow: "#4da3ff" },
    obstacles: [{ x: 150, y: 150, w: 90, h: 90, kind: "tent" }, { x: 560, y: 150, w: 90, h: 90, kind: "tent" }, { x: 355, y: 330, w: 90, h: 90, kind: "truck" }, { x: 355, y: 60, w: 90, h: 60, kind: "crate" }],
    objects: [
      obj("o1", "power", 90, 90, "Generator tent"), obj("o2", "terminal", 700, 90, "Comms tent"), obj("o3", "lab", 400, 215, "Field lab"),
      obj("o4", "cabinet", 90, 410, "Supply crates"), obj("o5", "panel", 710, 400, "Watchtower"), obj("o6", "console", 250, 330, "Planning table"),
      obj("o7", "door", 560, 420, "Gate"),
    ],
    spawns: ring(400, 245, 140, 10),
    zones: [{ name: "Generator tent", x: 90, y: 90 }, { name: "Comms tent", x: 700, y: 90 }, { name: "Supply crates", x: 90, y: 410 }, { name: "Watchtower", x: 710, y: 400 }],
  },
];

// Candidate spawn rings can land inside an obstacle: keep only walkable ones and top up from a grid so every map
// always has at least 10 valid, well-spread starting points.
for (const m of MAPS) {
  const spawns = m.spawns.filter((s) => walkable(m, s.x, s.y));
  for (let y = 60; y < WORLD.h - 40 && spawns.length < 10; y += 60) {
    for (let x = 60; x < WORLD.w - 40 && spawns.length < 10; x += 60) {
      if (walkable(m, x, y) && spawns.every((q) => dist(q, { x, y }) > 70) && m.objects.every((o) => dist(o, { x, y }) > 50)) spawns.push({ x, y });
    }
  }
  m.spawns = spawns;
}

export const mapById = (id: string) => MAPS.find((m) => m.id === id) ?? MAPS[0];

export function walkable(map: GameMap, x: number, y: number): boolean {
  const r = WORLD.radius;
  if (x < WORLD.margin || y < WORLD.margin || x > WORLD.w - WORLD.margin || y > WORLD.h - WORLD.margin) return false;
  for (const o of map.obstacles) {
    if (x > o.x - r && x < o.x + o.w + r && y > o.y - r && y < o.y + o.h + r) return false;
  }
  return true;
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---- original character roster (palettes; the client draws them procedurally, so there are no borrowed assets)
export type CharDef = { id: string; name: string; color: string; colorName: string; suit: string; trim: string; skin: string; hair: string; trait: string };
export const CHARACTERS: CharDef[] = [
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
export const charById = (id: string) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
