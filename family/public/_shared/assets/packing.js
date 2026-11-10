// Packing list: every thing has where it is now, where it goes, and which box it is in.
// The page sets on <body>: data-doc (API id), data-owner, data-prefix (box letter), data-move (YYYY-MM-DD), data-from, data-to (house names).
(function(){
  var B = document.body.dataset, API = '/api/docs/' + B.doc, FROM = B.from || 'the old house', TO = B.to || 'the new house', PRE = B.prefix || 'B';
  var rec = {version:0, state:{}}, state = {items:[]}, pending = [], timer = null, saving = false, dirty = false, loaded = false;
  var view = 'pack', editing = null, choosing = null;
  var $ = function(id){ return document.getElementById(id); };
  var statusEl = $('status');
  var ROOMS = ['My bedroom','My closet','Playroom','Basement','Living room','Kitchen','Garage','Office','Bathroom','Loft'];

  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function clean(v, n){ return String(v == null ? '' : v).replace(/\s+/g,' ').trim().slice(0, n); }
  function uid(){ return Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function setStatus(msg, err){ statusEl.textContent = msg; statusEl.className = 'status' + (err ? ' err' : ''); }
  function norm(s){
    var items = (s && Array.isArray(s.items)) ? s.items : [];
    return { items: items.filter(function(i){ return i && typeof i.id === 'string' && typeof i.t === 'string' && clean(i.t, 120); }).slice(0, 500).map(function(i){
      return { id: i.id, t: clean(i.t, 120), from: clean(i.from, 40), to: clean(i.to, 40), box: clean(i.box, 8).toUpperCase(), s: (i.s === 1 || i.s === 2) ? i.s : 0 }; }) };
  }
  function canon(room, key){
    var low = room.toLowerCase(), i;
    for(i = 0; i < state.items.length; i++) if(state.items[i][key] && state.items[i][key].toLowerCase() === low) return state.items[i][key];
    for(i = 0; i < ROOMS.length; i++) if(ROOMS[i].toLowerCase() === low) return ROOMS[i];
    return room;
  }
  function find(id){ for(var i = 0; i < state.items.length; i++) if(state.items[i].id === id) return state.items[i]; return null; }
  function groups(key, blank){
    var map = {}, order = [];
    state.items.forEach(function(it){ var k = it[key] || blank; if(!map[k]){ map[k] = []; order.push(k); } map[k].push(it); });
    order.sort(function(a, b){ if(a === blank) return 1; if(b === blank) return -1; return a.localeCompare(b, undefined, {numeric:true}); });
    return order.map(function(k){ return [k, map[k]]; });
  }
  function boxes(){ return groups('box', '').filter(function(g){ return g[0] !== ''; }); }
  function nextBox(){ var max = 0; state.items.forEach(function(it){ var m = /(\d+)\s*$/.exec(it.box || ''); if(m && it.box.indexOf(PRE) === 0) max = Math.max(max, +m[1]); }); return PRE + (max + 1); }
  function dests(list){ var seen = {}, out = []; list.forEach(function(it){ var d = it.to || 'not decided yet'; if(!seen[d]){ seen[d] = 1; out.push(d); } }); return out; }

  // ---- ops: applied here right away, and re-applied on top of a newer copy if someone else saved first
  function apply(op, st){
    if(op.type === 'add'){ if(!st.items.some(function(x){ return x.id === op.item.id; })) st.items.push(clone(op.item)); return; }
    var it = null, ix = -1;
    for(var i = 0; i < st.items.length; i++) if(st.items[i].id === op.id){ it = st.items[i]; ix = i; break; }
    if(!it) return;
    if(op.type === 'edit'){ for(var k in op.f) it[k] = op.f[k]; }
    else if(op.type === 'status'){ it.s = op.s; if(op.box !== undefined) it.box = op.box; }
    else if(op.type === 'del'){ st.items.splice(ix, 1); }
  }
  function change(op){ pending.push(op); apply(op, state); dirty = true; render(); setStatus('Saving…'); clearTimeout(timer); timer = setTimeout(save, 600); }

  function row(it, mode){
    var on = mode === 'unpack' ? it.s === 2 : it.s >= 1;
    var chip = it.box ? '<b class="chip">Box ' + esc(it.box) + '</b>' : '<b class="chip none">no box yet</b>';
    var sub = mode === 'pack' ? 'goes to: ' + esc(it.to || 'not decided yet') + ' · ' + chip
            : mode === 'unpack' ? chip + ' · was in: ' + esc(it.from || '?')
            : esc(it.from || '?') + ' → ' + esc(it.to || 'not decided yet') + (it.s === 2 ? ' · placed' : it.s === 1 ? ' · packed' : ' · not packed');
    var label = (mode === 'unpack' ? 'Placed: ' : 'Packed: ') + it.t;
    return '<li class="prow' + (on ? ' done' : '') + '">'
      + (mode === 'boxes' ? '' : '<button type="button" class="tick" data-id="' + esc(it.id) + '" aria-pressed="' + on + '" aria-label="' + esc(label) + '">' + (on ? '✓' : '') + '</button>')
      + '<div class="txt"><span class="nm">' + esc(it.t) + '</span><span class="spec">' + sub + '</span></div>'
      + '<button type="button" class="edit" data-id="' + esc(it.id) + '" aria-label="Edit ' + esc(it.t) + '">✎</button></li>';
  }
  function section(title, tally, rowsHtml, warn){
    return '<section class="box"><div class="card-head"><div class="who"><h2>' + esc(title) + '</h2></div><span class="tally">' + esc(tally) + '</span></div><ul>' + rowsHtml + '</ul>' + (warn ? '<p class="warn">' + esc(warn) + '</p>' : '') + '</section>';
  }

  function render(){
    var n = state.items.length, packed = state.items.filter(function(i){ return i.s >= 1; }).length, placed = state.items.filter(function(i){ return i.s === 2; }).length;
    $('overallTxt').textContent = n ? packed + ' of ' + n + ' packed · ' + placed + ' placed' : 'Nothing on the list yet';
    $('overallBar').style.width = (n ? packed / n * 100 : 0) + '%';
    var tabs = document.querySelectorAll('.tab'); for(var t = 0; t < tabs.length; t++) tabs[t].setAttribute('aria-selected', String(tabs[t].dataset.v === view));
    var html = '';
    if(!n){
      html = '<div class="empty"><b>Start your list</b>Add each thing you care about below: what it is, where it is now, and where it should go in the new house.</div>';
    } else if(view === 'pack'){
      $('hint').textContent = 'Go room by room at ' + FROM + '. Tap the square when a thing is in a box.';
      groups('from', 'Not sure where it is').forEach(function(g){
        var d = g[1].filter(function(i){ return i.s >= 1; }).length;
        html += section(g[0], d + ' of ' + g[1].length + ' packed', g[1].map(function(i){ return row(i, 'pack'); }).join(''));
      });
    } else if(view === 'boxes'){
      $('hint').textContent = 'One box should go to one room. Print the labels and tape one on each box.';
      var bx = boxes();
      bx.forEach(function(g){
        var ds = dests(g[1]);
        html += section('Box ' + g[0] + ' → ' + (ds.length === 1 ? ds[0] : ds.length + ' rooms'), g[1].length + (g[1].length === 1 ? ' thing' : ' things'), g[1].map(function(i){ return row(i, 'boxes'); }).join(''),
          ds.length > 1 ? 'This box is going to ' + ds.length + ' different rooms (' + ds.join(', ') + '). Move things so each box goes to one room.' : '');
      });
      var loose = state.items.filter(function(i){ return !i.box; });
      if(loose.length) html += section('No box yet', loose.length + (loose.length === 1 ? ' thing' : ' things'), loose.map(function(i){ return row(i, 'boxes'); }).join(''));
      if(bx.length) html += '<button type="button" class="btn ghost" id="printlabels">🖨️ Print box labels (' + bx.length + ')</button>';
    } else {
      $('hint').textContent = 'At ' + TO + ': go room by room. Tap the square when a thing is in its new spot.';
      groups('to', 'Not decided yet').forEach(function(g){
        var d = g[1].filter(function(i){ return i.s === 2; }).length;
        html += section(g[0], d + ' of ' + g[1].length + ' placed', g[1].map(function(i){ return row(i, 'unpack'); }).join(''));
      });
    }
    if(!n) $('hint').textContent = '';
    $('list').innerHTML = html;

    // room suggestions = rooms already used + a starter set
    var seenF = {}, seenT = {}, f = [], tt = [];
    state.items.forEach(function(i){ if(i.from && !seenF[i.from]){ seenF[i.from] = 1; f.push(i.from); } if(i.to && !seenT[i.to]){ seenT[i.to] = 1; tt.push(i.to); } });
    ROOMS.forEach(function(r){ if(!seenF[r]) f.push(r); if(!seenT[r]) tt.push(r); });
    $('fromlist').innerHTML = f.map(function(r){ return '<option value="' + esc(r) + '">'; }).join('');
    $('tolist').innerHTML = tt.map(function(r){ return '<option value="' + esc(r) + '">'; }).join('');

    // printable labels, one per box
    $('labels').innerHTML = boxes().map(function(g){
      var ds = dests(g[1]), fr = {}, frs = []; g[1].forEach(function(i){ var x = i.from || '?'; if(!fr[x]){ fr[x] = 1; frs.push(x); } });
      return '<div class="label"><div class="who">' + esc(B.owner || '') + '</div><div class="boxno">BOX ' + esc(g[0]) + '</div><div class="to">→ ' + esc(ds.join(' + ')) + '</div><div class="from">' + esc(TO) + ' · packed at ' + esc(FROM) + ': ' + esc(frs.join(', ')) + '</div><ul>' + g[1].map(function(i){ return '<li>' + esc(i.t) + '</li>'; }).join('') + '</ul></div>';
    }).join('');

    $('formtitle').textContent = editing ? 'Change this thing' : 'Add a thing';
    $('addbtn').textContent = editing ? 'Save changes' : 'Add to my list';
    $('canceledit').hidden = !editing; $('delbtn').hidden = !editing; $('boxfield').hidden = !editing;
    if(!rec.updatedAt) $('meta').textContent = '';
    else $('meta').textContent = 'Last change by ' + ((rec.updatedBy || '').split('@')[0] || 'someone') + ' · ' + new Date(rec.updatedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  }

  function openChooser(it){
    choosing = it.id;
    var html = '<h2>Which box is “' + esc(it.t) + '” going in?</h2><p class="hint">It goes to: <b>' + esc(it.to || 'not decided yet') + '</b></p>';
    boxes().forEach(function(g){
      var ds = dests(g[1]), match = ds.length === 1 && ds[0] === (it.to || 'not decided yet');
      html += '<button type="button" class="pick' + (match ? ' match' : '') + '" data-box="' + esc(g[0]) + '">Box ' + esc(g[0]) + (match ? ' ✓ same room' : '') + '<small>→ ' + esc(ds.join(' + ')) + ' · ' + g[1].length + (g[1].length === 1 ? ' thing' : ' things') + ' so far</small></button>';
    });
    html += '<button type="button" class="pick new" data-box="' + esc(nextBox()) + '">Start a new box: ' + esc(nextBox()) + '</button>'
      + '<button type="button" class="pick" data-box="">No box (I will carry it)</button><button type="button" class="btn ghost" id="closechooser">Cancel</button>';
    $('chooserbody').innerHTML = html; $('chooser').hidden = false;
    var first = $('chooserbody').querySelector('.pick'); if(first) first.focus();
  }
  function closeChooser(){ $('chooser').hidden = true; choosing = null; }

  function startEdit(it){
    editing = it.id; $('f-t').value = it.t; $('f-from').value = it.from; $('f-to').value = it.to; $('f-box').value = it.box; render();
    $('addform').scrollIntoView({block:'center'}); $('f-t').focus();
  }
  function stopEdit(){ editing = null; $('addform').reset(); render(); }

  function save(){
    if(saving || !dirty) return; saving = true; dirty = false;
    var ops = pending.slice();
    fetch(API, {method:'PUT', headers:{'content-type':'application/json'}, credentials:'same-origin', body: JSON.stringify({version: rec.version, state: state})})
    .then(function(r){ return r.json().then(function(b){ return {status: r.status, body: b}; }); })
    .then(function(res){
      if(res.status === 200){ rec = res.body; pending = pending.slice(ops.length); if(!dirty){ state = norm(rec.state); render(); setStatus('Saved'); } }
      else if(res.status === 409){
        rec = {version: res.body.version, state: res.body.state, updatedAt: res.body.updatedAt, updatedBy: res.body.updatedBy};
        state = norm(rec.state); pending.forEach(function(op){ apply(op, state); }); dirty = true; render(); setStatus('Someone else just saved. Putting both together…');
      } else if(res.status === 401 || res.status === 403){ setStatus('Signed out. Reload the page to sign in again.', true); dirty = true; }
      else if(res.status === 413){ setStatus('The list is too big to save. Remove a few things.', true); }
      else { setStatus('Couldn’t save. Trying again…', true); dirty = true; }
    })
    .catch(function(){ setStatus('Offline. Your changes are kept and will save when you are back online.', true); dirty = true; })
    .then(function(){ saving = false; if(dirty){ clearTimeout(timer); timer = setTimeout(save, 2500); } });
  }
  function load(){
    if(dirty || saving) return;
    fetch(API, {credentials:'same-origin', cache:'no-store'}).then(function(r){
      if(r.status === 401 || r.status === 403){ setStatus('Signed out. Reload the page to sign in again.', true); return null; }
      if(!r.ok) throw new Error(r.status); return r.json();
    }).then(function(b){
      if(!b || dirty || saving) return;
      if(!loaded || b.version !== rec.version){ rec = b; state = norm(b.state); }
      loaded = true; if(!editing && $('chooser').hidden) render(); setStatus('');
    }).catch(function(){ if(!loaded) setStatus('Couldn’t load the list. Check the connection and reload.', true); });
  }

  document.addEventListener('click', function(e){
    var el;
    if((el = e.target.closest('.tab'))){ view = el.dataset.v; render(); return; }
    if((el = e.target.closest('.tick'))){
      var it = find(el.dataset.id); if(!it) return;
      if(view === 'unpack') change({type:'status', id: it.id, s: it.s === 2 ? (it.box ? 1 : 0) : 2});
      else if(it.s >= 1) change({type:'status', id: it.id, s: 0});
      else openChooser(it);
      return;
    }
    if((el = e.target.closest('.pick'))){ var id = choosing, box = el.dataset.box; closeChooser(); if(id) change({type:'status', id: id, s: 1, box: box}); return; }
    if(e.target.id === 'closechooser' || e.target.id === 'chooser'){ closeChooser(); return; }
    if((el = e.target.closest('.edit'))){ var x = find(el.dataset.id); if(x) startEdit(x); return; }
    if(e.target.id === 'canceledit'){ stopEdit(); return; }
    if(e.target.id === 'delbtn'){ var d = find(editing); if(d && confirm('Take “' + d.t + '” off the list?')){ var did = d.id; editing = null; $('addform').reset(); change({type:'del', id: did}); } return; }
    if(e.target.id === 'printlabels'){ window.print(); return; }
  });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && !$('chooser').hidden) closeChooser(); });
  $('addform').addEventListener('submit', function(e){
    e.preventDefault();
    var t = clean($('f-t').value, 120), from = canon(clean($('f-from').value, 40), 'from'), to = canon(clean($('f-to').value, 40), 'to'), box = clean($('f-box').value, 8).toUpperCase();
    if(!t){ $('f-t').focus(); return; }
    if(editing){ var id = editing; editing = null; change({type:'edit', id: id, f: {t: t, from: from, to: to, box: box}}); }
    else { if(state.items.length >= 500){ setStatus('That is a lot of things! The list holds 500.', true); return; } change({type:'add', item: {id: uid(), t: t, from: from, to: to, box: '', s: 0}}); }
    $('addform').reset(); $('f-from').value = from; $('f-to').value = to; $('f-t').focus(); // keep the rooms: the next thing is usually in the same place
    if(editing === null) render();
  });
  $('bulkform').addEventListener('submit', function(e){
    e.preventDefault();
    var lines = $('bulktext').value.split(/\r?\n/), added = 0;
    lines.forEach(function(line){
      var p = line.split(/\s*[|,\t;]\s*/), t = clean((p[0] || '').replace(/^\s*(?:[-*•]\s*|\d+[.)]\s+)/, ''), 120);
      if(!t || state.items.length >= 500) return;
      change({type:'add', item: {id: uid(), t: t, from: canon(clean(p[1], 40), 'from'), to: canon(clean(p[2], 40), 'to'), box: '', s: 0}}); added++;
    });
    if(added){ $('bulktext').value = ''; $('bulk').open = false; setStatus('Added ' + added + (added === 1 ? ' thing' : ' things') + '. Saving…'); }
  });
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible') load(); });
  window.addEventListener('online', function(){ if(dirty) save(); else load(); });
  setInterval(function(){ if(document.visibilityState === 'visible') load(); }, 60000);

  // countdown
  if(B.move){ var p = B.move.split('-'), m = new Date(+p[0], +p[1]-1, +p[2]), now = new Date(); now.setHours(0,0,0,0); var dd = Math.round((m - now) / 864e5);
    $('days').textContent = dd > 0 ? dd : (dd === 0 ? 'Today' : 'Moved'); $('daysLabel').textContent = dd > 0 ? (dd === 1 ? 'day' : 'days') + ' to moving day' : 'moving day'; }
  render(); load();
})();
