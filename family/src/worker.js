// family.vasantpatel.xyz — worker
//
//   GET  /healthz                  "ok" (no login; deploy smoke test)
//   GET  /api/me                   { email }
//   GET  /api/boards/<path>        { version, state, updatedAt, updatedBy }
//   PUT  /api/boards/<path>        { version, state }   (version must match; 409 otherwise)
//   *    everything else           static files from public/, bundled into the worker at deploy time
//   cron                           daily digest email of open move items (needs RESEND_API_KEY)
//
// Every request except /healthz must carry a valid Cloudflare Access JWT. The
// worker verifies it itself (signature, issuer, audience, expiry) so a request
// that somehow reaches the worker without going through Access is refused.
// Until setup-access.sh fills ACCESS_TEAM_DOMAIN / ACCESS_AUD it fails closed
// with 503. `wrangler dev --var ALLOW_UNAUTHENTICATED:true` skips auth locally.

import moveSeed from '../seed/51-hartlander-move.json';
import { buildDigest } from './digest.js';
import STATIC from './assets.generated.js'; // built by scripts/bundle-assets.mjs

const SEEDS = { '51-hartlander/move': moveSeed };
const BOARD_ID = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const MAX_BODY = 256 * 1024, MAX_ITEMS = 500, MAX_TEXT = 400, MAX_URL = 1000, MAX_GROUPS = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return text('ok');

    const auth = await authenticate(request, env);
    if (!auth.ok) return gate(auth, url);

    if (url.pathname === '/api/me') return json({ email: auth.email });

    if (url.pathname.startsWith('/api/boards/')) {
      const id = url.pathname.slice('/api/boards/'.length).replace(/\/+$/, '');
      if (!BOARD_ID.test(id) || id.length > 80) return json({ error: 'bad_board_id' }, 400);
      if (request.method === 'GET') return json(await loadBoard(env, id));
      if (request.method === 'PUT') return saveBoard(request, env, id, auth.email);
      return text('Method not allowed', 405, { Allow: 'GET, PUT' });
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);

    return serveStatic(request, url);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDigest(env));
  },
};

// ---------- static pages ----------

const STATIC_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function serveStatic(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405, { Allow: 'GET, HEAD' });
  let path = url.pathname;
  if (path.endsWith('/')) path += 'index.html';
  let asset = STATIC[path];
  if (!asset && STATIC[url.pathname + '/index.html']) {
    return Response.redirect(url.origin + url.pathname + '/' + url.search, 301); // /kaavi -> /kaavi/
  }
  let status = 200;
  if (!asset) { asset = STATIC['/404.html']; status = 404; }
  if (!asset) return text('Not found', 404);
  const body = asset.bin ? b64urlToBytes(asset.b.replace(/\+/g, '-').replace(/\//g, '_')) : asset.b;
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: { 'content-type': asset.t, ...STATIC_HEADERS } });
}

// ---------- boards ----------

function emptyBoard() {
  // title is null so the page's data-title is used for the first save
  return { title: null, move: null, groups: [{ id: 'todo', name: 'To do', items: [] }] };
}

async function loadBoard(env, id) {
  const raw = await env.KV.get(`board:${id}`);
  if (raw) {
    try {
      const rec = JSON.parse(raw);
      if (rec && typeof rec.version === 'number' && rec.state) return rec;
    } catch {}
  }
  return { version: 0, state: SEEDS[id] || emptyBoard(), updatedAt: null, updatedBy: null };
}

async function saveBoard(request, env, id, email) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'too_large' }, 413);
  let body;
  try {
    const txt = await request.text();
    if (txt.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    body = JSON.parse(txt);
  } catch { return json({ error: 'bad_json' }, 400); }
  const state = sanitize(body && body.state, id);
  if (!state) return json({ error: 'bad_state' }, 400);
  if (typeof body.version !== 'number') return json({ error: 'missing_version' }, 400);

  const current = await loadBoard(env, id);
  if (body.version !== current.version) return json({ error: 'conflict', ...current }, 409);

  const rec = { version: current.version + 1, state, updatedAt: new Date().toISOString(), updatedBy: email };
  await env.KV.put(`board:${id}`, JSON.stringify(rec));
  return json(rec);
}

