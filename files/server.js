// api-connectors — serveur de la page dashboard « Connexions »
// Lancé par le control plane avec Bun. Env : OPEN_BOT_PAGE_PORT, OPEN_BOT_PAGE_TOKEN, OPEN_BOT_PLUGIN_ID.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as core from "./ob-plugin-api-connectors-core.js";

const PORT = Number(process.env.OPEN_BOT_PAGE_PORT ?? 4740);
const PAGE_TOKEN = process.env.OPEN_BOT_PAGE_TOKEN ?? "";

function authorized(req) {
  if (!PAGE_TOKEN) return true;
  return req.headers.get("x-open-bot-page-token") === PAGE_TOKEN;
}

// Enregistre ou vide une clé du coffre via `ob-plugin vault` (write-only, persistant
// côté control plane : survit aux réactivations et réinstallations).
function saveKey(slug, value) {
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
function setSetting(key, value) {
  const allowed = { enabled: ["true", "false"], log_calls: ["true", "false"], timeout_ms: null };
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
function saveJSONState(st) {
  try {
    mkdirSync(core.STATE_DIR, { recursive: true });
    writeFileSync(core.OAUTH_STATE_PATH, JSON.stringify(st, null, 2));
  } catch { /* jamais fatal */ }
}
function vaultWrite(slug, value) {
  return new Promise((resolve) => {
    const child = spawn("ob-plugin", ["vault", core.PLUGIN_ID, `${slug}=${value}`], { timeout: 30000 });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ ok: code === 0, message: code === 0 ? "ok" : (out.trim().slice(0, 160) || `code ${code}`) }));
    child.on("error", (e) => resolve({ ok: false, message: String(e).slice(0, 120) }));
  });
}
function cbPage(msg, ok) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f1117;color:#e6e8ef;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:20px">' + (ok ? "Connexion réussie" : "Connexion échouée") + '</h1><p style="color:#8b90a0">' + msg + '</p><p><a style="color:#7c93f5" href="/">Retour à Connexions</a></p></div>',
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
async function handleCodeCallback(o, url, provider) {
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

const HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connexions API</title>
<style>
:root{color-scheme:dark;--bg:#06080e;--text:#e7eaf3;--muted:#9aa3bb;--faint:#6d7590;--line:rgba(255,255,255,.08);--accent:#6b79f2;--accent-soft:#8b96ff;--green:#7ce3a8;--red:#ff8a9a}
*{box-sizing:border-box}
body{margin:0;font:14px/1.65 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);padding:60px 24px 72px;min-height:100vh;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin:0 0 6px}
.eyebrow{font-size:11.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);margin:0 0 10px}
h1{font-size:24px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em;font-weight:550}
.sub{color:var(--muted);margin:0;font-size:13px;max-width:64ch;font-weight:400}
code{background:rgba(255,255,255,.06);padding:1px 6px;border-radius:6px;font-size:12px;color:#c6cded;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.grid{display:grid;grid-template-columns:1fr;gap:0;margin-top:16px}
.card{background:none;border:none;border-top:1px solid var(--line);border-radius:0;padding:26px 0 24px;box-shadow:none}
.card:last-child{border-bottom:1px solid var(--line)}
.card h2{margin:0;font-size:15px;line-height:1.4;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:550;letter-spacing:-.005em}
.badge{font-size:12px;font-weight:500;letter-spacing:0;display:inline-flex;align-items:center;gap:7px;padding:0;border:none;background:none;white-space:nowrap}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;flex:none}
.badge.on{background:none;color:var(--green);border:none}
.badge.off{background:none;color:var(--faint);border:none}
.desc{color:var(--muted);font-size:13px;margin:8px 0 14px;font-weight:400}
.desc a{color:var(--faint);text-decoration:underline;text-underline-offset:3px;text-decoration-color:rgba(255,255,255,.22);font-weight:400}
.desc a:hover{color:var(--text);text-decoration-color:rgba(255,255,255,.45)}
.row{display:flex;gap:8px;align-items:center}
input{flex:1;min-width:0;background:transparent;border:1px solid rgba(255,255,255,.13);border-radius:9px;padding:9px 11px;color:var(--text);font-size:13px}
input::placeholder{color:var(--faint)}
input:focus{outline:none;border-color:var(--accent-soft)}
button{background:transparent;color:#c9d0e6;border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:9px 13px;font-size:13px;cursor:pointer;font-weight:500;white-space:nowrap}
button:hover{border-color:rgba(255,255,255,.28);color:var(--text)}
button.primary{background:var(--accent);border-color:transparent;color:#fff;box-shadow:none}
button.primary:hover{filter:brightness(1.1);color:#fff}
.result{margin-top:10px;font-size:12.5px;min-height:18px;white-space:pre-wrap;line-height:1.5;color:var(--muted)}
.result.ok{color:var(--green)}
.result.bad{color:var(--red)}
.ok{color:var(--green)}
.bad{color:var(--red)}
.meta{margin-top:8px;font-size:12px;color:var(--faint)}
.settings{margin-top:36px;border-top:1px solid var(--line);padding-top:26px}
.settings h2{font-size:15px;font-weight:550;margin:0 0 4px}
.settings-grid{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;margin-top:14px}
.check{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);cursor:pointer;background:none;border:none;padding:0}
.check input{width:auto;accent-color:var(--accent);margin:0;flex:none}
.field{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.field input{width:90px;flex:none}
.top-actions{flex:none;display:flex;gap:10px}
a{color:var(--accent-soft)}
@media (max-width:680px){body{padding:32px 18px 48px}h1{font-size:21px}.top{flex-direction:column}.top-actions{width:100%}.top-actions button{width:100%}.row{flex-wrap:wrap}.row input{flex:1 1 100%}.row button{flex:1}}
</style></head><body>
<div class="wrap">
<div class="top"><div><div class="eyebrow">Plugin api-connectors</div><h1>Connexions API</h1>
<p class="sub">Clés dans le coffre d’open-bot, utilisées via <code>ob-plugin-api-connectors-call</code> — persistantes après mise à jour.</p></div>
<div class="top-actions"><button onclick="refresh()">Actualiser</button></div></div>
<div class="grid" id="grid"></div>
<div class="settings" id="settings">
<h2>Réglages</h2>
<div class="row settings-grid">
<label class="check"><input type="checkbox" id="st-enabled"> Plugin actif</label>
<label class="check"><input type="checkbox" id="st-log"> Journaliser les appels</label>
<label class="field">Timeout (ms) <input type="number" id="st-timeout" min="1000" max="120000"></label>
<button class="primary" onclick="saveSettings()">Enregistrer les réglages</button>
<span class="result" id="st-res"></span>
</div>
</div>
</div>
<div class="card" style="max-width:1100px;margin-top:16px">
<h2>Connexion OAuth (bêta)</h2>
<p class="desc">Alternative à la clé collée : le plugin obtient et rafraîchit les tokens lui-même. Le token OAuth a priorité sur la clé.</p>

<div class="oauth-block"><b>GitHub — device flow</b>
<div class="row" style="margin-top:8px;flex-wrap:wrap">
<input id="gh-cid" placeholder="Client ID de ton OAuth App GitHub" autocomplete="off">
<button onclick="oauthSaveCreds('gh-cid','github-client-id')">Enregistrer</button>
<button class="primary" onclick="githubDevice()">Connecter avec GitHub</button>
</div>
<div class="result" id="gh-oauth-res"></div>
<div id="gh-device" style="display:none;margin-top:8px" class="desc">Va sur <a href="https://github.com/login/device" target="_blank" rel="noreferrer">github.com/login/device</a> et entre : <b id="gh-usercode" style="font-size:16px;letter-spacing:2px"></b> — en attente…</div>
</div>

<div class="oauth-block" style="margin-top:14px"><b>Google — authorization code</b>
<div class="row" style="margin-top:8px;flex-wrap:wrap">
<input id="go-cid" placeholder="Client ID Google" autocomplete="off">
<input id="go-secret" type="password" placeholder="Client Secret" autocomplete="off">
<button onclick="oauthSaveCreds2('go-cid','google-client-id','go-secret','google-client-secret')">Enregistrer</button>
</div>
<div class="row" style="margin-top:8px;flex-wrap:wrap;align-items:center">
<span class="desc" style="margin:0">Redirect URI à enregistrer dans Google Cloud :</span>
<input id="go-redirect" readonly style="max-width:420px">
<button onclick="copyField('go-redirect')">Copier</button>
<input id="go-scope" placeholder="scopes (défaut: youtube+drive readonly)">
<button class="primary" onclick="oauthConnect('google')">Connecter avec Google</button>
<button onclick="oauthDisconnect('google')">Déconnecter</button>
</div>
<div class="result" id="go-oauth-res"></div>
</div>

<div class="oauth-block" style="margin-top:14px"><b>Slack — authorization code</b>
<div class="row" style="margin-top:8px;flex-wrap:wrap">
<input id="sl-cid" placeholder="Client ID Slack" autocomplete="off">
<input id="sl-secret" type="password" placeholder="Client Secret" autocomplete="off">
<button onclick="oauthSaveCreds2('sl-cid','slack-client-id','sl-secret','slack-client-secret')">Enregistrer</button>
</div>
<div class="row" style="margin-top:8px;flex-wrap:wrap;align-items:center">
<span class="desc" style="margin:0">Redirect URI à enregistrer dans ton app Slack :</span>
<input id="sl-redirect" readonly style="max-width:420px">
<button onclick="copyField('sl-redirect')">Copier</button>
<input id="sl-scope" placeholder="scopes bot (défaut: chat:write,channels:read,im:history)">
<button class="primary" onclick="oauthConnect('slack')">Connecter avec Slack</button>
<button onclick="oauthDisconnect('slack')">Déconnecter</button>
</div>
<div class="result" id="sl-oauth-res"></div>
</div>
</div>
<script>let S=[];let errState=null;
function esc(s){return String(s).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];});}
async function refresh(){
  try{
    const r=await fetch('api/status');
    if(!r.ok) throw new Error('HTTP '+r.status);
    S=await r.json();errState=null;
    render();
    const b=document.getElementById('banner');if(b)b.remove();
  }catch(e){
    errState=String(e.message||e);
    const g=document.getElementById('grid');
    g.innerHTML='<div class="card" style="grid-column:1/-1"><h2>Serveur injoignable</h2><p class="desc">La page ne rejoint pas le serveur de connexions ('+esc(errState)+'). Nouvelle tentative dans 5 s…</p></div>';
  }
}
function render(){
  const g=document.getElementById('grid');g.innerHTML='';
  for(const p of S){
    const c=document.createElement('div');c.className='card';
    const esc=s=>String(s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
    const last=p.lastCall
      ? esc('Dernier appel : '+p.lastCall.method+' '+p.lastCall.path+' → HTTP '+p.lastCall.status+' ('+p.lastCall.total+' appels, '+p.lastCall.errors+' erreurs)')
      : 'Aucun appel enregistré.';
    c.innerHTML =
      '<h2>'+esc(p.label)+' <span class="badge '+(p.keyPresent?'on':'off')+'">'+(p.keyPresent?'Connecté':'Non configuré')+'</span></h2>'
      +'<p class="desc">'+esc(p.keyStyle)+'. <a href="'+esc(p.signup)+'" target="_blank" rel="noreferrer">Obtenir une clé ↗</a></p>'
      +'<div class="row"><input type="password" id="in-'+p.id+'" placeholder="Coller la clé…" autocomplete="off">'
      +'<button class="primary" onclick="save(\\''+p.id+'\\')">Enregistrer</button>'
      +'<button onclick="testP(\\''+p.id+'\\')">Tester</button>'
      +(p.keyPresent?'<button onclick="removeP(\\''+p.id+'\\')">Retirer</button>':'')+'</div>'
      +'<div class="result" id="res-'+p.id+'"></div>'
      +'<div class="meta">'+last+'</div>';
    g.appendChild(c);
  }
}
// Le serveur de page peut redémarrer pendant l'enregistrement (superviseur) :
// on juge toujours par le statut réel, jamais par la réponse du POST.
async function waitStatus(ms){await new Promise(r=>setTimeout(r,ms));await refresh().catch(()=>{});}
async function save(id){
  const v=document.getElementById('in-'+id).value.trim();
  const el=document.getElementById('res-'+id);
  if(!v){el.className='result bad';el.textContent="Colle d'abord une clé.";return}
  el.className='result';el.textContent='Enregistrement…';
  fetch('api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:id,value:v})}).catch(()=>{});
  document.getElementById('in-'+id).value='';
  await waitStatus(5000);await waitStatus(4000);
  const p=S.find(x=>x.id===id);
  el.className='result '+((p&&p.keyPresent)?'ok':'bad');
  el.textContent=(p&&p.keyPresent)?'Clé enregistrée dans le coffre (persistante).':'Enregistrement non confirmé — réessaie.';
}
async function removeP(id){
  const el=document.getElementById('res-'+id);
  el.className='result';el.textContent='Retrait…';
  fetch('api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:id,value:''})}).catch(()=>{});
  await waitStatus(5000);await waitStatus(4000);
  const p=S.find(x=>x.id===id);
  el.className='result '+((p&&!p.keyPresent)?'ok':'bad');
  el.textContent=(p&&!p.keyPresent)?'Clé retirée du coffre.':'Retrait non confirmé — réessaie.';
}
async function testP(id){
  const el=document.getElementById('res-'+id);
  el.className='result';el.textContent='Test en cours…';
  const r=await fetch('api/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:id})});
  const j=await r.json();el.className='result '+(j.ok?'ok':'bad');el.textContent=j.message;
}
async function loadSettings(){
  try{
    const s=await (await fetch('api/settings')).json();
    document.getElementById('st-enabled').checked=!!s.enabled;
    document.getElementById('st-log').checked=!!s.log_calls;
    document.getElementById('st-timeout').value=s.timeout_ms;
  }catch(e){}
}
async function saveSettings(){
  const el=document.getElementById('st-res');
  el.className='result';el.textContent='Enregistrement…';
  fetch('api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    enabled:document.getElementById('st-enabled').checked?'true':'false',
    log_calls:document.getElementById('st-log').checked?'true':'false',
    timeout_ms:document.getElementById('st-timeout').value
  })}).catch(()=>{});
  let s=null;
  for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,4000));try{s=await (await fetch('api/settings')).json();break}catch(e){}}
  if(!s){el.className='result bad';el.textContent='Vérification impossible — réessaie.';return}
  document.getElementById('st-enabled').checked=!!s.enabled;
  document.getElementById('st-log').checked=!!s.log_calls;
  document.getElementById('st-timeout').value=s.timeout_ms;
  el.className='result ok';el.textContent='Réglages enregistrés.';
}

