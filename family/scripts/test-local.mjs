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
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright'); // preinstalled globally in the Claude Code container

const PORT = Number(process.env.TEST_PORT) || 8787, BASE = `http://127.0.0.1:${PORT}`;
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
const site = (name, path, opts = {}) => fetch(BASE + path, { ...opts, headers: { 'x-dev-site': name, ...(opts.headers || {}) } });
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

// ---------- Reading Quest rules (pure, from public/kaavi/reading/plan.js) ----------
{
  const w = {}; new Function('window', readFileSync(new URL('../public/kaavi/reading/plan.js', import.meta.url), 'utf8'))(w);
  const Q = w.QUEST, T = [true, true, true, true, true];
  const st = (days, extra = {}) => Q.norm({ days, ...extra });
  check('quest: 5 steps, 40 stamps, 4 books, a prompt for every weekday', Q.STEPS.length === 5 && Q.TOTAL === 40 && Q.BOOKS.length === 4 && [1, 2, 3, 4, 5].every((d) => Q.PROMPTS[d] && Q.PROMPTS[d].how.length >= 2 && Q.PROMPTS[d].lines > 0));
  check('quest: a day needs all five steps (grown-up check included)', !Q.dayDone(st({ a: [true, true, true, true] }), 'a') && !Q.dayDone(st({ a: [true, true, true, true, false] }), 'a') && Q.dayDone(st({ a: T }), 'a'));
  check('quest: norm repairs missing or junk state', (() => { const n = Q.norm({ days: 5, neat: null }); return typeof n.days === 'object' && typeof n.neat === 'object' && typeof n.books === 'object' && Q.stamps(Q.norm(null)).length === 0; })());
  check('quest: stamps are sorted and ignore unfinished or junk keys', JSON.stringify(Q.stamps(st({ '2026-11-12': T, '2026-11-10': T, '2026-11-11': [true], junk: T }))) === '["2026-11-10","2026-11-12"]');
  // Tue Nov 10 + Wed Nov 11 done, today Thu Nov 12 not done yet -> streak 2 (today does not break it)
  check('quest: streak counts days in a row, today not yet done does not break it', Q.streaks(st({ '2026-11-10': T, '2026-11-11': T }), '2026-11-12').cur === 2);
  check('quest: finishing today extends the streak', Q.streaks(st({ '2026-11-10': T, '2026-11-11': T, '2026-11-12': T }), '2026-11-12').cur === 3);
  check('quest: a missed weekday resets the streak, best is kept', (() => { const r = Q.streaks(st({ '2026-11-10': T, '2026-11-11': T, '2026-11-13': T }), '2026-11-13'); return r.cur === 1 && r.best === 2; })());
  check('quest: a weekend does not break the streak', Q.streaks(st({ '2026-11-13': T, '2026-11-16': T }), '2026-11-16').cur === 2);
  check('quest: a weekend mission adds to the streak', Q.streaks(st({ '2026-11-13': T, '2026-11-14': T, '2026-11-16': T }), '2026-11-16').cur === 3);
  check('quest: streak is 0 with no stamps, and survives a stamp dated in the future', Q.streaks(st({}), '2026-11-10').cur === 0 && Q.streaks(st({ '2026-12-01': T }), '2026-11-10').cur === 0);
  check('quest: streak over a month boundary', Q.streaks(st({ '2026-11-30': T, '2026-12-01': T }), '2026-12-01').cur === 2);
  check('quest: current book is the first unfinished one, null when all done', Q.currentBook(st({}, { books: {} })).k === 'b1' && Q.currentBook(st({}, { books: { b1: true } })).k === 'b2' && Q.currentBook(st({}, { books: { b1: true, b2: true, b3: true, b4: true } })) === null);
  check('quest: prompts follow the weekday; weekend gets the bonus', Q.promptFor('2026-11-10').skill === 'Problem and action' && Q.promptFor('2026-11-13').skill === 'Friday write-up' && Q.promptFor('2026-11-14').skill === 'Weekend bonus' && Q.promptFor('2026-11-16').skill === 'Character trait');
  check('quest: date helpers round-trip', Q.ymd(Q.parse('2026-01-04')) === '2026-01-04' && Q.isDate('2026-11-10') && !Q.isDate('nope') && Q.isWeekend(Q.parse('2026-11-14')) && !Q.isWeekend(Q.parse('2026-11-13')));
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
    const prevWeekday = (() => { const d = new Date(); do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6); return d.toLocaleDateString('en-CA'); })();
    r = await put('/api/docs/kaavi/reading', { version: 0, state: { days: { [prevWeekday]: [true, true, true, true, true] }, neat: { [prevWeekday]: 3 }, books: { b1: true } } });
    check('docs: save -> version 1', r.status === 200 && r.body.version === 1 && r.body.state.books.b1 === true);
    check('docs: stale version -> 409', (await put('/api/docs/kaavi/reading', { version: 0, state: {} })).status === 409);
    check('docs: array state -> 400', (await put('/api/docs/kaavi/reading', { version: 1, state: [1] })).status === 400);
    check('docs: oversized -> 413', (await put('/api/docs/kaavi/reading', { version: 1, state: { x: 'a'.repeat(70000) } })).status === 413);

    // static pages bundled into the worker
    r = await fetch(BASE + '/');
    check('unknown host falls back to the family home, no-store', r.status === 200 && (await r.text()).includes('Patel') && r.headers.get('cache-control') === 'no-store');
    for (const [h, p] of [['family', '/51-hartlander/'], ['family', '/51-hartlander/move/'], ['kaavi', '/'], ['kaavi', '/reading/'], ['kaavi', '/list/'], ['kaveera', '/'], ['kaveera', '/list/'], ['kai', '/'], ['ami', '/list/'], ['ami', '/assets/board.js'], ['kaavi', '/assets/site.css']]) {
      check(`${h}: GET ${p} -> 200`, (await site(h, p)).status === 200);
    }
    r = await site('kaavi', '/');
    check('kaavi home lists /reading and /list', (t => t.includes('/reading/') && t.includes('/list/'))(await r.text()));
    check('the family move board is not served on kaavi\'s site', (await site('kaavi', '/51-hartlander/move/')).status === 404);
    check('family site has no /reading/', (await site('family', '/reading/')).status === 404);
    r = await site('kaavi', '/reading');
    check('/reading (no slash) redirects to /reading/', r.status === 200 && r.url.endsWith('/reading/'));
    r = await site('kai', '/does-not-exist/');
    check('unknown page -> 404 with custom page', r.status === 404 && (await r.text()).includes('Nothing here yet'));

    // cron digest
    r = await fetch(BASE + '/__scheduled?cron=0+12+*+*+*');
    await sleep(1500);
    check('cron trigger reaches the scheduled handler', r.status === 200 && sent.length === 1, `sent=${sent.length}`);
    check('digest email: bearer key, both recipients, open items in body', sent[0] && sent[0].auth === 'Bearer re_test' && sent[0].body.to.length === 2 && sent[0].body.text.includes('Buy sofa') && !sent[0].body.text.includes('EB Residency'), JSON.stringify(sent[0] && sent[0].body.to));

    // browser
    // real hostnames mapped to the local worker, so host-based routing is what the browser exercises
    const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.vasantpatel.xyz 127.0.0.1'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    const H = (h) => `http://${h}.vasantpatel.xyz:${PORT}`;
    // wrangler dev rewrites Host to localhost, so tell the worker which site each hostname is (dev mode only)
    await page.context().addCookies(['family', 'kaavi', 'kaveera', 'kai', 'ami'].map((h) => ({ name: 'dev-site', value: h, domain: `${h}.vasantpatel.xyz`, path: '/' })));
    await page.goto(H('family') + '/51-hartlander/move/');
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
    await page.goto(H('kaavi') + '/list/');
    await page.waitForSelector('#addgroup input');
    check('personal list shows its title and no countdown', (await page.locator('#title').textContent()) === "Kaavi's list" && await page.locator('#countdown').isHidden());
    await page.fill('#add-todo', 'Finish chapter 3'); await page.press('#add-todo', 'Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    await page.fill('#addgroup input', 'School'); await page.press('#addgroup input', 'Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    r = await api('/api/boards/kaavi/list');
    check('personal list saved with page title, item and new section', r.body.state.title === "Kaavi's list" && r.body.state.groups[0].items[0].t === 'Finish chapter 3' && r.body.state.groups[1].name === 'School');
    check('signed-in name shows in the top bar', (await page.locator('#me').textContent()) === 'local-dev');

    // Kaavi's packing list: add things, box them, labels, unpack view, merge with another phone
    const PK = '/api/docs/kaavi/51-hartlander/packing';
    const pkSaved = () => page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    await page.goto(H('kaavi') + '/51-hartlander/packing/');
    await page.waitForSelector('.empty');
    check('packing: empty list explains how to start; box field and edit buttons hidden until editing', (await page.locator('.empty').textContent()).includes('Start your list') && !(await page.locator('#boxfield').isVisible()) && !(await page.locator('#delbtn').isVisible()) && !(await page.locator('#canceledit').isVisible()));
    await page.fill('#f-t', 'Lego bin'); await page.fill('#f-from', 'my bedroom'); await page.fill('#f-to', 'Playroom'); await page.fill('#f-fs', 'near my bed'); await page.fill('#f-ts', 'toy shelf'); await page.click('#addbtn'); await pkSaved();
    check('packing: exact spots are shown with the thing and are not carried to the next one', (await page.locator('.prow .spec').first().textContent()).includes('near my bed') && (await page.locator('.prow .spec').first().textContent()).includes('Playroom, toy shelf') && (await page.inputValue('#f-fs')) === '' && (await page.inputValue('#f-from')) === 'My bedroom');
    await page.fill('#f-t', 'Desk lamp'); await page.fill('#f-to', 'My bedroom'); await page.click('#addbtn'); await pkSaved();
    check('packing: rooms carry over to the next thing, spelling is unified, pack view groups by where it is now', (await page.locator('.prow').count()) === 2 && (await page.locator('.box h2').allTextContents()).join('|') === 'My bedroom');
    await page.locator('.tick').first().click(); await page.waitForSelector('#chooser:not([hidden])');
    check('packing: tapping a thing asks which box and offers a new one', (await page.locator('.pick.new').textContent()).includes('K1'));
    await page.locator('.pick.new').click(); await pkSaved();
    await page.locator('.tick').nth(1).click(); await page.waitForSelector('#chooser:not([hidden])');
    check('packing: an existing box for a different room is offered without the "same room" mark', (await page.locator('.pick[data-box="K1"]').count()) === 1 && (await page.locator('.pick.match').count()) === 0 && (await page.locator('.pick.new').textContent()).includes('K2'));
    await page.locator('.pick[data-box="K1"]').click(); await pkSaved();
    check('packing: both packed, progress updated', (await page.locator('#overallTxt').textContent()).startsWith('2 of 2 packed'));
    await page.locator('.tab[data-v="boxes"]').click();
    check('packing: a box headed to two rooms is flagged', (await page.locator('.warn').count()) === 1 && (await page.locator('.box h2').first().textContent()).includes('2 rooms'));
    await page.locator('.edit').nth(1).click();
    check('packing: editing shows the box field and the remove button', await page.locator('#boxfield').isVisible() && await page.locator('#delbtn').isVisible());
    await page.fill('#f-box', 'k2'); await page.click('#addbtn'); await pkSaved();
    check('packing: after moving one thing, each box goes to one room', (await page.locator('.warn').count()) === 0 && (await page.locator('.box h2').allTextContents()).join('|') === 'Box K1 → Playroom|Box K2 → My bedroom');
    await page.emulateMedia({ media: 'print' });
    check('packing: one printable label per box, everything else hidden in print', (await page.locator('.label').count()) === 2 && await page.locator('.label').first().isVisible() && !(await page.locator('#addform').isVisible()) && (await page.locator('.label .to').first().textContent()).includes('Playroom') && (await page.locator('.label .boxno').first().textContent()) === 'BOX K1' && (await page.locator('.label li').first().textContent()) === 'Lego bin (toy shelf)');
    await page.emulateMedia({ media: 'screen' });
    r = await api(PK);
    const other3 = structuredClone(r.body.state); other3.items.push({ id: 'parent1', t: 'Soccer cleats', from: 'Garage', to: 'Garage', box: '', s: 0 });
    await put(PK, { version: r.body.version, state: other3 });
    await page.locator('.tab[data-v="unpack"]').click();
    await page.locator('.tick').first().click(); await pkSaved();
    r = await api(PK);
    check('packing: a thing added on another phone is merged with our tap', r.body.state.items.length === 3 && r.body.state.items.find((i) => i.t === 'Desk lamp').s === 2 && r.body.state.items.some((i) => i.id === 'parent1'));
    check('packing: unpack view groups by the room in the new house', (await page.locator('.box h2').allTextContents()).join('|') === 'Garage|My bedroom|Playroom');
    await page.locator('#bulk summary').click();
    await page.fill('#bulktext', '- Bike helmet, garage, garage\n2. Books | My bedroom | Loft\n\n3DS games\nJust a name');
    await page.click('#bulkform button'); await pkSaved();
    r = await api(PK);
    check('packing: adding a whole list parses each line', r.body.state.items.length === 7 && r.body.state.items.find((i) => i.t === 'Books').to === 'Loft' && r.body.state.items.find((i) => i.t === 'Bike helmet').from === 'Garage' && r.body.state.items.some((i) => i.t === '3DS games') && r.body.state.items.find((i) => i.t === 'Just a name').from === '');
    await page.locator('.tab[data-v="pack"]').click();
    await page.locator('.prow', { hasText: 'Just a name' }).locator('.edit').click();
    page.once('dialog', (d) => d.accept());
    await page.click('#delbtn'); await pkSaved();
    await page.reload(); await page.waitForSelector('.prow');
    check('packing: removing a thing sticks after reload', (await page.locator('.prow').count()) === 6 && (await page.locator('#overallTxt').textContent()).startsWith('2 of 6 packed · 1 placed'));
    check('packing: linked from Kaavi\'s home, his move hub, and the family move hub', (await (await site('kaavi', '/')).text()).includes('/51-hartlander/packing/') && (await site('kaavi', '/51-hartlander/')).status === 200 && (await (await site('family', '/51-hartlander/')).text()).includes('kaavi.vasantpatel.xyz/51-hartlander/packing/'));

    // Kaavi's Reading Quest: mission, grown-up stars, stamp card, books, then the printable sheet
    const todayKey = new Date().toLocaleDateString('en-CA');
    const saved = () => page.waitForFunction(() => document.getElementById('status').textContent === 'Saved', null, { timeout: 10000 });
    await page.goto(H('kaavi') + '/reading/');
    await page.waitForSelector('.day.read');
    check('reading: 4 tappable steps + grown-up row, 40 stamps, 4 books', (await page.locator('.step[data-i]').count()) === 4 && (await page.locator('.step.parent').count()) === 1 && (await page.locator('.day').count()) === 40 && (await page.locator('.book').count()) === 4);
    check('reading: seeded stamp shows with three stars', (await page.locator('.day.read').count()) === 1 && (await page.locator('.day.read .st').first().textContent()) === '★★★');
    check('reading: book 1 finished, book 2 is "reading now", big question follows it', (await page.locator('.book.done').count()) === 1 && (await page.locator('.book.now').getAttribute('data-k')) === 'b2' && (await page.locator('#question').textContent()).includes('Surprise Island'));
    check('reading: question shown before the steps, with sentence starters', (await page.locator('#prompt').textContent()).includes('Read with this question in mind') && (await page.locator('#prompt li').count()) >= 2);
    check('reading: stars locked until the four steps are done', await page.locator('.star').first().isDisabled());
    for (const i of [0, 1, 2, 3]) await page.locator(`.step[data-i="${i}"]`).click();
    check('reading: four steps ticked, no stamp yet without the grown-up check', (await page.locator('.step.done').count()) === 4 && !(await page.locator('#win').isVisible()) && (await page.locator('.day.read').count()) === 1);
    check('reading: stars unlock after the four steps', await page.locator('.star').first().isEnabled());
    await page.locator('.star[data-n="2"]').click(); await saved();
    check('reading: grown-up stars finish the mission', await page.locator('#win.show').isVisible() && (await page.locator('.day.read').count()) === 2 && (await page.locator('#win').textContent()).includes('Stamp 2'));
    check('reading: streak counts the seeded day plus today', (await page.locator('#streak').textContent()) === '2');
    await page.reload(); await page.waitForSelector('.star.on');
    check('reading: progress and stars survive reload', (await page.locator('.step.done').count()) === 5 && (await page.locator('.star.on').getAttribute('data-n')) === '2');
    r = await api('/api/docs/kaavi/reading');
    check('reading: today saved on the server with its stars', Array.isArray(r.body.state.days[todayKey]) && r.body.state.days[todayKey].length === 5 && r.body.state.days[todayKey].every(Boolean) && r.body.state.neat[todayKey] === 2);
    await page.locator('.star[data-n="2"]').click(); await saved();
    check('reading: tapping the same stars again takes the stamp back', !(await page.locator('#win').isVisible()) && (await page.locator('.day.read').count()) === 1);
    await page.locator('.star[data-n="3"]').click(); await saved();
    check('reading: three stars counted', (await page.locator('#neatCount').textContent()) === '2' && (await page.locator('.day.read').count()) === 2);
    // another device saves in between (book 2 finished on a parent's phone): our next tap must merge, not overwrite
    r = await api('/api/docs/kaavi/reading');
    const other2 = structuredClone(r.body.state); other2.books.b2 = true;
    await put('/api/docs/kaavi/reading', { version: r.body.version, state: other2 });
    await page.locator('.step[data-i="0"]').click(); await saved();
    await page.locator('.step[data-i="0"]').click(); await saved();
    r = await api('/api/docs/kaavi/reading');
    check('reading: a save from another phone is merged, not lost', r.body.state.books.b2 === true && r.body.state.books.b1 === true && r.body.state.days[todayKey].every(Boolean) && r.body.state.neat[todayKey] === 3);

    // printable sheet: right prompt and line count per weekday, current book filled in, fits one page
    const sp = page; // same page and cookies; this is the last browser block
    await sp.setViewportSize({ width: 703, height: 965 }); // A4 printable width, US Letter printable height: the tight side of each
    await sp.goto(H('kaavi') + '/reading/sheet/?d=2026-11-13');
    await sp.waitForFunction(() => document.getElementById('book').textContent === 'The Yellow House Mystery', null, { timeout: 10000 });
    check('sheet: Friday has the write-up prompt and 12 lines', (await sp.locator('#skill').textContent()) === 'Friday write-up' && (await sp.locator('.line').count()) === 12);
    check('sheet: shows the book he is on', (await sp.locator('#book').textContent()) === 'The Yellow House Mystery');
    await sp.emulateMedia({ media: 'print' });
    for (const [d, skill, lines] of [['2026-11-09', 'Character trait', 8], ['2026-11-10', 'Problem and action', 8], ['2026-11-11', 'How a character changes', 8], ['2026-11-12', 'The lesson', 8], ['2026-11-13', 'Friday write-up', 12], ['2026-11-14', 'Weekend bonus', 6]]) {
      await sp.goto(H('kaavi') + '/reading/sheet/?d=' + d); await sp.waitForSelector('.line');
      const h = await sp.evaluate(() => document.getElementById('sheet').getBoundingClientRect().height);
      check(`sheet ${d}: "${skill}", ${lines} lines, fits one printed page`, (await sp.locator('#skill').textContent()) === skill && (await sp.locator('.line').count()) === lines && h <= 965, `height=${Math.round(h)}px`);
    }
    check('sheet: the toolbar is hidden when printing', !(await sp.locator('.bar').isVisible()));
    await sp.emulateMedia({ media: 'screen' });
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
    check('valid token: static page -> 200', (await fetch(BASE + '/51-hartlander/', H(sign(good)))).status === 200);
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
