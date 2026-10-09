/* Miner app logic: config, backend adapter, store, pages, router */
/* ===== 0. ADS (dynamic: admin panel picks Monetag OR Adsgram + the Zone/Block ID, saved in database adConfig) =====
   backend.js listens to adConfig and calls Ads.configure(). Only the ACTIVE provider's SDK is loaded, and it is loaded
   right away (prewarm), BEFORE any tap. A tap then calls the SDK function directly with NO await before it, so the ad
   opens inside the user's tap (this is exactly how the working Watch Ad test page does it).
   Monetag: SDK tag carries data-zone / data-sdk and defines window.show_<zone>().  Adsgram: Adsgram.init({blockId}).show().
   backend.js uses window.Ads / window.showRewardedAd. If the admin leaves the Monetag zone empty, DEFAULT_ZONE is used.
   AUTO AD: whichever network is active (Monetag or Adsgram) opens an ad by itself at a random 2-5 minute gap. No admin setting. */
const Ads=(()=>{
  const DEFAULT_ZONE='11977341';
  const HOSTS={monetag:['https://libtl.com/sdk.js','https://yoszi.com/sdk.js'],adsgram:['https://sad.adsgram.ai/js/sad.min.js']};   // several hosts: Monetag rotates them
  const okZone=z=>/^[0-9]{1,12}$/.test(z),okBlock=b=>/^(int-)?[0-9]{1,12}$/.test(b);
  const MSG={wait:'Ad is loading... please tap again in a moment.',load:'Could not load the ad. Turn off your ad blocker and try again.',
    nofill:'No ad available right now. Please try again in a moment.',busy:'An ad is already loading. Please wait.',
    unset:'Ads are not configured yet.',skip:'Watch the full ad to get the reward.'};
  let cfg={provider:'monetag',zoneId:DEFAULT_ZONE,blockId:''},got=false,busyAt=0,last=0;
  const M={zone:'',script:null,p:null},G={p:null,ctl:{}},failed={monetag:false,adsgram:false};
  const fnName=z=>'show_'+z;

  /* script loader: resolves on load, rejects on error / timeout (ad blockers make it fail) */
  const inject=(src,attrs)=>new Promise((res,rej)=>{
    const s=document.createElement('script');let t;
    const fail=w=>{clearTimeout(t);try{s.remove()}catch(e){}rej(new Error(w))};
    s.src=src;s.async=true;for(const k in(attrs||{}))s.setAttribute(k,attrs[k]);
    t=setTimeout(()=>fail('timeout'),12000);
    s.onload=()=>{clearTimeout(t);res(s)};s.onerror=()=>fail('blocked');
    (document.head||document.documentElement).appendChild(s)});

  function loadMonetag(zone){
    const fn=fnName(zone);
    if(typeof window[fn]==='function')return Promise.resolve();
    if(M.zone===zone&&M.p)return M.p;
    if(M.script){try{M.script.remove()}catch(e){}try{delete window[fnName(M.zone)]}catch(e){}M.script=null}   // admin changed the zone: drop the old one
    M.zone=zone;
    const tryHost=i=>{
      if(typeof window[fn]==='function')return Promise.resolve();
      if(i>=HOSTS.monetag.length)return Promise.reject(new Error('load'));
      return inject(HOSTS.monetag[i],{'data-zone':zone,'data-sdk':fn}).then(s=>{M.script=s;if(typeof window[fn]!=='function')throw new Error('bad')})
        .catch(e=>{console.warn('[Ads] monetag sdk',HOSTS.monetag[i],e&&e.message);try{M.script&&M.script.remove()}catch(x){}M.script=null;return tryHost(i+1)})};
    const p=tryHost(0).then(()=>{failed.monetag=false},e=>{failed.monetag=true;throw e});
    M.p=p;p.catch(()=>{if(M.p===p)M.p=null});return p;
  }
  function loadAdsgram(block){
    const has=()=>window.Adsgram&&typeof window.Adsgram.init==='function';
    const boot=()=>{if(!G.ctl[block]){if(!has())throw new Error('load');G.ctl[block]=window.Adsgram.init({blockId:block})}return G.ctl[block]};
    if(!G.p){
      const tryHost=i=>{
        if(has())return Promise.resolve();
        if(i>=HOSTS.adsgram.length)return Promise.reject(new Error('load'));
        return inject(HOSTS.adsgram[i]).then(()=>{if(!has())throw new Error('bad')}).catch(e=>{console.warn('[Ads] adsgram sdk',HOSTS.adsgram[i],e&&e.message);return tryHost(i+1)})};
      const p=tryHost(0).then(()=>{failed.adsgram=false},e=>{failed.adsgram=true;throw e});
      G.p=p;p.catch(()=>{if(G.p===p)G.p=null});
    }
    return G.p.then(boot);
  }
  /* load the active SDK as soon as the config is known, so a tap can open the ad instantly */
  function prewarm(){try{
    if(cfg.provider==='monetag')loadMonetag(cfg.zoneId).catch(()=>{});
    else if(okBlock(cfg.blockId))loadAdsgram(cfg.blockId).catch(()=>{});
  }catch(e){}}
  function configure(raw){
    const c=raw||{},z=String((c.monetag&&c.monetag.zoneId)||'').trim();
    cfg={provider:c.provider==='adsgram'?'adsgram':'monetag',zoneId:okZone(z)?z:DEFAULT_ZONE,blockId:String((c.adsgram&&c.adsgram.blockId)||'').trim()};
    got=true;prewarm();
  }

  /* show one rewarded ad. Resolves true only when it was watched. IMPORTANT: no await before the SDK call (keeps the user's tap). */
  async function show(kind){
    if(busyAt&&Date.now()-busyAt<90000)throw new Error(MSG.busy);   // (an ad that never answers stops blocking after 90 s)
    if(!got)throw new Error(MSG.wait);                                           // adConfig has not arrived from the database yet
    busyAt=Date.now();last=0;
    try{
      if(cfg.provider==='monetag'){
        const fn=window[fnName(cfg.zoneId)];
        if(typeof fn!=='function'){loadMonetag(cfg.zoneId).catch(()=>{});throw new Error(failed.monetag?MSG.load:MSG.wait)}
        try{const t0=Date.now();await fn();last=Date.now()-t0;return true}
        catch(e){console.warn('[Ads] monetag show failed',e);throw new Error(MSG.nofill)}
      }
      if(!okBlock(cfg.blockId)){console.error('[Ads] Adsgram Block ID missing/invalid (Admin > Ads)');throw new Error(MSG.unset)}
      const ctl=G.ctl[cfg.blockId];
      if(!ctl){loadAdsgram(cfg.blockId).catch(()=>{});throw new Error(failed.adsgram?MSG.load:MSG.wait)}
      let r;try{const t0=Date.now();r=await ctl.show();last=Date.now()-t0}
      catch(e){console.warn('[Ads] adsgram show failed',e);throw new Error(e&&e.error?MSG.nofill:MSG.skip)}   // adsgram rejects with {done,error,state,description}
      return !!(r&&r.done===true);
    }finally{busyAt=0;autoReset()}                                                    // any ad (manual or auto) restarts the auto timer
  }
  /* ---- AUTO AD: random 2-5 min, only counted while the app is on screen. Never while another ad is running / verifying, a popup is open or the user is typing.
          No reward. If the ad cannot open (no fill, blocker, SDK not ready) it is simply retried in 60 s. ---- */
  const AUTO_MIN=120,AUTO_MAX=300;
  let left=0;
  const rnd=()=>(AUTO_MIN+Math.random()*(AUTO_MAX-AUTO_MIN))*1000;
  function autoReset(){left=rnd()}
  function autoBlocked(){try{
    if(typeof AdState!=='undefined'&&AdState)return true;                          // a Watch Ad is being verified
    if(store.s.banned||!store.s.loaded)return true;
    if(document.getElementById('jg'))return true;                                   // channel-join sheet is open
    if(document.querySelector('.ov'))return true;                                   // wallet / FAQ / confirm popup is open
    const t=(document.activeElement||{}).tagName;return t==='INPUT'||t==='TEXTAREA'  // user is typing
  }catch(e){return true}}
  autoReset();
  setInterval(()=>{
    if(!got||document.hidden)return;                                                // time only counts while the app is open on screen
    left-=1000;if(left>0)return;
    if(busyAt||autoBlocked()){left=15000;return}                                     // busy: look again in 15 s
    show('auto').catch(()=>{left=60000})                                            // success: show() already restarted the random timer
  },1000);
  const info=()=>({provider:cfg.provider,configured:cfg.provider==='monetag'?okZone(cfg.zoneId):okBlock(cfg.blockId),id:cfg.provider==='monetag'?cfg.zoneId:cfg.blockId});
  return{configure,show,info,get lastMs(){return last}};
})();
window.Ads=Ads;
window.showRewardedAd=kind=>Ads.show(kind);

/* ===== 1. CONFIG ===== */
const CONFIG={BOT:'Foxio_verseBot',LINK_MODE:'startapp',APP_SHORT:'',MIN_WITHDRAW:0.1,NETWORK:'USDT (BEP-20)',DECIMALS:8,APP_NAME:'FoxMiner'};

/* ===== 2. AUTH LAYER (only place that gates access) ===== */
const Auth={
  tg:null,
  BLOCK:['weba','webk','web','unknown'],   // Telegram Web (browser) platforms: app will not run there. Add 'tdesktop','macos' to also block desktop apps
  init(){ this.tg=window.Telegram&&window.Telegram.WebApp&&window.Telegram.WebApp.initData?window.Telegram.WebApp:null;
    if(this.tg){try{this.tg.ready();this.tg.expand();}catch(e){}} },
  blocked(){const p=String((this.tg&&this.tg.platform)||'').toLowerCase();return !!p&&this.BLOCK.includes(p)},
  user(){
    const u=this.tg&&this.tg.initDataUnsafe&&this.tg.initDataUnsafe.user;
    if(u&&this.blocked())return null;   // opened in Telegram Web / browser -> show the "open in Telegram on your phone" screen
    if(u)return{uid:String(u.id),firstName:u.first_name||'',lastName:u.last_name||'',username:u.username||'',photoUrl:u.photo_url||'',initData:this.tg.initData,startParam:String((this.tg.initDataUnsafe&&this.tg.initDataUnsafe.start_param)||''),dev:false,guest:false};
    return null;   // guest mode is OFF: outside Telegram there is no access
  }
};


