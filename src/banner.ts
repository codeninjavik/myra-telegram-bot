import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satori from "satori";
import { FONT_DEVANAGARI_600, FONT_INTER_500, FONT_INTER_600, FONT_INTER_700, FONT_PLAYFAIR_700, FONT_PLAYFAIR_800 } from "./fonts.js";
import { WELCOME_TEMPLATE_JPG } from "./template.js";

// Welcome banner: the Myra red card. The artwork (girl, frame, icons) is a fixed template with the sample name,
// photo, group and member number painted out; satori draws the real ones on top and resvg's WebAssembly build
// rasterises it, so no native binaries or system fonts are needed.
const W = 1672;
const H = 941;
const OUT_W = 1280;
const buf = (b64: string) => Buffer.from(b64, "base64");

let wasmReady: Promise<void> | null = null;
function initResvg() {
  wasmReady ??= initWasm(readFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm")));
  return wasmReady;
}

const FONTS = [
  { name: "Inter", data: buf(FONT_INTER_700), weight: 700 as const, style: "normal" as const },
  { name: "Inter", data: buf(FONT_INTER_600), weight: 600 as const, style: "normal" as const },
  { name: "Inter", data: buf(FONT_INTER_500), weight: 500 as const, style: "normal" as const },
  { name: "Playfair", data: buf(FONT_PLAYFAIR_800), weight: 800 as const, style: "normal" as const },
  { name: "Playfair", data: buf(FONT_PLAYFAIR_700), weight: 700 as const, style: "normal" as const },
  // Hindi names (fallback glyphs)
  { name: "NotoDeva", data: buf(FONT_DEVANAGARI_600), weight: 500 as const, style: "normal" as const },
  { name: "NotoDeva", data: buf(FONT_DEVANAGARI_600), weight: 600 as const, style: "normal" as const },
  { name: "NotoDeva", data: buf(FONT_DEVANAGARI_600), weight: 700 as const, style: "normal" as const },
];

const h = (type: string, style: Record<string, unknown>, children?: unknown): any => ({ type, props: { style, children } });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Text column (right of the photo, left of the girl) is 500px wide; pick a font size that fits it.
const COL_X = 455;
const COL_W = 500;
const fit = (chars: number, max: number, em: number, min: number) =>
  Math.max(min, Math.min(max, Math.floor(COL_W / (em * Math.max(chars, 1)))));

// Photo circle: same centre/size as the one in the artwork.
const AV_CX = 234;
const AV_CY = 505;
const AV_R = 152;

export type BannerInput = {
  name: string;
  group: string;
  avatar?: { data: Buffer; mime: string } | null;
  memberNo?: number | null;
};

export async function welcomeBanner(i: BannerInput): Promise<Buffer> {
  await initResvg();
  // Only scripts the bundled fonts cover (Latin, Devanagari); emoji and other scripts would draw as empty boxes.
  const printable = (s: string) => s.replace(/[^\p{Script=Latin}\p{Script=Devanagari}\p{N}\p{P}\p{Zs}]/gu, "").replace(/\s+/g, " ").trim();
  const name = clip(printable(i.name) || "Friend", 24);
  const group = clip(printable(i.group) || "this group", 26);
  const initial = [...name][0]?.toUpperCase() ?? "?";

  const D = AV_R * 2;
  const photo = i.avatar
    ? h("img", { width: D, height: D, borderRadius: AV_R, objectFit: "cover" }, undefined)
    : h("div", {
        width: D, height: D, borderRadius: AV_R, display: "flex", alignItems: "center", justifyContent: "center",
        background: "linear-gradient(160deg,#ff4a5c,#a00a1c)", color: "#fff", fontFamily: "Playfair", fontWeight: 800, fontSize: 190,
      }, initial);
  if (i.avatar) (photo.props as any).src = `data:${i.avatar.mime};base64,${i.avatar.data.toString("base64")}`;

  const nameSize = fit(name.length, 88, 0.62, 34);
  // "to <group> Members": the group is red, like the original card.
  const lineSize = fit(group.length + 12, 36, 0.56, 22);
  const badge = i.memberNo ? `Member #${i.memberNo.toLocaleString("en-US")}` : "New member";

  const tree = h("div", { width: W, height: H, display: "flex", position: "relative", fontFamily: "Inter, NotoDeva" }, [
    h("img", { position: "absolute", left: 0, top: 0, width: W, height: H }, undefined),
    // ring + photo
    h("div", {
      position: "absolute", left: AV_CX - AV_R - 7, top: AV_CY - AV_R - 7, width: D + 14, height: D + 14, borderRadius: AV_R + 7,
      display: "flex", alignItems: "center", justifyContent: "center", border: "4px solid #ffffff",
      boxShadow: "0 0 26px 4px rgba(255,30,60,0.75)", background: "#1a0003",
    }, photo),
    // name + red rule
    h("div", {
      position: "absolute", left: COL_X, top: 338, width: COL_W, height: 100, display: "flex", alignItems: "center",
      fontWeight: 700, fontSize: nameSize, color: "#ffffff", whiteSpace: "nowrap", overflow: "hidden",
    }, name),
    h("div", { position: "absolute", left: COL_X, top: 437, width: 210, height: 2, background: "linear-gradient(90deg,#ff2b3d,rgba(255,43,61,0))" }),
    // to <group> Members
    h("div", {
      position: "absolute", left: COL_X, top: 452, width: COL_W, height: 46, display: "flex", alignItems: "center",
      fontSize: lineSize, fontWeight: 500, color: "#f2f2f2", whiteSpace: "nowrap", overflow: "hidden",
    }, [
      h("span", { marginRight: 12 }, "to"),
      h("span", { color: "#ff2b3d", fontWeight: 600, marginRight: 12 }, group),
      h("span", {}, "Members"),
    ]),
    // member number inside the badge
    h("div", {
      position: "absolute", left: 549, top: 585, width: 250, height: 44, display: "flex", alignItems: "center",
      fontSize: badge.length > 14 ? 26 : 31, fontWeight: 600, color: "#ffffff", whiteSpace: "nowrap",
    }, badge),
  ]);
  // The artwork goes in as the first child's source.
  (tree.props.children[0].props as any).src = `data:image/jpeg;base64,${WELCOME_TEMPLATE_JPG}`;

  const svg = await satori(tree, { width: W, height: H, fonts: FONTS });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: OUT_W } }).render().asPng());
}
