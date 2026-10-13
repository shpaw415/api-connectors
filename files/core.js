// api-connectors — noyau partagé (page dashboard + outils CLI)
// Charge la config du plugin, résout les clés du coffre, exécute les appels API.
// Règle absolue : aucune clé ne sort jamais d'ici (URL et sorties masquées).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const PLUGIN_ID = "api-connectors";
export const CONFIG_PATH = path.join(homedir(), ".config", "open-bot", `plugin-${PLUGIN_ID}.json`);
export const STATE_DIR = path.join(homedir(), ".open-bot", PLUGIN_ID);
export const STATE_PATH = path.join(STATE_DIR, "state.json");

export const PROVIDERS = {
  github: {
    label: "GitHub",
    vault: "github-token",
    hosts: ["api.github.com"],
    keyStyle: "Token d'accès personnel (classic ou fine-grained)",
    signup: "https://github.com/settings/tokens",
    buildHeaders: (key) => ({
      Authorization: `Bearer ${key}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }),
    test: { method: "GET", path: "/rate_limit" },
  },
  google: {
    label: "Google",
    vault: "google-api-key",
    hosts: [
      "www.googleapis.com",
      "maps.googleapis.com",
      "youtube.googleapis.com",
      "translation.googleapis.com",
      "language.googleapis.com",
    ],
    keyStyle: "Clé API simple (injectée en ?key=…) — OAuth complet prévu en v2",
    signup: "https://console.cloud.google.com/apis/credentials",
    test: { method: "GET", path: "https://www.googleapis.com/youtube/v3/i18nLanguages?part=snippet" },
  },
  slack: {
    label: "Slack",
    vault: "slack-bot-token",
    hosts: ["slack.com"],
    keyStyle: "Bot token xoxb-… (scopes selon les méthodes utilisées)",
    signup: "https://api.slack.com/apps",
    buildHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    test: { method: "POST", path: "/api/auth.test" },
  },
};

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Les réglages vivent dans cfg.settings, les clés du coffre dans cfg.vault.
// (lecture tolérante à la racine pour les configs plus anciennes)
export function setting(key, cfg = loadConfig()) {
  return cfg?.settings?.[key] ?? cfg?.[key];
}

export function vaultValue(slug, cfg = loadConfig()) {
  const raw = cfg?.vault?.[slug] ?? cfg?.[slug] ?? "";
  return (typeof raw === "string" ? raw : String(raw?.apiKey ?? "")).trim();
}

export function keyFor(pid, cfg = loadConfig()) {
  const p = PROVIDERS[pid];
  if (!p) return "";
  // Format ob-plugin vault : { apiKey, accountId, baseUrl } ; tolérer l'ancienne string.
  const raw = cfg?.vault?.[p.vault] ?? cfg?.[p.vault] ?? "";
  const key = typeof raw === "string" ? raw : String(raw?.apiKey ?? "");
  return key.trim();
}

function noKeyMsg(p) {
  return `Aucune clé « ${p.vault} » configurée pour ${p.label}. Colle-la sur la page Connexions (Dashboards → Connexions) ou sur la page Config du plugin.`;
}

// Masque toute valeur de clé dans une URL avant affichage/journalisation.
export function redactUrl(u) {
  const out = new URL(u);
  for (const k of [...out.searchParams.keys()]) {
    if (/key|token|secret|access/i.test(k)) out.searchParams.set(k, "•••");
  }
  return out.toString();
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { providers: {} };
  }
}

function record(pid, method, pth, status, durationMs, err) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const st = loadState();
    const e = (st.providers[pid] ??= { total: 0, errors: 0 });
    e.total++;
    if (status === 0 || status >= 400) e.errors++;
    e.lastAt = new Date().toISOString();
    e.lastMethod = method;
    e.lastPath = pth;
    e.lastStatus = status;
    if (err) e.lastError = String(err).slice(0, 200);
    else delete e.lastError;
    writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
  } catch {
    /* l'état ne doit jamais faire échouer un appel */
  }
}

// État OAuth d'un provider : connecté via token OAuth (prioritaire) ou clé collée.
function oauthStatus(pid, cfg = loadConfig()) {
  const o = OAUTH[pid];
  if (!o) return null;
  const st = loadOauthState()[pid] ?? {};
  const hasOauth = Boolean(vaultValue(o.tokenVault, cfg));
  const hasKey = Boolean(keyFor(pid, cfg));
  return {
    connected: hasOauth || hasKey,
    mode: hasOauth ? "oauth" : (hasKey ? "key" : "none"),
    expiresAt: st.expiresAt ?? null,
    error: st.error ?? null,
  };
}

export function statusSummary(cfg = loadConfig()) {
  const st = loadState();
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const key = keyFor(id, cfg);
    const s = st.providers[id] ?? {};
    return {
      id,
      label: p.label,
      keyPresent: key.length > 0,
      keyStyle: p.keyStyle,
      signup: p.signup,
      oauth: oauthStatus(id, cfg),
      lastCall: s.lastAt
        ? { at: s.lastAt, method: s.lastMethod, path: s.lastPath, status: s.lastStatus, total: s.total, errors: s.errors, lastError: s.lastError ?? null }
        : null,
    };
  });
}


// ===== OAuth v0.2 =====
// Device flow pour GitHub ; authorization code pour Google et Slack (callback via le
// proxy dashboard). Refresh Google à la volée. Fallback : clé collée manuellement.
export const OAUTH = {
  github: {
    kind: "device",
    clientIdVault: "github-client-id",
    tokenVault: "github-oauth-token",
    deviceUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
  },
  google: {
    kind: "code",
    clientIdVault: "google-client-id",
    clientSecretVault: "google-client-secret",
    tokenVault: "google-refresh-token",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScope: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/drive.readonly",
    callbackPath: "/oauth/google/callback",
  },
  slack: {
    kind: "code",
    clientIdVault: "slack-client-id",
    clientSecretVault: "slack-client-secret",
    tokenVault: "slack-oauth-token",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    defaultScope: "chat:write,channels:read,im:history",
    callbackPath: "/oauth/slack/callback",
  },
};

export const OAUTH_STATE_PATH = path.join(STATE_DIR, "oauth.json");

function loadOauthState() {
  try { return JSON.parse(readFileSync(OAUTH_STATE_PATH, "utf8")); } catch { return {}; }
}
function saveOauthState(st) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(OAUTH_STATE_PATH, JSON.stringify(st, null, 2));
  } catch { /* jamais fatal */ }
}

// L'access token Google vit dans l'état local (éphémère) ; le refresh token au coffre.
async function googleAccessToken(cfg) {
  const st = loadOauthState();
  const g = st.google ?? {};
  if (g.access_token && g.expiresAt && Date.now() < g.expiresAt - 60000) return { token: g.access_token };
  const refresh = vaultValue(OAUTH.google.tokenVault, cfg);
  if (!refresh) return { error: "Google OAuth connecté mais refresh token absent — reconnecte-le sur la page Connexions." };
  let res;
  try {
    res = await fetch(OAUTH.google.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: vaultValue(OAUTH.google.clientIdVault, cfg),
        client_secret: vaultValue(OAUTH.google.clientSecretVault, cfg),
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { error: "Refresh Google impossible (" + (e?.cause?.code || e?.name || "réseau") + ")." };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const st2 = loadOauthState();
    st2.google = { ...(st2.google ?? {}), error: data.error || ("HTTP " + res.status) };
    saveOauthState(st2);
    return { error: "Refresh Google refusé (" + (data.error || res.status) + ") — reconnecte-le sur la page Connexions." };
  }
  const st3 = loadOauthState();
  st3.google = { ...(st3.google ?? {}), access_token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000, error: null };
  saveOauthState(st3);
  return { token: data.access_token };
}

// Résout les identifiants effectifs d'un provider pour un appel.
// Renvoie { kind: "oauth"|"key", token?, key?, error? }.
export async function credsFor(pid, cfg = loadConfig()) {
  const p = PROVIDERS[pid];
  if (!p) return { error: "provider inconnu" };
  if (pid === "github") {
    const t = vaultValue(OAUTH.github.tokenVault, cfg);
    if (t) return { kind: "oauth", token: t };
    const k = keyFor(pid, cfg);
    return k ? { kind: "key", token: k } : { kind: "none" };
  }
  if (pid === "google") {
    const r = vaultValue(OAUTH.google.tokenVault, cfg); // refresh token
    const st = loadOauthState();
    if (r && !(st.google?.error && !st.google?.access_token)) {
      const t = await googleAccessToken(cfg);
      if (t.token) return { kind: "oauth", token: t.token };
      return { error: t.error };
    }
    if (r) return { error: "Google OAuth doit être reconnecté sur la page Connexions (refresh expiré)." };
    const k = keyFor(pid, cfg);
    return k ? { kind: "key", key: k } : { kind: "none" };
  }
  if (pid === "slack") {
    const t = vaultValue(OAUTH.slack.tokenVault, cfg);
    if (t) return { kind: "oauth", token: t };
    const k = keyFor(pid, cfg);
    return k ? { kind: "key", token: k } : { kind: "none" };
  }
  return { kind: "none" };
}

// Appel API unifié. Ne lève jamais : renvoie { error } ou { ok, status, body, … }.
export async function apiCall(pid, opts = {}, cfg = loadConfig()) {
  const p = PROVIDERS[pid];
  if (!p) {
    return { error: `Provider « ${pid} » inconnu. Providers disponibles : ${Object.keys(PROVIDERS).join(", ")}.` };
  }
  const method = String(opts.method ?? "GET").toUpperCase();
  if (!/^[A-Z]+$/.test(method)) return { error: "Méthode HTTP invalide." };

  let url;
  const rawPath = String(opts.path ?? "");
  try {
    if (/^https:\/\//i.test(rawPath)) {
      url = new URL(rawPath);
      if (!p.hosts.includes(url.hostname)) {
        return { error: `Hôte « ${url.hostname} » non autorisé pour ${p.label} (autorisés : ${p.hosts.join(", ")}).` };
      }
    } else {
      if (!rawPath.startsWith("/")) return { error: "Le path doit commencer par « / » (ou être une URL https complète chez le provider)." };
      url = new URL(`https://${p.hosts[0]}${rawPath}`);
    }
  } catch {
    return { error: "URL invalide." };
  }
  for (const q of opts.query ?? []) {
    const i = q.indexOf("=");
    if (i > 0) url.searchParams.set(q.slice(0, i), q.slice(i + 1));
  }

  const creds = await credsFor(pid, cfg);
  if (creds.error) return { error: creds.error, needsOAuth: true };
  if (creds.kind === "none") return { error: noKeyMsg(p), needsKey: p.vault };

  const headers = {
    "User-Agent": String(setting("user_agent", cfg) || "open-bot-api-connectors/0.1"),
    Accept: "application/json",
  };
  for (const h of opts.headers ?? []) {
    const i = h.indexOf(":");
    if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  if (p.buildHeaders) Object.assign(headers, p.buildHeaders(creds.token));
  else if (creds.kind === "oauth") headers.Authorization = "Bearer " + creds.token;
  else if (!url.searchParams.has("key")) url.searchParams.set("key", creds.key);
  if (creds.kind === "oauth") out_oauth_mode = true;

  let body;
  if (opts.data != null && method !== "GET" && method !== "HEAD") {
    body = typeof opts.data === "string" ? opts.data : JSON.stringify(opts.data);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }

  let out_oauth_mode = false;
  const timeoutMs = Math.min(Math.max(Number(setting("timeout_ms", cfg)) || 20000, 1000), 120000);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e?.cause?.code || e?.name || "erreur réseau";
    record(pid, method, url.pathname, 0, Date.now() - t0, why);
    return { error: `Appel échoué (${why}) — réseau ou timeout après ${timeoutMs} ms.` };
  }

  const text = await res.text();
  const dur = Date.now() - t0;
  record(pid, method, url.pathname, res.status, dur);

  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* texte brut */
  }
  if (typeof parsed === "string" && parsed.length > 200000) parsed = parsed.slice(0, 200000) + "…[tronqué]";

  const out = {
    ok: res.ok,
    mode: out_oauth_mode ? "oauth" : "key",
    durationMs: dur,
    provider: pid,
    url: redactUrl(url),
    body: parsed,
  };
  if (res.status === 429) out.retryAfter = res.headers.get("retry-after");
  if (res.status === 401) out.hint = "Clé refusée (401) : remplace-la sur la page Connexions.";
  return out;
}

