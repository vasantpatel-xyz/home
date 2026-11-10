// Local end-to-end test. Run with: npm test  (or node scripts/test-local.mjs)
// Boots `wrangler dev` three times with different auth settings and checks:
//   A) open mode: API, optimistic-concurrency (409), validation, and the page via Playwright
//   B) Access mode: JWT verification against a locally signed token set
//   C) unconfigured mode: fails closed with 503
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // preinstalled globally in the Claude Code container

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDev(vars) {
  rmSync('.wrangler/state', { recursive: true, force: true }); // fresh local KV each run
  const args = ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const p = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return p; } catch {}
    if (p.exitCode !== null) break;
  }
  console.error(out);
  throw new Error('wrangler dev did not start');
}
async function stop(p) {
  // wrangler spawns workerd; kill the whole process group so the port is really freed
  try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  await new Promise((r) => { p.on('exit', r); setTimeout(r, 5000); });
  try { process.kill(-p.pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/healthz`); await sleep(250); } catch { return; } }
  throw new Error('port still in use after stopping wrangler dev');
}
const api = (opts = {}, path = '/api/state') => fetch(BASE + path, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const put = (body, headers = {}) => api({ method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---------- A: open mode ----------
{
  const dev = await startDev({ ALLOW_UNAUTHENTICATED: 'true' });
  try {
    let r = await api();
    check('GET /api/state returns seed at version 0', r.status === 200 && r.body.version === 0 && r.body.state.groups.length === 4);
    const items = r.body.state.groups.reduce((n, g) => n + g.items.length, 0);
    check('seed has 26 items, 3 already done', items === 26 && r.body.state.groups.flatMap((g) => g.items).filter((i) => i.d).length === 3, `items=${items}`);

    const s1 = structuredClone(r.body.state); s1.groups[0].items[0].d = true;
    r = await put({ version: 7, state: s1 });
    check('PUT with stale version -> 409 with current record', r.status === 409 && r.body.version === 0);
    r = await put({ version: 0, state: s1 });
    check('PUT with matching version -> 200, version 1, updatedBy local-dev', r.status === 200 && r.body.version === 1 && r.body.updatedBy === 'local-dev');
    r = await api();
    check('GET reflects the saved tick', r.body.version === 1 && r.body.state.groups[0].items[0].d === true);

    r = await put({ version: 1, state: { groups: 'nope' } });
    check('PUT invalid state -> 400', r.status === 400);
    r = await put({ state: s1 });
    check('PUT without version -> 400', r.status === 400);
    const s2 = structuredClone(s1); s2.groups[0].items.push({ t: 'x', d: false, u: 'javascript:alert(1)', s: 'spec' });
    r = await put({ version: 1, state: s2 });
    check('non-http item URL is dropped on save', r.status === 200 && r.body.state.groups[0].items.at(-1).u === undefined && r.body.state.groups[0].items.at(-1).s === 'spec');
    r = await fetch(BASE + '/api/state', { method: 'DELETE' });
    check('DELETE /api/state -> 405', r.status === 405);
    r = await fetch(BASE + '/nope');
    check('unknown path -> 404', r.status === 404);
    r = await fetch(BASE + '/');
    const html = await r.text();
    check('GET / serves the board page', r.status === 200 && html.includes('id="boxes"') && r.headers.get('cache-control') === 'no-store');

    // Browser: tick an item, reload, confirm it stuck; add an item; concurrent save conflict merges
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/');
    await page.waitForSelector('li input[type=checkbox]');
    check('page renders 27 checkboxes', (await page.locator('li input[type=checkbox]').count()) === 27);
    check('countdown shows a number or Today/Moved', /^\d+$|Today|Moved/.test((await page.locator('#days').textContent()).trim()));
    await page.locator('#c-ami-0').check();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    await page.reload();
    await page.waitForSelector('#c-ami-0');
    check('tick survives reload', await page.locator('#c-ami-0').isChecked());
    check('"Last change by" footer shows', (await page.locator('#meta').textContent()).startsWith('Last change by local-dev'));

    await page.fill('#add-mom', 'Label the boxes');
    await page.press('#add-mom', 'Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    r = await api();
    check('added item reaches the server', r.body.state.groups[2].items.some((i) => i.t === 'Label the boxes'));

    // Simulate another phone saving in between: bump server version, then tick in the page
    const other = structuredClone(r.body.state); other.groups[1].items[1].d = true;
    const bump = await put({ version: r.body.version, state: other });
    check('background save from "another phone" accepted', bump.status === 200);
    await page.locator('#c-v-3').check(); // "Buy sofa"
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 15000 });
    r = await api();
    const buySofa = r.body.state.groups[0].items[3], amiItem = r.body.state.groups[1].items[1];
    check('conflict merged: both the other phone\'s tick and ours are saved', buySofa.d === true && amiItem.d === true);
    check('no JavaScript errors on the page', errors.length === 0, errors.join(' | '));
    await browser.close();
  } finally { await stop(dev); }
}

// ---------- B: Access mode with locally signed JWTs ----------
{
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const certs = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => certs.listen(0, '127.0.0.1', r));
  const certsUrl = `http://127.0.0.1:${certs.address().port}/certs`;
  const TEAM = 'patel-test.cloudflareaccess.com', AUD = 'a'.repeat(64);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload, h = { alg: 'RS256', kid, typ: 'JWT' }) => {
    const data = `${b64(h)}.${b64(payload)}`;
    const s = createSign('RSA-SHA256'); s.update(data);
    return `${data}.${s.sign(privateKey).toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: `https://${TEAM}`, aud: [AUD], exp: now + 3600, iat: now, email: 'ami@example.com', sub: 'x' };

  const dev = await startDev({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_CERTS_URL: certsUrl });
  try {
    let r = await fetch(BASE + '/');
    check('no token -> 401', r.status === 401);
    r = await fetch(BASE + '/healthz');
    check('/healthz stays open', r.status === 200);
    r = await api({ headers: { 'cf-access-jwt-assertion': 'garbage' } });
    check('garbage token -> 401', r.status === 401);
    r = await api({ headers: { 'cf-access-jwt-assertion': sign(good) } });
    check('valid token via header -> 200', r.status === 200, JSON.stringify(r.body));
    r = await api({ headers: { cookie: `CF_Authorization=${sign(good)}` } });
    check('valid token via CF_Authorization cookie -> 200', r.status === 200);
    r = await api({ headers: { 'cf-access-jwt-assertion': sign({ ...good, exp: now - 120 }) } });
    check('expired token -> 401', r.status === 401);
    r = await api({ headers: { 'cf-access-jwt-assertion': sign({ ...good, aud: ['b'.repeat(64)] }) } });
    check('wrong audience -> 401', r.status === 401);
    r = await api({ headers: { 'cf-access-jwt-assertion': sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }) } });
    check('wrong issuer -> 401', r.status === 401);
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = (() => { const d = `${b64({ alg: 'RS256', kid })}.${b64(good)}`; const s = createSign('RSA-SHA256'); s.update(d); return `${d}.${s.sign(otherKey).toString('base64url')}`; })();
    r = await api({ headers: { 'cf-access-jwt-assertion': forged } });
    check('token signed by a different key -> 401', r.status === 401);
    r = await api({ headers: { 'cf-access-jwt-assertion': sign(good, { alg: 'none', kid }) } });
    check('alg=none -> 401', r.status === 401);
    const st = (await api({ headers: { 'cf-access-jwt-assertion': sign(good) } })).body.state;
    r = await put({ version: 0, state: st }, { 'cf-access-jwt-assertion': sign(good) });
    check('save records the Access email', r.status === 200 && r.body.updatedBy === 'ami@example.com');
  } finally { await stop(dev); certs.close(); }
}

// ---------- C: unconfigured -> fail closed ----------
{
  const dev = await startDev({});
  try {
    const r = await fetch(BASE + '/');
    check('no Access config -> 503 fail closed', r.status === 503 && (await r.text()).includes('setup-access.sh'));
    check('API also 503 when unconfigured', (await fetch(BASE + '/api/state')).status === 503);
  } finally { await stop(dev); }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
