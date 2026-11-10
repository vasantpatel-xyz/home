// Generic shared checklist. The page sets data-board (API id) and data-title on <body>.
(function(){
  var body = document.body, ID = body.dataset.board, API = '/api/boards/' + ID;
  var rec = null, state = null, pending = [], timer = null, saving = false, dirty = false;
  var palette = ['var(--c1)','var(--c2)','var(--c3)','var(--c4)','var(--c5)','var(--c6)'];
  var statusEl = document.getElementById('status'), metaEl = document.getElementById('meta');

  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function group(id){return state.groups.filter(function(g){return g.id===id;})[0];}
  function setStatus(msg, err){ statusEl.textContent = msg; statusEl.className = 'status' + (err ? ' err' : ''); }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function slug(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,20) || 'g'; }

  function countdown(){
    var el = document.getElementById('countdown');
    if(!state.move){ el.hidden = true; return; }
    el.hidden = false;
    var p = state.move.split('-'), m = new Date(+p[0],+p[1]-1,+p[2]), n = new Date(); n.setHours(0,0,0,0);
    var d = Math.round((m-n)/864e5), label = m.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
    document.getElementById('days').textContent = d > 0 ? d : (d === 0 ? 'Today' : 'Moved');
    document.getElementById('daysLabel').textContent = d > 0 ? (d===1?'day':'days')+' to '+label : label;
  }

  function render(){
    var t = state.title || body.dataset.title || 'List', parts = t.split('→');
    document.getElementById('title').innerHTML = parts.length === 2
      ? esc(parts[0].trim())+' <span class="arrow">→</span> '+esc(parts[1].trim()) : esc(t);
    document.title = t.replace(/→/g,'to');
    countdown();
    var all=0, done=0, html='';
    state.groups.forEach(function(g, gi){
      var c = g.items.filter(function(i){return i.d;}).length, tot=g.items.length, col = palette[gi % palette.length];
      all+=tot; done+=c;
      html += '<section class="box"><div class="card-head"><div class="who"><span class="dot" style="background:'+col+'"></span><h2>'+esc(g.name)+'</h2></div><span class="tally">'+c+' of '+tot+' done</span></div>'
        + '<div class="bar"><i style="width:'+(tot?c/tot*100:0)+'%;background:'+col+'"></i></div><ul>';
      g.items.forEach(function(it,ix){
        var id = 'c-'+g.id+'-'+ix;
        html += '<li class="'+(it.d?'done':'')+'"><input type="checkbox" id="'+id+'" data-g="'+g.id+'" data-i="'+ix+'"'+(it.d?' checked':'')+' aria-label="'+esc(it.t)+'">'
          + '<div class="txt"><label for="'+id+'"><span>'+esc(it.t)+'</span></label>'+(it.s?'<span class="spec">'+esc(it.s)+'</span>':'')
          + (it.u?'<a href="'+esc(it.u)+'" target="_blank" rel="noopener">Open link ↗</a>':'')+'</div>'
          + '<button class="del" data-g="'+g.id+'" data-i="'+ix+'" aria-label="Remove '+esc(it.t)+'">×</button></li>';
      });
      html += '</ul><form class="add" data-g="'+g.id+'"><input id="add-'+g.id+'" placeholder="Add to '+esc(g.name)+'…" autocomplete="off" maxlength="400"><button type="submit">Add</button></form></section>';
    });
    document.getElementById('boxes').innerHTML = html;
    document.getElementById('overallTxt').textContent = done+' / '+all+' done';
    document.getElementById('overallBar').style.width = (all?done/all*100:0)+'%';
    if(!rec || !rec.updatedAt){ metaEl.textContent = ''; }
    else { metaEl.textContent = 'Last change by '+((rec.updatedBy||'').split('@')[0]||'someone')+' · '+new Date(rec.updatedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
  }

  // ops are applied locally now and re-applied on top of a newer server copy on conflict
  function apply(op, s){
    if(op.type==='addgroup'){ if(!s.groups.some(function(g){return g.id===op.id;})) s.groups.push({id:op.id,name:op.name,items:[]}); return; }
    var g = s.groups.filter(function(x){return x.id===op.g;})[0]; if(!g) return;
    if(op.type==='toggle'){ var it = g.items.filter(function(x){return x.t===op.t;})[0]; if(it) it.d = op.d; }
    else if(op.type==='add'){ if(!g.items.some(function(x){return x.t===op.t;})) g.items.push({t:op.t,d:false}); }
    else if(op.type==='del'){ var ix = g.items.map(function(x){return x.t;}).indexOf(op.t); if(ix>=0) g.items.splice(ix,1); }
  }
  function change(op){
    pending.push(op); apply(op, state); dirty = true; render();
    setStatus('Saving…'); clearTimeout(timer); timer = setTimeout(save, 700);
  }

  function save(){
    if(saving || !dirty) return;
    saving = true; dirty = false;
    var ops = pending.slice();
    if(rec.version === 0 && body.dataset.title) state.title = state.title || body.dataset.title;
    fetch(API, {method:'PUT', headers:{'content-type':'application/json'}, credentials:'same-origin', body: JSON.stringify({version: rec.version, state: state})})
    .then(function(r){ return r.json().then(function(b){ return {status:r.status, body:b}; }); })
    .then(function(res){
      if(res.status===200){
        rec = res.body; pending = pending.slice(ops.length);
        if(!dirty){ state = clone(rec.state); render(); setStatus('Saved'); }
      } else if(res.status===409){
        rec = {version:res.body.version, state:res.body.state, updatedAt:res.body.updatedAt, updatedBy:res.body.updatedBy};
        state = clone(rec.state); pending.forEach(function(op){ apply(op, state); });
        dirty = true; render(); setStatus('Someone else just saved – merging…');
      } else if(res.status===401 || res.status===403){ setStatus('Signed out – reload to sign in again.', true); dirty = true; }
      else { setStatus('Couldn’t save ('+res.status+'). Will retry.', true); dirty = true; }
    })
    .catch(function(){ setStatus('Offline – will retry when back.', true); dirty = true; })
    .then(function(){ saving = false; if(dirty){ clearTimeout(timer); timer = setTimeout(save, 2000); } });
  }

  function refresh(){
    if(dirty || saving) return;
    fetch(API, {credentials:'same-origin', cache:'no-store'}).then(function(r){
      if(r.status===401 || r.status===403){ setStatus('Signed out – reload to sign in again.', true); return; }
      if(!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function(b){
      if(!b) return;
      if(!rec || b.version !== rec.version){ rec = b; state = clone(b.state); render(); }
      if(!dirty) setStatus(rec.version ? 'Up to date' : 'Nothing saved yet – tick or add something.');
    }).catch(function(){ if(!rec) setStatus('Couldn’t load the list. Check your connection and reload.', true); });
  }

  document.addEventListener('change', function(e){
    var t=e.target; if(t.type!=='checkbox'||!t.dataset.g) return;
    var it = group(t.dataset.g).items[+t.dataset.i];
    change({type:'toggle', g:t.dataset.g, t:it.t, d:t.checked});
  });
  document.addEventListener('click', function(e){
    var b=e.target.closest('.del'); if(!b) return;
    var it = group(b.dataset.g).items[+b.dataset.i];
    if(!confirm('Remove “'+it.t+'”?')) return;
    change({type:'del', g:b.dataset.g, t:it.t});
  });
  document.addEventListener('submit', function(e){
    var f=e.target.closest('form'); if(!f) return; e.preventDefault();
    var inp=f.querySelector('input'), v=inp.value.trim(); if(!v) return;
    inp.value='';
    if(f.classList.contains('add')) change({type:'add', g:f.dataset.g, t:v});
    else if(f.id==='addgroup'){ var id=slug(v); while(group(id)) id += '2'; change({type:'addgroup', id:id, name:v.slice(0,40)}); }
  });
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='visible') refresh(); });
  window.addEventListener('focus', refresh);
  window.addEventListener('online', function(){ if(dirty) save(); else refresh(); });
  setInterval(function(){ if(document.visibilityState==='visible') refresh(); }, 60000);
  refresh();
})();
