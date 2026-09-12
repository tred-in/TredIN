import crypto from 'node:crypto';
import http from 'node:http';
import { Pool } from 'pg';

const originalCreateServer = http.createServer;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const ADMIN_ROLES = new Set(['SUPER_ADMIN','OPERATIONS_ADMIN','FINANCE_ADMIN','READ_ONLY_ADMIN']);
const CREDIT_ROLES = new Set(['SUPER_ADMIN','FINANCE_ADMIN']);

function json(res, code, data, req) {
  const origin = String(req.headers.origin || '');
  const configured = String(process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
  const allow = configured.includes('*') ? origin : (configured.includes(origin) ? origin : (configured[0] || 'null'));
  res.writeHead(code, {
    'content-type':'application/json', 'cache-control':'no-store',
    'access-control-allow-origin':allow, 'access-control-allow-headers':'Content-Type,Authorization,Idempotency-Key,X-Request-ID',
    'access-control-allow-methods':'GET,POST,OPTIONS', 'vary':'Origin'
  });
  res.end(JSON.stringify(data));
}
function auth(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const [p,s] = m[1].split('.');
    const data = JSON.parse(Buffer.from(p,'base64url'));
    if (data.exp && Date.now()/1000 > data.exp) return null;
    if (data.iss !== (process.env.JWT_ISSUER || 'tredin')) return null;
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'CHANGE_ME').update(p).digest('base64url');
    if (s !== expected) return null;
    return data;
  } catch { return null; }
}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    const chunks=[]; let n=0;
    req.on('data',c=>{ n+=c.length; if(n>2e6){reject(new Error('BODY_TOO_LARGE')); req.destroy(); return;} chunks.push(c); });
    req.on('end',()=>{ try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('INVALID_JSON')); } });
    req.on('error',reject);
  });
}
async function actor(req,res,roles){
  const a=auth(req);
  if(!a){json(res,401,{ok:false,error:'UNAUTHORIZED'},req);return null;}
  if(!roles.has(a.role)){json(res,403,{ok:false,error:'FORBIDDEN'},req);return null;}
  if(pool){const r=await pool.query('select status from users where id=$1',[a.sub]);if(!r.rowCount||r.rows[0].status!=='ACTIVE'){json(res,401,{ok:false,error:'ACCOUNT_INACTIVE'},req);return null;}}
  return a;
}

http.createServer = function patchedCreateServer(requestListener, ...args) {
  return originalCreateServer.call(http, async (req,res) => {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS' && u.pathname.startsWith('/admin/funds/')) return json(res,204,{},req);
    if (u.pathname === '/admin/funds/users' && req.method === 'GET') {
      const a=await actor(req,res,ADMIN_ROLES); if(!a)return;
      if(!pool)return json(res,503,{ok:false,error:'DATABASE_NOT_CONFIGURED'},req);
      const qv=String(u.searchParams.get('search')||u.searchParams.get('q')||'').trim();
      if(qv.length<2)return json(res,400,{ok:false,error:'SEARCH_QUERY_REQUIRED'},req);
      const like=`%${qv.replace(/[%_\\]/g,'\\$&')}%`;
      const r=await pool.query(`select id,user_id,role,status,full_name,mobile,email from users where role='CUSTOMER' and (user_id ilike $1 escape '\\' or coalesce(full_name,'') ilike $1 escape '\\' or coalesce(mobile,'') ilike $1 escape '\\' or coalesce(email,'') ilike $1 escape '\\') order by created_at desc limit 20`,[like]);
      return json(res,200,{ok:true,users:r.rows},req);
    }
    if (u.pathname === '/admin/funds/credit' && req.method === 'POST') {
      const a=await actor(req,res,CREDIT_ROLES); if(!a)return;
      if(!pool)return json(res,503,{ok:false,error:'DATABASE_NOT_CONFIGURED'},req);
      let x; try{x=await readBody(req)}catch(e){return json(res,400,{ok:false,error:e.message||'INVALID_JSON'},req)}
      const userId=String(x.userId||'').trim(), amount=Number(x.amount), reason=String(x.reason||'').trim().slice(0,240);
      if(!userId||!Number.isFinite(amount)||amount<=0||amount>100000000)return json(res,400,{ok:false,error:'INVALID_CREDIT_PAYLOAD'},req);
      if(!reason)return json(res,400,{ok:false,error:'CREDIT_REASON_REQUIRED'},req);
      const idem=String(req.headers['idempotency-key']||'').trim();
      if(idem.length<8||idem.length>160)return json(res,400,{ok:false,error:'IDEMPOTENCY_KEY_REQUIRED'},req);
      const reference=`ADMIN_CREDIT:${idem}`;
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const existing=await client.query('select id,user_id,entry_type,amount,reference_id,status,balance_after,created_at from ledger_entries where reference_id=$1 limit 1',[reference]);
        if(existing.rowCount){await client.query('ROLLBACK');return json(res,200,{ok:true,idempotent:true,ledger:existing.rows[0]},req);}
        const target=await client.query('select id,user_id,status,full_name,mobile,email from users where id=$1 or user_id=$1 for update',[userId]);
        if(!target.rowCount||target.rows[0].role!=='CUSTOMER'||target.rows[0].status!=='ACTIVE'){await client.query('ROLLBACK');return json(res,404,{ok:false,error:'ACTIVE_CUSTOMER_NOT_FOUND'},req);}
        const customer=target.rows[0];
        const bal=await client.query(`select coalesce(sum(case when status='POSTED' and entry_type in ('DEPOSIT','CREDIT','REALIZED_PNL') then amount when status='POSTED' and entry_type in ('WITHDRAWAL','DEBIT') then -amount else 0 end),0) balance from ledger_entries where user_id=$1`,[customer.id]);
        const before=Number(bal.rows[0].balance), after=before+amount;
        const led=await client.query(`insert into ledger_entries(user_id,entry_type,amount,reference_id,status,balance_after) values($1,'CREDIT',$2,$3,'POSTED',$4) returning id,user_id,entry_type,amount,reference_id,status,balance_after,created_at`,[customer.id,amount,reference,after]);
        await client.query(`insert into audit_log(actor_user_id,action,entity_type,entity_id,request_id,payload) values($1,'ADMIN_FUNDS_CREDITED','USER',$2,$3,$4)`,[a.sub,customer.id,req.headers['x-request-id']||null,JSON.stringify({amount,reason,balanceBefore:before,balanceAfter:after,reference})]);
        await client.query('COMMIT');
        return json(res,201,{ok:true,ledger:led.rows[0],customer:{id:customer.id,userId:customer.user_id,name:customer.full_name,mobile:customer.mobile,email:customer.email},balanceBefore:before,balanceAfter:after},req);
      }catch(e){try{await client.query('ROLLBACK')}catch{};console.error(e);return json(res,500,{ok:false,error:'ADMIN_CREDIT_TRANSACTION_FAILED'},req)}finally{client.release()}
    }
    return requestListener(req,res);
  }, ...args);
};