/* ===== 2b. LOG TRACKER: every user-side error is saved to logs/{id} -> Admin > Log (username + error + Bangla explanation) ===== */
const Logger=(()=>{
  const q=[],seen=new Map(),MAX=25;let sent=0,tm=null,tries=0;
  const cut=(v,n)=>String(v==null?'':v).slice(0,n);
  const msgOf=e=>{try{if(e==null)return'';if(typeof e==='string')return e;if(e.message)return String(e.message);if(e.error)return typeof e.error==='string'?e.error:(e.error.message||JSON.stringify(e.error));if(e.reason)return String(e.reason);return JSON.stringify(e)}catch(x){return String(e)}};
  const who=()=>{try{return(typeof USER!=='undefined'&&USER&&!USER.guest&&USER.uid)?USER:null}catch(e){return null}};
  const page=()=>{try{return typeof route==='string'?route:''}catch(e){return''}};
  function flush(){
    clearTimeout(tm);tm=null;if(!q.length)return;
    const u=who();
    if(!u||!window.Backend||!Backend.db){if(++tries<40)tm=setTimeout(flush,3000);return}   // app still starting: try again shortly
    while(q.length){const l=q.shift();l.uid=String(u.uid);l.username=cut(u.username,64);l.firstName=cut(u.firstName,64);
      try{Backend.ref('logs').push(l).catch(()=>{})}catch(e){}}
  }
  function push(src,e){
    try{
      const m=cut(msgOf(e),300).trim();if(!m)return;
      const k=src+'|'+m,n=Date.now(),p=seen.get(k);
      if(p&&n-p<60000)return;seen.set(k,n);          // same error again within 60 s: ignore
      if(sent>=MAX)return;sent++;                    // max 25 logs per app session (protects the database)
      q.push({error:m,src:cut(src,40),page:cut(page(),30),plat:cut((Auth.tg&&Auth.tg.platform)||'',20),ts:firebase.database.ServerValue.TIMESTAMP});
      if(!tm)tm=setTimeout(flush,400);
    }catch(x){}
  }
  addEventListener('error',e=>{if(e&&e.message)push('js',e.message+(e.lineno?' (line '+e.lineno+')':''))});
  addEventListener('unhandledrejection',e=>push('promise',e&&e.reason));
  const ce=console.error,cw=console.warn;
  console.error=function(){try{push('console',[].map.call(arguments,msgOf).join(' '))}catch(x){}return ce.apply(console,arguments)};
  console.warn=function(){try{const a=[].map.call(arguments,msgOf).join(' ');if(/^\[Ads\]/.test(a))push('ads',a)}catch(x){}return cw.apply(console,arguments)};
  return{push,flush};
})();
window.Logger=Logger;

/* ===== 3. BACKEND: see backend.js (Firebase Realtime Database) ===== */

/* ===== 4. STORE (mirrors backend document shape; no fake values) ===== */
const store={
  s:{loaded:false,error:null,online:navigator.onLine,
    balances:{available:0,hold:0,frozen:0},
    mining:{ratePerHour:0,isMining:false,totalMining:0,todayMining:0,amount:0,syncedAt:Date.now()},
    stats:{totalIncome:0,totalWithdraw:0,totalCommission:0},
    team:{joinedBy:'',joinedBy2:'',upline:null,uplineLoaded:false,referralCode:null,teamCode:'',totalMembers:0,totalTeam:0,referralEarned:0,goalClaimed:false,totalCommission:0,balance:0,members:null,level2:null,todayL2:0,teamError:null},referral:{enabled:true,partnerReward:0.001,memberReward:0.0005,goalTarget:1000,goalReward:50},
    kyc:false,wdRules:{stage:1,min:0.1,max:0.5,needRef:0,hint:false,restricted:false},history:null,withdrawals:null,adsOn:false,tasks:[],memberBalances:{},upgTasks:[],upgrade:{minAdSeconds:10},upg:{},progress:{referrals:0},links:{},wallet:null,hasMoreHistory:false},
  subs:[],
  patch(p){ for(const k in p){ const v=p[k]; this.s[k]=(v&&typeof v==='object'&&!Array.isArray(v)&&this.s[k]&&typeof this.s[k]==='object')?{...this.s[k],...v}:v; } this.subs.forEach(f=>f(Object.keys(p))) },
  on(f){this.subs.push(f)}
};

/* ===== helpers ===== */
const $=s=>document.querySelector(s);
const money=n=>'$'+(Number(n)||0).toFixed(CONFIG.DECIMALS);
const V=(html)=>store.s.loaded?html:`<span class="ld">…</span>`;
const ico=(n,sz=18)=>`<i data-lucide="${n}" style="width:${sz}px;height:${sz}px"></i>`;
const short=a=>a?a.slice(0,6)+'.....'+a.slice(-6):'';
const esc=t=>String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const validAddr=a=>/^0x[a-fA-F0-9]{40}$/.test(a);
const fmtTime=ts=>{const d=new Date(ts),p=n=>String(n).padStart(2,'0');return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} | ${p(d.getHours())}:${p(d.getMinutes())}`};
let toastT;function toast(m){let t=$('#toast');if(!t){t=document.createElement('div');t.id='toast';document.body.appendChild(t)}t.textContent=m;t.style.display='block';clearTimeout(toastT);toastT=setTimeout(()=>t.style.display='none',2600)}
async function copy(t){try{await navigator.clipboard.writeText(t)}catch(e){const i=document.createElement('input');i.value=t;document.body.appendChild(i);i.select();document.execCommand('copy');i.remove()}toast('Copied')}
const busy=new Set();
async function act(key,fn,okMsg){ if(busy.has(key))return; busy.add(key); try{await fn(); okMsg&&toast(okMsg)}catch(e){Logger.push('action:'+key,e);toast(e.message||'Something went wrong')} finally{busy.delete(key)} }
const fullName=u=>[u.firstName,u.lastName].filter(Boolean).join(' ')||u.username||'User';
const initialOf=u=>(fullName(u)[0]||'?').toUpperCase();
function avErr(i){const d=document.createElement('div');d.className='av';d.style.cssText=i.style.cssText;d.textContent=i.dataset.i||'?';i.replaceWith(d)}
function banAv(sz){return `<div class="av" style="width:${sz}px;height:${sz}px;background:linear-gradient(135deg,#ff4d6d,#b3123a);display:grid;place-items:center;color:#fff"><svg width="${Math.round(sz*.55)}" height="${Math.round(sz*.55)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg></div>`}
function avatar(u,sz=40){if(store.s.banned&&USER&&String(u.uid)===String(USER.uid))return banAv(sz);return u.photoUrl?`<img class="av" style="width:${sz}px;height:${sz}px" src="${esc(u.photoUrl)}" alt="" referrerpolicy="no-referrer" data-i="${esc(initialOf(u))}" onerror="avErr(this)">`:`<div class="av" style="width:${sz}px;height:${sz}px">${esc(initialOf(u))}</div>`}
function inviteLink(){if(USER.guest)return `https://t.me/${CONFIG.BOT}`;const c=store.s.team.teamCode||store.s.team.referralCode||('ref_'+USER.uid);return CONFIG.LINK_MODE==='startapp'?`https://t.me/${CONFIG.BOT}${CONFIG.APP_SHORT?'/'+CONFIG.APP_SHORT:''}?startapp=${c}`:`https://t.me/${CONFIG.BOT}?start=${c}`}
/* reward earned since the last checkpoint (display only; the server credits the same amount) */
function liveExtra(){const m=store.s.mining;if(!m.isMining||!m.endsAt)return 0;const e=Math.min(Date.now(),m.endsAt);return Math.max(0,m.ratePerHour/3600*((e-m.syncedAt)/1000))}
function liveMining(){const m=store.s.mining;return m.isMining?m.amount+liveExtra():m.amount}
const LV={avail:()=>store.s.balances.available+liveExtra(),total:()=>store.s.balances.available+liveExtra(),mined:()=>store.s.mining.totalMining+liveExtra(),today:()=>store.s.mining.todayMining+liveExtra(),income:()=>store.s.stats.totalIncome+liveExtra()};
const LDG={avail:8,total:8,mined:8,today:8,income:8};   // live numbers show full digits so every second's change is visible
const LA=(k,sp,d)=>`data-live="${k},${sp},${LDG[k]||d}"`;
function liveTick(){if(!store.s.loaded)return;document.querySelectorAll('[data-live]').forEach(el=>{if(el.dataset.h)return;const[k,sp,d]=el.dataset.live.split(','),f=LV[k];if(f)el.textContent='$'+(+sp?' ':'')+f().toFixed(+d)})}
const availLive=()=>Math.floor((store.s.balances.available+liveExtra())*1e8)/1e8;
const hm=ms=>{const x=Math.max(0,Math.ceil(ms/60000)),h=x/60|0;return h?`${h}h ${x%60}m`:`${x}m`};
/* energy in bars: drains while mining, recharges when idle. Start needs >= 1 bar (not full). */
function energyInfo(){const m=store.s.mining,now=Date.now(),U=m.usable||3,MX=m.maxEnergy||5,dr=m.drainMs||20*3600e3/3,rs=m.restoreMs||5*3600e3/3;let E;
 if(!m.energyAt)E=U;else if(m.isMining)E=Math.max(0,m.energyValue-(now-m.energyAt)/dr);else E=Math.min(U,m.energyValue+(now-m.energyAt)/rs);
 let msg;
 if(m.isMining)msg='';
 else if(E>=U-1e-9)msg='Energy is full. Tap Start Mining.';
 else if(E>=1)msg=`Recharging · full in ${hm((U-E)*rs)} · you can start now`;
 else msg=`Recharging · you can start in ${hm((1-E)*rs)}`;
 return{E,U,MX,canStart:E>=1-1e-9,full:E>=U-1e-9,val:((m.isMining||E<U-1e-9)?E.toFixed(5):E.toFixed(1))+'/'+U,msg}}
const pipFill=(E,i)=>Math.max(0,Math.min(1,E-i));
const pipBg=f=>`linear-gradient(90deg,#2FA8FF,#56E6FF ${(f*100).toFixed(3)}%,#162550 ${(f*100).toFixed(3)}%)`;

const rate=n=>{n=Number(n)||0;let t=n.toFixed(8).replace(/0+$/,'');if(((t.split('.')[1])||'').length<3)t=n.toFixed(3);return '$ '+t};   // exact rate, no trailing zeros (0.00139)
const m3=(n,d=3)=>'$ '+(Number(n)||0).toFixed(d);
/* ===== pages ===== */
/* COIN_SRC is defined in assets.js */
const TH=(i,l)=>/withdraw/i.test(l||'')?'th-wd':({snowflake:'th-frozen',clock:'th-hold',lock:'th-hold','circle-dollar-sign':'th-avail',users:'th-team',zap:'th-rate',coins:'th-income',wallet:'th-income','calendar-days':'th-today',percent:'th-comm'}[i]||'');
const P={};
const tb=(t,i,back)=>'';
const cir=(i,c='')=>`<div class="cir ${c}">${ico(i,15)}</div>`;
const bal=(l,v,i,c)=>`<div class="card ${c}">${cir(i,c)}<div class="lbl">${l}</div><div class="num sm">${V(money(v))}</div></div>`;
const stat=(l,v,i)=>`<div class="card"><div class="lbl">${l}</div><div class="num sm" style="color:var(--ink)">${v}</div></div>`;
/* ===== ACTIVITY FEED (system generated, NOT real user data) =====
   One fake activity is generated per minute. It is derived ONLY from the minute number (seeded PRNG), so every visitor sees the same feed,
   it survives reloads, and nothing is read from / written to the database. The home page always shows the latest 12. */
