/**
 * api-connectors — harnais UI headless (happy-dom, aucun navigateur requis).
 * Vérifie, du point de vue utilisateur, contre le serveur LIVE (checkout bun --hot
 * OU install figée marketplace — les deux formes de page sont détectées) :
 *   1. /healthz -> 200 ; auth API : 401 sans token, 200 avec (jamais de valeur affichée).
 *   2. GET / -> HTML complet (titre, #grid), Cache-Control: no-cache sur la route HTML
 *      (install figée ; checkout : route HTMLBundle statique du scaffold, voir note),
 *      script de thème AVANT le CSS, aucun toggle custom.
 *   3. Thèmes : ?theme=light / ?theme=dark / sans param -> attribut data-theme correct
 *      (exécution du script <head> dans happy-dom).
 *   4. Bundle : checkout = assets /_bun/* (ou app.ts) servis en 200, app transpile ;
 *      install figée = HTML autonome (JS inline, CSS inline, aucun src), < 8 Mo.
 *   5. Rendu : la page exécute l'app et rend les 3 cartes providers (GitHub, Google,
 *      Slack), badges et réglages chargés — SANS muter le coffre ni les réglages.
 *   6. API : /api/status -> 3 providers, aucun secret dans les champs ;
 *      /api/test sur un provider non configuré -> réponse JSON gracieuse.
 * Usage : UI_PORT=4750 bun scripts/uitest.ts   (lecture seule : aucun POST /api/save)
 */
import { Window } from "happy-dom";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.UI_PORT ?? 4750);
const PLUGIN_ID = process.env.PLUGIN_ID ?? "api-connectors";
const BASE = `http://127.0.0.1:${PORT}`;
let fail = 0;
function ok(cond: boolean, label: string): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----- serveur : pid + mode (frozen si OPEN_BOT_PAGE_UI défini) + token de page.
// Ces valeurs sont lues dans /proc/<pid>/environ et JAMAIS affichées. -----
function pageProc(): { pid: number; token: string; frozen: boolean } {
  const out = spawnSync("ob-plugin", ["page", PLUGIN_ID], { encoding: "utf8" });
  const pid = Number(out.stdout.match(/"pid":\s*(\d+)/)?.[1] ?? 0);
  if (pid <= 0) return { pid: 0, token: process.env.PAGE_TOKEN ?? "", frozen: false };
  const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  const t = environ.find((l) => l.startsWith("OPEN_BOT_PAGE_TOKEN="));
  return {
    pid,
    token: process.env.PAGE_TOKEN ?? (t ? t.slice("OPEN_BOT_PAGE_TOKEN=".length) : ""),
    frozen: environ.some((l) => l.startsWith("OPEN_BOT_PAGE_UI=")),
  };
}
const { pid: SRV_PID, token: TOKEN, frozen: FROZEN } = pageProc();
console.log(`· serveur : pid=${SRV_PID} mode=${FROZEN ? "install figée (OPEN_BOT_PAGE_UI)" : "checkout (bun --hot)"}`);
const H: Record<string, string> = TOKEN ? { "x-open-bot-page-token": TOKEN } : {};
const authed = (p: string, init?: RequestInit) => fetch(BASE + p, { ...init, headers: { ...init?.headers, ...H } });

// fetch injecté dans la fenêtre : préfixe les URL relatives (api/…) vers le serveur
// et porte le token (le proxy dashboard fait pareil côté réel).
function makeFetch(win: Window): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), BASE).toString();
    return fetch(u, { ...init, headers: { ...init?.headers, ...H } });
  }) as typeof fetch;
}

// Exécute les <script> inline (thème) dans le contexte happy-dom
// (groupe de capture obligatoire dans la regex).
function runInlineScripts(win: Window, html: string): void {
  const doc = win.document as unknown as Document;
  doc.open(); doc.write(html); doc.close();
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    new Function("window", "with(window){ " + m[1] + " }")(win);
  }
}

// ---------- 1. healthz + auth ----------
ok((await fetch(BASE + "/healthz")).status === 200, "/healthz -> 200 (sans token)");
ok((await fetch(BASE + "/api/status")).status === 401, "/api/status sans token -> 401 (fail-closed avec token configuré)" + (TOKEN ? "" : " [serveur dev sans token]"));

// ---------- 2+3. page, thèmes, cache ----------
const html = await (await fetch(BASE + "/?theme=dark")).text();
const cache = (await fetch(BASE + "/")).headers.get("cache-control") ?? "";
if (FROZEN) ok(/no-cache/i.test(cache), `Cache-Control: no-cache sur la route HTML figée (« ${cache} »)`);
else console.log(`· checkout local : route HTMLBundle statique (scaffold) — cache-control serveur : « ${cache || "aucun"} » (no-cache requis et vérifié sur l'install figée)`);
ok(html.includes("Connexions API") && html.includes('id="grid"'), "GET / sert le HTML complet (titre + #grid)");

const scriptPos = html.indexOf("<script>");
const cssPos = html.search(/<style|rel="stylesheet"/);
ok(scriptPos >= 0 && cssPos >= 0 && scriptPos < cssPos, "script de thème AVANT le CSS (zéro flash)");
ok(/data-theme/.test(html) && !/theme-toggle|toggle-theme/i.test(html), "thème piloté par ?theme=/prefers, aucun toggle custom");

