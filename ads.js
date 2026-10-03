/* =====================================================================
   ADS ENGINE  -  Monetag + Adsgram, loaded dynamically
   ---------------------------------------------------------------------
   The admin panel writes  adConfig/{provider, monetag/zoneId, adsgram/blockId}  to the database.
   backend.js listens to it and calls Ads.configure(); this file then loads ONLY the active
   provider's SDK, using the IDs from the database (nothing is hard-coded, no redeploy needed).
   Exactly one provider is active at a time (enforced by the admin toggles).

   PUBLIC API
     Ads.configure(rawConfig)   called by backend.js whenever adConfig changes
     Ads.show(kind)             -> Promise<true> when the ad was watched completely, otherwise throws
                                   Error(<user friendly message>). kind = 'energy' | 'extraBar' | 'rate'
                                   (any placement name works; it is only passed through for future use)
     Ads.info()                 -> { provider, configured, id }
   window.showRewardedAd is wired to Ads.show, which is the hook backend.js -> playAd() already calls,
   so every ad button in the app goes through this file.

   NOTE: Monetag rotates its SDK host from time to time. If ads stop loading, replace the host in
   SDK.monetag below with the one shown in your Monetag dashboard (Zone -> "Get code").
   ===================================================================== */
const Ads=(()=>{
  /* Built-in fallback SDK hosts. The admin can put a different host in adConfig/<provider>/sdkUrl (paste the src from the
     network dashboard); that one is tried FIRST, then these. Monetag rotates hosts, so several are listed. */
  const SDK={monetag:['https://libtl.com/sdk.js','https://yoszi.com/sdk.js'],adsgram:['https://sad.adsgram.ai/js/sad.min.js']};
  const okUrl=u=>/^https:\/\/[^\s]{4,300}$/.test(u);
  const hostsOf=(p,custom)=>{const l=[];if(okUrl(custom))l.push(custom);SDK[p].forEach(h=>{if(l.indexOf(h)<0)l.push(h)});return l};
  const LOAD_MS=12000,CFG_WAIT_MS=6000;
  const okZone=z=>/^[0-9]{1,12}$/.test(z),okBlock=b=>/^(int-)?[0-9]{1,12}$/.test(b);
  const MSG={
    off:'Ads are not available right now.',
    unset:'Ads are not configured yet.',
    load:'Could not load the ad. Turn off your ad blocker and try again.',
    nofill:'No ad available right now. Please try again in a moment.',
    busy:'An ad is already loading. Please wait.',
    skip:'Watch the full ad to get the reward.'
  };
  let cfg=null,waiters=[],busy=false;
  const M={zone:'',key:'',script:null,p:null};       // monetag loader state (one script per zone)
  const G={p:null,ctl:{}};                    // adsgram loader state (one script, one controller per block)

  /* raw database value -> clean config. Missing/invalid provider defaults to monetag (same default as the admin panel). */
  const clean=c=>{c=c||{};
    return{provider:c.provider==='adsgram'?'adsgram':'monetag',
      zoneId:String((c.monetag&&c.monetag.zoneId)||'').trim(),
      blockId:String((c.adsgram&&c.adsgram.blockId)||'').trim(),
      monetagSdk:String((c.monetag&&c.monetag.sdkUrl)||'').trim(),
      adsgramSdk:String((c.adsgram&&c.adsgram.sdkUrl)||'').trim()}};

  /* ---- script loader: resolves on load, rejects on error / timeout (ad blockers make it fail) ---- */
  function inject(src,attrs,onDone){
    return new Promise((res,rej)=>{
      const s=document.createElement('script');let t;
      const fail=()=>{clearTimeout(t);try{s.remove()}catch(e){}rej(new Error('load'))};
      s.src=src;s.async=true;
      for(const k in (attrs||{}))s.setAttribute(k,attrs[k]);
      t=setTimeout(fail,LOAD_MS);
      s.onload=()=>{clearTimeout(t);try{res(onDone(s))}catch(e){fail()}};
      s.onerror=fail;
      (document.head||document.documentElement).appendChild(s);
      inject.last=s;
    });
  }

  /* ---- MONETAG: script tag carries the zone id, SDK defines window.show_<zone> ---- */
  function loadMonetag(zone,custom){
    const hosts=hostsOf('monetag',custom),key=zone+'|'+hosts.join(',');
    if(M.key===key&&M.p)return M.p;
    if(M.script){try{M.script.remove()}catch(e){}try{delete window['show_'+M.zone]}catch(e){}M.script=null}   // zone / host changed by admin: drop the old one
    const fn='show_'+zone;M.zone=zone;M.key=key;
    const tryHost=i=>{
      if(typeof window[fn]==='function')return Promise.resolve(window[fn]);
      if(i>=hosts.length)return Promise.reject(new Error('load'));
      const p=inject(hosts[i],{'data-zone':zone,'data-sdk':fn},()=>{if(typeof window[fn]!=='function')throw new Error('bad');return window[fn]});
      M.script=inject.last;
      return p.catch(()=>{try{M.script&&M.script.remove()}catch(e){}M.script=null;return tryHost(i+1)});   // this host is blocked / dead -> next one
    };
    const p=tryHost(0);
    M.p=p;p.catch(()=>{if(M.p===p){M.p=null;M.script=null;M.key=''}});     // a failed load can be retried by the next tap
    return p;
  }

  /* ---- ADSGRAM: one shared script, Adsgram.init({blockId}) per block ---- */
  function loadAdsgram(block,custom){
    const hosts=hostsOf('adsgram',custom),hk=hosts.join(',');
    if(G.hk!==hk){G.hk=hk;G.p=null;G.ctl={}}
    const has=()=>window.Adsgram&&typeof window.Adsgram.init==='function';
    const boot=()=>{
      if(!G.ctl[block]){if(!has())throw new Error('load');G.ctl[block]=window.Adsgram.init({blockId:block})}
      return G.ctl[block];
    };
    if(!G.p){
      const tryHost=i=>{
        if(has())return Promise.resolve();
        if(i>=hosts.length)return Promise.reject(new Error('load'));
        return inject(hosts[i],null,()=>{if(!has())throw new Error('bad')}).catch(()=>tryHost(i+1));
      };
      const p=tryHost(0);
      G.p=p;p.catch(()=>{if(G.p===p)G.p=null});
    }
    return G.p.then(boot);
  }

  /* start loading the active SDK as soon as the config arrives, so the first tap on an ad button is fast */
  function prewarm(){
    if(!cfg)return;
    try{
      if(cfg.provider==='monetag'&&okZone(cfg.zoneId))loadMonetag(cfg.zoneId,cfg.monetagSdk).catch(()=>{});
      else if(cfg.provider==='adsgram'&&okBlock(cfg.blockId))loadAdsgram(cfg.blockId,cfg.adsgramSdk).catch(()=>{});
    }catch(e){}
  }
  function configure(raw){
    cfg=clean(raw);
    const w=waiters;waiters=[];w.forEach(f=>f(cfg));
    prewarm();
  }
  const ready=()=>cfg?Promise.resolve(cfg):new Promise(res=>{
    const f=c=>{clearTimeout(t);res(c)};
    const t=setTimeout(()=>{waiters=waiters.filter(x=>x!==f);res(null)},CFG_WAIT_MS);
    waiters.push(f)});

  /* ---- show one rewarded ad. Resolves true ONLY when the ad was watched completely. ---- */
  let last=0;                                          // ms the last ad stayed open (backend rejects ads closed too early)
  async function show(kind){
    if(busy)throw new Error(MSG.busy);
    busy=true;last=0;
    try{
      const c=await ready();
      if(!c)throw new Error(MSG.off);
      if(c.provider==='monetag'){
        if(!okZone(c.zoneId))throw new Error(MSG.unset);
        let fn;try{fn=await loadMonetag(c.zoneId,c.monetagSdk)}catch(e){throw new Error(MSG.load)}
        try{const t0=Date.now();await fn();last=Date.now()-t0;return true}catch(e){throw new Error(MSG.nofill)}      // promise resolves after the ad is watched
      }
      if(!okBlock(c.blockId))throw new Error(MSG.unset);
      let ctl;try{ctl=await loadAdsgram(c.blockId,c.adsgramSdk)}catch(e){throw new Error(MSG.load)}
      let r;const t0=Date.now();try{r=await ctl.show();last=Date.now()-t0}catch(e){                                   // adsgram rejects with {done,error,state,description}
        throw new Error(e&&e.error?MSG.nofill:MSG.skip)}
      return !!(r&&r.done===true);
    }finally{busy=false}
  }
  const info=()=>({provider:cfg?cfg.provider:null,
    configured:!!cfg&&(cfg.provider==='monetag'?okZone(cfg.zoneId):okBlock(cfg.blockId)),
    id:cfg?(cfg.provider==='monetag'?cfg.zoneId:cfg.blockId):''});

  return{configure,show,info,get lastMs(){return last}};
})();
window.Ads=Ads;
window.showRewardedAd=kind=>Ads.show(kind);
