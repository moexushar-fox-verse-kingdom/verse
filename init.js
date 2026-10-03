/* Telegram viewport / safe-area setup */
(function(){const R=document.documentElement.style,T=()=>window.Telegram&&window.Telegram.WebApp;
const vh=()=>{const w=T();R.setProperty('--tg-vh',((w&&(w.viewportStableHeight||w.viewportHeight))||window.innerHeight)+'px')};
const sa=()=>{const w=T()||{},a=w.safeAreaInset||{},c=w.contentSafeAreaInset||{},t=(+a.top||0)+(+c.top||0),b=(+a.bottom||0)+(+c.bottom||0);R.setProperty('--safe-top',t>0?t+'px':'env(safe-area-inset-top,0px)');R.setProperty('--safe-bottom',b>0?b+'px':'env(safe-area-inset-bottom,0px)')};
const bind=()=>{const w=T();vh();sa();if(w&&w.onEvent&&!bind.d){bind.d=1;w.onEvent('viewportChanged',vh);['safeAreaChanged','contentSafeAreaChanged','fullscreenChanged'].forEach(e=>w.onEvent(e,sa))}};
vh();sa();addEventListener('resize',vh);addEventListener('orientationchange',()=>setTimeout(vh,150));addEventListener('load',bind);setTimeout(bind,600);})();

/* Ban long-press menu, text selection & drag (inputs excluded so typing/paste still works) */
(function(){const ok=e=>{const t=e.target;return t&&t.closest&&t.closest('input,textarea')};
['contextmenu','selectstart','dragstart'].forEach(n=>document.addEventListener(n,e=>{if(!ok(e))e.preventDefault()},{passive:false}));
document.addEventListener('copy',e=>{if(!ok(e))e.preventDefault()});})();