async function oauthSave(slug, value){
  const r=await fetch('api/oauth/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug,value})}).catch(()=>null);
  return r&&r.ok?(await r.json()):{ok:false,message:'Serveur injoignable — réessaie.'};
}
async function oauthSaveCreds(fieldId,slug){
  const v=document.getElementById(fieldId).value.trim();
  const j=await oauthSave(slug,v);
  return j;
}
async function oauthSaveCreds2(f1,s1,f2,s2){
  const a=await oauthSaveCreds(f1,s1);const b=await oauthSaveCreds(f2,s2);
  return a.ok&&b.ok;
}
function copyField(id){
  const el=document.getElementById(id);el.select();
  try{navigator.clipboard.writeText(el.value);}catch(e){document.execCommand('copy');}
}
function redirectUri(provider){
  return window.location.origin+'/api/pages/api-connectors/oauth/'+provider+'/callback';
}
function initRedirects(){
  const go=document.getElementById('go-redirect');if(go)go.value=redirectUri('google');
  const sl=document.getElementById('sl-redirect');if(sl)sl.value=redirectUri('slack');
}
async function githubDevice(){
  const el=document.getElementById('gh-oauth-res');
  el.className='result';el.textContent='Demande à GitHub…';
  const r=await fetch('api/oauth/github/start',{method:'POST'}).catch(()=>null);
  const j=r&&r.ok?await r.json():{ok:false,message:'Serveur injoignable — réessaie.'};
  if(!j.ok){el.className='result bad';el.textContent=j.message;return}
  el.className='result ok';el.textContent='Code affiché ci-dessous — termine chez GitHub.';
  document.getElementById('gh-device').style.display='block';
  document.getElementById('gh-usercode').textContent=j.user_code;
  window.open(j.verification_uri,'_blank');
  pollGithub();
}
let ghPolling=false;
async function pollGithub(){
  if(ghPolling)return;ghPolling=true;
  const el=document.getElementById('gh-oauth-res');
  for(let i=0;i<80;i++){
    await new Promise(r=>setTimeout(r,5000));
    const r=await fetch('api/oauth/github/poll',{method:'POST'}).catch(()=>null);
    if(!r||!r.ok)continue;
    const j=await r.json();
    if(j.state==='pending')continue;
    if(j.state==='done'){el.className='result ok';el.textContent='GitHub connecté par OAuth.';document.getElementById('gh-device').style.display='none';ghPolling=false;refresh().catch(()=>{});return}
    if(j.state==='pending'||j.state==='idle')continue;
    el.className='result bad';el.textContent='Échec : '+(j.message||j.state);ghPolling=false;return;
  }
  el.className='result bad';el.textContent='Délai dépassé — recommence.';ghPolling=false;
}
async function oauthConnect(provider){
  const el=document.getElementById(provider==='google'?'go-oauth-res':'sl-oauth-res');
  el.className='result';el.textContent='Préparation du consentement…';
  const scope=document.getElementById(provider==='google'?'go-scope':'sl-scope').value.trim();
  const r=await fetch('api/oauth/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider,redirectUri:redirectUri(provider),scope})}).catch(()=>null);
  const j=r&&r.ok?await r.json():{ok:false,message:'Serveur injoignable — réessaie.'};
  if(!j.ok){el.className='result bad';el.textContent=j.message;return}
  window.location.href=j.url;
}
async function oauthDisconnect(provider){
  const el=document.getElementById(provider==='google'?'go-oauth-res':'sl-oauth-res');
  el.className='result';el.textContent='Déconnexion…';
  await fetch('api/oauth/disconnect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider})}).catch(()=>{});
  await waitStatus(4000);
  el.className='result ok';el.textContent='Déconnecté.';
}
refresh().catch(()=>{});loadSettings().catch(()=>{});initRedirects();setInterval(function(){refresh();},30000);setInterval(function(){refresh().catch(function(){});},5000);},30000);setInterval(function(){if(errState)refresh();},5000);</script></body></html>`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (!authorized(req)) return new Response("unauthorized", { status: 401 });

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
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
        results.push({ key: k, ok: (await setSetting(k, v)).ok });
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
