// api-connectors — logique client de la page Connexions (extraite de l'ancienne template
// server.js à l'identique : mêmes ids, mêmes classes, mêmes chemins fetch relatifs).
// Le bundle d'install figée est un module : les handlers onclick inline ont besoin des
// fonctions sur globalThis (exposées en bas de fichier).
let S = [];let errState = null;
function esc(s) {return String(s).replace(/[&<>"']/g, function (m) {return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[m];});}
async function refresh() {
  try {
    const r = await fetch('api/status');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    S = await r.json();errState = null;
    render();
    const b = document.getElementById('banner');if (b) b.remove();
  } catch (e) {
    errState = String(e.message || e);
    const g = document.getElementById('grid');
    g.innerHTML = '<div class="card" style="grid-column:1/-1"><h2>Serveur injoignable</h2><p class="desc">La page ne rejoint pas le serveur de connexions (' + esc(errState) + '). Nouvelle tentative dans 5 s…</p></div>';
  }
}
function render() {
  const g = document.getElementById('grid');g.innerHTML = '';
  for (const p of S) {
    const c = document.createElement('div');c.className = 'card';
    const esc = s => String(s).replace(/[&<>"]/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[m]));
    const last = p.lastCall
      ? esc('Dernier appel : ' + p.lastCall.method + ' ' + p.lastCall.path + ' → HTTP ' + p.lastCall.status + ' (' + p.lastCall.total + ' appels, ' + p.lastCall.errors + ' erreurs)')
      : 'Aucun appel enregistré.';
    c.innerHTML =
      '<h2>' + esc(p.label) + ' <span class="badge ' + (p.keyPresent ? 'on' : 'off') + '">' + (p.keyPresent ? 'Connecté' : 'Non configuré') + '</span></h2>'
      + '<p class="desc">' + esc(p.keyStyle) + '. <a href="' + esc(p.signup) + '" target="_blank" rel="noreferrer">Obtenir une clé ↗</a></p>'
      + '<div class="row"><input type="password" id="in-' + p.id + '" placeholder="Coller la clé…" autocomplete="off">'
      + '<button class="primary" onclick="save(\'' + p.id + '\')">Enregistrer</button>'
      + '<button onclick="testP(\'' + p.id + '\')">Tester</button>'
      + (p.keyPresent ? '<button onclick="removeP(\'' + p.id + '\')">Retirer</button>' : '') + '</div>'
      + '<div class="result" id="res-' + p.id + '"></div>'
      + '<div class="meta">' + last + '</div>';
    g.appendChild(c);
  }
}
// Le serveur de page peut redémarrer pendant l'enregistrement (superviseur) :
// on juge toujours par le statut réel, jamais par la réponse du POST.
async function waitStatus(ms) {await new Promise(r => setTimeout(r, ms));await refresh().catch(() => {});}
async function save(id) {
  const v = document.getElementById('in-' + id).value.trim();
  const el = document.getElementById('res-' + id);
  if (!v) {el.className = 'result bad';el.textContent = "Colle d'abord une clé.";return}
  el.className = 'result';el.textContent = 'Enregistrement…';
  fetch('api/save', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({provider: id, value: v})}).catch(() => {});
  document.getElementById('in-' + id).value = '';
  await waitStatus(5000);await waitStatus(4000);
  const p = S.find(x => x.id === id);
  el.className = 'result ' + ((p && p.keyPresent) ? 'ok' : 'bad');
  el.textContent = (p && p.keyPresent) ? 'Clé enregistrée dans le coffre (persistante).' : 'Enregistrement non confirmé — réessaie.';
}
async function removeP(id) {
  const el = document.getElementById('res-' + id);
  el.className = 'result';el.textContent = 'Retrait…';
  fetch('api/save', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({provider: id, value: ''})}).catch(() => {});
  await waitStatus(5000);await waitStatus(4000);
  const p = S.find(x => x.id === id);
  el.className = 'result ' + ((p && !p.keyPresent) ? 'ok' : 'bad');
  el.textContent = (p && !p.keyPresent) ? 'Clé retirée du coffre.' : 'Retrait non confirmé — réessaie.';
}
async function testP(id) {
  const el = document.getElementById('res-' + id);
  el.className = 'result';el.textContent = 'Test en cours…';
  const r = await fetch('api/test', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({provider: id})});
  const j = await r.json();el.className = 'result ' + (j.ok ? 'ok' : 'bad');el.textContent = j.message;
}
async function loadSettings() {
  try {
    const s = await (await fetch('api/settings')).json();
    document.getElementById('st-enabled').checked = !!s.enabled;
    document.getElementById('st-log').checked = !!s.log_calls;
    document.getElementById('st-timeout').value = s.timeout_ms;
  } catch (e) {}
}
async function saveSettings() {
  const el = document.getElementById('st-res');
  el.className = 'result';el.textContent = 'Enregistrement…';
  fetch('api/settings', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
    enabled: document.getElementById('st-enabled').checked ? 'true' : 'false',
    log_calls: document.getElementById('st-log').checked ? 'true' : 'false',
    timeout_ms: document.getElementById('st-timeout').value
  })}).catch(() => {});
  let s = null;
  for (let i = 0;i < 4;i++) {await new Promise(r => setTimeout(r, 4000));try {s = await (await fetch('api/settings')).json();break}catch (e) {}}
  if (!s) {el.className = 'result bad';el.textContent = 'Vérification impossible — réessaie.';return}
  document.getElementById('st-enabled').checked = !!s.enabled;
  document.getElementById('st-log').checked = !!s.log_calls;
  document.getElementById('st-timeout').value = s.timeout_ms;
  el.className = 'result ok';el.textContent = 'Réglages enregistrés.';
}