for (const [qs, attendu] of [["?theme=dark", "dark"], ["?theme=light", "light"], ["", null]] as const) {
  const w = new Window({ url: BASE + "/" + qs });
  runInlineScripts(w, html);
  const got = (w.document as unknown as Document).documentElement.getAttribute("data-theme");
  const bon = attendu ? got === attendu : (got === "light" || got === "dark");
  ok(bon, `data-theme${qs || " (sans param)"} -> ${got}${attendu ? ` (attendu ${attendu})` : ""}`);
  await w.happyDOM.abort();
}

// ---------- 4. bundle : les deux formes de page ----------
// Install figée (marketplace) : HTML autonome, app transpilée inline dans
// <script type="module">, CSS inline, AUCUN src. Checkout local (bun --hot) :
// assets /_bun/client/*.js + /_bun/asset/*.css servis par Bun (ou src app.ts direct).
const appSrc = html.match(/src="([^"]*_bun\/client\/[^"]+\.js)"/)?.[1]
  ?? html.match(/src="([^"]*app\.ts)"/)?.[1];
let appJs: string;
if (appSrc) {
  const appRes = await fetch(new URL(appSrc, BASE).toString());
  ok(appRes.status === 200, `JS de l'app servi en 200 (${appSrc})`);
  appJs = await appRes.text();
  try {
    const transpilé = new Bun.Transpiler({ loader: "ts" }).transformSync(appJs);
    ok(transpilé.includes("refresh"), "JS de l'app transpile et contient l'app (refresh)");
  } catch (e) { ok(false, `JS de l'app transpile : ${String(e).slice(0, 80)}`); }
  const cssHref = html.match(/href="([^"]*_bun\/asset\/[^"]+\.css)"/)?.[1]
    ?? html.match(/href="([^"]*styles\.css)"/)?.[1];
  const cssRes = cssHref ? await fetch(new URL(cssHref, BASE).toString()) : null;
  ok(!!cssRes && cssRes.status === 200, `CSS servi en 200 (${cssHref ?? "introuvable"})`);
  const cssLen = cssRes ? Number(cssRes.headers.get("content-length") ?? (await cssRes.text()).length) : 0;
  ok(appJs.length + cssLen < 8 * 1024 * 1024, `bundle < 8 Mo (${((appJs.length + cssLen) / 1024).toFixed(0)} Ko)`);
} else {
  ok(FROZEN, "aucun src externe (forme autonome attendue en install figée)");
  appJs = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] ?? "";
  ok(appJs.length > 1000, `app bundle inlinée dans le HTML (${(appJs.length / 1024).toFixed(0)} Ko de JS transpilé)`);
  ok(/<style>[\s\S]{500,}<\/style>/.test(html), "CSS inline dans le bundle");
  ok(html.length < 8 * 1024 * 1024, `bundle HTML autonome < 8 Mo (${(html.length / 1024).toFixed(0)} Ko)`);
}

// ---------- 5. rendu réel : les 3 cartes providers ----------
const win = new Window({ url: BASE + "/?theme=light" });
(win as unknown as { fetch: typeof fetch }).fetch = makeFetch(win);
runInlineScripts(win, html);
new Function("window", "with(window){ " + appJs + " }")(win);
await sleep(500);
const doc = win.document as unknown as Document;
const cartes = doc.querySelectorAll("#grid .card");
ok(cartes.length === 3, `3 cartes providers rendues (${cartes.length})`);
const badges = [...doc.querySelectorAll("#grid .badge")].map((b) => b.textContent?.trim());
ok(badges.length === 3 && badges.every((b) => b === "Connecté" || b === "Non configuré"), `badges cohérents (${badges.join(", ")})`);
const ids = [...doc.querySelectorAll("#grid input[id^='in-']")].map((i) => i.id);
ok(ids.length === 3 && ids.every((i) => /^(in-github|in-google|in-slack)$/.test(i)), `champs de clé par provider (${ids.join(", ")})`);
const stEnabled = doc.querySelector("#st-enabled");
ok(stEnabled !== null, "réglages présents (case Plugin actif)");
await win.happyDOM.abort();

// ---------- 6. API sans clés réelles (lecture seule) ----------
const status = await (await authed("/api/status")).json() as Array<Record<string, unknown>>;
ok(Array.isArray(status) && status.length === 3, "/api/status -> 3 providers");
ok(status.every((r) => typeof r.keyPresent === "boolean" && typeof r.label === "string" && typeof r.signup === "string"), "/api/status : forme des lignes OK");
const champs = new Set(status.flatMap((r) => Object.keys(r)));
ok(![...champs].some((c) => /key$|token$|secret$|value$/i.test(c)), `aucun champ de secret dans /api/status (${[...champs].join(", ")})`);
const settings = await (await authed("/api/settings")).json() as Record<string, unknown>;
ok(typeof settings.enabled === "boolean" && typeof settings.timeout_ms === "number", "/api/settings -> JSON de réglages");
const sansClé = status.find((r) => r.keyPresent === false);
if (sansClé) {
  const t = await (await authed("/api/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: sansClé.id }) })).json() as Record<string, unknown>;
  ok(typeof t.ok === "boolean" && typeof t.message === "string" && (t.ok === false || t.message.length > 0), `/api/test sans clé (${sansClé.id}) -> gracieux : ok=${t.ok}`);
} else {
  console.log("· tous les providers ont une clé : /api/test non exécuté (aucun appel réel déclenché)");
}

console.log(fail ? `\n${fail} échec(s)` : "\ntous les cas UI passent");
process.exit(fail ? 1 : 0);
