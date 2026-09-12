(function(){
  'use strict';
  const cfg=window.TREDIN_CONFIG||{};
  const apiBase=String(cfg.apiBaseUrl||'').replace(/\/$/,'');
  if(!apiBase)return;
  window.TredINFundControl={
    async find(query,token){
      const q=String(query||'').trim();
      if(q.length<2)throw new Error('Enter at least 2 characters');
      const r=await fetch(apiBase+'/admin/funds/users?search='+encodeURIComponent(q),{headers:{Authorization:'Bearer '+token}});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||'Customer search failed');
      return d;
    },
    async credit(userId,amount,reason,token){
      const key=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random());
      const r=await fetch(apiBase+'/admin/funds/credit',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'Idempotency-Key':key},body:JSON.stringify({userId,amount:Number(amount),reason})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||'Fund credit failed');
      return d;
    }
  };
})();
