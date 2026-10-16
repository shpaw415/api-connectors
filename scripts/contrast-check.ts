/**
 * api-connectors — audit de contraste WCAG des deux thèmes (règle thèmes : dark + light, min 4.5).
 * Extrait les variables CSS de la page servie (checkout OU bundle figé) et vérifie
 * les paires texte/fond. Les rgba() sont composités sur --bg du thème.
 * Usage : UI_PORT=4750 bun scripts/contrast-check.ts
 */
const PORT = Number(process.env.UI_PORT ?? 4750);
const BASE = `http://127.0.0.1:${PORT}`;

function pageToken(): string {
  if (process.env.PAGE_TOKEN) return process.env.PAGE_TOKEN;
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const out = spawnSync("ob-plugin", ["page", "api-connectors"], { encoding: "utf8" });
    const pid = Number(out.stdout.match(/"pid":\s*(\d+)/)?.[1] ?? 0);
    if (pid > 0) {
      const t = readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0").find((l) => l.startsWith("OPEN_BOT_PAGE_TOKEN="));
      return t ? t.slice("OPEN_BOT_PAGE_TOKEN=".length) : "";
    }
  } catch { /* dev sans token */ }
  return "";
}

const TOKEN = pageToken();
const html = await (await fetch(BASE + "/", { headers: TOKEN ? { "x-open-bot-page-token": TOKEN } : {} })).text();

// HTML bundle (install figé) : CSS inliné dans <style>. Checkout local (bun --hot) :
// feuille liée ./styles.css — on la suit (avec token : la route passe par le fetch authifié).
let css: string | undefined = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
if (!css) {
  const link = html.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
  if (!link) {
    console.error("✗ ni <style> ni feuille liée dans la page servie");
    process.exit(1);
  }
  css = await (await fetch(new URL(link, BASE).toString(), { headers: TOKEN ? { "x-open-bot-page-token": TOKEN } : {} })).text();
}
const darkMatch = css.match(/html\[data-theme="dark"\]\s*\{/);
if (!darkMatch || darkMatch.index === undefined) {
  console.error("✗ bloc html[data-theme=\"dark\"] introuvable — page mono-thème ?");
  process.exit(1);
}
type Vars = Record<string, string>;
function varsOf(block: string): Vars {
  const out: Vars = {};
  for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const light = varsOf(css.slice(0, darkMatch.index));
const dark = varsOf(css.slice(darkMatch.index));

function hexToRgb(hex: string): [number, number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // #rrggbbaa : le bundler CSS de Bun convertit les rgba() en hex 8 chiffres
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}
function parseColor(c: string, bg: [number, number, number]): [number, number, number] {
  c = c.trim();
  if (c.startsWith("#")) {
    const [r, g, b, a] = hexToRgb(c);
    return [
      Math.round(r * a + bg[0] * (1 - a)),
      Math.round(g * a + bg[1] * (1 - a)),
      Math.round(b * a + bg[2] * (1 - a)),
    ];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((s) => parseFloat(s));
    const [r, g, b] = parts;
    const a = parts[3] === undefined ? 1 : parts[3];
    return [
      Math.round(r * a + bg[0] * (1 - a)),
      Math.round(g * a + bg[1] * (1 - a)),
      Math.round(b * a + bg[2] * (1 - a)),
    ];
  }
  throw new Error(`couleur non gérée : ${c}`);
}
function lum([r, g, b]: [number, number, number]): number {
  const [rr, gg, bb] = [r, g, b].map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
}
function ratio(fg: string, bg: string, v: Vars): number {
  const bgc = parseColor(v.bg, [0, 0, 0]);
  const a = lum(parseColor(fg, bgc));
  const b = lum(parseColor(bg, bgc));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

let fail = 0;
function check(theme: string, name: string, fg: string, bg: string, v: Vars, min = 4.5) {
  if (!v[fg] || !v[bg]) {
    fail++;
    console.log(`✗ [${theme}] ${name} : variable manquante (--${fg} ou --${bg})`);
    return;
  }
  const r = ratio(v[fg], v[bg], v);
  const okk = r >= min;
  if (!okk) fail++;
  console.log(`${okk ? "✓" : "✗"} [${theme}] ${name} : ${r.toFixed(2)}:1 (min ${min})  [--${fg} sur --${bg}]`);
}

for (const [theme, v] of [["light", light], ["dark", dark]] as const) {
  console.log(`\n— thème ${theme} —`);
  check(theme, "body (texte/bg)", "text", "bg", v);
  check(theme, ".sub/.desc (muted/bg)", "muted", "bg", v);
  check(theme, ".eyebrow/.meta/.badge.off (faint/bg)", "faint", "bg", v);
  check(theme, "input::placeholder (faint/bg)", "faint", "bg", v);
  check(theme, "button (encre/fond transparent)", "btn-ink", "bg", v);
  check(theme, "button.primary (encre/accent)", "primary-ink", "accent", v);
  check(theme, ".badge.on/.result.ok (green/bg)", "green", "bg", v);
  check(theme, ".result.bad/.bad (red/bg)", "red", "bg", v);
  check(theme, "code (code-ink/code-bg composité)", "code-ink", "code-bg", v);
  check(theme, "a (accent-soft/bg)", "accent-soft", "bg", v);
  // hover des boutons secondaires : encre --text sur fond bg, bordure seule change
  check(theme, "button:hover (text/bg)", "text", "bg", v);
}

console.log(fail ? `\n${fail} échec(s)` : "\ntous les contrastes passent dans les deux thèmes");
process.exit(fail ? 1 : 0);
