// api-connectors — serveur de la page dashboard « Connexions »
// Lancé par le control plane avec Bun. Env : OPEN_BOT_PAGE_PORT, OPEN_BOT_PAGE_TOKEN, OPEN_BOT_PLUGIN_ID,
// et OPEN_BOT_PAGE_UI sur les installs figées (le control plane bundle index.html en un HTML autonome au
// install). Les installs locales et les previews lancent ce checkout avec bun --hot et importent
// index.html live à la place (directive dashboard server du 2026-10-16).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
// Core importé par son chemin installé (comme les tools du manifest) : le serveur de page
// tourne depuis le checkout (bun --hot) comme depuis un install, où le fichier voisin
// s'appelle ob-plugin-api-connectors-core.js — l'import relatif ne résout que dans l'install.
import * as core from "/usr/local/bin/ob-plugin-api-connectors-core.js";

const PORT = Number(process.env.OPEN_BOT_PAGE_PORT ?? 4740);
const PAGE_TOKEN = process.env.OPEN_BOT_PAGE_TOKEN ?? "";

const UI_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };

// La route "/" branle sur le mode : la valeur de route doit être choisie AVANT le démarrage
// du serveur. Install figée (OPEN_BOT_PAGE_UI) : handler Response sur le fichier bundle avec
// Cache-Control: no-cache (directive — route HTML de production). Checkout local / preview :
// l'HTMLBundle de import("./index.html") n'est valide QUE comme valeur statique de route
// (sinon il se linéarise en « [object HTMLBundle] » et les assets /_bun/* disparaissent) —
// forme identique au scaffold de référence ; Bun le sert en text/html (serveur de dev).
const routes = process.env.OPEN_BOT_PAGE_UI
  ? {
      "/": () =>
        new Response(Bun.file(process.env.OPEN_BOT_PAGE_UI as string), { headers: UI_HEADERS }),
    }
  : { "/": await import("./index.html").then((m) => m.default) };

function authorized(req: Request) {
  // Directive 2026-10-16 : sans token configuré (dev), pas d'authentification. Avec token :
  // header x-open-bot-page-token obligatoire ; la valeur « dev-preview » (preview) n'est
  // acceptée qu'en loopback.
  if (!PAGE_TOKEN) return true;
  const h = req.headers.get("x-open-bot-page-token") ?? "";
  if (h === PAGE_TOKEN) return true;
  if (h !== "dev-preview") return false;
  try {
    const ip = server.requestIP(req);
    if (!ip) return false;
    const a = ip.address.replace(/^::ffff:/, "");
    return a === "127.0.0.1" || a === "::1";
  } catch {
    return false;
  }
}

// Enregistre ou vide une clé du coffre via `ob-plugin vault` (write-only, persistant
// côté control plane : survit aux réactivations et réinstallations).
function saveKey(slug: string, value: string) {
  const v = String(value ?? "").trim();
  if (v.length > 2000) return Promise.resolve({ ok: false, message: "Valeur trop longue (max 2000 caractères)." });
  return new Promise((resolve) => {
    const child = spawn("ob-plugin", ["vault", core.PLUGIN_ID, `${slug}=${v}`], { timeout: 30000 });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, message: v ? "Clé enregistrée dans le coffre (persistante)." : "Clé retirée du coffre." });
      } else {
        resolve({ ok: false, message: `Échec de l'enregistrement : ${out.trim().slice(0, 200) || `code ${code}`}` });
      }
    });
    child.on("error", (e) => resolve({ ok: false, message: `ob-plugin injoignable : ${String(e).slice(0, 120)}` }));
  });
}

// Réglages typés du plugin via `ob-plugin settings` (validation côté CLI).
function setSetting(key: string, value: string) {
  const allowed: Record<string, string[] | null> = { enabled: ["true", "false"], log_calls: ["true", "false"], timeout_ms: null };
  if (!(key in allowed)) return Promise.resolve({ ok: false, message: "Réglage inconnu." });
  let v = String(value).trim();
  if (allowed[key] && !allowed[key].includes(v)) return Promise.resolve({ ok: false, message: "Valeur attendue : " + allowed[key].join(" ou ") + "." });
  if (key === "timeout_ms") {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1000 || n > 120000) return Promise.resolve({ ok: false, message: "Timeout entre 1000 et 120000 ms." });
  }
  return new Promise((resolve) => {
    const child = spawn("ob-plugin", ["settings", core.PLUGIN_ID, `${key}=${v}`], { timeout: 30000 });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      if (code === 0 && core.setting(key) === v) resolve({ ok: true, message: "Réglage enregistré." });
      else resolve({ ok: false, message: `Échec : ${out.trim().slice(0, 160) || `code ${code}`}` });
    });
    child.on("error", (e) => resolve({ ok: false, message: `ob-plugin injoignable : ${String(e).slice(0, 120)}` }));
  });
}

