// Local end-to-end test. Run with: npm test  (or node scripts/test-local.mjs)
// Boots `wrangler dev` three times with different auth settings and checks:
//   A) open mode: boards API, optimistic concurrency (409), validation, static pages, the board in a browser, the cron digest
//   B) Access mode: JWT verification against a locally signed token set
//   C) unconfigured mode: fails closed with 503
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildDigest } from '../src/digest.js';
const { chromium } = createRequire(import.meta.url)('playwright'); // preinstalled globally in the Claude Code container

const PORT = 8787, BASE = `http://127.0.0.1:${PORT}`;
const MOVE = '/api/boards/51-hartlander/move';
let failures = 0;
function check(name, cond, extra = '') { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); if (!cond) failures++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDev(vars) {
  rmSync('.wrangler/state', { recursive: true, force: true }); // fresh local KV each run
  const args = ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn', '--test-scheduled'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const p = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/healthz`)).ok) return p; } catch {}
    if (p.exitCode !== null) break;
  }
  console.error(out); throw new Error('wrangler dev did not start');
}
async function stop(p) {
  try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  await new Promise((r) => { p.on('exit', r); setTimeout(r, 5000); });
  try { process.kill(-p.pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/healthz`); await sleep(250); } catch { return; } }
  throw new Error('port still in use after stopping wrangler dev');
}
const api = (path = MOVE, opts = {}) => fetch(BASE + path, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const put = (path, body, headers = {}) => api(path, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---------- digest builder (pure) ----------
{
  const st = { title: 'Move', move: '2026-11-14', groups: [{ id: 'a', name: 'V', items: [{ t: 'one', d: false }, { t: 'two', d: true }] }, { id: 'b', name: 'Ami', items: [{ t: 'three', d: true }] }] };
  const d = buildDigest(st, new Date(Date.UTC(2026, 10, 10, 12)));
  check('digest: subject counts open items and days', d && d.subject === 'Move: 1 open · 4 days to go', d && d.subject);
  check('digest: text lists only open items by group', d && d.text.includes('V (1)') && d.text.includes('• one') && !d.text.includes('Ami (') && !d.text.includes('two'));
  check('digest: html escapes', buildDigest({ ...st, title: 'a<b' }, new Date(Date.UTC(2026, 10, 10))).html.includes('a&lt;b'));
  check('digest: stops 4+ days after the move', buildDigest(st, new Date(Date.UTC(2026, 10, 18, 12))) === null);
  check('digest: moving day wording', buildDigest(st, new Date(Date.UTC(2026, 10, 14, 12))).subject.endsWith('Moving day is today'));
  check('digest: list with no date and nothing open -> null', buildDigest({ title: 'x', move: null, groups: [{ id: 'a', name: 'A', items: [{ t: 'z', d: true }] }] }, new Date()) === null);
}

// ---------- A: open mode ----------
{
  // mock Resend so the cron can be exercised offline
  const sent = [];
  const resend = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { sent.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(b) }); res.setHeader('content-type', 'application/json'); res.end('{"id":"mock"}'); }); });
  await new Promise((r) => resend.listen(0, '127.0.0.1', r));
  const dev = await startDev({ ALLOW_UNAUTHENTICATED: 'true', RESEND_API_KEY: 're_test', DIGEST_TO: 'a@example.com, b@example.com', RESEND_API_URL: `http://127.0.0.1:${resend.address().port}` });
  try {
    let r = await api();
    check('GET move board returns seed at version 0', r.status === 200 && r.body.version === 0 && r.body.state.groups.length === 4);
    const items = r.body.state.groups.reduce((n, g) => n + g.items.length, 0);
    check('seed has 26 items, 3 already done', items === 26 && r.body.state.groups.flatMap((g) => g.items).filter((i) => i.d).length === 3, `items=${items}`);
    check('GET /api/me returns the login email', (await api('/api/me')).body.email === 'local-dev@example.com');

    const s1 = structuredClone(r.body.state); s1.groups[0].items[0].d = true;
    r = await put(MOVE, { version: 7, state: s1 });
    check('PUT with stale version -> 409 with current record', r.status === 409 && r.body.version === 0);
    r = await put(MOVE, { version: 0, state: s1 });
    check('PUT with matching version -> 200, version 1, updatedBy set', r.status === 200 && r.body.version === 1 && r.body.updatedBy === 'local-dev@example.com');
    check('GET reflects the saved tick', (await api()).body.state.groups[0].items[0].d === true);
    check('PUT invalid state -> 400', (await put(MOVE, { version: 1, state: { groups: 'nope' } })).status === 400);
    check('PUT without version -> 400', (await put(MOVE, { state: s1 })).status === 400);
    const s2 = structuredClone(s1); s2.groups[0].items.push({ t: 'x', d: false, u: 'javascript:alert(1)', s: 'spec' });
    r = await put(MOVE, { version: 1, state: s2 });
    check('non-http item URL is dropped on save', r.status === 200 && r.body.state.groups[0].items.at(-1).u === undefined && r.body.state.groups[0].items.at(-1).s === 'spec');
    check('DELETE -> 405', (await fetch(BASE + MOVE, { method: 'DELETE' })).status === 405);
    check('bad board id -> 400', (await api('/api/boards/../etc')).status === 400 || (await api('/api/boards/Bad_Id')).status === 400);
    check('unknown api -> 404 json', (await api('/api/nope')).status === 404);

    r = await api('/api/boards/kaavi/list');
    check('unseeded board starts empty with a To do section', r.status === 200 && r.body.version === 0 && r.body.state.groups[0].id === 'todo' && r.body.state.title === null);
    check('boards are independent', (await api('/api/boards/kai/list')).body.state.groups[0].items.length === 0);

    // free-form docs API (reading page)
    r = await api('/api/docs/kaavi/reading');
    check('docs: empty doc at version 0', r.status === 200 && r.body.version === 0 && JSON.stringify(r.body.state) === '{}');
    r = await put('/api/docs/kaavi/reading', { version: 0, state: { days: { '2026-11-16': [true, true, true, true] }, books: { b1: true } } });
    check('docs: save -> version 1', r.status === 200 && r.body.version === 1 && r.body.state.books.b1 === true);
    check('docs: stale version -> 409', (await put('/api/docs/kaavi/reading', { version: 0, state: {} })).status === 409);
    check('docs: array state -> 400', (await put('/api/docs/kaavi/reading', { version: 1, state: [1] })).status === 400);
    check('docs: oversized -> 413', (await put('/api/docs/kaavi/reading', { version: 1, state: { x: 'a'.repeat(70000) } })).status === 413);

    // static pages bundled into the worker
    r = await fetch(BASE + '/');
    check('GET / serves the family home, no-store', r.status === 200 && (await r.text()).includes('Patel') && r.headers.get('cache-control') === 'no-store');
    for (const p of ['/kaavi/', '/kaavi/reading/', '/kaveera/', '/kai/', '/ami/', '/51-hartlander/', '/51-hartlander/move/', '/kaavi/list/', '/assets/board.js']) {
      check(`GET ${p} -> 200`, (await fetch(BASE + p)).status === 200);
    }
    r = await fetch(BASE + '/kaavi');
    check('/kaavi (no slash) redirects to /kaavi/', r.status === 200 && r.url.endsWith('/kaavi/'));
    r = await fetch(BASE + '/does-not-exist/');
    check('unknown page -> 404 with custom page', r.status === 404 && (await r.text()).includes('Nothing here yet'));

    // cron digest
    r = await fetch(BASE + '/__scheduled?cron=0+12+*+*+*');
    await sleep(1500);
    check('cron trigger reaches the scheduled handler', r.status === 200 && sent.length === 1, `sent=${sent.length}`);
    check('digest email: bearer key, both recipients, open items in body', sent[0] && sent[0].auth === 'Bearer re_test' && sent[0].body.to.length === 2 && sent[0].body.text.includes('Buy sofa') && !sent[0].body.text.includes('EB Residency'), JSON.stringify(sent[0] && sent[0].body.to));

    // browser
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/51-hartlander/move/');
    await page.waitForSelector('li input[type=checkbox]');
    check('move board renders 27 checkboxes and the countdown', (await page.locator('li input[type=checkbox]').count()) === 27 && !(await page.locator('#countdown').isHidden()));
    await page.locator('#c-ami-0').check();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    await page.reload(); await page.waitForSelector('#c-ami-0');
    check('tick survives reload', await page.locator('#c-ami-0').isChecked());
    check('"Last change by" footer shows', (await page.locator('#meta').textContent()).startsWith('Last change by local-dev'));
    await page.fill('#add-mom', 'Label the boxes'); await page.press('#add-mom', 'Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    r = await api();
    check('added item reaches the server', r.body.state.groups[2].items.some((i) => i.t === 'Label the boxes'));
    const other = structuredClone(r.body.state); other.groups[1].items[1].d = true;
    check('background save from "another phone" accepted', (await put(MOVE, { version: r.body.version, state: other })).status === 200);
    await page.locator('#c-v-3').check();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 15000 });
    r = await api();
    check('conflict merged: both ticks saved', r.body.state.groups[0].items[3].d === true && r.body.state.groups[1].items[1].d === true);

    // a personal list: title from the page, add section, countdown hidden
    await page.goto(BASE + '/kaavi/list/');
    await page.waitForSelector('#addgroup input');
    check('personal list shows its title and no countdown', (await page.locator('#title').textContent()) === "Kaavi's list" && await page.locator('#countdown').isHidden());
    await page.fill('#add-todo', 'Finish chapter 3'); await page.press('#add-todo', 'Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    await page.fill('#addgroup input', 'School'); await page.press('#addgroup input', 'Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    r = await api('/api/boards/kaavi/list');
    check('personal list saved with page title, item and new section', r.body.state.title === "Kaavi's list" && r.body.state.groups[0].items[0].t === 'Finish chapter 3' && r.body.state.groups[1].name === 'School');
    check('signed-in name shows in the top bar', (await page.locator('#me').textContent()) === 'local-dev');

    // Kaavi's reading page: 4 steps, grid of 40 days, 4 books; tap steps -> saved -> survives reload
    await page.goto(BASE + '/kaavi/reading/');
    await page.waitForSelector('.step');
    check('reading: 4 steps, 40 days, 4 books rendered', (await page.locator('.step').count()) === 4 && (await page.locator('.day').count()) === 40 && (await page.locator('.book').count()) === 4);
    check('reading: book 1 shows as finished from the API save', await page.locator('.book.done').count() === 1);
    for (const i of [0, 1, 2, 3]) await page.locator('.step').nth(i).click();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    check('reading: all four steps -> mission done banner', await page.locator('#win.show').isVisible());
    await page.reload(); await page.waitForSelector('.step');
    check('reading: today\'s steps survive reload', (await page.locator('.step.done').count()) === 4);
    r = await api('/api/docs/kaavi/reading');
    const todayKey = new Date().toLocaleDateString('en-CA');
    check('reading: today saved on the server', Array.isArray(r.body.state.days[todayKey]) && r.body.state.days[todayKey].every(Boolean));
    check('no JavaScript errors on the pages', errors.length === 0, errors.join(' | '));
    await browser.close();
  } finally { await stop(dev); resend.close(); }
}

// ---------- B: Access mode with locally signed JWTs ----------
{
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const certs = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => certs.listen(0, '127.0.0.1', r));
  const TEAM = 'patel-test.cloudflareaccess.com', AUD = 'a'.repeat(64);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload, h = { alg: 'RS256', kid, typ: 'JWT' }, key = privateKey) => { const d = `${b64(h)}.${b64(payload)}`; const s = createSign('RSA-SHA256'); s.update(d); return `${d}.${s.sign(key).toString('base64url')}`; };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: `https://${TEAM}`, aud: [AUD], exp: now + 3600, iat: now, email: 'ami@example.com', sub: 'x' };
  const dev = await startDev({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_CERTS_URL: `http://127.0.0.1:${certs.address().port}/certs` });
  try {
    check('no token: page -> 401', (await fetch(BASE + '/')).status === 401);
    check('no token: static asset -> 401 too', (await fetch(BASE + '/assets/board.js')).status === 401);
    check('/healthz stays open', (await fetch(BASE + '/healthz')).status === 200);
    const H = (t) => ({ headers: { 'cf-access-jwt-assertion': t } });
    check('garbage token -> 401', (await api(MOVE, H('garbage'))).status === 401);
    check('valid token via header -> 200', (await api(MOVE, H(sign(good)))).status === 200);
    check('valid token via CF_Authorization cookie -> 200', (await api(MOVE, { headers: { cookie: `CF_Authorization=${sign(good)}` } })).status === 200);
    check('valid token: static page -> 200', (await fetch(BASE + '/kai/', H(sign(good)))).status === 200);
    check('expired token -> 401', (await api(MOVE, H(sign({ ...good, exp: now - 120 })))).status === 401);
    check('wrong audience -> 401', (await api(MOVE, H(sign({ ...good, aud: ['b'.repeat(64)] })))).status === 401);
    check('wrong issuer -> 401', (await api(MOVE, H(sign({ ...good, iss: 'https://evil.cloudflareaccess.com' })))).status === 401);
    check('token signed by a different key -> 401', (await api(MOVE, H(sign(good, undefined, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)))).status === 401);
    check('alg=none -> 401', (await api(MOVE, H(sign(good, { alg: 'none', kid })))).status === 401);
    const st = (await api(MOVE, H(sign(good)))).body.state;
    const r = await put(MOVE, { version: 0, state: st }, { 'cf-access-jwt-assertion': sign(good) });
    check('save records the Access email', r.status === 200 && r.body.updatedBy === 'ami@example.com');
  } finally { await stop(dev); certs.close(); }
}

// ---------- C: unconfigured -> fail closed ----------
{
  // wrangler.toml carries the real Access config once setup-access.sh has run; blank it for this mode
  const dev = await startDev({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' });
  try {
    const r = await fetch(BASE + '/');
    check('no Access config -> 503 fail closed', r.status === 503 && (await r.text()).includes('setup-access.sh'));
    check('API also 503 when unconfigured', (await fetch(BASE + MOVE)).status === 503);
  } finally { await stop(dev); }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
