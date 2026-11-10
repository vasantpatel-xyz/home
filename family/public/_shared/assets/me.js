// Shows who is signed in (from the Cloudflare Access login) in the top bar.
fetch('/api/me',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null;}).then(function(m){
  var el=document.getElementById('me'); if(el&&m&&m.email) el.textContent=m.email.split('@')[0];
}).catch(function(){});
