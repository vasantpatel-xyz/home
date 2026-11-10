// Move Board worker
//
//   GET  /            -> the board page (src/index.html)
//   GET  /api/state   -> { version, state, updatedAt, updatedBy }
//   PUT  /api/state   -> { version, state }  (version must match; 409 otherwise)
//   GET  /healthz     -> "ok" (no auth; used by deploy smoke test)
//
// Every other request must carry a valid Cloudflare Access JWT. The worker
// verifies the token itself (signature, issuer, audience, expiry) so a request
// that somehow reaches the worker without going through Access is still refused.
// Until setup-access.sh fills ACCESS_TEAM_DOMAIN / ACCESS_AUD the worker fails
// closed with 503. `wrangler dev --var ALLOW_UNAUTHENTICATED:true` skips auth
// for local testing only.

import page from './index.html';
import seed from '../seed.json';

const STATE_KEY = 'state';
const MAX_BODY = 256 * 1024;
const MAX_ITEMS = 500;
const MAX_TEXT = 400;
const MAX_URL = 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') return text('ok');

    const auth = await authenticate(request, env, ctx);
    if (!auth.ok) return gate(auth);

    if (url.pathname === '/api/state') {
      if (request.method === 'GET') return json(await load(env));
      if (request.method === 'PUT') return save(request, env, auth.email);
      return text('Method not allowed', 405, { Allow: 'GET, PUT' });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(page, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        },
      });
    }

    return text('Not found', 404);
  },
};

// ---------- storage ----------

async function load(env) {
  const raw = await env.MOVE_BOARD.get(STATE_KEY);
  if (!raw) return { version: 0, state: seed, updatedAt: null, updatedBy: null };
  try {
    const rec = JSON.parse(raw);
    if (rec && typeof rec.version === 'number' && rec.state) return rec;
  } catch {}
  // Corrupt record: fall back to the seed but keep a high version so clients re-sync.
  return { version: 0, state: seed, updatedAt: null, updatedBy: null };
}

async function save(request, env, email) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ error: 'too_large' }, 413);
  let body;
  try {
    const txt = await request.text();
    if (txt.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    body = JSON.parse(txt);
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const state = sanitize(body && body.state);
  if (!state) return json({ error: 'bad_state' }, 400);
  if (typeof body.version !== 'number') return json({ error: 'missing_version' }, 400);

  const current = await load(env);
  if (body.version !== current.version) {
    return json({ error: 'conflict', ...current }, 409);
  }
  const rec = {
    version: current.version + 1,
    state,
    updatedAt: new Date().toISOString(),
    updatedBy: email,
  };
  await env.MOVE_BOARD.put(STATE_KEY, JSON.stringify(rec));
  return json(rec);
}

function sanitize(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.groups)) return null;
  if (typeof s.move !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.move)) return null;
  const title = typeof s.title === 'string' ? s.title.slice(0, 80) : seed.title;
  let count = 0;
  const groups = [];
  for (const g of s.groups) {
    if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || !Array.isArray(g.items)) return null;
    if (!/^[a-z0-9_-]{1,20}$/.test(g.id)) return null;
    const items = [];
    for (const it of g.items) {
      if (!it || typeof it.t !== 'string') return null;
      if (++count > MAX_ITEMS) return null;
      const o = { t: it.t.slice(0, MAX_TEXT), d: it.d === true };
      if (typeof it.s === 'string' && it.s) o.s = it.s.slice(0, MAX_TEXT);
      if (typeof it.u === 'string' && /^https?:\/\//i.test(it.u)) o.u = it.u.slice(0, MAX_URL);
      items.push(o);
    }
    groups.push({ id: g.id, name: g.name.slice(0, 40), items });
  }
  return { title, move: s.move, groups };
}

// ---------- Cloudflare Access ----------

let certCache = { url: null, keys: null, fetchedAt: 0 };

async function authenticate(request, env, ctx) {
  if (env.ALLOW_UNAUTHENTICATED === 'true') return { ok: true, email: 'local-dev' };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, status: 503, reason: 'not_configured' };

  const token = request.headers.get('cf-access-jwt-assertion') || cookie(request, 'CF_Authorization');
  if (!token) return { ok: false, status: 401, reason: 'no_token' };

  try {
    const payload = await verifyAccessJwt(token, env, ctx);
    return { ok: true, email: payload.email || payload.common_name || 'unknown' };
  } catch (e) {
    return { ok: false, status: 401, reason: 'bad_token', detail: String(e && e.message || e) };
  }
}

async function verifyAccessJwt(token, env, ctx) {
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
  if (!jwk) jwk = await findKey(certsUrl, header.kid, true); // key rotated: refetch once
  if (!jwk) throw new Error('kid');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
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
  const c = request.headers.get('cookie') || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// ---------- responses ----------

function gate(auth) {
  const msg = {
    not_configured: 'The login gate is not set up yet. Run scripts/setup-access.sh, then reload.',
    no_token: 'Not signed in. Open the board through its real address so Cloudflare Access can log you in.',
    bad_token: 'Your login could not be verified. Reload the page to sign in again.',
  }[auth.reason] || 'Access denied.';
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Move Board</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#17202a">
<h1 style="font-size:1.4rem;margin:0 0 .5rem">Move Board</h1><p>${msg}</p>
<p style="color:#5d6b7a;font-size:.85rem">${auth.status} · ${auth.reason}${auth.detail ? ' · ' + escapeHtml(auth.detail) : ''}</p></body>`;
  return new Response(html, {
    status: auth.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function text(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