function sanitize(s, id) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.groups) || s.groups.length > MAX_GROUPS) return null;
  const move = typeof s.move === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.move) ? s.move : null;
  const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 80) : 'List';
  let count = 0; const groups = []; const seen = new Set();
  for (const g of s.groups) {
    if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || !Array.isArray(g.items)) return null;
    if (!/^[a-z0-9_-]{1,24}$/.test(g.id) || seen.has(g.id)) return null;
    seen.add(g.id);
    const items = [];
    for (const it of g.items) {
      if (!it || typeof it.t !== 'string' || !it.t.trim()) return null;
      if (++count > MAX_ITEMS) return null;
      const o = { t: it.t.trim().slice(0, MAX_TEXT), d: it.d === true };
      if (typeof it.s === 'string' && it.s.trim()) o.s = it.s.trim().slice(0, MAX_TEXT);
      if (typeof it.u === 'string' && /^https?:\/\//i.test(it.u)) o.u = it.u.slice(0, MAX_URL);
      items.push(o);
    }
    groups.push({ id: g.id, name: g.name.trim().slice(0, 40) || g.id, items });
  }
  return { title, move, groups };
}

// ---------- digest (cron) ----------

async function sendDigest(env) {
  if (!env.RESEND_API_KEY || !env.DIGEST_TO) return { skipped: 'not_configured' };
  const to = env.DIGEST_TO.split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length) return { skipped: 'no_recipients' };
  const rec = await loadBoard(env, '51-hartlander/move');
  const mail = buildDigest(rec.state, new Date());
  if (!mail) return { skipped: 'nothing_to_say' };
  const res = await fetch((env.RESEND_API_URL || 'https://api.resend.com') + '/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Family Board <noreply@vasantpatel.xyz>', to, subject: mail.subject, text: mail.text, html: mail.html }),
  });
  return { sent: res.ok, status: res.status };
}

// ---------- Cloudflare Access ----------

let certCache = { url: null, keys: null, fetchedAt: 0 };

async function authenticate(request, env) {
  if (env.ALLOW_UNAUTHENTICATED === 'true') return { ok: true, email: 'local-dev@example.com' };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, status: 503, reason: 'not_configured' };
  const token = request.headers.get('cf-access-jwt-assertion') || cookie(request, 'CF_Authorization');
  if (!token) return { ok: false, status: 401, reason: 'no_token' };
  try {
    const payload = await verifyAccessJwt(token, env);
    return { ok: true, email: payload.email || payload.common_name || 'unknown' };
  } catch (e) {
    return { ok: false, status: 401, reason: 'bad_token', detail: String((e && e.message) || e) };
  }
}

async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = JSON.parse(b64urlToString(parts[0]));
  const payload = JSON.parse(b64urlToString(parts[1]));
  if (header.alg !== 'RS256') throw new Error('alg');
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer) throw new Error('iss');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error('aud');
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) throw new Error('exp');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) throw new Error('nbf');

  const certsUrl = env.ACCESS_CERTS_URL || `${issuer}/cdn-cgi/access/certs`;
  let jwk = await findKey(certsUrl, header.kid, false);
  if (!jwk) jwk = await findKey(certsUrl, header.kid, true); // key rotation: refetch once
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('sig');
  return payload;
}

async function findKey(certsUrl, kid, force) {
  const fresh = certCache.url === certsUrl && certCache.keys && Date.now() - certCache.fetchedAt < 6 * 3600 * 1000;
  if (force || !fresh) {
    const res = await fetch(certsUrl, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new Error('certs_' + res.status);
    const data = await res.json();
    certCache = { url: certsUrl, keys: data.keys || [], fetchedAt: Date.now() };
  }
  return certCache.keys.find((k) => k.kid === kid) || null;
}

function cookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) { return new TextDecoder().decode(b64urlToBytes(s)); }

// ---------- responses ----------

function gate(auth, url) {
  if (url.pathname.startsWith('/api/')) return json({ error: auth.reason }, auth.status);
  const msg = {
    not_configured: 'The login gate is not set up yet. Run scripts/setup-access.sh, then reload.',
    no_token: 'Not signed in. Open the site through its real address so Cloudflare Access can log you in.',
    bad_token: 'Your login could not be verified. Reload the page to sign in again.',
  }[auth.reason] || 'Access denied.';
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Family</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#17202a">
<h1 style="font-size:1.4rem;margin:0 0 .5rem">Family site</h1><p>${msg}</p>
<p style="color:#5d6b7a;font-size:.85rem">${auth.status} · ${auth.reason}${auth.detail ? ' · ' + esc(auth.detail) : ''}</p></body>`;
  return new Response(html, { status: auth.status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function text(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