const ACT_N=12,ACT_STEP=60000;
const ACT_NAMES=['Rahim','Karim','Sakib','Tanvir','Nusrat','Mehedi','Jannat','Arif','Sumaiya','Rakib','Farhan','Tamim','Sadia','Imran','Mim','Shuvo','Rafi','Nabila','Hasan','Riya','Fahim','Anika','Sohan','Tania','Mahin','Ayesha','Rony','Lamia','Zihad','Maruf','Priya','Arjun','Rohan','Sneha','Aman','Neha','Vikram','Pooja','Kabir','Sara','Omar','Yusuf','Leila','Hamza','Zain','Amir','Dina','Ivan','Alex','Maria','Daniel','Sofia','Lucas','Emma','Ethan','Mia','Noah','Liam','Anna','Chris'];
const ACT_LAST=['K.','H.','A.','R.','S.','M.','B.','T.','N.','D.','J.','F.'];
function actRng(seed){let t=(seed>>>0)+0x6D2B79F5;return()=>{t+=0x6D2B79F5;let r=Math.imul(t^t>>>15,1|t);r^=r+Math.imul(r^r>>>7,61|r);return((r^r>>>14)>>>0)/4294967296}}
/* Exact mix inside every block of 10 minutes: 5 withdraw, 2 start mining, 1 team refer, 1 partner refer, 1 upgrade (= 50/20/10/10/10 %).
   The order inside a block is shuffled from the block number, so it looks random but is identical for every visitor. */
const ACT_MIX=['wd','wd','wd','wd','wd','mine','mine','team','partner','upg'];
function actType(slot){const b=Math.floor(slot/10),R=actRng(Math.imul(b^(b>>>13),2654435769)^Math.imul(b,1597334677)),A=ACT_MIX.slice();
 for(let i=A.length-1;i>0;i--){const j=Math.floor(R()*(i+1));[A[i],A[j]]=[A[j],A[i]]}
 return A[((slot%10)+10)%10]}
function actMake(slot){const R=actRng(Math.imul(slot^(slot>>>15),2246822507)^Math.imul(slot,3266489909)),pick=a=>a[Math.floor(R()*a.length)],type=actType(slot);
 const name=pick(ACT_NAMES)+(R()<.45?' '+pick(ACT_LAST):'');
 return type==='wd'?{slot,name,type,amt:(0.1+Math.floor(R()*21)/100).toFixed(2)}:{slot,name,type}}      // withdraw amount: 0.10 .. 0.30
const actAgo=ms=>{const m=Math.floor(ms/60000);return m<1?'Just now':m+' min ago'};
/* icons = the ones the app already uses: Withdraw -> Withdraw History row (check), Start mining -> Mining History row (coins),
   Team / Partner -> "Refer" nav button (users), Upgrade -> "Upgrade" nav button (rocket) */
const ACT_ICO={wd:['check',16],mine:['coins',18],team:['users',19],partner:['users',19],upg:['rocket',19]};
const actRow=(x,now)=>{
 const av=`<div class="aic t-${x.type}">${ico(...ACT_ICO[x.type])}</div>`;
 const txt={wd:`Withdraw <b class="amt">$${x.amt}</b>`,mine:'Started mining',upg:'Completed upgrade task',team:'Have 1 new refer <em>(Team)</em>',partner:'Have 1 new refer <em>(Partner)</em>'}[x.type];
 const st=(x.type==='wd'||x.type==='upg')?`<span class="ast">${ico('check',11)}Successful</span>`:'';
 return `<div class="ar t-${x.type}" data-slot="${x.slot}">${av}<div class="ag"><span class="nm">${esc(x.name)}</span><small>${txt}</small></div><div class="ar2">${st}<span class="at">${actAgo(now-x.slot*ACT_STEP)}</span></div></div>`};
const actRows=()=>{const now=Date.now(),cur=Math.floor(now/ACT_STEP);let h='';for(let i=0;i<ACT_N;i++)h+=actRow(actMake(cur-i),now);return h};
const activityFeed=()=>`<div class="lb act"><div class="lh">${ico('activity',22)}<b>Live Activity</b></div><div id="actList">${actRows()}</div></div>`;
const walletNote=()=>{const s=store.s;if(USER.guest||s.wallet||!s.loaded)return '';return `<div class="card wal" style="margin:0 0 12px"><div class="ic">${ico('wallet',18)}</div><div class="g"><small>Wallet required</small><b>Connect your wallet to start mining and save your progress</b></div><button class="btn s" data-wallet>Connect</button></div>`};
const homeAd=()=>{const s=store.s,T=(s.upgTasks||[]).find(x=>x.kind==='rate'&&x.enabled);if(USER.guest||!s.adsOn||!T)return '';return taskCard(T)};
P.home=()=>{const s=store.s,b=s.balances,w=s.wallet,tot=b.available,all=b.available+b.hold+b.frozen,pc=v=>all>0?Math.max(0,Math.min(100,v/all*100)):0,
 ch=tot>0?(s.mining.todayMining/tot*100):0;
 const coin=(sz)=>`<img class="tcoin" src="${COIN_SRC}" width="${sz}" height="${sz}" alt="USDT">`;
 const sb=(l,v,i,c,p,lk)=>`<div class="sb ${c} ${TH(i,l)}"><div class="r"><div class="ci">${ico(i,17)}</div><small>${l}</small></div><b ${lk?LA(lk,1,4):''}>${V(m3(v,4))}</b><div class="pb"><i style="width:${pc(p).toFixed(0)}%"></i></div></div>`;
 const qc=(l,v,i,c,t,lk)=>`<div class="qc ${c} ${TH(i,l)}"><div class="r"><div class="ci">${ico(i,18)}</div><small>${l}</small></div><b ${lk?LA(lk,1,5):''}>${V(v)}</b><em>${t}</em></div>`;
 return `<div class="page">
${walletNote()}<div class="bc"><div class="bt"><div class="wic">${ico('wallet',26)}</div><div><div class="tl">Total Balance<button data-eye="tb" aria-label="Toggle balance">${ico('eye',18)}</button></div><div class="amt" id="tb" ${LA('total',0,8)}>${V(money(tot))}</div></div></div><button class="cw${w?' on':''}" ${w?'data-copy="'+esc(w.address)+'"':'data-wallet'} aria-label="${w?'Copy wallet address':'Connect wallet'}">${ico('wallet',13)}<span>${w?w.address.slice(0,4)+'..'+w.address.slice(-4):'Connect Wallet'}</span></button>
<div class="sub3">${sb('Available',b.available,'circle-dollar-sign','g',b.available,'avail')}${sb('Hold',b.hold,'clock','v',b.hold)}${sb('Frozen',b.frozen,'snowflake','bl',b.frozen)}</div></div>
<div class="acts"><button class="ab u" data-go="upgrade"><div class="ci">${ico('rocket',22)}</div><div><b>Upgrade</b><small>Increase your mining rate</small></div>${ico('chevron-right',18)}</button><button class="ab w" data-go="withdraw"><div class="ci">${ico('wallet',22)}</div><div><b>Withdraw</b><small>Get your USDT (BEP-20)</small></div>${ico('chevron-right',18)}</button></div>
<div class="qh"><div class="qb"><i style="height:9px"></i><i style="height:15px"></i><i style="height:22px"></i></div><b>Quick Stats</b><a data-go="mining">View All ${ico('chevron-right',15)}</a></div>
<div class="qg">${qc('Refer',(s.team.totalMembers||0)+(s.team.totalTeam||0),'users','g',(s.team.totalMembers||0)+' partners · '+(s.team.totalTeam||0)+' members')}${qc('Per/H',rate(s.mining.ratePerHour),'zap','v',s.mining.isMining?'Mining':'Idle')}${qc('Total Income',m3(s.stats.totalIncome,8),'coins','bl','+'+(Number(s.mining.todayMining)||0).toFixed(2)+' today','income')}</div>
${homeAd()}${activityFeed()}
<div class="ban"><img class="art bimg" src="${IMG.bfox}" alt="" draggable="false"><div class="tx"><h3>Grow Your <span>Earnings</span></h3><p>Complete tasks, upgrade your rate and earn more every hour!</p></div><button data-go="mining">Start Now ${ico('chevron-right',16)}</button></div></div>`};