// ===== OAuth : état des flows + écriture coffre + callbacks =====
function coreJSONState() {
  try { return JSON.parse(readFileSync(core.OAUTH_STATE_PATH, "utf8")); } catch { return {}; }
}
function saveJSONState(st: any) {
  try {
    mkdirSync(core.STATE_DIR, { recursive: true });
    writeFileSync(core.OAUTH_STATE_PATH, JSON.stringify(st, null, 2));
  } catch { /* jamais fatal */ }
}
function vaultWrite(slug: string, value: string) {
  return new Promise((resolve) => {
    const child = spawn("ob-plugin", ["vault", core.PLUGIN_ID, `${slug}=${value}`], { timeout: 30000 });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ ok: code === 0, message: code === 0 ? "ok" : (out.trim().slice(0, 160) || `code ${code}`) }));
    child.on("error", (e) => resolve({ ok: false, message: String(e).slice(0, 120) }));
  });
}
function escHtml(v: string) {
  return String(v).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m] as string));
}
function cbPage(msg: string, ok: boolean) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f1117;color:#e6e8ef;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:20px">' + (ok ? "Connexion réussie" : "Connexion échouée") + '</h1><p style="color:#8b90a0">' + escHtml(msg) + '</p><p><a style="color:#7c93f5" href="/">Retour à Connexions</a></p></div>',
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
async function handleCodeCallback(o: any, url: URL, provider: string) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  const st = coreJSONState();
  const flow = state ? st[state] : null;
  if (err) return cbPage("Le provider a refusé : " + err, false);
  if (!code || !flow || flow.provider !== provider) return cbPage("Code ou état invalide (expiré ?) — recommence depuis la page Connexions.", false);
  if (Date.now() > (flow.expiresAt || 0)) return cbPage("Délai dépassé — recommence depuis la page Connexions.", false);
  delete st[state]; saveJSONState(st);
  const cfg = core.loadConfig();
  const cid = String(cfg?.vault?.[o.clientIdVault]?.apiKey ?? cfg?.[o.clientIdVault] ?? "").trim();
  const csec = String(cfg?.vault?.[o.clientSecretVault]?.apiKey ?? cfg?.[o.clientSecretVault] ?? "").trim();
  const body = new URLSearchParams({ client_id: cid, client_secret: csec, code, redirect_uri: flow.redirectUri, grant_type: "authorization_code" });
  const r = await fetch(o.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) return cbPage("Échange du code refusé : " + (data.error || ("HTTP " + r.status)), false);
  let token = data.access_token || "";
  if (provider === "slack" && data.authed_user?.access_token) token = token || data.authed_user.access_token;
  if (provider === "google" && !data.refresh_token) return cbPage("Google n'a pas renvoyé de refresh token — révoque l'accès chez Google et recommence.", false);
  const sv = await vaultWrite(o.tokenVault, provider === "google" ? data.refresh_token : token);
  if (provider === "google" && sv.ok) {
    const cst = coreJSONState();
    cst.google = { access_token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000, kind: "oauth", error: null };
    saveJSONState(cst);
  }
  return cbPage(core.PROVIDERS[provider].label + " est connecté. Tu peux fermer cette page.", sv.ok);
}

