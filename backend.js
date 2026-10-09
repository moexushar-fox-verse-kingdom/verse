/* =====================================================================
   BACKEND = Firebase Realtime Database only (no Cloud Functions, no Auth)
   ---------------------------------------------------------------------
   DATABASE MAP
   users/{uid}                 profile + balances + mining state (public per-uid read)
   userPrivate/{uid}           deviceIp, localIp, userAgent...   (write-only, read blocked)
   leaderboard/{uid}           legacy copy (kept in sync, no longer read). The home Top 10 is read from users/ ordered by totalBalance
   teams/{referrerUid}/members/{uid}   who joined by this user + commission earned from them
   miningHistory/{uid}/{id}    one row per finished mining session
   withdrawals/{uid}/{id}      user's withdraw requests (status: pending|completed|rejected)
   withdrawQueue/{id}          admin to-do list (read blocked; delete row after paying)
   settings/...                admin controlled: mining rate, session, energy, tasks, links
   WALLET FIRST: nothing is written for a user until a wallet is connected. A brand-new user has no users/{uid} record at all;
   saveWallet() creates the record (+ referral, team row, leaderboard row) together with the wallet in ONE atomic update.
   adConfig/...                admin controlled ads: provider (monetag|adsgram, exactly one), -> Ads in app.js
   MINING MODEL: 5 energy bars, 2 locked. Usable bars = 3 + unlocked (500 ads per unlocked bar, max +2).
   1 bar drains in sessionHours/3 (20h/3) while mining and recharges in energyRechargeHours/3 (5h/3).
   Mining can start with >= 1 bar (no need to be full); the session lasts until the energy is 0, then it
   stops automatically (no manual stop) and the user must press Start again. Rewards are credited to the
   balance automatically (checkpoint every 5 min + at session end) - no claim button.
   Ads: energyAd (x ads = unlock bar 4), extraBarAd (y ads = unlock bar 5), rateAd (2 ads = +0.00001 Per/H). Guests mine locally (localStorage).
   ===================================================================== */
const SP=(p,t)=>{try{window.Splash&&Splash.set(p,t)}catch(e){}};
const DEFSTAGES=[{refer:0,min:0.1,max:0.5,hint:false,restrict:false},{refer:1,min:0.5,max:0.5,hint:true,restrict:false},{refer:1,min:50,max:100,hint:true,restrict:true}];   // used until admin saves wdStages
const DEFAULTS={
  baseRatePerHour:0.00139,
  baseEnergy:3, maxEnergy:5,          // base bars unlocked, the rest locked; admin Upgrade tasks unlock them one by one (bar tasks)
  sessionHours:20,                    // 3 bars drain in 20h (=> 1 bar = 20/3 h of mining)
  energyRechargeHours:5,              // 3 bars fully recharge in 5h (=> 1 bar = 5/3 h)
  teamCommissionPercent:10, minWithdraw:0.1,
  upgrade:{minAdSeconds:10},           // an ad only counts if it stayed open at least this many seconds (admin: Upgrade > Settings)
  links:{channel:'',support:'',faq:'',kyc:''},
  referral:{enabled:true,partnerReward:0.001,memberReward:0.0005,goalTarget:1000,goalReward:50}   // partner = direct invite (level 1), member = partner's invite (level 2); goal = team-size milestone
};
const r8=n=>Math.round((Number(n)||0)*1e8)/1e8;
const dayKey=t=>new Date(t).toISOString().slice(0,10);
const balOf=u=>r8((Number(u.totalMining)||0)+(Number(u.totalCommission)||0)+(Number(u.totalReferral)||0));
const clamp01=n=>Math.max(0,Math.min(1,n));
const isPlain=o=>o&&typeof o==='object'&&!Array.isArray(o);
const deepMerge=(a,b)=>{const o={...a};for(const k in (b||{})){o[k]=isPlain(o[k])&&isPlain(b[k])?deepMerge(o[k],b[k]):b[k]}return o};