/* IMG is defined in assets.js */const FOX=(c,k)=>`<img class="${c}" src="${IMG[k||{fox:'profile',foxm:'mining',tfox:'team'}[c]]}" alt="" draggable="false">`;
const liveBal=id=>{const L=(store.s.memberBalances||{})[String(id)];if(!L)return null;const n=Date.now();return L.bal+(L.on&&L.rate>0?L.rate*(Math.max(0,Math.min(n,L.ends||n)-L.since))/3600e3:0)};
const lbTxt=id=>{const v=liveBal(id);return v==null?'—':'$'+v.toFixed(6)};
const dot=(u,sz=46)=>`<div class="pa">${avatar(u,sz)}</div>`;
const sqrt=0;
let teamTab='partners';
const usd=n=>'$'+String(+(Number(n)||0).toFixed(8));
const kfmt=n=>n>=1000&&n%1000===0?(n/1000)+'K':Number(n).toLocaleString('en-US');
P.team=()=>{const s=store.s,T=s.team,R=s.referral||{},bl=T.balance,P1=T.members,P2=T.level2,size=(T.totalMembers||0)+(T.totalTeam||0);
 const chg=s.mining.todayMining>0&&s.stats.totalIncome>0?(s.mining.todayMining/s.stats.totalIncome*100):0;
 const cur=teamTab==='team'?P2:P1,isL2=teamTab==='team';let list;
 const nameOf=id=>{const p=(P1||[]).find(x=>String(x.uid)===String(id));return p?(p.firstName||p.username||'partner'):''};
 if(T.teamError&&!isL2)list=`<div class="empty">${ico('cloud-off',28)}${esc(T.teamError)}<br><br><button class="btn ghost s" data-retry>Retry</button></div>`;
 else if(cur===null||cur===undefined)list=`<div class="empty ldg">Loading…</div>`;
 else if(!cur.length)list=`<div class="empty">${ico('users',28)}${isL2?'No team members yet.<br>They appear when your partners invite people.':'No partners yet.<br>Share your link or team code to add partners.'}</div>`;
 else list=cur.map(u=>{const L=(store.s.memberBalances||{})[String(u.uid)]||{},un=L.username||u.username,pn=id=>{const p=(P1||[]).find(x=>String(x.uid)===String(id)),B=(store.s.memberBalances||{})[String(id)]||{},h=(p&&p.username)||B.username;return h?'@'+h:(p&&p.firstName)||B.firstName||('ID '+id)},
   by=isL2?pn(u.via):'You',rej=u.st==='rej';
  return `<div class="mr" data-uid="${esc(u.uid)}">${dot({...u,photoUrl:L.photoUrl||u.photoUrl},44)}<div class="g"><b>${esc((u.firstName+' '+(u.lastName||'')).trim()||un||'User')}${String(u.uid)===String(USER.uid)?ico('crown',15):''}</b><small>${un?'@'+esc(un):'No username'}</small><small class="invb">Invited by <span>${esc(by)}</span></small></div><div class="rt"><span class="am lbv" data-lbid="${esc(u.uid)}">${lbTxt(u.uid)}</span><small class="jb ${rej?'bd':''}">${rej?'Not counted'+({device:' · same device',wallet:' · same wallet',speed:' · too many joins'}[u.fl]||''):(u.bonus>0?'+'+usd(u.bonus)+' join':'')}</small></div></div>`}).join('');
 const ms=(l,v,i,c,t,lk)=>`<div class="qc ${c} ${TH(i,l)}"><div class="r"><div class="ci">${ico(i,20)}</div><small>${l}</small></div><b ${lk?LA(lk,1,5):''}>${V(v)}</b><em>${t}</em></div>`;
 const tgt=Number(R.goalTarget)||1000,pct=Math.max(0,Math.min(100,size/tgt*100)),done=size>=tgt,can=done&&!T.goalClaimed&&R.enabled!==false&&!USER.guest;
 const goal=`<div class="goal${T.goalClaimed?' cl':''}"><div class="gt"><div class="gi">${ico('trophy',22)}</div><div class="gx"><b>Refer ${kfmt(tgt)} members</b><small>Partners + team members count · reward ${usd(R.goalReward)}</small></div></div><div class="gbar"><i style="width:${pct.toFixed(2)}%"></i><span>${V(size.toLocaleString('en-US')+' / '+tgt.toLocaleString('en-US'))}</span></div><button class="btn gc" data-claimgoal ${can?'':'disabled'}>${T.goalClaimed?ico('check',17)+' Claimed':(done?ico('gift',17)+' Claim '+usd(R.goalReward):ico('lock',16)+' Claim '+usd(R.goalReward)+' at '+kfmt(tgt))}</button></div>`;
 const code=T.teamCode,link=inviteLink();
 const up=T.upline||[],upc=!T.joinedBy?`<div class="upl none"><div class="ui">${ico('user-round',18)}</div><div class="ux"><b>You joined directly</b><small>Nobody referred you</small></div></div>`
  :(!T.uplineLoaded&&!up.length?`<div class="upl"><div class="ux"><small>Loading your team owner…</small></div></div>`
  :up.map(x=>`<div class="upl">${dot(x,38)}<div class="ux"><small>${x.level===1?'You were referred by':'Level 2 referrer'}</small><b>${esc((x.firstName+' '+x.lastName).trim()||x.username||('ID '+x.uid))}</b>${x.username?`<small>@${esc(x.username)}</small>`:''}</div><span class="lv">${x.level===1?'Referrer':'Level 2'}</span></div>`).join(''));
 return `<div class="page">
<div class="pnl tbal"><div class="wic">${ico('users',28)}</div><div style="flex:1;min-width:0"><div class="tl">Refer Balance<button data-eye="tbb" aria-label="Toggle">${ico('eye',18)}</button></div><div class="amt" id="tbb">${V(m3(bl,3))}</div></div><svg class="spk" viewBox="0 0 150 70" preserveAspectRatio="none"><path d="M0 62L20 50 34 56 56 36 72 42 96 20 112 28 150 4V70H0z" fill="rgba(34,229,139,.14)"/><path d="M0 62L20 50 34 56 56 36 72 42 96 20 112 28 150 4" fill="none" stroke="#22E58B" stroke-width="2.5" stroke-linejoin="round"/></svg>${FOX('tfox')}</div>
<div class="inv"><div class="ih"><div class="lk">${ico('link',22)}</div><div class="ht"><div class="t">Your Refer Link</div><div class="s">Share this link to earn refer rewards</div></div></div><div class="u">${ico('link-2',15)}<span>${esc(link)}</span></div><button class="cpy" data-copy="${esc(link)}">${ico('copy',18)}Copy Link</button></div>
<div class="tcd"><div class="tc1"><small>Your Refer Code</small><b>${code?esc(code):(USER.guest?'—':'Connect wallet to get it')}</b></div>${code?`<button class="btn ghost s" data-copy="${esc(code)}">${ico('copy',15)}Code</button>`:''}<button class="btn s" data-share="${esc(link)}">${ico('send',15)}Share</button></div>
<div class="rwd"><div><small>Partner joins</small><b>+${usd(R.partnerReward)}</b></div><div><small>Team member joins</small><b>+${usd(R.memberReward)}</b></div></div>
${goal}
<div class="upw">${upc}</div>
<div class="qg">${ms('Partners',T.totalMembers,'users','g','+'+(T.todayMembers||0)+' today')}${ms('Team Members',T.totalTeam||0,'users','v','+'+(T.todayL2||0)+' today')}${ms('Referral Earned',m3(T.referralEarned||0,4),'coins','bl','join rewards')}</div>
<div class="ttabs"><button class="${isL2?'':'on'}" data-tt="partners">Partners (${T.totalMembers||0})</button><button class="${isL2?'on':''}" data-tt="team">Team Members (${T.totalTeam||0})</button></div>
<div id="teamlist">${list}</div></div>`};

const hms=t=>{const x=Math.max(0,Math.floor((Date.now()-t)/1000)),p=n=>String(n).padStart(2,'0');return `${p(x/3600|0)}:${p((x/60|0)%60)}:${p(x%60)}`};
P.mining=()=>{const s=store.s,m=s.mining,h=s.history,pr=Math.min(1,Math.max(0,m.isMining&&m.endsAt>m.startedAt?(Date.now()-m.startedAt)/(m.endsAt-m.startedAt):(m.progress||0))),R=72,C=2*Math.PI*R,A=.75*C;let hl;
 const chg=m.totalMining>0?(m.todayMining/m.totalMining*100):0;
 if(h===null)hl=`<div class="empty ldg">Loading…</div>`;
 else if(!h.length)hl=`<div class="empty">${ico('history',28)}No mining history yet.</div>`;
 else hl=h.map(r=>`<div class="hr"><div class="cn">${ico('coins',18)}</div><div class="hgx"><b>${money(r.amount)}</b><span class="dt">${fmtTime(r.timestamp)}</span></div><span class="ok">${esc(r.status?r.status[0].toUpperCase()+r.status.slice(1):'Credited')}</span></div>`).join('')+(s.hasMoreHistory?`<div style="padding:6px 0"><button class="btn ghost s" data-more style="width:100%">Load more</button></div>`:'');
 const ms=(l,v,i,c,t,lk)=>`<div class="ms ${c} ${TH(i,l)}"><div class="r"><div class="ci">${ico(i,20)}</div><small>${l}</small></div><b ${lk?LA(lk,1,3):''}>${V(v)}</b><em>${ico('arrow-up-right',12)}${t}</em></div>`;
 return `<div class="page">
${walletNote()}<div class="pnl mtop"><div class="bep"><img src="${COIN_SRC}" alt="USDT BEP-20" draggable="false"><span>BEP-20</span></div><div style="position:relative;z-index:1"><div class="tl">Total Mining<button data-eye="tmb" aria-label="Toggle">${ico('eye',18)}</button></div><div class="amt" id="tmb" ${LA('mined',1,3)}>${V(m3(m.totalMining,8))}</div><span class="chp" style="margin-top:8px">${ico('arrow-up-right',15)}${chg>=0?'+':''}${chg.toFixed(1)}% Today</span></div>${FOX('foxm')}</div>
<div class="qg">${ms('Today',m3(m.todayMining,8),'calendar-days','g','+'+chg.toFixed(1)+'%','today')}${ms('Per/H',rate(m.ratePerHour),'zap','v','+'+chg.toFixed(1)+'%')}${ms('Total Mining',m3(m.totalMining,8),'coins','bl','+'+chg.toFixed(1)+'%','mined')}</div>
${(()=>{const e=energyInfo(),di=(m.isMining||e.E<e.U-1e-9)?Math.max(0,Math.ceil(e.E-1e-9)-1):-1;return `<div class="pnl enrg${e.E<1&&!m.isMining?' empty0':''}"><img class="enimg" src="${IMG.energy}" alt="Energy" draggable="false"><div class="eb"><div class="et"><b>Energy</b></div><div class="epips" id="energybar">${Array.from({length:e.MX},(_,i)=>{if(i>=e.U)return `<i class="lk">${ico('lock',9)}</i>`;const f=pipFill(e.E,i);return `<i class="${f>=0.99999?'on':''}${i===di?' dr':''}" ${f>0.00001&&f<0.99999?`style="background:${pipBg(f)}"`:''}></i>`}).join('')}</div><small id="energysub">${e.msg}</small></div></div>`})()}
<div class="mp"><div class="gz"><svg width="180" height="180" viewBox="0 0 180 180" style="transform:rotate(135deg)"><defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#22E58B"/></linearGradient></defs><circle cx="90" cy="90" r="${R}" fill="none" stroke="#DCE3F5" stroke-width="12" stroke-linecap="round" stroke-dasharray="${A} ${C}"/><circle cx="90" cy="90" r="${R}" fill="none" id="gring" stroke="url(#gg)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${Math.max(.001,pr*A)} ${C}"/></svg><div class="c"><div class="pk">${ico('pickaxe',26)}</div><div class="v" id="live">${V(m3(liveMining(),8))}</div><small>Mining Amount</small></div><div class="ac ${m.isMining?'':'off'}">${ico('zap',14)}${m.isMining?'Mining Active':'Mining Stopped'}</div></div>
<div class="mpr"><div class="pc2"><div class="a">${ico('clock',18)}Mining Progress</div><div class="a" style="margin:0"><div class="bb"><i id="pbar" style="width:${Math.round(pr*100)}%"></i></div><b id="ppct" style="font-size:15px">${Math.round(pr*100)}%</b></div><div class="rw gg"><span>${ico('zap',16)}Rate</span><em>${ico('zap',14)}${rate(m.ratePerHour)} /H</em></div><div class="rw"><span>${ico('calendar-days',16)}Started At</span><em>${m.startedAt?fmtTime(m.startedAt):'--'}</em></div></div>
<button class="stopb ${m.isMining?'run':'go'}" data-mine ${s.loaded&&!m.isMining?'':'disabled'}>${m.isMining?`${ico('pickaxe',20)}Mining in progress`:`${ico('play',20)}Start Mining`}</button></div></div>
<div class="hist"><div class="mh2" style="margin-top:0"><span class="ic2" style="color:#4B5A82">${ico('clock',22)}</span><b style="font-size:18px">Mining History</b><a style="color:#6FA8FF;font-size:14px;display:flex;align-items:center;gap:2px">View All ${ico('chevron-right',15)}</a></div>${hl}</div></div>`};

/* ===== Upgrade: every task comes from the admin panel (settings/upgradeTasks) ===== */
const UGRP=[['rate','Per/H Boost'],['restore','Energy Restore'],['bar','Energy Bars'],['invite','Invite & Earn']];
const UICON={rate:'zap',restore:'battery-charging',bar:'battery-full',invite:'user-plus'};
const UBTN={watch:'Watch Ad',claim:'Claim',invite:'Invite',done:'Done',lock:'Locked'};
/* invite tasks are tiers: invites fill the first task, only what is left over counts for the next one (so the 2nd shows 0/50, not 10/50) */
const invOff=T=>{let o=0;for(const x of(store.s.upgTasks||[])){if(x.id===T.id)break;if(x.kind==='invite'&&x.enabled&&x.src===T.src)o+=x.target}return o};
function shareInvite(){const l=inviteLink();return openLinkSmart('https://t.me/share/url?url='+encodeURIComponent(l)+'&text='+encodeURIComponent('Join me on '+CONFIG.APP_NAME+' and start earning!'))}
function upgState(T){
 const s=store.s,m=s.mining,p=(s.upg||{})[T.id]||{},ads=Number(p.ads)||0,claims=Number(p.claims)||0,done=T.maxClaims>0&&claims>=T.maxClaims;
 let cur,tot,act,lock='';
 if(T.kind==='invite'){const p=s.team.totalMembers||0,q=s.team.totalTeam||0,size=Math.max(0,(T.src==='member'?q:T.src==='both'?p+q:p)-invOff(T));tot=T.target;cur=Math.min(size,tot);act=done?'done':size>=tot?'claim':'invite'}
 else{tot=T.ads;cur=Math.min(ads,tot);act=done?'done':ads>=tot?'claim':'watch';
  if(T.kind==='bar'){const have=m.usable||0;
   if(T.barNo<=have)act='done';else if(T.barNo>(m.maxEnergy||5)){act='lock';lock='Not available yet'}else if(T.barNo>have+1){act='lock';lock='Unlock energy bar '+(T.barNo-1)+' first'}}}
 return{cur,tot,act,lock,claims,pct:tot?Math.min(100,Math.round(cur/tot*100)):0}}