// Appel de test par provider, avec message humain clair.
export async function testProvider(pid, cfg = loadConfig()) {
  const p = PROVIDERS[pid];
  if (!p) return { ok: false, message: `Provider « ${pid} » inconnu.` };
  if (!keyFor(pid, cfg)) return { ok: false, message: noKeyMsg(p) };
  const r = await apiCall(pid, { method: p.test.method, path: p.test.path }, cfg);
  if (r.error) return { ok: false, message: r.error };
  // Slack répond HTTP 200 même sur une clé invalide : body.ok fait foi.
  if (pid === "slack" && r.body && r.body.ok === false) {
    return { ok: false, status: r.status, message: `Slack a refusé la clé (${r.body.error}). Remplace-la sur la page Connexions.` };
  }
  if (r.ok) {
    let extra = "";
    if (pid === "slack" && r.body?.ok) extra = ` — connecté en tant que ${r.body.user} (équipe ${r.body.team})`;
    return { ok: true, message: `${p.label} répond (HTTP ${r.status})${extra}.` };
  }
  let msg = `${p.label} a refusé la clé (HTTP ${r.status}).`;
  if (pid === "google" && r.body?.error?.message) msg += ` Détail : ${r.body.error.message}`;
  if (pid === "slack" && r.body?.error) msg += ` Détail : ${r.body.error}`;
  if (r.hint) msg += ` ${r.hint}`;
  return { ok: false, status: r.status, message: msg };
}