async function oauthSave(slug, value) {
  const r = await fetch('api/oauth/save', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({slug, value})}).catch(() => null);
  return r && r.ok ? (await r.json()) : {ok: false, message: 'Serveur injoignable — réessaie.'};
}
async function oauthSaveCreds(fieldId, slug) {
  const v = document.getElementById(fieldId).value.trim();
  const j = await oauthSave(slug, v);
  return j;
}
async function oauthSaveCreds2(f1, s1, f2, s2) {
  const a = await oauthSaveCreds(f1, s1);const b = await oauthSaveCreds(f2, s2);
  return a.ok && b.ok;
}
function copyField(id) {
  const el = document.getElementById(id);el.select();
  try {navigator.clipboard.writeText(el.value);} catch (e) {document.execCommand('copy');}
}
function redirectUri(provider) {
  return window.location.origin + '/api/pages/api-connectors/oauth/' + provider + '/callback';
}
function initRedirects() {
  const go = document.getElementById('go-redirect');if (go) go.value = redirectUri('google');
  const sl = document.getElementById('sl-redirect');if (sl) sl.value = redirectUri('slack');
}
async function githubDevice() {
  const el = document.getElementById('gh-oauth-res');
  el.className = 'result';el.textContent = 'Demande à GitHub…';
  const r = await fetch('api/oauth/github/start', {method: 'POST'}).catch(() => null);
  const j = r && r.ok ? await r.json() : {ok: false, message: 'Serveur injoignable — réessaie.'};
  if (!j.ok) {el.className = 'result bad';el.textContent = j.message;return}
  el.className = 'result ok';el.textContent = 'Code affiché ci-dessous — termine chez GitHub.';
  document.getElementById('gh-device').style.display = 'block';
  document.getElementById('gh-usercode').textContent = j.user_code;
  window.open(j.verification_uri, '_blank');
  pollGithub();
}
let ghPolling = false;
async function pollGithub() {
  if (ghPolling)return;ghPolling = true;
  const el = document.getElementById('gh-oauth-res');
  for (let i = 0;i < 80;i++) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await fetch('api/oauth/github/poll', {method: 'POST'}).catch(() => null);
    if (!r || !r.ok)continue;
    const j = await r.json();
    if (j.state === 'pending')continue;
    if (j.state === 'done') {el.className = 'result ok';el.textContent = 'GitHub connecté par OAuth.';document.getElementById('gh-device').style.display = 'none';ghPolling = false;refresh().catch(() => {});return}
    if (j.state === 'pending' || j.state === 'idle')continue;
    el.className = 'result bad';el.textContent = 'Échec : ' + (j.message || j.state);ghPolling = false;return;
  }
  el.className = 'result bad';el.textContent = 'Délai dépassé — recommence.';ghPolling = false;
}
async function oauthConnect(provider) {
  const el = document.getElementById(provider === 'google' ? 'go-oauth-res' : 'sl-oauth-res');
  el.className = 'result';el.textContent = 'Préparation du consentement…';
  const scope = document.getElementById(provider === 'google' ? 'go-scope' : 'sl-scope').value.trim();
  const r = await fetch('api/oauth/start', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({provider, redirectUri: redirectUri(provider), scope})}).catch(() => null);
  const j = r && r.ok ? await r.json() : {ok: false, message: 'Serveur injoignable — réessaie.'};
  if (!j.ok) {el.className = 'result bad';el.textContent = j.message;return}
  window.location.href = j.url;
}
async function oauthDisconnect(provider) {
  const el = document.getElementById(provider === 'google' ? 'go-oauth-res' : 'sl-oauth-res');
  el.className = 'result';el.textContent = 'Déconnexion…';
  await fetch('api/oauth/disconnect', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({provider})}).catch(() => {});
  await waitStatus(4000);
  el.className = 'result ok';el.textContent = 'Déconnecté.';
}
refresh().catch(() => {});loadSettings().catch(() => {});initRedirects();setInterval(function () {refresh();}, 30000);setInterval(function () {refresh().catch(function () {});}, 5000);setInterval(function () {if (errState) refresh();}, 5000);
Object.assign(globalThis, { refresh, render, save, removeP, testP, loadSettings, saveSettings, oauthSave, oauthSaveCreds, oauthSaveCreds2, copyField, redirectUri, initRedirects, githubDevice, pollGithub, oauthConnect, oauthDisconnect, esc, waitStatus });