const upgRewards=T=>{const o=[],k=T.kind,rt=T.rtype,en=n=>n>0?'+ '+n+' Energy':'Full Energy';
 if(k==='bar')o.push('Energy Bar '+T.barNo);else if(k==='restore'||(k==='invite'&&rt==='restore'))o.push(en(T.reward+(T.reward>0?(T.xRestore||0):0)));
 else if(k==='invite'&&rt==='cash')o.push('+ $'+T.reward);else o.push('+ '+rate(T.reward)+' Per/H');
 if(T.xRate>0)o.push('+ '+rate(T.xRate)+' Per/H');if(T.xCash>0)o.push('+ $'+T.xCash);
 if(T.xRestore>0&&!(k==='restore'||(k==='invite'&&rt==='restore')))o.push('+ '+T.xRestore+' Energy');return o};
let AdState=null;                                                  // {id,phase:'loading'|'verify'|'count',pct} while a Watch Ad is running
const adBtn=s=>s.phase==='loading'?{t:'Loading…',p:0}:s.phase==='count'?{t:'Counting…',p:100}:{t:'Verify '+s.pct+'%',p:s.pct};
function adUI(id,s){AdState=s?{id,...s}:null;const c=document.querySelector('[data-upg="'+String(id).replace(/"/g,'')+'"]'),b=c&&c.querySelector('.btn');if(!b)return;   // updates the button in place (no page redraw)
 if(s){const a=adBtn(AdState);b.classList.add('ld','vf');b.style.setProperty('--p',a.p+'%');if(b.textContent!==a.t)b.textContent=a.t}
 else{b.classList.remove('ld','vf');b.style.removeProperty('--p');b.textContent=UBTN[c.dataset.uact]||b.textContent}}
const taskCard=T=>{const st=upgState(T),ab=AdState&&AdState.id===T.id&&st.act==='watch'?adBtn(AdState):null,cls=T.kind==='invite'?'invite10':'ad',off=st.act==='lock'||st.act==='done',
  sub=T.kind==='invite'?`${st.cur}/${st.tot} ${T.src==='member'?'team members':T.src==='both'?'partners+team':'partners'}`:`${st.cur}/${st.tot} ads`,rep=T.maxClaims!==1&&st.claims>0?` · claimed ${st.claims}×`:'';
 return `<div class="card tk uk ${cls}${off?' lockd':''}${st.act==='claim'?' rdy':''}" data-upg="${esc(T.id)}" data-uact="${st.act}" data-ulock="${esc(st.lock)}"><div class="ut"><div class="tic ${cls}">${ico(UICON[T.kind],22)}</div><div class="ub"><div class="un2"><b>${esc(T.title)}</b></div><p>${esc(st.lock||T.desc)}${rep}</p></div></div>
<div class="uf"><span class="rw2">${ico('zap',13)}${upgRewards(T).join(' · ')}</span><div class="up"><div class="bar"><i style="width:${st.pct}%"></i></div><small>${sub}</small></div><span class="btn s${st.act==='claim'?' clm':''}${ab?' ld vf':''}"${ab?` style="--p:${ab.p}%"`:''} role="button" tabindex="0">${ab?ab.t:UBTN[st.act]}</span></div></div>`};
P.upgrade=()=>{const s=store.s,m=s.mining,card=taskCard;
 return `<div class="page">${tb('Upgrade','rocket','home')}
<div class="pnl upg"><div class="wic">${ico('trending-up',24)}</div><div class="um"><div class="lbl">Current Per/H</div><div class="uv">${V(rate(m.ratePerHour))}<span>/H</span></div></div>${FOX('upfox','upgrade')}</div>
${(()=>{const T=(s.upgTasks||[]).filter(t=>t.enabled);return T.length?UGRP.map(([k,l])=>{const g=T.filter(t=>t.kind===k);return g.length?`<div class="uh2"><b>${l}</b><small>${g.length}</small></div>${g.map(card).join('')}`:''}).join(''):`<div class="empty">${ico('rocket',28)}No upgrade tasks yet.</div>`})()}</div>`};

P.profile=()=>{const s=store.s,st=s.stats;const menu=[['Telegram Channel','Join our official channel','send','channel','linear-gradient(135deg,#1E90FF,#0C5FC9)'],['KYC Verification','Verify your identity','shield-check','kyc','linear-gradient(135deg,#17B972,#0E8F5C)'],['Support','Get help from our team','headset','support','linear-gradient(135deg,#6D3FE8,#3B23A8)'],['FAQ','Find answers to common questions','circle-help','faq','linear-gradient(135deg,#3B4CF0,#2530B8)']];
 const t3=(l,v,i,c,lk)=>`<div class="pt3 ${c} ${TH(i,l)}"><div class="r"><div class="ci">${ico(i,22)}</div><small>${l}${ico('info',15)}</small></div><b ${lk?LA(lk,1,3):''}>${V(v)}</b></div>`;
 const t4=(l,v,i,c,go)=>`<div class="pt4 ${c} ${TH(i,l)}" ${go?`data-go="${go}" role="button" style="cursor:pointer"`:''}><div class="ci">${ico(i,20)}</div><div class="g"><small>${l}</small><b>${V(v)}</b></div>${ico('chevron-right',16)}</div>`;
 return `<div class="page">${tb('Profile','user','home')}<div class="pb2"><div class="pfl"><div class="pav">${avatar(USER,84)}<u></u></div><div class="pinfo"><div class="nm"><span class="nmt">${esc(store.s.banned?'Restricted by system':fullName(USER))}</span></div>${store.s.banned?`<div class="sm2">userban</div>`:USER.username?`<div class="sm2">@${esc(USER.username)}</div>`:`<div class="sm2 none">No username</div>`}${store.s.banned?'':`<div class="uidc"><span>UID</span><b>${esc(USER.uid)}</b></div>`}</div>${FOX('fox')}</div>

<div class="bts"><button class="ab w2" data-go="withdraw"><div class="ci">${ico('wallet',22)}</div><b>Withdraw</b><span style="flex:1"></span>${ico('chevron-right',20)}</button><button class="ab u2" data-go="upgrade"><div class="ci">${ico('rocket',22)}</div><b>Upgrade</b><span style="flex:1"></span>${ico('chevron-right',20)}</button></div></div>
<div class="big3"><div class="g3">${t3('Total Income',m3(st.totalIncome,8),'wallet','g','income')}${t3('Frozen',m3(s.balances.frozen,3),'snowflake','v')}${t3('Hold',m3(s.balances.hold,3),'lock','bl')}</div>
<div class="g3">${t4('Total Team Members',(s.team.totalMembers||0)+(s.team.totalTeam||0),'users','g','team')}${t4('Total Withdraw',m3(st.totalWithdraw,4),'coins','bl')}${t4('Total Commission',m3(st.totalCommission,4),'percent','bl')}</div></div>
<div class="menu">${menu.map(([t,d,i,k,bg])=>{const kOff=k==='kyc'&&!s.kyc;return `<div class="mi${kOff?' dis':''}" ${kOff?'aria-disabled="true"':`data-link="${k==='kyc'?'support':k}" role="button" tabindex="0"`}><div class="ci" style="background:${bg}">${ico(i,24)}</div><div class="g"><b>${t}</b><small>${d}</small></div>${k==='kyc'?(s.kyc?'<span class="noneed warn">Get Verify Yourself</span>':'<span class="noneed">No Need</span>'):''}${ico('chevron-right',22)}</div>`}).join('')}</div></div>`};

let wdFilter='all';
const wdKind=v=>{v=String(v||'pending').toLowerCase();return /complete|success|paid|done/.test(v)?'completed':/reject|fail|declin|cancel/.test(v)?'rejected':'pending'};
const WD_UI={completed:['check','Completed'],pending:['clock','Pending'],rejected:['x','Rejected']};
const wdHint=()=>{const R=store.s.wdRules;if(!R||!R.hint)return '';const have=Math.min(R.haveRef||0,R.needRef);
 return `<div class="lbl">Minimum: $${R.min}</div><div class="lbl">Maximum: $${R.max}</div><div class="lbl">Referral needed: ${R.needRef} (${have}/${R.needRef})</div>`};
P.withdraw=()=>{const s=store.s,w=s.wallet,b=s.balances;
 const stt=(k,l,i,v,lk)=>`<div class="wst ${k}"><div class="ci">${ico(i,17)}</div><small>${l}</small><b ${lk?LA(lk,1,3):''}>${V(m3(v,3))}</b></div>`;
 return `<div class="page">
<div class="pnl usdtp" style="padding:14px 16px;display:flex;align-items:center;gap:14px"><div class="wic coinw"><img src="${COIN_SRC}" alt="USDT"></div><div><b style="font-size:16px">${CONFIG.NETWORK}</b>${wdHint()}${store.s.kyc?`<div class="lbl" style="color:var(--amb);font-weight:800">KYC required: contact Support to verify before withdrawing</div>`:''}<div class="lbl">Network: BSC (BEP-20)</div></div>${FOX('wdfox','withdraw')}</div>
${w?`<div class="card wal"><div class="ic">${ico('wallet',18)}</div><div class="g"><small>Wallet address</small><b class="num">${short(w.address)}</b></div><button class="back" data-copy="${esc(w.address)}" aria-label="Copy address">${ico('copy',16)}</button></div>`
 :`<div class="card empty">${ico('wallet',28)}Connect a USDT (BEP-20) wallet to withdraw.<br><br><button class="btn" style="width:100%" data-wallet>Connect Wallet</button></div>`}
<div class="wsr">${stt('sa','Available','circle-dollar-sign',b.available,'avail')}${stt('sf','Frozen','snowflake',b.frozen)}${stt('sh','Hold','lock',b.hold)}</div>
<div class="wamt"><b>Withdrawal amount</b><div style="position:relative"><input id="wamt" inputmode="decimal" placeholder="Enter amount" ${w?'':'disabled'}><button class="btn soft s" data-max style="position:absolute;right:8px;top:8px;border-radius:10px">Max</button></div><div class="err" id="werr"></div></div>
<div><button class="btn alt big2" style="width:100%" data-wd ${w?'':'disabled'}>WITHDRAW</button></div>${wdHistoryBlock()}</div>`};

const wdHistoryBlock=()=>{const s=store.s,l=s.withdrawals,f=wdFilter;
 const rows=l===null?null:l.map(r=>({...r,k:wdKind(r.status)})),cnt=k=>rows?(k==='all'?rows.length:rows.filter(r=>r.k===k).length):0;
 const shown=rows?rows.filter(r=>f==='all'||r.k===f):[];
 const chips=[['all','All'],['completed','Completed'],['pending','Pending'],['rejected','Rejected']].map(([k,t])=>`<button class="${f===k?'on':''}" data-wf="${k}">${t}<em>${cnt(k)}</em></button>`).join('');
 const body=rows===null?`<div class="empty ldg">Loading…</div>`
  :!shown.length?`<div class="empty">${ico('receipt',28)}${rows.length?'No '+f+' withdrawals.':'No withdrawals yet.'}</div>`
  :shown.map(r=>{const u=WD_UI[r.k];return `<div class="item"><div class="ic ${r.k}">${ico(u[0],16)}</div><div class="g"><b class="num" style="font-size:14px">${money(r.amount)}</b><small>${fmtTime(r.timestamp)}${r.address?' | '+short(r.address):''}</small>${r.by==='system'&&r.note?`<small style="color:#D12A4B;display:block;margin-top:2px">Rejected by system · ${esc(r.note.replace(/^Anti-cheat: /,''))}</small>`:''}</div><span class="pill ${r.k}">${u[1]}</span></div>`}).join('');
 return `<section class="wdsec"><div class="mh2 wdh" style="margin-top:6px"><span class="ic2" style="color:#4B5A82">${ico('history',22)}</span><b style="font-size:18px">Withdraw History</b></div><div class="card g wsum"><div class="cir g" style="margin:0">${ico('coins',16)}</div><div><div class="lbl">Total withdrawn</div><div class="num" style="font-size:20px;font-weight:800;color:var(--gr)">${V(m3(s.stats.totalWithdraw,3))}</div></div><span class="pill on" style="margin-left:auto">${cnt('all')} requests</span></div>
<div class="wfl">${chips}</div>
<div class="card" style="padding:2px 14px">${body}</div></section>`};
P.wdhistory=()=>{return `<div class="page">${wdHistoryBlock()}</div>`};
/* ===== modals ===== */
function modal(html){const o=document.createElement('div');o.className='ov';o.innerHTML=`<div class="sheet" role="dialog">${html}</div>`;o.addEventListener('click',e=>{if(e.target===o)o.remove()});document.body.appendChild(o);lucide.createIcons();return o}
function walletModal(){if(store.s.wallet)return toast('Wallet is already connected');const o=modal(`<b style="font-size:16px">Enter your USDT (BEP-20) address</b><p>Make sure it is a valid BSC wallet address. Never share seed phrases or private keys.</p><input id="waddr" placeholder="0x..." autocomplete="off"><div class="err" id="waerr"></div><div class="row" style="margin-top:8px"><button class="btn ghost" data-x>Cancel</button><button class="btn" data-save>Save</button></div>`);
 o.querySelector('[data-x]').onclick=()=>o.remove();
 o.querySelector('[data-save]').onclick=()=>{const a=o.querySelector('#waddr').value.trim();if(!validAddr(a)){o.querySelector('#waerr').textContent='Enter a valid BEP-20 address: 0x followed by 40 hex characters.';return}act('wallet',()=>Backend.saveWallet(a),'Wallet saved').then(()=>o.remove())}}
/* ===== FAQ (Profile > FAQ): 15 topics. Tap a topic -> dialogue with the answer (English). Numbers come from the live settings. ===== */
function FAQS(){
 const s=store.s,R=s.referral||{},m=s.mining||{},mn=(s.upgrade||{}).minAdSeconds||10,usd=n=>'$'+String(+(Number(n)||0).toFixed(8)),
  hr=ms=>{const x=(Number(ms)||0)/3600e3;return x>0?String(+x.toFixed(1)):'a few'},bar=hr(m.drainMs),rec=hr(m.restoreMs);
 return [
 {id:'withdraw',t:'Withdraw',i:'wallet',a:[
  'To withdraw, connect your USDT (BEP-20) wallet, open the Withdraw page, enter an amount and confirm. The amount must be inside the minimum and maximum shown on the Withdraw page and cannot be more than your Available balance.',
  'Processing time: 12-24 hours. While your request is being processed the amount stays in Hold until it is paid or rejected.',
  'Please double-check your wallet address. Payments sent to a wrong address cannot be recovered.',
  'If KYC verification is required for your account you must complete it first (see KYC Verify).']},
 {id:'refer',t:'Refer',i:'share-2',a:[
  'Open the Refer page to get your personal Refer Link and Refer Code and share them with your friends.',
  'When someone opens your link and connects their wallet, they join your team and you instantly earn a reward: '+usd(R.partnerReward)+' for every Partner and '+usd(R.memberReward)+' for every Team Member.',
  'Every person can join only one team, and you cannot use your own link. Rewards go straight to your balance and can be withdrawn.']},
 {id:'team',t:'Team',i:'users',a:[
  'Your team is everyone connected to you through referrals: your Partners (people who joined with your link) and your Team Members (people who joined with your partners\' links).',
  'On the Refer page you can see every member\'s photo, username, who invited them and their live balance.',
  'When your team reaches '+(R.goalTarget||1000)+' members you can claim a one-time bonus of '+usd(R.goalReward)+'.']},
 {id:'partner',t:'Partner',i:'user-plus',a:[
  'A Partner is a person who joins directly with your Refer Link or Code (level 1). You earn '+usd(R.partnerReward)+' for every Partner.',
  'Anyone your Partner invites becomes your Team Member (level 2) and you earn '+usd(R.memberReward)+' for each of them.',
  'Some withdrawals or Upgrade tasks may need a certain number of Partners. The requirement is always shown on that page.']},
 {id:'upgrade',t:'Upgrade',i:'rocket',a:[
  'Upgrade tasks make your account stronger for life: a higher Per/H, energy restore, extra energy bars, or bonus rewards for inviting friends.',
  'For Watch Ad tasks watch the required number of ads (shown as x/y). When x reaches y, tap Claim to receive the reward. Each ad must stay open for at least '+mn+' seconds, closing it earlier does not count.',
  'Many tasks can be claimed again and again and everything you claim is saved forever.']},
 {id:'ban',t:'Ban/Unban',i:'ban',sup:true,a:[
  'A banned account is restricted: mining, rewards and withdrawals are blocked and a "Restricted by system" bar appears at the top of the app.',
  'Bans are usually caused by rule violations such as fake or multiple accounts, abusing referrals or ads, or suspicious activity.',
  'If you think it is a mistake, tap Support on the restricted bar and explain your case. After a successful review your account is unbanned and everything works again.']},
 {id:'hold',t:'Hold',i:'lock',a:[
  'Hold is the part of your balance reserved for withdrawal requests that are still being processed. You cannot use or withdraw it while it is on Hold.',
  'When the request is paid, the Hold amount is deducted from your balance. If the request is rejected, the amount returns to your Available balance.']},
 {id:'frozen',t:'Frozen',i:'snowflake',sup:true,a:[
  'Frozen balance is temporarily locked and cannot be withdrawn. It can be set by the system or our team, for example during a security check or after repeated blocked withdrawal attempts.',
  'If you believe part of your balance was frozen by mistake, contact Support. When the review is finished the amount is released back to your Available balance.']},
 {id:'mining',t:'Mining',i:'pickaxe',a:[
  'Tap Start Mining on the Mining page (your wallet must be connected). While mining, you earn your Per/H rate every hour and your balance grows live.',
  'Mining uses energy. When all energy bars are used, mining stops. One bar lasts about '+bar+' hours of mining and recharges in about '+rec+' hours while you are not mining.',
  'You can boost your earnings and energy from the Upgrade page.']},
 {id:'kyc',t:'KYC Verify',i:'badge-check',sup:true,a:[
  'Some accounts must be verified (KYC) before they can withdraw. If your Profile shows "Get Verify Yourself", verification is required for your account.',
  'To verify, you have to contact Support and follow the instructions they give you. Verification is completed only through Support.',
  'While verification is pending, withdrawals are disabled. After Support verifies you, your Profile shows "No Need" and you can withdraw normally.']},
 {id:'support',t:'Support',i:'headphones',sup:true,a:[
  'Need help? Open Profile and tap Support, or use the Contact Support button below, to chat with our team on Telegram.',
  'Send your Telegram username, describe the problem clearly and add screenshots if you can, so we can help you faster.',
  'Never share your seed phrase or private key with anyone, including Support.']},
 {id:'energy',t:'Energy Bars',i:'battery-charging',a:[
  'Energy bars show how long you can keep mining. Each bar lasts about '+bar+' hours and recharges in about '+rec+' hours when you are not mining.',
  'You currently have '+(m.usable||0)+' of '+(m.maxEnergy||5)+' bars. Locked bars can be unlocked one by one from the Upgrade page by watching ads and claiming.']},
 {id:'perh',t:'Per/H Rate',i:'trending-up',a:[
  'Per/H is the amount you earn for every hour of mining. You can see your current rate on the Upgrade page.',
  'Increase it permanently by completing Upgrade tasks (watching ads or inviting friends). Every boost you claim is added on top and saved for life, so you can keep growing your rate.']},
 {id:'wallet',t:'Wallet',i:'plug',a:[
  'A wallet is needed to mine, join a team and withdraw. Connect a valid USDT (BEP-20) address: it starts with 0x and has 42 characters in total.',
  'Withdrawals are sent only to your connected wallet. Check the address carefully, use an address that supports BEP-20, and never share your seed phrase or private key.']},
 {id:'ads',t:'Watch Ads',i:'tv',a:[
  'Ads keep the app free and are used by Upgrade tasks. For a task, stay on the ad for at least '+mn+' seconds so it counts.',
  'An ad may also open by itself every couple of minutes while you are using the app. These automatic ads do not give rewards.',
  'If an ad does not load, check your connection and try again.']}];
}
function faqOpen(){const L=FAQS(),o=modal(`<b style="font-size:17px">FAQ</b><p>Tap a topic to read the answer.</p><div class="faqg">${L.map(f=>`<button class="faqt" data-faq="${f.id}">${ico(f.i,18)}<span>${esc(f.t)}</span></button>`).join('')}</div><div class="row" style="margin-top:12px"><button class="btn ghost" data-x>Close</button></div>`);
 o.querySelector('[data-x]').onclick=()=>o.remove();o.querySelectorAll('[data-faq]').forEach(b=>b.onclick=()=>faqAnswer(b.dataset.faq));lucide.createIcons()}
function faqAnswer(id){const f=FAQS().find(x=>x.id===id);if(!f)return;
 const o=modal(`<div class="faqh">${ico(f.i,22)}<b>${esc(f.t)}</b></div><div class="faqa">${f.a.map(p=>`<p>${esc(p)}</p>`).join('')}</div><div class="row" style="margin-top:12px">${f.sup?'<button class="btn" data-sup>Contact Support</button>':''}<button class="btn ghost" data-x>Close</button></div>`);
 o.querySelector('[data-x]').onclick=()=>o.remove();const sp=o.querySelector('[data-sup]');if(sp)sp.onclick=()=>{const u=(store.s.links||{}).support;u?openLinkSmart(u):toast('Support link is not available yet')};lucide.createIcons()}
function confirmWd(amt){const o=modal(`<b style="font-size:16px">Confirm withdrawal</b><p>Withdraw ${money(amt)} to ${short(store.s.wallet.address)} on ${CONFIG.NETWORK}? The request is verified by the server.</p><div class="row"><button class="btn ghost" data-x>Cancel</button><button class="btn" data-ok>Confirm</button></div>`);
 o.querySelector('[data-x]').onclick=()=>o.remove();o.querySelector('[data-ok]').onclick=()=>{o.remove();act('wd',async()=>{const r=await Backend.requestWithdraw(amt);if(r&&r.rejected)throw new Error('Withdrawal rejected by system. '+r.reason+(r.frozen?'. $'+r.amount+' is now frozen.':(r.left>0?'. '+r.left+' more rejected '+(r.left>1?'tries':'try')+' will freeze the amount.':'')))},'Withdrawal requested')}}

/* ===== router / render ===== */
let USER,route='home';const NAV=[['home','Home','home'],['team','Refer','users'],['mining','Mining','pickaxe'],['upgrade','Upgrade','rocket'],['profile','Profile','user']];
function shell(){$('#app').innerHTML=`${USER.guest?'<div class="demobar">Guest mode · mining works, but rewards are saved on this device only. Open in Telegram to withdraw</div>':''}<header class="hd">${avatar(USER,42)}<div class="t"><b>${esc(USER.firstName||'User')}</b><small>${USER.username?'@'+esc(USER.username):'UID: '+esc(USER.uid)}</small></div><button class="back" id="bellb" aria-label="Notifications">${ico('bell',18)}</button></header><main id="main"></main><nav>${NAV.map(([k,l,i])=>`<button data-nav="${k}">${ico(i,20)}${l}</button>`).join('')}</nav>`;
 $('#bellb').onclick=()=>toast('No new notifications');
 $('nav').addEventListener('click',e=>{const b=e.target.closest('[data-nav]');if(b)go(b.dataset.nav)});
 $('#main').addEventListener('click',onClick)}
function go(r){if(r==='wdhistory')wdFilter='all';route=r;draw();$('#main').scrollTop=0}
function header(){const h=$('#hd');if(!h)return;h.style.display=(route==='profile'||route==='withdraw')?'none':'flex';h.innerHTML=`${avatar(USER,42)}<div><small>Welcome back</small><b>${esc(store.s.banned?'Restricted by system':USER.firstName)}</b></div><span class="pill on" style="margin-left:auto">${ico('gauge',13)}<span class="num" style="font-size:12px">${rate(store.s.mining.ratePerHour)}/h</span></span>`}
/* ===== live DOM patcher =====
   Every store change used to rebuild the whole page (innerHTML) + re-create all icons + replay the page slide-in animation,
   which looked like a reload. Now the new HTML is diffed against the screen and ONLY what changed is touched: unchanged
   elements, icons, avatars, scroll positions, focus and typed text stay exactly as they are, and changed numbers/classes
   update in place (so CSS transitions animate instead of blinking). A full rebuild happens only when the page itself changes. */
const Dom=(()=>{
  const SKIP='#gring,#pbar,#ppct,#live,#energysub';                       // ticker-driven nodes (mineTick), never reverted by a patch
  const ikey=n=>n.nodeType===1?(n.getAttribute('data-ico')||n.getAttribute('data-lucide')):null;   // lucide icon: <i data-lucide> (new) or the <svg> it became
  const same=(o,n)=>{if(o.nodeType!==n.nodeType)return false;if(o.nodeType!==1)return true;
    const a=ikey(o),b=ikey(n);if(a||b)return a===b;
    return o.nodeName===n.nodeName&&(o.id||'')===(n.id||'')};
  function attrs(o,n){for(const a of [...o.attributes])if(!n.hasAttribute(a.name))o.removeAttribute(a.name);
    for(const a of n.attributes)if(o.getAttribute(a.name)!==a.value)o.setAttribute(a.name,a.value)}   // a typed-in input value is a property, not an attribute: it survives
  function node(o,n){
    if(o.nodeType!==1){if(o.nodeValue!==n.nodeValue)o.nodeValue=n.nodeValue;return}
    if(ikey(o)){const st=n.getAttribute('style');if(st!==null&&o.getAttribute('style')!==st)o.setAttribute('style',st);return}   // icon already drawn: keep it
    if(o.matches(SKIP))return;
    attrs(o,n);kids(o,n)}
  function kids(a,b){const nk=[...b.childNodes];let i=0;
    for(const n of nk){const o=a.childNodes[i];
      if(!o){a.appendChild(n);i++;continue}
      if(same(o,n)){node(o,n);i++;continue}
      let f=null;if(n.nodeType===1&&n.id){for(let j=i+1;j<a.childNodes.length;j++){const c=a.childNodes[j];if(c.nodeType===1&&c.id===n.id){f=c;break}}}
      if(f){a.insertBefore(f,o);node(f,n);i++;continue}
      a.insertBefore(n,o);i++}
    while(a.childNodes.length>i)a.removeChild(a.lastChild)}
  return{patch(el,html){const t=document.createElement('template');t.innerHTML=html;kids(el,t.content)}};
})();
function icons(){document.querySelectorAll('i[data-lucide]').forEach(i=>{if(!i.hasAttribute('data-ico'))i.setAttribute('data-ico',i.getAttribute('data-lucide'))});lucide.createIcons()}   // only new <i> are converted
let lastRoute='';
function draw(){const m=$('#main');const html=P[route]();
 if(lastRoute===route&&m.firstChild)Dom.patch(m,html);                      // same page: update in place (no flash, no animation, no reload feel)
 else{const y=m.scrollTop;m.innerHTML=html;m.scrollTop=y}                   // another page: build it once
 lastRoute=route;header();{const hd=document.querySelector('.hd');if(hd)hd.style.display=['home','team','mining','profile','withdraw','wdhistory'].includes(route)?'none':'flex'}liveTick();mineTick();
 document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.nav===(route==='withdraw'||route==='wdhistory'?'profile':route)));icons()}