const server = Bun.serve({
  port: PORT,
  routes,
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (!authorized(req)) return new Response("unauthorized", { status: 401 });

    if (req.method === "GET" && url.pathname === "/api/settings") {
      const cfg = core.loadConfig();
      return Response.json({
        enabled: core.setting("enabled", cfg) === "true",
        log_calls: core.setting("log_calls", cfg) === "true",
        timeout_ms: Number(core.setting("timeout_ms", cfg)) || 20000,
      }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await req.json().catch(() => ({}));
      const results = [];
      for (const [k, v] of Object.entries(body)) {
        results.push({ key: k, ok: (await setSetting(k, v as string)).ok });
      }
      return Response.json({ ok: results.every((r) => r.ok), results }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return Response.json(core.statusSummary(), { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "POST" && url.pathname === "/api/save") {
      const { provider, value } = await req.json().catch(() => ({}));
      const p = core.PROVIDERS[provider];
      if (!p) return Response.json({ ok: false, message: "Provider inconnu." }, { status: 400 });
      return Response.json(await saveKey(p.vault, value), { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "POST" && url.pathname === "/api/test") {
      const { provider } = await req.json().catch(() => ({}));
      const r = await core.testProvider(provider);
      return Response.json(r, { headers: { "cache-control": "no-store" } });
    }
    // ===== OAuth =====
    if (req.method === "POST" && url.pathname === "/api/oauth/github/start") {
      const cfg = core.loadConfig();
      const cid = String(cfg?.vault?.["github-client-id"]?.apiKey ?? cfg?.["github-client-id"] ?? "").trim();
      if (!cid) return Response.json({ ok: false, message: "Colle d'abord ton Client ID d'OAuth App GitHub (github.com/settings/developers)." }, { status: 400 });
      const scope = new URL(url).searchParams.get("scope") ?? "";
      const r = await fetch(core.OAUTH.github.deviceUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_id: cid, scope }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.device_code) return Response.json({ ok: false, message: "GitHub a refusé la demande de device code (" + (j.error || r.status) + ")." }, { status: 502 });
      const st = coreJSONState();
      st.githubFlow = { device_code: j.device_code, interval: Number(j.interval) || 5, expiresAt: Date.now() + (Number(j.expires_in) || 900) * 1000 };
      saveJSONState(st);
      return Response.json({ ok: true, user_code: j.user_code, verification_uri: j.verification_uri }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "POST" && url.pathname === "/api/oauth/github/poll") {
      const cfg = core.loadConfig();
      const st = coreJSONState();
      const f = st.githubFlow;
      if (!f) return Response.json({ state: "idle" }, { headers: { "cache-control": "no-store" } });
      if (Date.now() > f.expiresAt) { delete st.githubFlow; saveJSONState(st); return Response.json({ state: "expired" }, { headers: { "cache-control": "no-store" } }); }
      const cid = String(cfg?.vault?.["github-client-id"]?.apiKey ?? cfg?.["github-client-id"] ?? "").trim();
      const r = await fetch(core.OAUTH.github.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_id: cid, device_code: f.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (j.error === "authorization_pending" || j.error === "slow_down") return Response.json({ state: "pending" }, { headers: { "cache-control": "no-store" } });
      if (j.error) return Response.json({ state: "error", message: j.error_description || j.error }, { headers: { "cache-control": "no-store" } });
      if (!j.access_token) return Response.json({ state: "error", message: "réponse inattendue de GitHub" }, { headers: { "cache-control": "no-store" } });
      delete st.githubFlow; saveJSONState(st);
      const sv = await vaultWrite(core.OAUTH.github.tokenVault, j.access_token);
      return Response.json({ state: sv.ok ? "done" : "error", message: sv.message }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "POST" && url.pathname === "/api/oauth/start") {
      const { provider, redirectUri, scope } = await req.json().catch(() => ({}));
      const o = core.OAUTH[provider];
      if (!o || o.kind !== "code") return Response.json({ ok: false, message: "Provider OAuth inconnu." }, { status: 400 });
      const cfg = core.loadConfig();
      const cid = String(cfg?.vault?.[o.clientIdVault]?.apiKey ?? cfg?.[o.clientIdVault] ?? "").trim();
      if (!cid) return Response.json({ ok: false, message: "Enregistre d'abord le Client ID de " + core.PROVIDERS[provider].label + "." }, { status: 400 });
      const state = randomUUID();
      const st = coreJSONState();
      st[state] = { provider, redirectUri, expiresAt: Date.now() + 600000 };
      saveJSONState(st);
      const u = new URL(o.authUrl);
      u.searchParams.set("client_id", cid);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", scope || o.defaultScope);
      if (provider === "google") { u.searchParams.set("access_type", "offline"); u.searchParams.set("prompt", "consent"); }
      else { u.searchParams.set("user_scope", scope || o.defaultScope); }
      return Response.json({ ok: true, url: u.toString() }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "GET" && url.pathname === "/oauth/google/callback") return handleCodeCallback(core.OAUTH.google, url, "google");
    if (req.method === "GET" && url.pathname === "/oauth/slack/callback") return handleCodeCallback(core.OAUTH.slack, url, "slack");
    if (req.method === "POST" && url.pathname === "/api/oauth/disconnect") {
      const { provider } = await req.json().catch(() => ({}));
      const o = core.OAUTH[provider];
      if (!o) return Response.json({ ok: false, message: "Provider inconnu." }, { status: 400 });
      const sv = await vaultWrite(o.tokenVault, "");
      const st = coreJSONState(); delete st[provider]; delete st[provider + "Flow"]; saveJSONState(st);
      return Response.json({ ok: sv.ok, message: sv.ok ? "Déconnecté." : sv.message }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "POST" && url.pathname === "/api/oauth/save") {
      const { slug, value } = await req.json().catch(() => ({}));
      const allowed = ["github-client-id","google-client-id","google-client-secret","slack-client-id","slack-client-secret"];
      if (!allowed.includes(slug)) return Response.json({ ok: false, message: "Slug inconnu." }, { status: 400 });
      return Response.json(await vaultWrite(slug, String(value ?? "").trim()), { headers: { "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
});
