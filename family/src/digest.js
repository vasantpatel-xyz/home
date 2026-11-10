// Builds the daily digest email for the move board. Pure function, unit-tested in scripts/test-local.mjs.
export function buildDigest(state, now) {
  if (!state || !Array.isArray(state.groups)) return null;
  const open = state.groups.map((g) => ({ name: g.name, items: g.items.filter((i) => !i.d) })).filter((g) => g.items.length);
  const total = state.groups.reduce((n, g) => n + g.items.length, 0);
  const done = total - open.reduce((n, g) => n + g.items.length, 0);

  let when = '';
  if (state.move) {
    const [y, m, d] = state.move.split('-').map(Number);
    const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 864e5);
    if (days < -3) return null; // the move is over; stop emailing
    when = days > 1 ? `${days} days to go` : days === 1 ? 'Tomorrow is moving day' : days === 0 ? 'Moving day is today' : 'Moved!';
  }
  if (!open.length && !when) return null;

  const subject = `${state.title || 'Board'}: ${open.length ? `${total - done} open` : 'all done'}${when ? ' · ' + when : ''}`;
  const lines = [state.title || 'Board', when, `${done} of ${total} done`, ''];
  for (const g of open) { lines.push(`${g.name.toUpperCase()} (${g.items.length})`); for (const i of g.items) lines.push(`  • ${i.t}`); lines.push(''); }
  if (!open.length) lines.push('Nothing left on the list.');
  lines.push('Open the board: https://family.vasantpatel.xyz/51-hartlander/move');
  const text = lines.join('\n');

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#17202a">
<h2 style="margin:0 0 4px">${esc(state.title || 'Board')}</h2>
<p style="margin:0 0 16px;color:#5d6b7a">${esc(when)}${when ? ' · ' : ''}${done} of ${total} done</p>
${open.map((g) => `<h3 style="margin:16px 0 4px;font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:#e0601f">${esc(g.name)} (${g.items.length})</h3><ul style="margin:0;padding-left:20px">${g.items.map((i) => `<li>${esc(i.t)}</li>`).join('')}</ul>`).join('')}
${open.length ? '' : '<p>Nothing left on the list.</p>'}
<p style="margin-top:24px"><a href="https://family.vasantpatel.xyz/51-hartlander/move" style="color:#e0601f">Open the board</a></p></div>`;
  return { subject, text, html };
}
