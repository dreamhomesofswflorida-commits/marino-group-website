/* Marino Group buyer accounts: sign in by email link, save homes (hearts), save searches with alerts,
   request a tour. Uses Supabase tables favorites, saved_searches and leads (schema-v3.sql).
   Listings come from /listings/listings.json (Marino Group listings, refreshed daily). */
(function(){
  const C = window.MG_CONFIG || {};
  const LIVE = !!(C.SUPABASE_URL && C.SUPABASE_ANON_KEY && window.supabase);
  const sb = LIVE ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY) : null;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const S = { user:null, favs:new Set(), searches:[], homes:[] };

  const css = document.createElement("style");
  css.textContent = `
  .acct{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 20px}
  .acct form{display:flex;gap:8px;flex-wrap:wrap}.acct input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:inherit;min-width:220px}
  .acct .b{font:500 15px var(--body,inherit);padding:10px 18px;border-radius:999px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;text-decoration:none}
  .acct .b.gold{background:var(--gold-soft,#d8c3a0);border-color:var(--gold,#b8955d);color:#1e1d1c}
  .lgrid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
  .lcard{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden;display:flex;flex-direction:column}
  .lcard img{width:100%;height:180px;object-fit:cover;display:block;background:var(--sunk,#ece6dc)}
  .lcard .t{padding:14px 16px;display:grid;gap:4px;flex:1}.lcard .p{font:500 22px var(--display,inherit)}
  .lcard .m{color:var(--muted);font-size:14px}.lcard .acts{display:flex;gap:8px;padding:0 16px 16px}
  .lcard .acts button,.lcard .acts a{font:500 14px inherit;padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;text-decoration:none}
  .heart{position:absolute;top:10px;right:10px;width:42px;height:42px;border-radius:50%;border:0;background:#fffe;display:grid;place-items:center;cursor:pointer;box-shadow:0 2px 8px #0003}
  .heart svg{width:22px;height:22px}.heart[aria-pressed=true] svg path{fill:#c0392b;stroke:#c0392b}
  .rent{position:absolute;top:10px;left:10px;background:#1e1d1c;color:#f3ece0;font-size:12px;padding:3px 10px;border-radius:999px}
  .mgdlg{position:fixed;inset:0;background:#0008;display:grid;place-items:center;z-index:50;padding:16px}
  .mgdlg .box{background:var(--bg,#f6f3ee);color:var(--fg,#1e1d1c);border-radius:18px;padding:22px;width:min(520px,100%);max-height:90vh;overflow:auto}
  .mgdlg label{display:block;font-size:14px;color:var(--muted);margin:10px 0 4px}.mgdlg input,.mgdlg select,.mgdlg textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:inherit}
  .saved{display:grid;gap:8px;margin-top:12px}.saved li{list-style:none;display:flex;justify-content:space-between;gap:10px;align-items:center;border-bottom:1px solid var(--line);padding:8px 0}`;
  document.head.appendChild(css);

  const heart = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.8 8.3 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.5.7-1.3 2.2-2.5 4.3-2.5 3.7 0 5.9 3.8 4.3 7.3C19.5 16.4 12 21 12 21z" fill="none" stroke="#1e1d1c" stroke-width="1.8"/></svg>`;

  async function load(){
    try{ const j = await (await fetch("/listings/listings.json",{cache:"no-cache"})).json(); S.homes = (j.homes||[]); if(window.MG_FILTER==="rent") S.homes=S.homes.filter(h=>h.rent); if(window.MG_FILTER==="sale") S.homes=S.homes.filter(h=>!h.rent); }catch(e){ S.homes = []; }
    if(LIVE){
      const {data:{session}} = await sb.auth.getSession(); S.user = session?.user || null;
      sb.auth.onAuthStateChange((_e,s)=>{ const u=s?.user||null; if((u&&u.id)!==(S.user&&S.user.id)){ S.user=u; refresh(); } });
    }
    await refresh();
  }
  async function refresh(){
    if(S.user){
      const [f,s] = await Promise.all([sb.from("favorites").select("listing_id"), sb.from("saved_searches").select("*").order("created_at",{ascending:false})]);
      S.favs = new Set((f.data||[]).map(x=>x.listing_id)); S.searches = s.data||[];
    } else { S.favs = new Set(); S.searches = []; }
    drawAcct(); drawHomes();
  }

  function drawAcct(){
    const el = $("#acct"); if(!el) return;
    if(!LIVE){ el.innerHTML = `<span>Save homes and get alerts: coming soon.</span>`; return; }
    if(!S.user){
      el.innerHTML = `<div><b>Save homes and get new-listing alerts</b><br><span class="m" style="color:var(--muted);font-size:14px">Free. No password: we email you a sign-in link.</span></div>
        <form id="mgIn"><input type="email" required placeholder="you@email.com" autocomplete="email" aria-label="Email"><button class="b gold">Email me a link</button></form>`;
      $("#mgIn").onsubmit = async e=>{ e.preventDefault(); const em=e.target.querySelector("input").value.trim();
        const {error} = await sb.auth.signInWithOtp({email:em, options:{emailRedirectTo: location.origin + location.pathname + location.search}});
        e.target.innerHTML = error ? `<span>${esc(error.message)}</span>` : `<span>Check <b>${esc(em)}</b> for your sign-in link.</span>`; };
      return;
    }
    el.innerHTML = `<div><b>Signed in as ${esc(S.user.email)}</b><br><span style="color:var(--muted);font-size:14px">${S.favs.size} saved home${S.favs.size===1?"":"s"} · ${S.searches.length} saved search${S.searches.length===1?"":"es"}</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="b gold" id="mgSave">Save this search</button><button class="b" id="mgMine">My saved</button><button class="b" id="mgOut">Sign out</button></div>`;
    $("#mgSave").onclick = saveSearch; $("#mgMine").onclick = mine; $("#mgOut").onclick = async()=>{ await sb.auth.signOut(); S.user=null; refresh(); };
  }

  function drawHomes(){
    const el = $("#lgrid"); if(!el) return;
    if(!S.homes.length){ el.innerHTML = `<p class="lead">Our listings will appear here.</p>`; return; }
    el.innerHTML = S.homes.map(h=>`<div class="lcard">
      <img src="/${esc(h.photo)}" alt="${esc(h.street)}" loading="lazy">${h.rent?`<span class="rent">For rent</span>`:""}
      <button class="heart" data-fav="${esc(h.id)}" aria-pressed="${S.favs.has(String(h.id))}" aria-label="Save ${esc(h.street)}">${heart}</button>
      <div class="t"><span class="p">${esc(h.price)}${h.rent?"/mo":""}</span><span>${esc(h.street)}, ${esc(h.city)} ${esc(h.zip)}</span>
        <span class="m">${[h.beds!=null&&h.beds+" bd",h.baths&&h.baths+" ba",h.sqft&&h.sqft+" sq ft",h.acres&&h.acres+" ac",h.type].filter(Boolean).map(esc).join(" · ")}</span></div>
      <div class="acts"><button data-tour="${esc(h.id)}">${h.rent?"Ask about renting":"Request a tour"}</button><a href="/check/?address=${encodeURIComponent(h.street+", "+h.city+", FL "+h.zip)}${h.rent?"":"&price="+(h.priceNum||"")}">Property check</a></div></div>`).join("");
    el.querySelectorAll("[data-fav]").forEach(b=>b.onclick=()=>toggleFav(b));
    el.querySelectorAll("[data-tour]").forEach(b=>b.onclick=()=>tour(S.homes.find(h=>String(h.id)===b.dataset.tour)));
  }

  async function toggleFav(b){
    if(!LIVE) return;
    if(!S.user){ $("#acct").scrollIntoView({behavior:"smooth",block:"center"}); $("#mgIn input")?.focus(); return; }
    const id=b.dataset.fav, h=S.homes.find(x=>String(x.id)===id), on=S.favs.has(id);
    b.setAttribute("aria-pressed", String(!on));
    const r = on ? await sb.from("favorites").delete().eq("listing_id",id)
                 : await sb.from("favorites").insert({listing_id:id,address:`${h.street}, ${h.city}`,price:h.priceNum||null});
    if(r.error){ b.setAttribute("aria-pressed", String(on)); alert(r.error.message); return; }
    on ? S.favs.delete(id) : S.favs.add(id); drawAcct();
  }

  function dialog(html){ const d=document.createElement("div"); d.className="mgdlg"; d.innerHTML=`<div class="box" role="dialog" aria-modal="true">${html}</div>`;
    d.onclick=e=>{ if(e.target===d) d.remove(); }; document.body.appendChild(d); d.querySelector("input,select,button")?.focus(); return d; }

  function tour(h){
    const d = dialog(`<h3 style="font-family:var(--display);font-weight:400;font-size:24px;margin:0">${h.rent?"Ask about":"Tour"} ${esc(h.street)}</h3>
      <form id="tf"><label>Your name</label><input name="name" required autocomplete="name">
      <label>Mobile</label><input name="phone" type="tel" autocomplete="tel"><label>Email</label><input name="email" type="email" autocomplete="email" value="${esc(S.user?.email||"")}">
      ${h.rent?`<label>Move-in date</label><input name="when" type="date">`:`<label>Preferred day and time</label><input name="when" placeholder="e.g. Saturday morning">`}
      <label>Working with an agent already?</label><select name="agent"><option>No</option><option>Yes</option></select>
      <label>Language</label><select name="language"><option>English</option><option>Español</option><option>Русский</option></select>
      <p class="err" style="color:#b4472c" hidden></p>
      <div style="display:flex;gap:8px;margin-top:14px"><button class="b gold" style="font:500 15px inherit;padding:10px 18px;border-radius:999px;border:1px solid #b8955d;background:#d8c3a0;color:#1e1d1c">Send</button><button type="button" class="b" style="font:500 15px inherit;padding:10px 18px;border-radius:999px;border:1px solid var(--line);background:transparent;color:inherit" data-x>Cancel</button></div></form>`);
    d.querySelector("[data-x]").onclick=()=>d.remove();
    d.querySelector("#tf").onsubmit = async e=>{ e.preventDefault(); const f=Object.fromEntries(new FormData(e.target)), er=d.querySelector(".err");
      if(!f.phone && !f.email){ er.textContent="Please add a phone or email."; er.hidden=false; return; }
      const row={name:f.name.trim(),phone:f.phone||null,email:f.email||null,language:f.language,lead_type:h.rent?"renter":"tour",listing_id:String(h.id),
        address:`${h.street}, ${h.city}, FL ${h.zip}`,source:"website /homes",details:{when:f.when,has_agent:f.agent,price:h.price}};
      if(!LIVE){ d.remove(); return; }
      const {error}=await sb.from("leads").insert(row);
      d.querySelector(".box").innerHTML = error ? `<p>Sorry, that didn't send. Please call or text (239) 776-2393.</p>` : `<h3 style="font-family:var(--display);font-weight:400;font-size:24px;margin:0">Request sent</h3><p style="margin-top:8px">We'll contact you shortly to confirm. Questions? (239) 776-2393.</p><button class="b" style="margin-top:12px;padding:10px 18px;border-radius:999px;border:1px solid var(--line);background:transparent;color:inherit">Close</button>`;
      d.querySelector("button")?.addEventListener("click",()=>d.remove()); };
  }

  async function saveSearch(){
    const form = document.getElementById("hs"); const raw = Object.fromEntries(new FormData(form)); raw.f = new FormData(form).getAll("f");
    const label = (document.getElementById("summary")||{}).textContent || "My search";
    const d = dialog(`<h3 style="font-family:var(--display);font-weight:400;font-size:24px;margin:0">Save this search</h3><p style="margin-top:6px;color:var(--muted)">${esc(label)}</p>
      <label>Name</label><input id="ssn" value="${esc(label)}"><label>Email me new matches</label><select id="ssf"><option value="instant">As soon as they list</option><option value="daily" selected>Once a day</option><option value="weekly">Once a week</option><option value="off">Don't email me</option></select>
      <div style="display:flex;gap:8px;margin-top:14px"><button style="font:500 15px inherit;padding:10px 18px;border-radius:999px;border:1px solid #b8955d;background:#d8c3a0;color:#1e1d1c" id="sso">Save</button><button style="font:500 15px inherit;padding:10px 18px;border-radius:999px;border:1px solid var(--line);background:transparent;color:inherit" data-x>Cancel</button></div>`);
    d.querySelector("[data-x]").onclick=()=>d.remove();
    d.querySelector("#sso").onclick = async()=>{ const {error}=await sb.from("saved_searches").insert({name:d.querySelector("#ssn").value.trim()||label,criteria:raw,frequency:d.querySelector("#ssf").value});
      if(error){ alert(error.message); return; } d.remove(); refresh(); };
  }

  function mine(){
    const favs = S.homes.filter(h=>S.favs.has(String(h.id)));
    const d = dialog(`<h3 style="font-family:var(--display);font-weight:400;font-size:24px;margin:0">My saved</h3>
      <h4 style="margin:16px 0 0">Homes</h4><ul class="saved">${favs.map(h=>`<li><span>${esc(h.street)}, ${esc(h.city)} · ${esc(h.price)}</span><button data-unfav="${esc(h.id)}" style="border:1px solid var(--line);background:transparent;color:inherit;border-radius:999px;padding:4px 10px;cursor:pointer">Remove</button></li>`).join("") || "<li>No saved homes yet. Tap a heart to save one.</li>"}</ul>
      <h4 style="margin:16px 0 0">Searches</h4><ul class="saved">${S.searches.map(s=>`<li><span>${esc(s.name)}<br><small style="color:var(--muted)">Alerts: ${esc(s.frequency)}</small></span><span style="display:flex;gap:6px"><a href="/homes/?${new URLSearchParams(Object.entries(s.criteria||{}).flatMap(([k,v])=>Array.isArray(v)?v.map(x=>[k,x]):v?[[k,v]]:[]))}" style="border:1px solid var(--line);border-radius:999px;padding:4px 10px;text-decoration:none">Open</a><button data-unsave="${s.id}" style="border:1px solid var(--line);background:transparent;color:inherit;border-radius:999px;padding:4px 10px;cursor:pointer">Delete</button></span></li>`).join("") || "<li>No saved searches yet.</li>"}</ul>
      <p style="color:var(--muted);font-size:13px;margin-top:12px">Alerts for every Southwest Florida listing start when our full MLS search goes live. Until then, a Marino Group agent emails you matching homes.</p>
      <button data-x style="margin-top:10px;font:500 15px inherit;padding:10px 18px;border-radius:999px;border:1px solid var(--line);background:transparent;color:inherit">Close</button>`);
    d.querySelector("[data-x]").onclick=()=>d.remove();
    d.querySelectorAll("[data-unfav]").forEach(b=>b.onclick=async()=>{ await sb.from("favorites").delete().eq("listing_id",b.dataset.unfav); d.remove(); await refresh(); mine(); });
    d.querySelectorAll("[data-unsave]").forEach(b=>b.onclick=async()=>{ await sb.from("saved_searches").delete().eq("id",b.dataset.unsave); d.remove(); await refresh(); mine(); });
  }

  // Used by the "Get matching homes sent to you" form on /homes
  async function searchLead(data, raw){
    const row={name:data.Name.trim(),email:data.Email||null,phone:data.Phone||null,lead_type:"buyer",timeline:data.Timeline,source:"website /homes",details:raw,address:null};
    const {error}=await sb.from("leads").insert(row); if(error) throw error;
    if(S.user) await sb.from("saved_searches").insert({name:(document.getElementById("summary")||{}).textContent||"My search",criteria:raw,frequency:"daily"});
  }
  window.MGBuyer = { live: LIVE, searchLead, insertLead: async row => { const {error}=await sb.from("leads").insert(row); if(error) throw error; } };
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",load); else load();
})();
