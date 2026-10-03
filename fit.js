/* Fits page content to screen height */
(function(){let q=0;const fit=()=>{q=0;const m=document.querySelector('main');if(!m)return;const p=m.querySelector(':scope>.page')||m.firstElementChild;if(!p)return;
p.style.zoom='';p.style.removeProperty('--g');
const cs=getComputedStyle(m),avail=m.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom),nat=p.getBoundingClientRect().height;
if(!nat||avail<=nat)return;
const cap=Math.min(1.22,Math.max(1,m.clientWidth/330)),z=Math.min(cap,avail/nat);
if(z>1.01)p.style.zoom=z.toFixed(3);
const extra=avail-nat*z,n=p.children.length;
if(extra>8&&n>1){const g=Math.min(56,extra/(n-1))*.92;p.style.setProperty('--g',(g/z).toFixed(1)+'px')}};
const sch=()=>{if(!q)q=requestAnimationFrame(fit)};
new MutationObserver(sch).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
addEventListener('resize',sch);addEventListener('load',sch);setTimeout(sch,300);})();