function openLinkSmart(u){if(Auth.tg&&/^https?:\/\/(t|telegram)\.me\//i.test(u)&&Auth.tg.openTelegramLink)return Auth.tg.openTelegramLink(u);return Auth.tg?Auth.tg.openLink(u):window.open(u,'_blank','noopener')}
function onClick(e){const ey=e.target.closest('[data-eye]');if(ey){const t=$('#'+ey.dataset.eye);t.dataset.h=t.dataset.h?'':'1';if(t.dataset.h){t.dataset.v=t.textContent;t.textContent='$ ••••'}else t.textContent=t.dataset.v;return}const t=e.target.closest('button,[data-link],[data-go],[data-task],[data-upg]');if(!t)return;const d=t.dataset;
 if(d.bell!==undefined)return toast('No new notifications');if(d.wf!==undefined){wdFilter=d.wf;return draw()}if(d.tt){teamTab=d.tt;return draw()}if(d.claimgoal!==undefined){if(!USER.guest&&!store.s.wallet){toast('Connect your wallet first to continue');return walletModal()}return act('goal',async()=>{toast(await Backend.claimTeamGoal())})}if(d.share){return openLinkSmart('https://t.me/share/url?url='+encodeURIComponent(d.share)+'&text='+encodeURIComponent('Join me on '+CONFIG.APP_NAME+' and start earning!'))}if(d.max!==undefined){$('#wamt').value=Math.min(availLive(),store.s.wdRules.max).toFixed(CONFIG.DECIMALS);return}if(d.ext)return Auth.tg?Auth.tg.openLink(d.ext):window.open(d.ext,'_blank','noopener'); if(d.go)return go(d.go); if(d.copy)return copy(d.copy); if(d.wallet!==undefined)return walletModal();
 if(d.retry!==undefined)return Backend.connect(USER);
 if(d.more!==undefined)return act('more',()=>Backend.claimHistoryPage());
 if(d.mine!==undefined&&!USER.guest&&!store.s.wallet){toast('Connect your wallet first to start mining');return walletModal()}
 if(d.mine!==undefined){const _m=store.s.mining;if(_m.isMining)return toast('Mining is running. It stops automatically when energy ends.');if(!energyInfo().canStart)return toast('Not enough energy. You need at least 1 energy bar to start.')}
 if(d.mine!==undefined)return act('mine',()=>Backend.startMining(),'Mining started');
 if(d.upg){const T=(store.s.upgTasks||[]).find(x=>x.id===d.upg);if(!T)return;const k=d.uact;
  const bt=e.target.closest('.btn');if(!bt)return;                                   // only the button reacts, not the whole card
  if(k==='done'||k==='lock')return toast(d.ulock||'Already completed');
  if(k!=='watch'&&!USER.guest&&!store.s.wallet){toast('Connect your wallet first to continue');return walletModal()}   // Watch Ad must open WITHOUT a wallet; the wallet is only checked when the reward is counted / claimed
  if(k==='invite')return shareInvite();                                              // opens the Telegram share sheet with MY team link
  if(k==='claim')return act('claim',async()=>{toast(await Backend.claimUpgrade(T.id))});
  if(busy.has('ad'))return;                                                            // an ad request is already running: repeated taps are ignored
  return act('ad',async()=>{try{toast(await Backend.watchUpgradeAd(T.id,st=>adUI(T.id,st)))}catch(e){if(e&&e.needWallet){toast(e.message);walletModal();return}throw e}finally{adUI(T.id,null)}})}   // button: Loading… -> Verifying 0..100% -> counted / not counted
 if(d.link){if(d.link==='faq')return faqOpen();const u=store.s.links[d.link];if(d.link==='kyc'&&!u)return faqAnswer('kyc');return u?openLinkSmart(u):toast('Not available yet')}
 if(d.wd!==undefined){const a=parseFloat($('#wamt').value),er=$('#werr'),b=store.s.balances,w=store.s.wallet;let m='';
  if(!w||!validAddr(w.address))m='Connect a valid wallet first.';else if(store.s.kyc){er.textContent='';toast('KYC verification required before withdrawing');return faqAnswer('kyc')}else if(store.s.wdRules.restricted){er.textContent='';return toast('Your account is restricted from withdrawal system')}else if(!(a>0))m='Enter an amount.';else if(store.s.wdRules.needRef&&(store.s.wdRules.haveRef||0)<store.s.wdRules.needRef)m=`You need ${store.s.wdRules.needRef} referral to withdraw.`;else if(a<store.s.wdRules.min-1e-9)m=`Minimum withdrawal is $${store.s.wdRules.min}.`;else if(a>store.s.wdRules.max+1e-9)m=`Maximum withdrawal is $${store.s.wdRules.max}.`;else if(a>availLive()+1e-9)m='Amount exceeds your Available balance. Hold and Frozen cannot be withdrawn.';
  er.textContent=m;if(!m)confirmWd(a)}}

/* live ticker: balances, mining gauge and energy update in place (no DOM rebuild) */
setInterval(()=>{liveTick();
 if(route==='team')document.querySelectorAll('[data-lbid]').forEach(el=>{const t=lbTxt(el.dataset.lbid);if(el.textContent!==t)el.textContent=t});
 mineTick();
},250);
/* activity feed: re-render only the list when a new minute starts (new item slides in) or the "x min ago" labels change */
let actSig='';
setInterval(()=>{if(route!=='home')return;const L=$('#actList');if(!L)return;const h=actRows(),top=Math.floor(Date.now()/ACT_STEP)+'';
 if(h===actSig)return;const fresh=actSig&&L.firstElementChild&&L.firstElementChild.dataset.slot!==top;actSig=h;L.innerHTML=h;
 if(fresh&&L.firstElementChild)L.firstElementChild.classList.add('new');icons()},1000);
/* mining gauge, % bar, live amount and energy pips (driven by the ticker, so a page patch never has to touch them) */
function mineTick(){if(route!=='mining')return;
 {const m=store.s.mining,pr=Math.min(1,Math.max(0,m.isMining&&m.endsAt>m.startedAt?(Date.now()-m.startedAt)/(m.endsAt-m.startedAt):(m.progress||0))),C=2*Math.PI*72,g=$('#gring'),bb=$('#pbar'),pp=$('#ppct');g&&g.setAttribute('stroke-dasharray',Math.max(.001,pr*.75*C)+' '+C);bb&&(bb.style.width=Math.round(pr*100)+'%');pp&&(pp.textContent=Math.round(pr*100)+'%')}
 if(store.s.mining.isMining){const e=$('#live');e&&(e.textContent=m3(liveMining(),8))}
 const bar=$('#energybar');if(bar){const e=energyInfo(),di=(store.s.mining.isMining||e.E<e.U-1e-9)?Math.max(0,Math.ceil(e.E-1e-9)-1):-1;[...bar.children].forEach((c,i)=>{if(i>=e.U)return;const f=pipFill(e.E,i);c.classList.toggle('on',f>=0.99999);c.classList.toggle('dr',i===di);c.style.background=(f>0.00001&&f<0.99999)?pipBg(f):''});const sb=$('#energysub');sb&&(sb.textContent=e.msg);const pn=bar.closest('.enrg');pn&&pn.classList.toggle('empty0',e.E<1&&!store.s.mining.isMining)}
}

/* targeted updates so lists don't rebuild whole page */
store.on(keys=>{ if(!$('#main'))return;
 if(route==='mining'&&keys.every(k=>['team','links','tasks','withdrawals','wdRules','wallet','progress','kyc','online'].includes(k)))return;   // data the mining page doesn't show: don't rebuild it
 if(route==='team'&&keys.length===1&&keys[0]==='memberBalances'){return}
 draw() });
addEventListener('online',()=>{store.patch({online:true});toast('Back online')});addEventListener('offline',()=>toast('You are offline'));

store.on(()=>{if(store.s.loaded&&window.Splash)Splash.done()});   // data ready (or error state) -> finish splash
/* ===== boot ===== */
Auth.init();
function boot(){USER=Auth.user();window.Splash&&Splash.set(52,'Starting…');
 if(!USER){window.Splash&&Splash.done();$('#app').innerHTML=`<div class="gate"><div><div class="ic" style="margin:0 auto 12px;width:52px;height:52px">${ico('send',24)}</div><h1>Please open in Telegram on your phone</h1><p style="color:var(--mut)">This app works only inside the Telegram mobile app. Browsers and Telegram Web are not supported.</p></div></div>`;lucide.createIcons();return}
 shell();draw();Backend.loadWallet();Backend.connect(USER)}
let booted=false;const bootOnce=()=>{if(booted)return;booted=true;Auth.init();boot()};
if(Auth.tg)bootOnce();
else{ // give Telegram SDK a moment; outside Telegram it falls back to Guest
  const sc=document.createElement('script');sc.src='https://telegram.org/js/telegram-web-app.js';sc.onload=bootOnce;sc.onerror=bootOnce;document.head.appendChild(sc);setTimeout(bootOnce,2500)}

/* banned: app stays visible but read-only; only the Support button works */
(()=>{const st=document.createElement('style');st.textContent='#banbar{flex:none;display:flex;align-items:center;gap:10px;padding:10px 14px;background:linear-gradient(135deg,#3a0d1c,#1a0812);border-bottom:1px solid rgba(255,77,109,.5);z-index:50}#banbar .bt{flex:1;min-width:0}#banbar b{display:block;color:#D12A4B;font-size:14px}#banbar small{color:#c9a0aa;font-size:12px}#banSup{border:0;border-radius:12px;padding:10px 16px;font-weight:800;font-size:13px;color:#fff;background:linear-gradient(135deg,#1E90FF,#0C5FC9)}body.banned main{user-select:none;-webkit-user-select:none}';document.head.appendChild(st)})();
store.on(()=>{const b=store.s.banned===true,app=document.getElementById('app');document.body.classList.toggle('banned',b);let o=document.getElementById('banbar');
 if(b&&app&&!o){o=document.createElement('div');o.id='banbar';o.innerHTML=banAv(40)+'<div class="bt"><b>Restricted by system</b><small>userban</small></div><button id="banSup">Support</button>';
  app.insertBefore(o,app.firstChild);o.querySelector('#banSup').onclick=()=>{const u=(store.s.links||{}).support;u?openLinkSmart(u):toast('Support link not available yet')}}
 else if(!b&&o)o.remove()});
const roBlock=e=>{if(!store.s.banned||(e.target.closest&&e.target.closest('#banSup')))return;if(e.type==='keydown'&&e.key!=='Enter'&&e.key!==' ')return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation()};
['click','keydown','submit','change','input'].forEach(t=>document.addEventListener(t,roBlock,true));
document.addEventListener('focusin',e=>{if(store.s.banned&&e.target.matches&&e.target.matches('input,textarea,select'))e.target.blur()},true);

/* ===== JOIN GATE: user must be a member of the admin's Telegram channel (Admin > Settings > Channel join gate) =====
   Join Now -> opens the channel, button becomes Verify -> Verify asks the Bot API (getChatMember) -> joined = access.
   Re-checked every N seconds while the app is open + every time the user comes back to the app, so leaving the channel locks the app again. */
const JoinGate=(()=>{
  let joined=null,clicked=false,busy=false,lastAt=0,sig='',errLogged=false,tmr=null;
  const cfg=()=>store.s.joinGate||{};
  const chatId=c=>{let v=String(c.channel||'').trim().replace(/^https?:\/\/(t|telegram)\.me\//i,'').replace(/^@/,'');return /^-?\d+$/.test(v)?v:(v?'@'+v:'')};
  const linkOf=c=>{const l=String(c.link||'').trim();if(l)return l;const v=chatId(c);return v&&v[0]==='@'?'https://t.me/'+v.slice(1):''};
  const on=()=>{const c=cfg();return c.enabled===true&&!!chatId(c)&&!!USER&&!USER.guest&&!store.s.banned};
  const clean=m=>String(m||'').replace(/bot\d+:[\w-]+/g,'bot***');
  async function ask(){
    const c=cfg(),chat=chatId(c);
    if(c.token){                                    // bot token comes from Admin > Settings > Channel join gate
      const j=await (await fetch('https://api.telegram.org/bot'+String(c.token).trim()+'/getChatMember?chat_id='+encodeURIComponent(chat)+'&user_id='+encodeURIComponent(USER.uid))).json();
      if(!j.ok)throw new Error('Join gate Telegram: '+clean(j.description||'error'));
      const m=j.result||{},st=m.status;return st==='member'||st==='administrator'||st==='creator'||(st==='restricted'&&m.is_member===true);
    }
    throw new Error('Join gate: no bot token set in Admin');
  }
  async function check(auto,back){
    if(!on()||busy)return;
    if(auto&&Date.now()-lastAt<(back?1500:5000))return;   // 'back' = user just returned to the app: check almost immediately
    busy=true;lastAt=Date.now();paint();
    try{
      const ok=await ask();const was=joined;joined=ok;
      if(!ok&&!manualMsg.t)manualMsg.t=auto?'':'You have not joined yet. Join the channel, then tap Verify.';
      if(ok){manualMsg.t=''}
      if(was===true&&!ok)clicked=false;             // joined before, left now -> start again from "Join Now"
    }catch(e){                                      // API/network problem: keep the previous state (never lock people out because of a config or network error)
      if(!auto)manualMsg.t='Could not check right now. Please try again.';
      if(!errLogged){errLogged=true;try{Logger.push('joingate',e)}catch(x){}}
    }
    busy=false;paint();
  }
  const manualMsg={t:''};
  function css(){if(document.getElementById('jgcss'))return;const st=document.createElement('style');st.id='jgcss';
    st.textContent='#jg{position:fixed;inset:0;z-index:9990;display:flex;align-items:flex-end;justify-content:center;background:rgba(3,6,20,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);touch-action:none}'
    +'#jg .jgs{width:100%;max-width:520px;min-height:46%;box-sizing:border-box;background:var(--card);color:var(--ink);border-radius:26px 26px 0 0;border:1px solid var(--edge);border-bottom:0;padding:26px 22px calc(24px + var(--sb));text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;animation:jgup .32s cubic-bezier(.2,.8,.2,1);box-shadow:0 -10px 40px rgba(31,107,255,.28)}'
    +'@keyframes jgup{from{transform:translateY(100%)}to{transform:none}}'
    +'#jg .jgi{width:64px;height:64px;border-radius:50%;background:var(--pus);color:var(--pu);display:grid;place-items:center;margin-bottom:4px}'
    +'#jg h2{font:800 20px Plus Jakarta Sans,sans-serif;margin:0}#jg p{color:var(--mut);font-size:14px;line-height:1.5;margin:0 0 6px;max-width:340px}'
    +'#jg .btn{width:100%;max-width:360px}#jg .btn.v{background:var(--gr);border-color:rgba(120,240,190,.6);box-shadow:0 0 20px rgba(52,211,153,.4),inset 0 1px 0 rgba(255,255,255,.25);color:#052b1c}#jg .btn[disabled]{opacity:.65}'
    +'#jg .jgm{min-height:18px;font-size:12.5px;font-weight:700;color:var(--red)}#jg .jgl{background:0;border:0;color:var(--mut);font:700 12.5px Plus Jakarta Sans,sans-serif;text-decoration:underline;padding:6px}';
    document.head.appendChild(st)}
  function paint(){
    const want=on()&&joined===false;let el=document.getElementById('jg');
    if(!want){if(el)el.remove();return}
    css();const c=cfg();
    if(!el){el=document.createElement('div');el.id='jg';
      el.innerHTML='<div class="jgs"><div class="jgi">'+ico('send',30)+'</div><h2></h2><p></p><button class="btn" id="jgmain"></button><div class="jgm" id="jgmsg"></div><button class="jgl" id="jgagain">Open channel again</button></div>';
      document.body.appendChild(el);try{lucide.createIcons()}catch(e){}
      el.querySelector('#jgmain').onclick=()=>{if(!clicked){const l=linkOf(cfg());if(!l){toast('Channel link not set');return}clicked=true;manualMsg.t='';openLinkSmart(l);paint()}else check(false)};
      el.querySelector('#jgagain').onclick=()=>{const l=linkOf(cfg());l&&openLinkSmart(l)};
      ['touchmove','wheel'].forEach(n=>el.addEventListener(n,e=>e.preventDefault(),{passive:false}))}
    el.querySelector('h2').textContent=c.title||'Join our channel';
    el.querySelector('p').textContent=c.text||'Join our official Telegram channel to use the app.';
    const b=el.querySelector('#jgmain');b.disabled=busy;b.classList.toggle('v',clicked);b.textContent=busy?'Checking…':(clicked?'Verify':'Join Now');
    el.querySelector('#jgmsg').textContent=manualMsg.t;el.querySelector('#jgagain').style.display=clicked?'':'none';
  }
  function sync(){
    const c=cfg(),s=[c.enabled,chatId(c),c.token,c.interval].join('|');
    if(s!==sig){sig=s;joined=null;errLogged=false;clearInterval(tmr);tmr=null;if(on())check(true)}
    if(on()&&!tmr){tmr=setInterval(()=>{if(on()&&!document.hidden)check(true)},Math.max(10,Number(cfg().interval)||30)*1000)}
    if(!on()){joined=null;paint();return}
    if(joined===null&&!busy)check(true);else paint();
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)check(true,true)});
  addEventListener('focus',()=>check(true,true));
  try{Auth.tg&&Auth.tg.onEvent&&Auth.tg.onEvent('activated',()=>check(true,true))}catch(e){}
  store.on(()=>sync());
  return{check,sync,get joined(){return joined}};
})();
