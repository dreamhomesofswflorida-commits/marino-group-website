/* Marino Group app: website pages opened from the app get a "Back to app" button,
   because the iPhone app has no browser back button. Only shows inside the app. */
(function(){
  var inApp=false;
  try{ inApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || sessionStorage.getItem("mgApp")==="1"; }catch(e){}
  if(!inApp || location.pathname.indexOf("/app/")===0) return;
  // Sign-in areas (client portal, agent showings) stay on the website, not in the app.
  if(/^\/(portal|showings|course)(\/|$)/.test(location.pathname)){ location.replace("/app/"); return; }
  try{ var st0=document.createElement("style"); st0.textContent='a[href^="/portal"],a[href^="/showings"],a[href^="/course"]{display:none!important}'; (document.head||document.documentElement).appendChild(st0); }catch(e){}
  function add(){
    if(document.getElementById("mg-app-back")) return;
    var a=document.createElement("a");
    a.id="mg-app-back"; a.href="/app/"; a.setAttribute("aria-label","Back to the Marino Homes app");
    a.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg><span>Back to app</span>';
    a.style.cssText="position:fixed;left:14px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483000;display:flex;align-items:center;gap:6px;padding:11px 16px 11px 12px;border-radius:999px;background:#141312;color:#f3ece0;font:600 15px/1 Figtree,'Segoe UI',Arial,sans-serif;text-decoration:none;box-shadow:0 6px 20px rgba(0,0,0,.28)";
    a.addEventListener("click",function(e){ if(history.length>1 && document.referrer.indexOf("/app/")>-1){ e.preventDefault(); history.back(); } });
    var st=document.createElement("style");
    st.textContent="@keyframes mgBackIn{from{opacity:0;transform:translateX(-24px) scale(.92)}to{opacity:1;transform:none}}"+
      "@keyframes mgBackNudge{0%,100%{transform:translateX(0)}50%{transform:translateX(-4px)}}"+
      "#mg-app-back{animation:mgBackIn .55s cubic-bezier(.2,.8,.4,1) .35s both;transition:filter .2s linear,box-shadow .2s ease}"+
      "#mg-app-back svg{animation:mgBackNudge 1.6s ease-in-out 1s 2}"+
      "#mg-app-back:active{filter:brightness(1.35)}"+
      "@media (prefers-reduced-motion:reduce){#mg-app-back,#mg-app-back svg{animation:none}}";
    document.head.appendChild(st);
    document.body.appendChild(a);
  }
  if(document.body) add(); else document.addEventListener("DOMContentLoaded",add);
})();