const Backend={
  db:null,uid:null,offset:0,cfg:deepMerge(DEFAULTS,{}),user:null,
  offs:[],histOff:null,histLimit:20,settling:false,ckBusy:false,isGuest:false,gh:[],inflight:new Set(),_sig:'',_tick:null,_seen:null,

  /* ---- basics ---- */
  TS(){return firebase.database.ServerValue.TIMESTAMP},
  ref(p){return this.db.ref(p)},
  uref(){return this.ref('users/'+this.uid)},
  now(){return Date.now()+this.offset},          // server-corrected clock
  local(t){return t-this.offset},                // server time -> device time (for UI timers)
  init(){
    if(typeof firebase==='undefined')throw new Error('Firebase SDK failed to load');
    if(!firebase.apps.length)firebase.initializeApp(FIREBASE_CONFIG);
    /* Google Analytics (optional): never blocks the app if it is unsupported, blocked or fails */
    try{if(firebase.analytics&&FIREBASE_CONFIG.measurementId&&/^https?:$/.test(location.protocol))firebase.analytics.isSupported().then(ok=>{if(ok)firebase.analytics()}).catch(()=>{})}catch(e){}
    this.db=firebase.database();
    this.ref('.info/serverTimeOffset').on('value',s=>{this.offset=Number(s.val())||0});
  },
  listen(q,ev,cb,err){const h=q.on(ev,cb,err);const off=()=>q.off(ev,h);this.offs.push(off);return off},
  detach(){this.offs.forEach(f=>{try{f()}catch(e){}});this.offs=[];if(this.histOff){try{this.histOff()}catch(e){}this.histOff=null}clearInterval(this._tick)},

  /* ---- connect ---- */
  async connect(user){
    if(user&&user.guest){                                     // guest: reads PUBLIC data only (settings + leaderboard); mining state lives in localStorage, nothing written to the database
      this.detach();this.isGuest=true;this.uid='guest';
      try{this.init();this.watchSettings();this.watchAds();this.watchStages()}catch(e){console.error(e)}
      this.user=this.guestLoad();const d=this.demoData();
      SP(93,'Almost ready…');store.patch({loaded:true,error:null,...d,history:[...this.gh,...d.history]});
      this.render(this.user);this.startTicker();this.settle().catch(()=>{});return}
    this.isGuest=false;this.detach();store.patch({error:null});
    try{
      this.init();this.uid=String(user.uid);this.tgUser=user;this.pending=false;this.active=false;SP(60,'Connecting…');
      this.watchSettings();this.watchAds();this.watchStages();
      const snap=await this.uref().once('value'),ex=snap.val();
      if(ex){if(this.hasWallet(ex))await this.ensureUser(user)}      // profile / leaderboard sync only for wallet-connected users
      else{                                                          // brand-new user: keep everything in memory, write NOTHING yet
        this.pending=true;this.user=this.blankUser(user);this.render(this.user);
      }
      SP(84,'Loading your account…');
      this.watchUser();this.watchTeam();this.watchHistory();this.watchWithdrawals();
      this.startTicker();
      if(this.pending)store.patch({loaded:true,error:null});
    }catch(e){console.error(e);store.patch({loaded:true,error:'Cannot connect to the server. Check your connection and retry.',history:[],withdrawals:[],team:{members:[],teamError:'Cannot connect to the server.'}})}
  },
  /* ---- wallet-first helpers ---- */
  hasWallet(u){return !!(u&&u.wallet&&u.wallet.address)},
  needWallet(){if(this.isGuest)return;if(!this.hasWallet(this.user)){const e=new Error('Connect your wallet first to continue.');e.needWallet=true;throw e}},
  blankUser(user){return{uid:String(user.uid),firstName:user.firstName||'',lastName:user.lastName||'',username:user.username||'',photoUrl:user.photoUrl||'',
    totalMining:0,totalCommission:0,totalBalance:0,frozenBalance:0,holdBalance:0,totalWithdrawn:0,totalInvite:0,totalTeam:0,totalReferral:0,bonusRate:0,kyc:false,runing_withd:1}},
  /* presence + device info start only once the user has a wallet (i.e. a saved record) */
  activate(){if(this.active||this.isGuest)return;this.active=true;this.presence();this.writePrivate()},
  /* ---- ads config (admin controlled): Ads (app.js) loads the active provider's SDK with these ids ---- */
  watchAds(){
    const on=v=>{try{window.Ads&&Ads.configure(v);store.patch({adsOn:!!(window.Ads&&Ads.info().configured)})}catch(e){console.error(e)}};
    this.listen(this.ref('adConfig'),'value',s=>on(s.val()),()=>on(null));
  },
  /* ---- guest demo data: shown ONLY in guest mode (outside Telegram). Never read from / written to the database ---- */
  demoData(){
    const now=Date.now(),H=3600e3,D=24*H,d0=new Date();d0.setHours(0,0,0,0);
    const mk=(firstName,lastName,username,com,joinedAt)=>({uid:String(Math.abs(hash(firstName+username))%900000000+100000000),firstName,lastName,username,photoUrl:'',available:com,joinedAt});
    const hash=s=>{let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))|0;return h};
    const members=[
      mk('Alex','Carter','alexc',1.12345,now-2*H),
      mk('Maria','Silva','maria_s',0.8421,d0.getTime()+H),
      mk('Rahim','Uddin','rahim_u',0.6103,now-2*D),
      mk('Sofia','Rossi','sofia_r',0.4258,now-3*D),
      mk('Liam','Chen','liamchen',0.2975,now-5*D),
      mk('Nora','Ali','',0.1364,now-6*D),
      mk('Omar','Khan','omar_k',0.08,now-9*D),
      mk('Ivy','Park','ivy_p',0.0271,now-12*D)
    ];
    const l2=[mk('Zed','Noor','zed_n',0.02,now-4*D),mk('Tia','Lee','tia_l',0.01,now-8*D)].map(x=>({...x,bonus:0.0005,via:members[0].uid}));
    const commission=r8(members.reduce((s,x)=>s+x.available,0));
    const totalMining=15.2,totalBalance=r8(totalMining+commission),withdrawn=4.25,frozen=0.5,hold=1.5;
    const rate=r8(Number(this.cfg.baseRatePerHour)||0.00139);
    const todayMined=0.0272;
    const history=[0,1,2,3,4,5].map(i=>({amount:r8(0.0272-i*0.0007),status:'claimed',timestamp:now-(i*9+3)*H}));
    const addr='0x7a3F91c2B5d84E60a1cD9f3e2B7A4c58D6e01F9b';
    const withdrawals=[
      {id:'d3',status:'pending',amount:1.5,timestamp:now-5*H,address:addr},
      {id:'d2',status:'completed',amount:1.75,timestamp:now-6*D,address:addr},
      {id:'d1',status:'completed',amount:2.5,timestamp:now-15*D,address:addr}
    ];
    return{
      balances:{available:r8(totalBalance-withdrawn-frozen-hold),hold,frozen},
      mining:{ratePerHour:rate,isMining:false,totalMining,todayMining:todayMined,amount:0,syncedAt:now},
      stats:{totalIncome:totalBalance,totalWithdraw:withdrawn,totalCommission:commission},
      team:{joinedBy:'7001',joinedBy2:'7002',uplineLoaded:true,upline:[{level:1,uid:'7001',firstName:'Nora',lastName:'K',username:'nora_k',photoUrl:''},{level:2,uid:'7002',firstName:'Sam',lastName:'R',username:'sam_r',photoUrl:''}],referralCode:'ref_guest',teamCode:'alrahi42x',totalMembers:members.length,totalTeam:l2.length,referralEarned:0,goalClaimed:false,level2:l2,todayL2:0,totalCommission:commission,balance:commission,members,todayMembers:members.filter(x=>x.joinedAt>=d0.getTime()).length,teamError:null},
      memberBalances:Object.fromEntries(members.concat(l2).map((x,i)=>[String(x.uid),{bal:+(1.5+i*0.73).toFixed(4),on:i%2===0,rate:0.00139,since:now-3600e3,ends:now+5*3600e3,username:x.username||'',photoUrl:''}])),
      progress:{referrals:members.length},
      history,hasMoreHistory:false,withdrawals,kyc:false,wallet:null
    };
  },
  /* ---- guest mining state (localStorage only; try/catch because storage can be blocked) ---- */
  guestLoad(){
    try{const s=localStorage.getItem('fm_guest');if(s){const o=JSON.parse(s);if(o&&o.uid==='guest')this.user=o;
      const h=localStorage.getItem('fm_guest_hist');this.gh=h?JSON.parse(h):[];if(o&&o.uid==='guest')return o}}catch(e){}
    const c=this.demoData().stats.totalCommission,tm=15.2;
    return{uid:'guest',totalMining:tm,totalCommission:c,totalBalance:r8(tm+c),frozenBalance:0.5,holdBalance:1.5,totalWithdrawn:4.25,
      totalInvite:8,totalTeam:2,totalReferral:0,bonusRate:0,kyc:false,joinedBy:'',joinedAt:Date.now()};
  },
  guestSave(){try{localStorage.setItem('fm_guest',JSON.stringify(this.user));localStorage.setItem('fm_guest_hist',JSON.stringify(this.gh.slice(0,50)))}catch(e){}},
  /* one full leaderboard row. ALWAYS write the whole row (never a single child): the database rule needs uid + totalBalance
     on the node, so a lone child write on a missing node is rejected and that user never appears on the board. */
  lbRow(uid,p,bal){p=p||{};const t=(v,n)=>String(v==null?'':v).slice(0,n),ph=t(p.photoUrl,600);
    return{uid:String(uid),firstName:t(p.firstName,64),lastName:t(p.lastName,64),username:t(p.username,64),photoUrl:ph.length>500?'':ph,totalBalance:r8(bal)}},
  guardUpg(){if(this.user&&this.user.banned)throw new Error('Your account is banned')},   // upgrade ads / claims also work in guest mode (saved on this device only)
  guard(){if(USER&&USER.guest)throw new Error('Guest mode: open in Telegram to use this');if(this.user&&this.user.banned)throw new Error('Your account is banned')},

  /* ---- settings (admin controlled) ---- */
  watchSettings(){
    this.listen(this.ref('settings'),'value',s=>{
      const raw=s.val()||{};this.cfg=deepMerge(DEFAULTS,raw);this.upgList=this.normTasks(raw.upgradeTasks);SP(72,'Loading settings…');
      CONFIG.MIN_WITHDRAW=Number(this.cfg.minWithdraw)||CONFIG.MIN_WITHDRAW;
      store.patch({upgTasks:this.upgList,upgrade:{minAdSeconds:this.adMin()},links:{...this.cfg.links},referral:this.refCfg(),joinGate:{...(raw.joinGate||{})}});
      if(this.user)this.render(this.user);
    },()=>{});
  },

  /* ---- user create / profile sync ---- */
  /* ---- TEAM SYSTEM ----------------------------------------------------------------------------------------
     Deep link : https://t.me/<bot>?startapp=<teamCode>          (legacy ref_<uid> / <uid> links still work)
     Refer code : 8 chars, see codeBase()
     Level 1   : PARTNER      = someone who starts with MY link            -> I earn referral.partnerReward instantly
     Level 2   : TEAM MEMBER  = someone who starts with my PARTNER's link  -> I earn referral.memberReward instantly
     Team size = partners + team members. Reaching referral.goalTarget lets me claim referral.goalReward once (claimTeamGoal).
     Everything is counted when the new user saves his wallet (wallet-first design), so a bot /start alone never pays. */
  refCfg(){const r=this.cfg.referral||{},n=(v,d)=>{v=Number(v);return isFinite(v)&&v>=0?v:d};
    return{enabled:r.enabled!==false,partnerReward:n(r.partnerReward,0.001),memberReward:n(r.memberReward,0.0005),goalTarget:Math.max(1,Math.floor(n(r.goalTarget,1000))),goalReward:n(r.goalReward,50)}},
  /* start param can come from Telegram start_param, or from the URL the bot opens (?ref= / ?start= / ?code= / ?startapp=) */
  refParam(user){
    let p=String(user.startParam||'').trim();
    if(!p){try{const q=new URLSearchParams(location.search),h=new URLSearchParams(String(location.hash||'').replace(/^#/,''));
      p=String(q.get('ref')||q.get('start')||q.get('code')||q.get('startapp')||h.get('tgWebAppStartParam')||'').trim()}catch(e){}}
    return p.replace(/^\/?(?:start|teamcode)\s+/i,'').slice(0,40)},
  /* FIRST-TOUCH memory: the first valid team link a person opens is kept on the device, so the inviter is never lost when the
     person connects the wallet later from the normal app icon (no start param). Once stored it is never replaced by another link. */
  storedRef(){try{return String(localStorage.getItem('fox_ref')||'')}catch(e){return ''}},
  keepRef(raw){try{if(!localStorage.getItem('fox_ref'))localStorage.setItem('fox_ref',raw)}catch(e){}},
  dropRef(){try{localStorage.removeItem('fox_ref')}catch(e){}},
  /* one raw code/link param -> {by, gp} (empty strings when invalid / self / unknown) */
  async lookupRef(raw){
    const none={by:'',gp:''};if(!raw)return none;
    let by='';const code=raw.toLowerCase();
    for(const c of [this.isNewCode(raw.toUpperCase())?raw.toUpperCase():'',/^[a-z0-9]{9}$/.test(code)?code:'']){if(!c||by)continue;const x=await this.ref('teamCodes/'+c).once('value');if(x.exists())by=String(x.val())}
    if(!by){const m=raw.match(/^(?:ref_)?(\d{3,20})$/);if(m)by=m[1]}                       // legacy uid links
    if(!by||by===this.uid)return none;                                                       // SELF link: ignored
    const ex=await this.ref(`users/${by}/uid`).once('value');if(!ex.exists())return none;   // referrer must have a wallet-created account
    const g=await this.ref(`users/${by}/joinedBy`).once('value'),gp=String(g.val()||'');
    return{by,gp:(gp&&gp!==this.uid&&gp!==by)?gp:''}},
  /* stored (first-touch) link wins; the link opened right now is the fallback */
  async resolveRef(user){
    const tries=[],st=this.storedRef(),cur=this.refParam(user);
    if(st)tries.push(st);
    try{const pr=await this.ref('pendingRefs/'+this.uid).once('value');if(pr.exists()&&tries.indexOf(String(pr.val()))<0)tries.push(String(pr.val()))}catch(e){}   // written by the bot on /start
    if(cur&&tries.indexOf(cur)<0)tries.push(cur);
    for(const raw of tries){const r=await this.lookupRef(raw);if(r.by)return{...r,raw}}
    return{by:'',gp:'',raw:''}},
  /* runs every time a wallet-less person opens the app: remember who invited him */
  async trackRef(user){try{const cur=this.storedRef()||this.refParam(user);if(!cur)return;const r=await this.lookupRef(cur);
      if(r.by){this.keepRef(cur);this.ref('pendingRefs/'+this.uid).set(cur).catch(()=>{})}}catch(e){}},   // whenever he connects the wallet (even days later, other device) he becomes this owner's referral
  /* who am I under? -> store.team.upline = [{level,uid,name,username,photoUrl}] */
  async loadUpline(u){
    const out=[];
    for(const[lvl,id]of[[1,u.joinedBy],[2,u.joinedBy2]]){if(!id)continue;
      try{const s=await this.ref('users/'+id).once('value'),v=s.val()||{};
        out.push({level:lvl,uid:String(id),firstName:v.firstName||'',lastName:v.lastName||'',username:v.username||'',photoUrl:v.photoUrl||''})}
      catch(e){out.push({level:lvl,uid:String(id),firstName:'',lastName:'',username:'',photoUrl:''})}}
    store.patch({team:{upline:out,uplineLoaded:true}})},
  parseRef(user){const m=String(this.refParam(user)).match(/^(?:ref_)?(\d{3,20})$/);return m&&m[1]!==String(user.uid)?m[1]:''},
  /* REFER CODE = 8 characters, upper case:  AAA 111 L D
       AAA : first 3 characters of the Telegram USERNAME. No username -> first 2 letters of the first name + first letter of the last name
             (only a first name -> its first 3 letters). Missing characters are filled with X.
       111 : first 3 digits of the Telegram user ID
       L   : random letter A-Z          D : random digit 0-9
     e.g. no username, tushar khan, id 123445990 -> TUK123P8     |  username jubayer, id 1848281888 -> JUB184F0
     Old 9-character lower-case codes keep working (teamCodes keeps them); an account that has one gets a new code the next time it opens the app. */
  codeBase(prof,uid){const a=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    const U=a(prof.username),F=a(prof.firstName),L=a(prof.lastName);
    const p=((U?U.slice(0,3):(F&&L)?F.slice(0,2)+L.slice(0,1):(F+L).slice(0,3))+'XXX').slice(0,3);
    return p+String(uid).replace(/\D/g,'').slice(0,3).padEnd(3,'0')},
  isNewCode(c){return /^[A-Z0-9]{3}[0-9]{3}[A-Z][0-9]$/.test(String(c||''))},
  /* reserve a unique code in teamCodes/{code} = uid (write-once). Tries every letter+digit ending (260), random order. */
  async claimTeamCode(prof,uid){
    const base=this.codeBase(prof,uid),E=[];
    for(const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')for(const d of '0123456789')E.push(l+d);
    for(let i=E.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[E[i],E[j]]=[E[j],E[i]]}
    for(const e of E){const code=base+e,r=await this.ref('teamCodes/'+code).transaction(v=>v?undefined:String(uid));
      if(r.committed||String(r.snapshot.val())===String(uid))return code}
    throw new Error('Could not create your refer code. Try again.')},
  /* instant join reward: +1 counter and +reward on the owner, plus the bonus shown on his team row */
  async payJoin(to,level,newUid){
    const R=this.refCfg(),reward=R.enabled?r8(level===1?R.partnerReward:R.memberReward):0,cnt=level===1?'totalInvite':'totalTeam',node=level===1?'members':'level2';
    /* DUPLICATE GUARD: claim the team row's `paid` marker first. Only one caller can ever win it, so a double tap / two tabs / a retry
       can never count the same person twice or pay twice. */
    const mark=this.ref(`teams/${to}/${node}/${newUid}/paid`),claim=await mark.transaction(v=>v?undefined:1);
    if(!claim.committed)return;
    let row=null;
    try{await this.ref('users/'+to).transaction(x=>{row=null;if(!x)return x;
      x[cnt]=(Number(x[cnt])||0)+1;x.totalReferral=r8((Number(x.totalReferral)||0)+reward);x.totalBalance=balOf(x);row=this.lbRow(to,x,x.totalBalance);return x})}catch(e){await mark.remove().catch(()=>{});throw e}
    if(row===null){await mark.remove().catch(()=>{});return}
    await this.ref(`teams/${to}/${node}/${newUid}`).update({bonus:reward,st:'ok',fl:''}).catch(()=>{});
    await this.ref('leaderboard/'+to).update(row).catch(()=>{});
  },
  /* ---- WITHDRAW ANTI-CHEAT (referrals are NOT affected by it) ---------------------------------------------------------
     Admin: Settings > Withdraw stages > "Anti cheat" checkbox on a stage (+ "check IP too"). When it is ON for the user's current stage and he
     asks for a withdrawal, the request is created as PENDING and then the system immediately REJECTS it (rejectedBy = system, reason saved,
     the held balance goes back to him) if another account uses the same device, the same IP or the same wallet.
     deviceIndex/{device}/{uid}, ipIndex/{hash(ip)}/{uid}, walletIndex/{wallet}/{uid} are filled whenever an account opens the app. */
  devKey(){try{let d=localStorage.getItem('fox_dev');if(!d){d=(Math.random().toString(36).slice(2,12)+Date.now().toString(36)).replace(/[^a-z0-9]/g,'').slice(0,24);localStorage.setItem('fox_dev',d)}return 'd'+d}catch(e){return ''}},
  h53(str){let h1=0xdeadbeef,h2=0x41c6ce57;for(let i=0,c;i<str.length;i++){c=str.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677)}
    h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);return(4294967296*(2097151&h2)+(h1>>>0)).toString(36)},
  async myIp(){try{let v=sessionStorage.getItem('fox_ip');if(v)return v;
      const c=typeof AbortController!=='undefined'?new AbortController():null,t=c&&setTimeout(()=>c.abort(),4000);
      const r=await fetch('https://api.ipify.org?format=json',c?{signal:c.signal}:{});clearTimeout(t);const j=await r.json(),ip=String(j&&j.ip||'');
      if(/^[0-9a-fA-F:.]{3,45}$/.test(ip)){sessionStorage.setItem('fox_ip',ip);return ip}}catch(e){}return ''},
  async registerIdent(u){
    if(this.isGuest||!this.uid)return;
    try{const dev=this.devKey(),ip=await this.myIp(),a=u&&u.wallet&&u.wallet.address,t=Date.now(),w=[];
      if(dev)w.push(this.ref(`deviceIndex/${dev}/${this.uid}`).set(t));
      if(ip)w.push(this.ref(`ipIndex/i${this.h53(ip)}/${this.uid}`).set(t));
      if(a)w.push(this.ref(`walletIndex/${String(a).toLowerCase()}/${this.uid}`).set(t));
      await Promise.all(w.map(p=>p.catch(()=>{})))}catch(e){}},
  /* '' = clean, otherwise the reason text, e.g. "Anti-cheat: same device + same wallet" */
  async antiCheat(R,w){
    const me=String(this.uid),dev=this.devKey(),ip=R.antiIp?await this.myIp():'',found=[];
    await this.registerIdent({wallet:w});
    const others=async p=>{try{const sn=await this.ref(p).once('value');let n=0;sn.forEach(c=>{if(c.key!==me)n++});return n}catch(e){return 0}};
    if(dev&&await others(`deviceIndex/${dev}`))found.push('same device');
    if(ip&&await others(`ipIndex/i${this.h53(ip)}`))found.push('same IP');
    if(w&&w.address&&await others(`walletIndex/${String(w.address).toLowerCase()}`))found.push('same wallet');
    return found.length?'Anti-cheat: '+found.join(' + '):''},
  /* same bookkeeping the admin panel does for a manual reject, but marked as done by the system.
     FREEZE: every system reject adds 1 to users/{uid}/acRej. When it reaches the stage's `freezeAfter` (admin setting, 0 = off) the amount of that
     request is NOT given back to Available: it moves from Hold to Frozen (admin can release it by editing Frozen in the user editor) and the counter restarts.
     An accepted withdrawal also restarts the counter. */
  async autoReject(wid,qk,amount,reason,freezeAfter){
    const f=await this.ref(`withdrawals/${this.uid}/${wid}/settled`).transaction(v=>v?undefined:true);if(!f.committed)return{froze:false,tries:0};
    let froze=false,tries=0;
    await this.uref().transaction(u=>{if(!u)return u;froze=false;
      u.holdBalance=Math.max(0,r8((u.holdBalance||0)-amount));
      tries=(Number(u.acRej)||0)+1;
      if(freezeAfter>0&&tries>=freezeAfter){u.frozenBalance=r8((u.frozenBalance||0)+amount);u.acRej=0;froze=true}else u.acRej=tries;
      return u});
    const note=(reason+(froze?` · $${amount} frozen after ${freezeAfter} tries`:'')).slice(0,200);
    await this.ref(`withdrawals/${this.uid}/${wid}`).update({status:'rejected',by:'system',note});
    await this.ref('withdrawQueue/'+qk).update({status:'rejected',by:'system',note,actedAt:this.TS()});
    return{froze,tries}},
  /* claim the team-size milestone (once) */
  async claimTeamGoal(){
    this.guard();this.needWallet();
    const R=this.refCfg();if(!R.enabled||!(R.goalReward>0))throw new Error('This reward is not available right now.');
    const{res,err}=await this.tx((u,fail)=>{
      if(u.tasks&&u.tasks.teamGoal){fail('Reward already claimed.');return}
      const size=(Number(u.totalInvite)||0)+(Number(u.totalTeam)||0);
      if(size<R.goalTarget){fail(`Refer ${R.goalTarget} members first (${size}/${R.goalTarget}).`);return}
      u.tasks=u.tasks||{};u.tasks['teamGoal']=this.now();
      u.totalReferral=r8((Number(u.totalReferral)||0)+R.goalReward);u.totalBalance=balOf(u);return u});
    if(!res.committed)throw new Error(err||'Could not claim. Try again.');
    const u=res.snapshot.val();if(u)this.ref('leaderboard/'+this.uid).update(this.lbRow(this.uid,u,u.totalBalance)).catch(()=>{});
    return `+$${R.goalReward} claimed!`},
  async ensureUser(user){
    const uid=this.uid,root=this.db.ref(),snap=await this.uref().once('value');
    const prof={firstName:user.firstName||'',lastName:user.lastName||'',username:user.username||'',photoUrl:user.photoUrl||''};
    if(snap.exists()){                                   // existing: keep profile fresh + make sure the leaderboard row exists
      const u=snap.val(),up={},tm={};
      for(const k in prof)if((u[k]||'')!==prof[k]){up[`users/${uid}/${k}`]=prof[k];if(u.joinedBy)tm[`teams/${u.joinedBy}/members/${uid}/${k}`]=prof[k];if(u.joinedBy2)tm[`teams/${u.joinedBy2}/level2/${uid}/${k}`]=prof[k]}
      try{const lb=await this.ref('leaderboard/'+uid).once('value'),v=lb.val()||{};
        if(!lb.exists()||Object.keys(prof).some(k=>(v[k]||'')!==prof[k])||Number(v.totalBalance)!==r8(u.totalBalance))
          up['leaderboard/'+uid]=this.lbRow(uid,{...u,...prof},u.totalBalance)}catch(e){}
      if(!this.isNewCode(u.teamCode)){try{const c=await this.claimTeamCode({...u,...prof},uid);up[`users/${uid}/teamCode`]=c;u.teamCode=c}catch(e){}}   // no code yet, or an old 9-character one: give the new format (the old code keeps working)
      if(Object.keys(up).length)await root.update(up);
      if(Object.keys(tm).length)root.update(tm).catch(()=>{});      // team-row sync must never block login
      this.user={...u,...prof};
      if(!u.joinedBy&&!this.isGuest&&!this._lateTried){this._lateTried=true;this.lateJoin(user,prof).catch(e=>console.error('lateJoin',e))}   // joined directly before, now opened a team link -> join that team
      return;
    }
    /* no record yet: nothing is created here. createUser() runs from saveWallet(). Only remember who invited this person. */
    this.trackRef(user);
  },
  /* first and only creation of users/{uid}: record + wallet + referral + team row + leaderboard row, all-or-nothing */
  async createUser(user,wal){
    const uid=this.uid,root=this.db.ref();
    const prof={firstName:user.firstName||'',lastName:user.lastName||'',username:user.username||'',photoUrl:user.photoUrl||''};
    if(this._creating)return;this._creating=true;
    try{
    const{by,gp}=await this.resolveRef(user);            // by = my partner-owner (level 1), gp = his inviter (level 2)
    if((await this.uref().once('value')).exists())return;   // already created (other tab / double tap): never create or pay twice
    const code=await this.claimTeamCode(prof,uid);
    const TS=this.TS(),up={};
    up[`users/${uid}`]={uid,...prof,totalMining:0,totalCommission:0,totalBalance:0,frozenBalance:0,holdBalance:0,totalWithdrawn:0,
      totalInvite:0,totalTeam:0,totalReferral:0,bonusRate:0,kyc:false,runing_withd:1,joinedBy:by,joinedBy2:gp,teamCode:code,joinedAt:TS,lastSeen:TS,online:true,wallet:wal};
    up[`leaderboard/${uid}`]=this.lbRow(uid,prof,0);
    if(by)up[`teams/${by}/members/${uid}`]={uid,...prof,joinedAt:TS,commission:0,bonus:0};
    if(gp)up[`teams/${gp}/level2/${uid}`]={uid,...prof,joinedAt:TS,commission:0,bonus:0,via:by};
    await root.update(up);
    /* INSTANT: the link owner is found by resolveRef (by = direct link owner -> he gets a PARTNER; gp = his inviter -> gets a TEAM MEMBER).
       Both rows + joinedBy are written above, then each owner's balance is credited right now. Withdraw whenever he wants. */
    if(by)await this.payJoin(by,1,uid).catch(e=>console.error('payJoin L1',e));
    if(gp)await this.payJoin(gp,2,uid).catch(e=>console.error('payJoin L2',e));
    this.dropRef();
    }finally{this._creating=false}
  },

  /* LATE JOIN: a person who already has an account but NO inviter (he started without a link) opens someone's team link later ->
     he joins that owner's team right now (same rewards as a normal join). Only works while he has no inviter (first team always wins),
     never for yourself, and never for somebody who is already in your own team (that would make a loop). */
  async lateJoin(user,prof){
    const uid=this.uid;
    const{by,gp}=await this.resolveRef(user);if(!by)return;                     // no valid link (stored / bot / opened now)
    const me=(await this.uref().once('value')).val()||{};if(me.joinedBy)return;   // already joined meanwhile (other tab / device)
    const[a,c]=await Promise.all([this.ref(`users/${by}/joinedBy`).once('value'),this.ref(`users/${by}/joinedBy2`).once('value')]);
    if(String(a.val()||'')===uid||String(c.val()||'')===uid)return;               // link owner is already in MY team -> loop, ignore
    const TS=this.TS(),up={};
    up[`users/${uid}/joinedBy`]=by;up[`users/${uid}/joinedBy2`]=gp;
    up[`teams/${by}/members/${uid}`]={uid,...prof,joinedAt:TS,commission:0,bonus:0};
    if(gp)up[`teams/${gp}/level2/${uid}`]={uid,...prof,joinedAt:TS,commission:0,bonus:0,via:by};
    await this.db.ref().update(up);
    await this.payJoin(by,1,uid).catch(e=>console.error('payJoin L1',e));
    if(gp)await this.payJoin(gp,2,uid).catch(e=>console.error('payJoin L2',e));
    this.dropRef();
  },

  /* ---- realtime listeners -> store ---- */
  drainMs(){return(Number(this.cfg.sessionHours)||20)*3600e3/(Number(this.cfg.baseEnergy)||3)},          // time to burn 1 bar
  restoreMs(){return Math.max(1,(Number(this.cfg.energyRechargeHours)||5)*3600e3/(Number(this.cfg.baseEnergy)||3))},   // time to refill 1 bar
  maxBars(){return Number(this.cfg.maxEnergy)||5},
  usableOf(u){return Math.min(this.maxBars(),(Number(this.cfg.baseEnergy)||3)+(Number(u.barsAdded)||0))},
  /* energy in bars (0..usable). u.energy={value,at}: energy was `value` bars at time `at`. Drains while mining, recharges while idle. */
  energyBars(u,t,U){const e=u.energy,m=u.mining||{};U=U==null?this.usableOf(u):U;
    if(!e||!(e.at>0))return U;
    if(m.isMining)return Math.max(0,(Number(e.value)||0)-(t-e.at)/this.drainMs());
    return Math.min(U,(Number(e.value)||0)+(t-e.at)/this.restoreMs())},
  rateOf(u){return r8((Number(this.cfg.baseRatePerHour)||0)+(Number(u.bonusRate)||0))},
  watchUser(){
    this.listen(this.uref(),'value',s=>{const u=s.val();if(!u)return;this.user=u;SP(93,'Almost ready…');this.render(u);this.afterUser(u)},
      e=>{console.error(e);store.patch({loaded:true,error:'Cannot read your data. Check your connection and retry.'})});
  },
  render(u){
    {const k=(u.joinedBy||'')+'|'+(u.joinedBy2||'');if(k!=='|'&&k!==this._upKey&&!this.isGuest){this._upKey=k;this.loadUpline(u)}}   // who invited me (kar team e join hoyechi)
    const t=this.now(),m=u.mining||{},on=!!m.isMining,bal=Number(u.totalBalance)||0;
    const available=Math.max(0,r8(bal-(u.totalWithdrawn||0)-(u.frozenBalance||0)-(u.holdBalance||0)));
    const patch={
      balances:{available,hold:Number(u.holdBalance)||0,frozen:Number(u.frozenBalance)||0},
      mining:{ratePerHour:on?m.rate:this.rateOf(u),isMining:on,totalMining:Number(u.totalMining)||0,
        todayMining:(u.today&&u.today.day===dayKey(t))?Number(u.today.mined)||0:0,
        amount:on?Number(m.accrued)||0:0,syncedAt:on?this.local(m.rateSince):0,   // amount = already credited this session; live part = rate*(now-syncedAt)
       
        startedAt:on?this.local(m.startedAt):null,endsAt:on?this.local(m.endsAt):null,
        energyValue:(u.energy&&u.energy.at>0)?Number(u.energy.value)||0:0,energyAt:(u.energy&&u.energy.at>0)?this.local(u.energy.at):0,
        usable:this.usableOf(u),added:Number(u.barsAdded)||0,maxEnergy:this.maxBars(),drainMs:this.drainMs(),restoreMs:this.restoreMs()},
      stats:{totalIncome:bal,totalWithdraw:Number(u.totalWithdrawn)||0,totalCommission:Number(u.totalCommission)||0},
      team:{joinedBy:u.joinedBy||'',joinedBy2:u.joinedBy2||'',referralCode:u.teamCode||('ref_'+this.uid),teamCode:u.teamCode||'',totalMembers:Number(u.totalInvite)||0,totalTeam:Number(u.totalTeam)||0,totalCommission:Number(u.totalCommission)||0,referralEarned:Number(u.totalReferral)||0,balance:r8((Number(u.totalCommission)||0)+(Number(u.totalReferral)||0)),goalClaimed:!!(u.tasks&&u.tasks.teamGoal),teamError:null},
      progress:{referrals:Number(u.totalInvite)||0},upg:u.upg||{},
      wallet:u.wallet&&u.wallet.address?{network:u.wallet.network||CONFIG.NETWORK,address:u.wallet.address}:null,
      banned:u.banned===true,kyc:u.kyc===true,wdRules:this.wdRules(u),error:null,loaded:true};
    const sig=JSON.stringify(patch);if(sig===this._sig)return;   // no redraw if nothing visible changed
    this._sig=sig;store.patch(patch);
  },
  afterUser(u){
    if(!this.hasWallet(u))return;                       // wallet first: nothing is written before it is connected
    this.registerIdent(u);                               // remember device / IP / wallet (used only by the withdraw anti-cheat)
    this.activate();
    const m=u.mining||{};
    if(m.isMining&&this.now()>=m.endsAt)this.settle().catch(()=>{});          // session finished while app was closed
  },
  watchTeam(){
    const rows=s=>{const a=[];s.forEach(c=>{const v=c.val();a.push({uid:v.uid||c.key,firstName:v.firstName||'',lastName:v.lastName||'',username:v.username||'',photoUrl:v.photoUrl||'',available:Number(v.commission)||0,bonus:Number(v.bonus)||0,st:v.st||'ok',fl:v.fl||'',via:v.via||'',joinedAt:Number(v.joinedAt)||0})});a.reverse();return a};
    const d=new Date();d.setHours(0,0,0,0);const today=a=>a.filter(x=>x.joinedAt>=d.getTime()&&x.st!=='rej').length;
    this._tm={1:[],2:[]};const live=()=>this.watchLive(this._tm[1].concat(this._tm[2]));
    this.listen(this.ref(`teams/${this.uid}/members`).orderByChild('joinedAt').limitToLast(100),'value',s=>{const a=rows(s);this._tm[1]=a.map(x=>String(x.uid));
      store.patch({team:{members:a,todayMembers:today(a),teamError:null}});live()},()=>store.patch({team:{teamError:'Could not load your team.'}}));
    this.listen(this.ref(`teams/${this.uid}/level2`).orderByChild('joinedAt').limitToLast(100),'value',s=>{const a=rows(s);this._tm[2]=a.map(x=>String(x.uid));
      store.patch({team:{level2:a,todayL2:today(a)}});live()},()=>store.patch({team:{level2:[]}}));
  },
  /* REALTIME LIVE BALANCE of the partners / team members shown on the Refer page: one listener per member (newest 60 per level).
     Stored under the top-level key `memberBalances` so a balance change updates the numbers in place without redrawing the page.
     bal = his lifetime balance; while he is mining the page adds rate * (now - since) every 250 ms. */
  watchLive(ids){
    this._live=this._live||{};const want=new Set();
    [this._tm[1],this._tm[2]].forEach(l=>l.slice(0,60).forEach(id=>want.add(String(id))));
    Object.keys(this._live).forEach(id=>{if(!want.has(id)){try{this._live[id]()}catch(e){}delete this._live[id]}});
    want.forEach(id=>{if(this._live[id])return;
      this._live[id]=this.listen(this.ref('users/'+id),'value',s=>{const v=s.val();if(!v)return;const m=v.mining||{},on=!!m.isMining;
        store.patch({memberBalances:{[id]:{bal:Number(v.totalBalance)||0,on,rate:on?Number(m.rate)||0:0,since:on?this.local(m.rateSince):0,ends:on?this.local(m.endsAt):0,
          username:v.username||'',photoUrl:v.photoUrl||'',firstName:v.firstName||''}}})},()=>{})})},
  watchHistory(){
    if(this.histOff){this.histOff();this.offs=this.offs.filter(f=>f!==this.histOff)}
    const lim=this.histLimit,q=this.ref(`miningHistory/${this.uid}`).orderByKey().limitToLast(lim);
    this.histOff=this.listen(q,'value',s=>{
      const a=[];s.forEach(c=>{const v=c.val();a.push({amount:Number(v.amount)||0,status:v.status||'claimed',timestamp:Number(v.timestamp)||0})});
      a.reverse();store.patch({history:a,hasMoreHistory:a.length>=lim});
    },()=>store.patch({history:[]}));
  },
  claimHistoryPage(){this.guard();this.histLimit+=20;this.watchHistory();return Promise.resolve()},
  watchWithdrawals(){
    const q=this.ref(`withdrawals/${this.uid}`).orderByKey().limitToLast(50);
    this.listen(q,'value',s=>{
      const a=[],todo=[];
      s.forEach(c=>{const v=c.val();a.push({id:c.key,status:v.status||'pending',amount:Number(v.amount)||0,timestamp:Number(v.timestamp)||0,address:v.address||'',orderId:v.orderId||'',wdNo:Number(v.wdNo)||0,by:v.by||'',note:v.by==='system'?String(v.note||''):''});
        if((v.status==='completed'||v.status==='rejected')&&!v.settled)todo.push({id:c.key,status:v.status,amount:Number(v.amount)||0})});
      a.reverse();store.patch({withdrawals:a});
      todo.forEach(w=>this.reconcile(w));
    },()=>store.patch({withdrawals:[]}));
  },
  /* admin flips status in console -> user's client moves hold/withdrawn exactly once */
  async reconcile(w){
    const key='wd'+w.id;if(this.inflight.has(key))return;this.inflight.add(key);
    try{
      const flag=await this.ref(`withdrawals/${this.uid}/${w.id}/settled`).transaction(v=>v?undefined:true);
      if(!flag.committed)return;
      await this.uref().transaction(u=>{if(!u)return u;
        u.holdBalance=Math.max(0,r8((u.holdBalance||0)-w.amount));
        if(w.status==='completed'){u.totalWithdrawn=r8((u.totalWithdrawn||0)+w.amount);u.runing_withd=(Number(u.runing_withd)||1)+1}   // success -> next hidden withdraw stage
        return u});
    }catch(e){console.error(e)}finally{this.inflight.delete(key)}
  },
  /* ---- presence, lastSeen, device info ---- */
  presence(){
    const me=this.uref();
    this.listen(this.ref('.info/connected'),'value',s=>{
      if(s.val()!==true)return;
      me.child('online').onDisconnect().set(false);
      me.child('lastSeen').onDisconnect().set(this.TS());
      me.update({online:true,lastSeen:this.TS()});
    });
    const beat=()=>{if(document.visibilityState!=='hidden')this.uref().update({online:true,lastSeen:this.TS()}).catch(()=>{})};
    const iv=setInterval(beat,120000);this.offs.push(()=>clearInterval(iv));
    document.addEventListener('visibilitychange',beat);
  },
  async publicIp(){try{const c=new AbortController(),t=setTimeout(()=>c.abort(),4000);const r=await fetch('https://api.ipify.org?format=json',{signal:c.signal});clearTimeout(t);return(await r.json()).ip||''}catch(e){return''}},
  localIp(){return new Promise(res=>{
    try{const pc=new RTCPeerConnection({iceServers:[]});let done=false;const fin=v=>{if(!done){done=true;try{pc.close()}catch(e){}res(v)}};
      pc.createDataChannel('x');pc.onicecandidate=e=>{const m=e&&e.candidate&&/(\d{1,3}(?:\.\d{1,3}){3})/.exec(e.candidate.candidate);if(m&&!/^0\./.test(m[1]))fin(m[1])};
      pc.createOffer().then(o=>pc.setLocalDescription(o)).catch(()=>fin(''));setTimeout(()=>fin(''),1500)}catch(e){res('')}})},
  async writePrivate(){
    const ref=this.ref('userPrivate/'+this.uid);
    const base={uid:this.uid,userAgent:navigator.userAgent.slice(0,300),platform:String((Auth.tg&&Auth.tg.platform)||navigator.platform||'').slice(0,40),
      language:String(navigator.language||'').slice(0,20),timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone||'').slice(0,60),lastSeen:this.TS()};
    try{await ref.update(base);const[a,b]=await Promise.all([this.publicIp(),this.localIp()]);await ref.update({deviceIp:a,localIp:b})}catch(e){}
  },

  /* ---- mining (client transaction on users/{uid}) ---- */
  startTicker(){
    clearInterval(this._tick);
    let last=Date.now(),lastMin=Date.now(),lastCk=Date.now();
    this._tick=setInterval(()=>{
      const u=this.user;if(!u||(!this.isGuest&&!this.hasWallet(u)))return;const m=u.mining||{},t=this.now();
      if(m.isMining&&t>=m.endsAt)return this.settle().catch(()=>{});             // energy finished -> auto stop
      if(m.isMining&&Date.now()-lastCk>=300000){lastCk=Date.now();this.checkpoint().catch(()=>{})}   // auto-credit to balance every 5 min
      if(Date.now()-lastMin>60000){lastMin=Date.now();this.render(u)}
    },1000);
  },
  /* run fn on users/{uid}. Guests run it on the local copy instead of the database. */
  async tx(fn){
    let err=null;
    if(this.isGuest){
      const u=JSON.parse(JSON.stringify(this.user)),out=fn(u,e=>{err=e});
      const ok=out!==undefined&&out!==null&&!err;
      if(ok){this.user=out;this.guestSave();this.render(out)}
      return{res:{committed:ok,snapshot:{val:()=>out}},err};
    }
    const res=await this.uref().transaction(u=>{err=null;if(!u)return u;return fn(u,e=>{err=e})});return{res,err}
  },
  /* moves the reward earned since m.rateSince into the balance (mutates u, returns amount).
     m.accrued = total already credited in this session. */
  accrue(u,t){
    const m=u.mining;if(!m||!m.isMining)return 0;
    const e=Math.min(t,m.endsAt),g=r8(m.rate/3600*Math.max(0,(e-m.rateSince)/1000));
    m.accrued=r8((m.accrued||0)+g);m.rateSince=Math.max(m.rateSince,e);
    if(g>0){u.totalMining=r8((u.totalMining||0)+g);u.totalBalance=balOf(u);
      const day=dayKey(t),td=(u.today&&u.today.day===day)?Number(u.today.mined)||0:0;u.today={day,mined:r8(td+g)}}
    return g;
  },
  /* after a credit: keep the leaderboard in sync and (referrers earn ONLY the join reward, no mining commission) */
  async creditAfter(res,earned){
    if(this.isGuest||!res||!res.committed||!(earned>0))return;
    const u=res.snapshot.val();if(!u)return;
    await this.ref(`leaderboard/${this.uid}`).update(this.lbRow(this.uid,u,u.totalBalance));
  },
  async checkpoint(){
    if(this.ckBusy||!this.uid)return;this.ckBusy=true;
    try{
      let earned=0;
      const{res}=await this.tx(u=>{earned=0;const m=u.mining;if(!m||!m.isMining)return;earned=this.accrue(u,this.now());return earned>0?u:undefined});
      await this.creditAfter(res,earned);
    }finally{this.ckBusy=false}
  },
  async startMining(){
    this.needWallet();
    await this.settle();                                   // close an already-finished session first
    const{res,err}=await this.tx((u,fail)=>{
      const t=this.now();if(u.mining&&u.mining.isMining){fail('Mining is already running.');return}
      const E=this.energyBars(u,t);
      if(E<1-1e-9){fail('Not enough energy. You need at least 1 energy bar to start mining.');return}
      u.energy={value:E,at:t};                            // session lasts until this energy is burned
      u.mining={isMining:true,startedAt:t,endsAt:t+Math.round(E*this.drainMs()),rate:this.rateOf(u),accrued:0,rateSince:t};
      return u});
    if(!res.committed)throw new Error(err||'Could not start mining. Try again.');
  },
  stopMining(){return Promise.reject(new Error('Mining cannot be stopped manually. It stops automatically when energy ends.'))},
  /* closes a session whose energy ran out (auto stop). Never closes a running session early. */
  async settle(){
    if(this.settling||!this.uid)return;this.settling=true;
    try{
      let earned=0,total=0,startedAt=0,secs=0;
      const{res}=await this.tx(u=>{
        earned=0;total=0;const m=u.mining;if(!m||!m.isMining)return;
        const t=this.now();if(t<m.endsAt)return;
        earned=this.accrue(u,t);total=m.accrued||0;startedAt=m.startedAt;secs=Math.max(0,Math.round((m.endsAt-m.startedAt)/1000));
        u.energy={value:0,at:m.endsAt};u.mining={isMining:false,lastEndedAt:m.endsAt};return u});
      if(!res.committed)return;
      if(this.isGuest){
        if(total>0){this.gh.unshift({amount:total,status:'credited',timestamp:Date.now()});this.guestSave();
          store.patch({history:[...this.gh,...this.demoData().history]})}
        return}
      if(total>0)await this.ref(`miningHistory/${this.uid}`).push({amount:total,status:'credited',timestamp:this.TS(),startedAt,seconds:secs});
      await this.creditAfter(res,earned);
    }catch(e){console.error(e);throw e}finally{this.settling=false}
  },
  async payCommission(to,earned){
    if(!to||to===this.uid)return;const c=r8(earned*(Number(this.cfg.teamCommissionPercent)||0)/100);if(!(c>0))return;
    let row=null;
    await this.ref('users/'+to).transaction(x=>{row=null;if(!x)return x;x.totalCommission=r8((x.totalCommission||0)+c);x.totalBalance=balOf(x);row=this.lbRow(to,x,x.totalBalance);return x});
    if(row===null)return;
    await this.ref(`teams/${to}/members/${this.uid}/commission`).transaction(v=>r8((v||0)+c));
    await this.ref(`leaderboard/${to}`).update(row);
  },

  /* ---- tasks / bonus (adds permanent Per/H bonus) ---- */
  async grant(id,reward,once,extra){
    let earned=0;
    const{res,err}=await this.tx((u,fail)=>{
      earned=0;
      if(once&&u.tasks&&u.tasks[id]){fail('Already completed.');return}
      if(extra&&extra.check){const m=extra.check(u);if(m){fail(m);return}}
      const t=this.now();if(once){u.tasks=u.tasks||{};u.tasks[id]=t}
      if(extra&&extra.apply)extra.apply(u,t);
      u.bonusRate=r8((u.bonusRate||0)+Number(reward||0));
      const m=u.mining;if(m&&m.isMining){earned=this.accrue(u,t);m.rate=this.rateOf(u)}   // credit at the old rate, then switch rate
      return u});
    if(!res.committed)throw new Error(err||'Could not add bonus. Try again.');
    await this.creditAfter(res,earned).catch(()=>{});
  },
  /* AD SDK HOOK: window.showRewardedAd is defined in app.js (Ads: Monetag / Adsgram, chosen + configured live from the admin panel).
     kind: 'energy' | 'extraBar' | 'rate'. It returns true only when the ad was watched completely, otherwise it throws a friendly message. */
  async playAd(kind){
    if(typeof window.showRewardedAd!=='function')throw new Error('Ads are not available right now.');
    if(!(await window.showRewardedAd(kind)))throw new Error('Watch the full ad to get the reward.');
  },
  /* ---- UPGRADE TASKS (fully admin controlled: settings/upgradeTasks/{id}) --------------------------------------------
     kind rate    : watch `ads` ads -> Claim -> +reward Per/H forever (repeatable, every claim adds more)
     kind restore : watch `ads` ads -> Claim -> energy refilled (+reward bars, 0 = full)
     kind bar     : watch `ads` ads -> Claim -> energy bar #barNo unlocked. Bars unlock one by one (4, then 5, then 6 ...) up to settings/maxEnergy
     kind invite  : reach `target` partners / team members / both (src) -> Claim -> reward by rtype: rate = +Per/H, cash = +$ balance, restore = energy bars
     Progress = users/{uid}/upg/{taskId} = {ads, claims}. x/y reached -> only Claim is possible; claiming keeps the extra ads and saves the
     reward for life. An ad is counted ONLY if it stayed open >= minAdSeconds (leaving the ad early = not counted). */
  normTasks(raw){
    const out=[],num=(v,d)=>{v=Number(v);return isFinite(v)?v:d},str=(v,n)=>String(v==null?'':v).slice(0,n);
    Object.entries(raw||{}).forEach(([id,t])=>{
      if(!t||typeof t!=='object')return;
      const kind=['rate','restore','bar','invite'].indexOf(t.kind)>=0?t.kind:'';if(!kind)return;
      out.push({id,kind,title:str(t.title,60)||'Task',desc:str(t.desc,160),enabled:t.enabled!==false,order:num(t.order,0),
        ads:Math.max(1,Math.floor(num(t.ads,10))),target:Math.max(1,Math.floor(num(t.target,10))),reward:Math.max(0,num(t.reward,0)),
        barNo:Math.max(1,Math.floor(num(t.barNo,4))),maxClaims:(kind==='bar'||kind==='invite')?1:Math.max(0,Math.floor(num(t.maxClaims,0))),
        src:['partner','member','both'].indexOf(t.src)>=0?t.src:(t.countTeam===true?'both':'partner'),         // invite: who is counted
        rtype:['rate','cash','restore'].indexOf(t.rtype)>=0?t.rtype:'rate',
        xRate:Math.max(0,num(t.xRate,0)),xCash:Math.max(0,num(t.xCash,0)),xRestore:Math.max(0,num(t.xRestore,0))})});   // MULTI REWARD: optional extras paid together with the main reward                                // invite: what is paid
    return out.sort((a,b)=>a.order-b.order||(a.id<b.id?-1:1))},
  /* invite tasks are tiers: only invites AFTER the earlier invite tasks (same source, enabled) are filled count for this one */
  invOff(T){let o=0;for(const x of(this.upgList||[])){if(x.id===T.id)break;if(x.kind==='invite'&&x.enabled&&x.src===T.src)o+=x.target}return o},
  invSize(T,u){const p=Number(u.totalInvite)||0,m=Number(u.totalTeam)||0;return Math.max(0,(T.src==='member'?m:T.src==='both'?p+m:p)-this.invOff(T))},
  invName(T){return T.src==='member'?'team members':T.src==='both'?'partners + team members':'partners'},
  upgTask(id){return(this.upgList||[]).find(t=>t.id===id)},
  adMin(){const v=Number((this.cfg.upgrade||{}).minAdSeconds);return isFinite(v)&&v>=0?v:10},
  /* '' = fine, otherwise why this task can not be watched / claimed right now */
  upgBlock(T,u,forAd){
    const p=(u.upg||{})[T.id]||{},ads=Number(p.ads)||0,claims=Number(p.claims)||0;
    if(!T.enabled)return 'This task is not available.';
    if(T.maxClaims>0&&claims>=T.maxClaims)return 'Task completed.';
    if(T.kind==='bar'){const have=this.usableOf(u);
      if(T.barNo<=have)return 'This energy bar is already unlocked.';
      if(T.barNo>this.maxBars())return 'This energy bar is not available.';
      if(T.barNo>have+1)return `Unlock energy bar ${T.barNo-1} first.`}
    if(forAd&&ads>=T.ads)return 'Goal reached. Tap Claim to get your reward.';
    return ''},
  /* AD VERIFY (client side, shown on the button via `ui`):
       1. tap -> button "Loading…" while the ad opens (the SDK is called inside the tap, nothing awaited before it)
       2. then a 15 s progress 0 -> 100% on the button = the verification window
       3. the ad only counts if the user really stayed on it: it must stay open >= minAdSeconds (admin, default 10) and the user must NOT
          come back to the app inside that time. Leaving early / ad error / no ad = NOT counted, nothing is written.
       4. at 100% and ad finished -> the ad is counted (Counting…), then the normal activity continues (x/y ads, Claim ...). */
  async watchUpgradeAd(id,ui){
    this.guardUpg();                                                // NO wallet check here: the ad must be able to open without a wallet
    const T=this.upgTask(id);if(!T||T.kind==='invite')throw new Error('This task is not available.');
    const why=this.upgBlock(T,this.user||{},true);if(why)throw new Error(why);
    const min=this.adMin(),VERIFY=15000,say=typeof ui==='function'?ui:()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms));
    const t0=Date.now();let hid=false,early=false,endAt=0,adOk=false,adErr=null;
    const vis=()=>{if(document.hidden){hid=true;return}if(hid&&Date.now()-t0<min*1000)early=true};   // user came back to the app before the minimum seconds
    document.addEventListener('visibilitychange',vis);
    this.playAd('upgrade').then(()=>{adOk=true},e=>{adErr=e}).then(()=>{endAt=Date.now()});            // starts the ad right now (inside the tap)
    say({phase:'loading',pct:0});
    try{
      await wait(800);                                              // "Loading…" while the ad opens
      const vs=Date.now();
      for(;;){
        const el=Date.now()-vs;say({phase:'verify',pct:Math.min(100,Math.floor(el/VERIFY*100))});
        if(early||adErr)break;                                      // came back early / ad failed
        if(endAt&&endAt-t0<min*1000)break;                          // ad closed too soon
        if(endAt&&el>=VERIFY)break;                                 // 100% reached and the ad is finished
        if(Date.now()-t0>180000)break;                              // ad never finished
        await wait(100)}
    }finally{document.removeEventListener('visibilitychange',vis)}
    if(adErr&&!early)throw adErr;
    const ms=(endAt||Date.now())-t0;
    if(early||!adOk||(min>0&&ms<min*1000))throw new Error(`Ad not completed${endAt||early?` (${Math.floor((early?Date.now()-t0:ms)/1000)}s)`:''}. Watch the full ad (at least ${min} seconds) so it counts.`);
    say({phase:'count',pct:100});
    this.needWallet();                                              // wallet is needed only now, to record the counted ad
    let n=0;
    const{res,err}=await this.tx((u,fail)=>{const w=this.upgBlock(T,u,true);if(w){fail(w);return}
      u.upg=u.upg||{};const p=u.upg[id]=u.upg[id]||{ads:0,claims:0};p.ads=(Number(p.ads)||0)+1;n=p.ads;return u});
    if(!res.committed)throw new Error(err||'Could not count this ad. Try again.');
    return n>=T.ads?'Goal reached! Tap Claim to get your reward.':`Ad counted · ${n}/${T.ads}`},
  async claimUpgrade(id){
    this.guardUpg();this.needWallet();
    const T=this.upgTask(id);if(!T)throw new Error('This task is not available.');
    let earned=0,msg='',cash=false;
    const{res,err}=await this.tx((u,fail)=>{
      earned=0;cash=false;const t=this.now();
      const w=this.upgBlock(T,u,false);if(w){fail(w);return}
      const p=(u.upg&&u.upg[id])||{ads:0,claims:0};
      if(T.kind==='invite'){const size=this.invSize(T,u);
        if(size<T.target){fail(`Reach ${T.target} ${this.invName(T)} first (${size}/${T.target}).`);return}}
      else if((Number(p.ads)||0)<T.ads){fail(`Watch ${T.ads-(Number(p.ads)||0)} more ads first.`);return}
      /* what this claim pays: ONE main reward (by kind / rtype) + optional extras (xRate, xCash, xRestore), all in the same claim */
      const main=T.kind==='restore'||(T.kind==='invite'&&T.rtype==='restore')?'restore':T.kind==='bar'?'bar':(T.kind==='invite'&&T.rtype==='cash')?'cash':'rate';
      let rateAdd=(main==='rate'?T.reward:0)+T.xRate,cashAdd=(main==='cash'?T.reward:0)+T.xCash,rest=null;
      if(main==='restore')rest=T.reward>0?T.reward+T.xRestore:0;else if(T.xRestore>0)rest=T.xRestore;        // rest: null = none, 0 = full, n = bars
      if(rest!==null){
        if(u.mining&&u.mining.isMining&&main!=='bar'){fail('Mining is running. Claim after it stops (this reward restores energy).');return}
        if(main!=='bar'){const U=this.usableOf(u),E=this.energyBars(u,t);if(E>=U-1e-9){fail('Your energy is already full. Claim when it is low.');return}}}
      const parts=[];
      if(main==='bar'){
        const before=this.usableOf(u);u.barsAdded=Math.max(Number(u.barsAdded)||0,T.barNo-(Number(this.cfg.baseEnergy)||3));
        if(this.usableOf(u)>before&&!(u.mining&&u.mining.isMining))u.energy={value:this.energyBars(u,t,before),at:t};   // new bar starts empty
        parts.push(`Energy bar ${T.barNo} unlocked`)}
      if(rest!==null&&!(u.mining&&u.mining.isMining)){
        const U=this.usableOf(u),E=this.energyBars(u,t);u.energy={value:rest>0?Math.min(U,E+rest):U,at:t};parts.push(rest>0?`+${rest} energy bar`:'Energy fully restored')}
      if(rateAdd>0){
        const m=u.mining;if(m&&m.isMining){earned=this.accrue(u,t)}                                              // credit at the old rate first
        u.bonusRate=r8((Number(u.bonusRate)||0)+rateAdd);if(m&&m.isMining)m.rate=this.rateOf(u);                 // then switch to the new rate
        parts.push(`Per/H +${r8(rateAdd)}`)}
      if(cashAdd>0){u.totalReferral=r8((Number(u.totalReferral)||0)+cashAdd);u.totalBalance=balOf(u);cash=true;parts.push(`+$${r8(cashAdd)} to balance`)}
      msg=parts.join(' · ');
      u.upg=u.upg||{};const q=u.upg[id]=u.upg[id]||{ads:0,claims:0};
      if(T.kind!=='invite')q.ads=Math.max(0,(Number(q.ads)||0)-T.ads);
      q.claims=(Number(q.claims)||0)+1;return u});
    if(!res.committed)throw new Error(err||'Could not claim. Try again.');
    await this.creditAfter(res,earned).catch(()=>{});
    if(cash&&!this.isGuest){const u=res.snapshot.val();if(u)this.ref('leaderboard/'+this.uid).update(this.lbRow(this.uid,u,u.totalBalance)).catch(()=>{})}
    return msg},

  /* ---- wallet / withdraw ---- */
  async saveWallet(addr){
    if(USER&&USER.guest){this.user={...this.user,wallet:{network:CONFIG.NETWORK,address:addr}};this.guestSave();this.render(this.user);return}
    addr=String(addr||'').trim();if(!validAddr(addr))throw new Error('Enter a valid BEP-20 address.');
    const wal={network:CONFIG.NETWORK,address:addr,updatedAt:this.TS()};
    const snap=await this.uref().once('value');
    if(snap.exists())await this.uref().child('wallet').set(wal);      // existing user without a wallet
    else await this.createUser(this.tgUser||USER,wal);                // new user: first write of the account happens here
    this.ref(`walletIndex/${addr.toLowerCase()}/${this.uid}`).set(Date.now()).catch(()=>{});   // used for same-wallet detection
    this.pending=false;
    if(snap.exists())this.ensureUser(this.tgUser||USER).catch(()=>{});   // profile + leaderboard row now that a wallet exists
  },
  loadWallet(){},                                        // wallet arrives with the users/{uid} listener
  /* ---- hidden withdraw stages (users/{uid}/runing_withd: 1 = first withdraw, 2 = second, 3+ = restricted) ----
     stage 1: min 0.1 / max 0.5, no requirement, nothing is shown on screen
     stage 2: needs 1 referral, min 0.5 / max 0.5 (hint shown)
     stage 3+: min 50 / max 100, hint shown, but the account is restricted (no request is created) */
  wdStage(u){u=u||this.user||{};return Math.max(1,Math.floor(Number(u.runing_withd)||1))},
  /* stage rules come from admin (wdStages/s1..sN); stages past the last one repeat the last stage */
  wdRules(u){u=u||this.user||{};const st=this.wdStage(u),L=this.stages&&this.stages.length?this.stages:DEFSTAGES,x=L[Math.min(st,L.length)-1];
    return{stage:st,min:Number(x.min)||0,max:Number(x.max)||0,needRef:Number(x.refer)||0,hint:x.hint===true,restricted:x.restrict===true,anti:x.anti===true,antiIp:x.antiIp!==false,freezeAfter:x.freezeAfter===undefined?3:Math.max(0,Math.floor(Number(x.freezeAfter))||0),haveRef:Number(u.totalInvite)||0}},
  watchStages(){this.listen(this.ref('wdStages'),'value',sn=>{const v=sn.val()||{};
    this.stages=Object.keys(v).filter(k=>/^s\d+$/.test(k)).sort((a,b)=>a.slice(1)-b.slice(1)).map(k=>v[k]);if(this.user)this.render(this.user)},()=>{})},
  newOrderId(){return 'WD'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,6).toUpperCase()},
  async requestWithdraw(amount){
    this.guard();
    amount=r8(amount);const w=this.user&&this.user.wallet;
    if(!w||!validAddr(w.address))throw new Error('Connect a valid wallet first.');
    if(this.user&&this.user.kyc===true)throw new Error('KYC verification required. Please contact Support to verify your account before withdrawing.');   // admin KYC switch ON = verify first
    const R=this.wdRules(this.user);
    if(R.restricted)throw new Error('Your account is restricted from withdrawal system');   // stage 3+: no request, no action
    if(R.needRef&&(Number(this.user.totalInvite)||0)<R.needRef)throw new Error(`You need ${R.needRef} referral to withdraw.`);
    if(R.hint&&!(amount>=R.min-1e-9&&amount<=R.max+1e-9))throw new Error(R.min===R.max?`Withdrawal amount must be exactly $${R.min}.`:`Withdrawal amount must be between $${R.min} and $${R.max}.`);
    if(!(amount>=R.min-1e-9))throw new Error(`Minimum withdrawal is $${R.min}.`);
    if(amount>R.max+1e-9)throw new Error(`Maximum withdrawal is $${R.max}.`);
    // only one open request at a time (so the stage cannot be skipped)
    const open=await this.ref(`withdrawals/${this.uid}`).orderByKey().limitToLast(20).once('value');
    let pend=false;open.forEach(c=>{if((c.val()||{}).status==='pending')pend=true});
    if(pend)throw new Error('You already have a pending withdrawal.');
    // same wallet / fair-user check: other accounts that saved the same wallet address
    let sameUids=[];
    try{const wi=await this.ref(`walletIndex/${w.address.toLowerCase()}`).once('value');wi.forEach(c=>{if(c.key!==this.uid)sameUids.push(c.key)});
      this.ref(`walletIndex/${w.address.toLowerCase()}/${this.uid}`).set(Date.now()).catch(()=>{})}catch(e){}
    let earned=0;
    const{res,err}=await this.tx((u,fail)=>{
      if(this.wdStage(u)!==R.stage){fail('Withdrawal state changed. Try again.');return}
      earned=this.accrue(u,this.now());                  // include mining reward earned so far
      const avail=r8((u.totalBalance||0)-(u.totalWithdrawn||0)-(u.frozenBalance||0)-(u.holdBalance||0));
      if(amount>avail+1e-9){fail('Amount exceeds your Available balance.');return}
      u.holdBalance=r8((u.holdBalance||0)+amount);return u});
    if(!res.committed)throw new Error(err||'Withdrawal failed. Try again.');
    this.creditAfter(res,earned).catch(()=>{});
    let qk='',wkey='';
    try{
      const orderId=this.newOrderId(),usr=this.user||{},TS=this.TS();
      const row={amount,address:w.address,network:w.network||CONFIG.NETWORK,status:'pending',timestamp:TS,settled:false,orderId,wdNo:R.stage};
      const r=await this.ref(`withdrawals/${this.uid}`).push(row);
      qk=(await this.ref('withdrawQueue').push({uid:this.uid,wid:r.key,orderId,username:usr.username||'',firstName:usr.firstName||'',photoUrl:usr.photoUrl||'',
        amount,address:w.address,network:row.network,timestamp:TS,wdNo:R.stage,
        sameWallet:sameUids.length>0,sameWalletCount:sameUids.length,sameWalletUids:sameUids.join(',').slice(0,400)})).key;
      wkey=r.key;
    }catch(e){                                           // roll back the hold if the request could not be saved
      await this.uref().transaction(u=>{if(!u)return u;u.holdBalance=Math.max(0,r8((u.holdBalance||0)-amount));return u});
      throw new Error('Could not send the request. Try again.');
    }
    if(R.anti){                                             // admin turned Anti cheat ON for this stage
      let why='';try{why=await this.antiCheat(R,w)}catch(e){}
      if(why){const z=await this.autoReject(wkey,qk,amount,why,R.freezeAfter).catch(()=>({froze:false,tries:0}));
        return{rejected:true,reason:why,frozen:!!z.froze,amount,left:R.freezeAfter>0&&!z.froze?Math.max(0,R.freezeAfter-(z.tries||0)):0}}
    }
    return{rejected:false};
  }
};
