import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { InternalExecutionEngine } = require('./execution-engine.js');
const { RmsEngine } = require('./broker-engine.js');

dotenv.config();
const PORT=Number(process.env.PORT||8788);
const MARKET=process.env.MARKET_ADAPTER_URL||'http://127.0.0.1:8787';
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
const executionEngine=new InternalExecutionEngine({rms:new RmsEngine()});
const REQUIRE_SECURE_CONFIG=process.env.NODE_ENV==='production';
if(REQUIRE_SECURE_CONFIG && (!process.env.JWT_SECRET || process.env.JWT_SECRET==='CHANGE_ME')) throw new Error('JWT_SECRET_MUST_BE_CONFIGURED');
const RATE_WINDOW_MS=60_000, RATE_MAX=120, rateBuckets=new Map();
function clientKey(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim()}
function rateLimit(req,res){const now=Date.now(), key=clientKey(req);let b=rateBuckets.get(key);if(!b||now-b.start>RATE_WINDOW_MS){b={start:now,count:0};rateBuckets.set(key,b)}b.count++;if(b.count>RATE_MAX){json(res,429,{ok:false,error:'RATE_LIMITED'},req);return false}return true}
function corsOrigin(req){const configured=String(process.env.CORS_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);const origin=String(req?.headers?.origin||'');if(!origin)return configured[0]||'null';if(configured.includes('*'))return origin;const ok=configured.some(x=>x===origin||(x.startsWith('*.')&&origin.endsWith(x.slice(1))));return ok?origin:'null'}
function securityHeaders(req){return {'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','permissions-policy':'geolocation=(),camera=(),microphone=()','access-control-allow-origin':corsOrigin(req),'access-control-allow-headers':'Content-Type,Authorization,X-Request-ID,Idempotency-Key','access-control-allow-methods':'GET,POST,DELETE,OPTIONS','vary':'Origin'}}
function json(res,code,data,req){const b=JSON.stringify(data);res.writeHead(code,securityHeaders(req||res.req));res.end(b)}
function rawBody(req,limit=8e6){return new Promise((resolve,reject)=>{const chunks=[];let n=0;req.on('data',c=>{n+=c.length;if(n>limit){reject(new Error('BODY_TOO_LARGE'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}
function body(req){return rawBody(req,2e6).then(b=>{try{return b.length?JSON.parse(b.toString('utf8')):{}}catch(e){throw Object.assign(new Error('INVALID_JSON'),{code:'INVALID_JSON'})}})}
function parseMultipart(buf,contentType){const m=String(contentType||'').match(/boundary=(?:\"([^\"]+)\"|([^;]+))/i);if(!m)throw Object.assign(new Error('MULTIPART_BOUNDARY_MISSING'),{code:'MULTIPART_BOUNDARY_MISSING'});const boundary=Buffer.from('--'+(m[1]||m[2]));const parts=[];let start=0;while((start=buf.indexOf(boundary,start))!==-1){start+=boundary.length;if(buf.slice(start,start+2).toString()==='--')break;if(buf.slice(start,start+2).toString()==='\r\n')start+=2;const end=buf.indexOf(boundary,start);if(end<0)break;let part=buf.slice(start,end);if(part.slice(-2).toString()==='\r\n')part=part.slice(0,-2);const sep=part.indexOf(Buffer.from('\r\n\r\n'));if(sep<0)continue;const headers=part.slice(0,sep).toString('utf8');const data=part.slice(sep+4);const disp=headers.match(/Content-Disposition:\s*form-data;\s*([^\r\n]+)/i)?.[1]||'';const name=disp.match(/name=\"([^\"]+)\"/i)?.[1];const filename=disp.match(/filename=\"([^\"]*)\"/i)?.[1]||'';const ct=headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]||'application/octet-stream';if(name)parts.push({name,filename,contentType:ct,data});start=end}return parts}
function bearer(req){const m=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);return m?m[1]:null}
function auth(req){const t=bearer(req); if(!t) return null; try{const [p,s]=t.split('.');const data=JSON.parse(Buffer.from(p,'base64url'));if(data.exp&&Date.now()/1000>data.exp)return null;const sig=crypto.createHmac('sha256',process.env.JWT_SECRET||'CHANGE_ME').update(p).digest('base64url');if(sig!==s)return null;return data}catch{return null}}
function token(sub,role='CUSTOMER'){const p=Buffer.from(JSON.stringify({sub,role,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,iss:process.env.JWT_ISSUER||'tredin'})).toString('base64url');const s=crypto.createHmac('sha256',process.env.JWT_SECRET||'CHANGE_ME').update(p).digest('base64url');return `${p}.${s}`}
function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(String(password),salt,64).toString('hex');return `scrypt$${salt}$${hash}`}
function verifyPassword(password,encoded){try{const [scheme,salt,hex]=String(encoded||'').split('$');if(scheme!=='scrypt'||!salt||!hex)return false;const a=crypto.scryptSync(String(password),salt,64);const b=Buffer.from(hex,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}catch{return false}}
function adminRole(role){return ['SUPER_ADMIN','OPERATIONS_ADMIN','KYC_ADMIN','FINANCE_ADMIN','RISK_ADMIN','SUPPORT_ADMIN','READ_ONLY_ADMIN'].includes(role)}
function requireRole(req,res,roles){const a=requireAuth(req,res);if(!a)return null;if(!adminRole(a.role)||!roles.includes(a.role)){json(res,403,{ok:false,error:'FORBIDDEN'});return null}return a}

async function q(text,args=[]){if(!pool)throw new Error('DATABASE_NOT_CONFIGURED');return pool.query(text,args)}
async function proxyMarket(path,res){try{const r=await fetch(MARKET+path);const t=await r.text();res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json','cache-control':'no-store'});res.end(t)}catch(e){json(res,503,{ok:false,error:'MARKET_ADAPTER_UNAVAILABLE'})}}
async function proxyMarketStream(res){try{const r=await fetch(MARKET+'/market/stream',{headers:{Accept:'text/event-stream'}});if(!r.ok||!r.body) return json(res,r.status||503,{ok:false,error:'MARKET_STREAM_UNAVAILABLE'});res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*','x-accel-buffering':'no'});for await (const chunk of r.body){res.write(Buffer.from(chunk));}res.end();}catch(e){if(!res.headersSent) json(res,503,{ok:false,error:'MARKET_STREAM_UNAVAILABLE'});else res.end();}}
function requireAuth(req,res){const a=auth(req);if(!a){json(res,401,{ok:false,error:'UNAUTHORIZED'});return null}return a}
function validOrder(x){return x&&['BUY','SELL'].includes(String(x.side).toUpperCase())&&['MARKET','LIMIT','SL','SL-M'].includes(String(x.orderType).toUpperCase())&&Number.isFinite(Number(x.quantity))&&Number(x.quantity)>0&&x.instrumentId}
async function server(){const s=http.createServer(async(req,res)=>{if(!rateLimit(req,res))return;if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':corsOrigin(req),'access-control-allow-headers':'Content-Type,Authorization,X-Request-ID,Idempotency-Key','access-control-allow-methods':'GET,POST,DELETE,OPTIONS','access-control-max-age':'600'});return res.end()}
 const u=new URL(req.url,`http://${req.headers.host}`);
 const requestId=String(req.headers['x-request-id']||crypto.randomUUID()); res.setHeader('x-request-id',requestId);
 try{
  if(req.method==='GET'&&u.pathname==='/health') return json(res,200,{ok:true,service:'tredin-core',database:!!pool,execution:process.env.ORDER_EXECUTION_ENABLED==='true',marketAdapter:MARKET});
  if(req.method==='GET'&&u.pathname==='/market/stream') return proxyMarketStream(res);
  if(u.pathname.startsWith('/market/')) return proxyMarket(u.pathname+u.search,res);
  if(req.method==='POST'&&u.pathname==='/auth/login'){
    if(!pool)return json(res,503,{ok:false,error:'DATABASE_NOT_CONFIGURED'});
    const x=await body(req); if(!x.userId||!x.password)return json(res,400,{ok:false,error:'INVALID_CREDENTIALS'});
    const r=await q('select id,user_id,role,password_hash,status,full_name,mobile,email from users where user_id=$1 or lower(email)=lower($1) or mobile=$1 limit 1',[String(x.userId)]); if(!r.rowCount)return json(res,401,{ok:false,error:'INVALID_CREDENTIALS'});
    const u=r.rows[0]; if(u.status!=='ACTIVE'||!u.password_hash||!verifyPassword(x.password,u.password_hash))return json(res,401,{ok:false,error:'INVALID_CREDENTIALS'});
    return json(res,200,{ok:true,token:token(u.id,u.role),user:{id:u.id,userId:u.user_id,role:u.role,status:u.status,name:u.full_name,mobile:u.mobile,email:u.email}});
  }
  if(req.method==='POST'&&u.pathname==='/auth/refresh'){return json(res,501,{ok:false,error:'REFRESH_STORE_NOT_CONFIGURED'})}
  if(req.method==='POST'&&u.pathname==='/auth/logout'){return json(res,200,{ok:true})}
  if(req.method==='POST'&&u.pathname==='/auth/register'){
    if(!pool)return json(res,503,{ok:false,error:'DATABASE_NOT_CONFIGURED'});
    const x=await body(req); const name=String(x.name||'').trim(), mobile=String(x.mobile||'').replace(/\D/g,''), email=String(x.email||'').trim().toLowerCase(), password=String(x.password||'');
    if(!name||!/^[6-9]\d{9}$/.test(mobile)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8)return json(res,400,{ok:false,error:'INVALID_REGISTRATION_PAYLOAD'});
    const exists=await q('select 1 from users where user_id=$1 or email=$2 or mobile=$3 limit 1',[mobile,email,mobile]); if(exists.rowCount)return json(res,409,{ok:false,error:'ACCOUNT_ALREADY_EXISTS'});
    const r=await q("insert into users(user_id,role,status,password_hash,full_name,mobile,email) values($1,'CUSTOMER','ACTIVE',$2,$3,$4,$5) returning id,user_id,role,status,created_at",[mobile,hashPassword(password),name,mobile,email]);
    return json(res,201,{ok:true,user:{id:r.rows[0].id,userId:r.rows[0].user_id,role:r.rows[0].role,status:r.rows[0].status,name, mobile,email},message:'Account created. Continue with KYC.'});
  }
  if(req.method==='GET'&&u.pathname==='/admin/me'){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','KYC_ADMIN','FINANCE_ADMIN','RISK_ADMIN','SUPPORT_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    return json(res,200,{ok:true,admin:{id:a.sub,role:a.role}});
  }
  if(req.method==='GET'&&u.pathname==='/admin/users'){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','KYC_ADMIN','FINANCE_ADMIN','RISK_ADMIN','SUPPORT_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    const r=await q('select id,user_id,role,status,created_at from users order by created_at desc limit 500'); return json(res,200,{ok:true,users:r.rows});
  }
  if(req.method==='GET'&&u.pathname==='/admin/orders'){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','RISK_ADMIN','SUPPORT_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    const r=await q(`select o.id,o.user_id,u.user_id as customer_id,o.instrument_id,i.symbol,o.side,o.order_type,o.quantity,o.limit_price,o.trigger_price,o.status,o.rms_status,o.rejection_code,o.client_order_id,o.created_at,o.updated_at from orders o join users u on u.id=o.user_id join instruments i on i.id=o.instrument_id order by o.created_at desc limit 500`);
    return json(res,200,{ok:true,orders:r.rows});
  }
  if(req.method==='GET'&&u.pathname==='/admin/risk'){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','RISK_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    const r=await q(`select r.user_id,u.user_id as customer_id,r.max_order_value,r.max_open_orders,r.max_daily_loss,r.margin_multiplier,r.broker_funding_limit,r.enabled,r.updated_at from risk_limits r join users u on u.id=r.user_id order by u.user_id limit 500`);
    return json(res,200,{ok:true,risk:r.rows});
  }
  if(req.method==='GET'&&u.pathname==='/admin/support'){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','SUPPORT_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    const r=await q(`select t.*,u.user_id as customer_id,(select count(*) from support_messages m where m.ticket_id=t.id)::int as message_count from support_tickets t join users u on u.id=t.user_id order by t.updated_at desc limit 500`);
    return json(res,200,{ok:true,tickets:r.rows});
  }
  if(req.method==='GET'&&/^\/admin\/support\/[^/]+$/.test(u.pathname)){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','SUPPORT_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    const id=u.pathname.split('/')[3]; const t=await q('select t.*,u.user_id as customer_id from support_tickets t join users u on u.id=t.user_id where t.id=$1',[id]);
    if(!t.rowCount)return json(res,404,{ok:false,error:'TICKET_NOT_FOUND'});
    const m=await q('select sm.*,u.user_id as sender_id from support_messages sm join users u on u.id=sm.sender_user_id where sm.ticket_id=$1 order by sm.created_at asc',[id]);
    return json(res,200,{ok:true,ticket:t.rows[0],messages:m.rows});
  }
  if(req.method==='POST'&&/^\/admin\/support\/[^/]+\/(reply|close)$/.test(u.pathname)){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','SUPPORT_ADMIN']); if(!a)return;
    const parts=u.pathname.split('/'); const id=parts[3]; const action=parts[4];
    const t=await q('select id,user_id,status from support_tickets where id=$1',[id]); if(!t.rowCount)return json(res,404,{ok:false,error:'TICKET_NOT_FOUND'});
    if(action==='reply'){
      const x=await body(req); const msg=String(x.message||'').trim(); if(!msg)return json(res,400,{ok:false,error:'MESSAGE_REQUIRED'});
      await q('insert into support_messages(ticket_id,sender_user_id,message) values($1,$2,$3)',[id,a.sub,msg]);
      await q(`update support_tickets set status='PENDING_USER',updated_at=now() where id=$1`,[id]);
      await q(`insert into notifications(user_id,type,title,message) values($1,'SUPPORT','Support ticket updated',$2)`,[t.rows[0].user_id,`Support replied to ticket ${id}.`]);
      await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'SUPPORT_REPLY','SUPPORT_TICKET',$2,$3)`,[a.sub,id,JSON.stringify({ticketId:id})]);
      return json(res,200,{ok:true,status:'PENDING_USER'});
    }
    await q(`update support_tickets set status='CLOSED',closed_at=now(),updated_at=now() where id=$1`,[id]);
    await q(`insert into notifications(user_id,type,title,message) values($1,'SUPPORT','Support ticket closed',$2)`,[t.rows[0].user_id,`Support ticket ${id} has been closed.`]);
    await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'SUPPORT_CLOSED','SUPPORT_TICKET',$2,$3)`,[a.sub,id,JSON.stringify({ticketId:id})]);
    return json(res,200,{ok:true,status:'CLOSED'});
  }
  if(req.method==='GET'&&u.pathname==='/admin/audit'){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','KYC_ADMIN','FINANCE_ADMIN','RISK_ADMIN','SUPPORT_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    const r=await q(`select a.*,u.user_id as actor_id from audit_log a left join users u on u.id=a.actor_user_id order by a.created_at desc limit 500`);
    return json(res,200,{ok:true,audit:r.rows});
  }
  if(req.method==='GET'&&u.pathname==='/admin/kyc'){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','KYC_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    const r=await q(`select k.*,u.user_id as customer_id from kyc_cases k join users u on u.id=k.user_id order by k.submitted_at desc nulls last limit 500`);
    return json(res,200,{ok:true,kyc:r.rows});
  }
  if(req.method==='GET'&&u.pathname==='/admin/finance'){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','FINANCE_ADMIN','READ_ONLY_ADMIN']); if(!a)return;
    const r=await q(`select f.*,u.user_id as customer_id from finance_requests f join users u on u.id=f.user_id order by f.created_at desc limit 500`);
    return json(res,200,{ok:true,finance:r.rows});
  }
  if(req.method==='POST'&&/^\/admin\/kyc\/[^/]+\/(approve|reject)$/.test(u.pathname)){
    const a=requireRole(req,res,['SUPER_ADMIN','KYC_ADMIN']); if(!a)return;
    const parts=u.pathname.split('/'); const caseId=parts[3]; const action=parts[4];
    const status=action==='approve'?'APPROVED':'REJECTED';
    const r=await q(`update kyc_cases set status=$1,reviewed_at=now(),reviewed_by=$2 where id=$3 returning id,user_id,status,reviewed_at,reviewed_by`,[status,a.sub,caseId]);
    if(!r.rowCount)return json(res,404,{ok:false,error:'KYC_CASE_NOT_FOUND'});
    await q(`update kyc_documents set status=$1 where case_id=$2 and status='SUBMITTED'`,[status,caseId]);
    await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,$2,'KYC_CASE',$3,$4)`,[a.sub,`KYC_${status}`,caseId,JSON.stringify({status})]);
    return json(res,200,{ok:true,kyc:r.rows[0]});
  }
  if(req.method==='POST'&&/^\/admin\/finance\/[^/]+\/(approve|reject)$/.test(u.pathname)){
    const a=requireRole(req,res,['SUPER_ADMIN','FINANCE_ADMIN']); if(!a)return;
    if(!pool)return json(res,503,{ok:false,error:'DATABASE_NOT_CONFIGURED'});
    const parts=u.pathname.split('/'); const requestId=parts[3]; const action=parts[4];
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const fr=await client.query(`select * from finance_requests where id=$1 for update`,[requestId]);
      if(!fr.rowCount){await client.query('ROLLBACK');return json(res,404,{ok:false,error:'FINANCE_REQUEST_NOT_FOUND'});}
      const f=fr.rows[0]; if(f.status!=='PENDING'){await client.query('ROLLBACK');return json(res,409,{ok:false,error:'FINANCE_REQUEST_ALREADY_REVIEWED',status:f.status});}
      if(action==='reject'){
        const r=await client.query(`update finance_requests set status='REJECTED',reviewed_by=$1,reviewed_at=now() where id=$2 returning *`,[a.sub,requestId]);
        await client.query(`insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'FINANCE_REJECTED','FINANCE_REQUEST',$2,$3)`,[a.sub,requestId,JSON.stringify({type:f.request_type,amount:f.amount})]);
        await client.query('COMMIT'); return json(res,200,{ok:true,request:r.rows[0]});
      }
      const bal=await client.query(`select coalesce(sum(case when status='POSTED' and entry_type in ('DEPOSIT','CREDIT','REALIZED_PNL') then amount when status='POSTED' and entry_type in ('WITHDRAWAL','DEBIT') then -amount else 0 end),0) balance from ledger_entries where user_id=$1`,[f.user_id]);
      if(f.request_type==='WITHDRAW' && Number(bal.rows[0].balance)<Number(f.amount)){await client.query('ROLLBACK');return json(res,422,{ok:false,error:'INSUFFICIENT_AVAILABLE_BALANCE'});}
      const r=await client.query(`update finance_requests set status='APPROVED',reviewed_by=$1,reviewed_at=now() where id=$2 returning *`,[a.sub,requestId]);
      const entry=f.request_type==='DEPOSIT'?'DEPOSIT':'WITHDRAWAL'; const amount=f.request_type==='DEPOSIT'?Number(f.amount):-Number(f.amount); const after=Number(bal.rows[0].balance)+amount;
      await client.query(`insert into ledger_entries(user_id,entry_type,amount,reference_id,status,balance_after) values($1,$2,$3,$4,'POSTED',$5)`,[f.user_id,entry,Math.abs(amount),requestId,after]);
      await client.query(`insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'FINANCE_APPROVED','FINANCE_REQUEST',$2,$3)`,[a.sub,requestId,JSON.stringify({type:f.request_type,amount:f.amount,balanceAfter:after})]);
      await client.query('COMMIT'); return json(res,200,{ok:true,request:r.rows[0],ledger:{entryType:entry,amount:Math.abs(amount),balanceAfter:after}});
    }catch(e){try{await client.query('ROLLBACK')}catch{}; console.error(e); return json(res,500,{ok:false,error:'FINANCE_TRANSACTION_FAILED'});
    }finally{client.release();}
  }
  if(req.method==='POST'&&/^\/admin\/users\/[^/]+\/(suspend|activate)$/.test(u.pathname)){
    const a=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN']); if(!a)return;
    const parts=u.pathname.split('/'); const userId=parts[3]; const action=parts[4]; const status=action==='suspend'?'SUSPENDED':'ACTIVE';
    const r=await q(`update users set status=$1,updated_at=now() where id=$2 returning id,user_id,role,status`,[status,userId]);
    if(!r.rowCount)return json(res,404,{ok:false,error:'USER_NOT_FOUND'});
    await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,$2,'USER',$3,$4)`,[a.sub,`USER_${action.toUpperCase()}`,userId,JSON.stringify({status})]);
    return json(res,200,{ok:true,user:r.rows[0]});
  }
  const a=requireAuth(req,res);if(!a)return;
  if(req.method==='GET'&&u.pathname==='/me'){
    const r=await q('select id,user_id,role,status,created_at from users where id=$1',[a.sub]);if(!r.rowCount)return json(res,404,{ok:false,error:'USER_NOT_FOUND'});return json(res,200,{ok:true,user:r.rows[0]})
  }
  if(req.method==='GET'&&u.pathname==='/orders'){
    const r=await q('select o.id,o.instrument_id,o.side,o.order_type,o.quantity,o.limit_price,o.trigger_price,o.status,o.rms_status,o.rejection_code,o.client_order_id,o.broker_order_id,o.created_at,o.updated_at,i.symbol,i.exchange,i.segment from orders o join instruments i on i.id=o.instrument_id where o.user_id=$1 order by o.created_at desc limit 200',[a.sub]);
    return json(res,200,{ok:true,orders:r.rows});
  }
  if(req.method==='GET'&&u.pathname.startsWith('/orders/')){
    const id=u.pathname.split('/')[2];
    const r=await q('select o.*,i.symbol,i.exchange,i.segment from orders o join instruments i on i.id=o.instrument_id where o.id=$1 and o.user_id=$2',[id,a.sub]);
    if(!r.rowCount)return json(res,404,{ok:false,error:'ORDER_NOT_FOUND'});
    const e=await q('select * from executions where order_id=$1 order by executed_at asc',[id]);
    return json(res,200,{ok:true,order:r.rows[0],executions:e.rows});
  }
  if(req.method==='POST'&&u.pathname==='/orders'){
    if(!pool)return json(res,503,{ok:false,error:'DATABASE_NOT_CONFIGURED'});
    const x=await body(req);if(!validOrder(x))return json(res,400,{ok:false,error:'INVALID_ORDER_PAYLOAD'});
    const instrumentResult=await q('select id,symbol,exchange,segment,enabled as trading_enabled from instruments where id=$1',[String(x.instrumentId)]);
    if(!instrumentResult.rowCount)return json(res,404,{ok:false,error:'INSTRUMENT_NOT_FOUND'});
    const account={trading_enabled:true};
    const ctx=executionEngine.createContext({order:x,account,instrument:instrumentResult.rows[0]});
    const clientId=x.clientOrderId?String(x.clientOrderId):null;
    if(clientId){const dup=await q('select id,status from orders where user_id=$1 and client_order_id=$2 limit 1',[a.sub,clientId]);if(dup.rowCount)return json(res,200,{ok:true,idempotent:true,orderId:dup.rows[0].id,status:dup.rows[0].status});}
    const status=ctx.risk.ok?'RMS_PENDING':'REJECTED';
    const rejection=ctx.risk.ok?null:ctx.risk.code;
    const r=await q('insert into orders(user_id,instrument_id,side,order_type,quantity,limit_price,trigger_price,status,rms_status,rejection_code,client_order_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id,status,rms_status,rejection_code,created_at',[a.sub,String(x.instrumentId),ctx.order.side,ctx.order.orderType,ctx.order.quantity,ctx.order.limitPrice,ctx.order.triggerPrice,status,ctx.risk.ok?'PENDING':'REJECTED',rejection,clientId]);
    await q('insert into audit_log(actor_user_id,action,entity_type,entity_id,request_id,payload) values($1,$2,$3,$4,$5,$6)',[a.sub,'ORDER_ACCEPTED_FOR_RMS','ORDER',r.rows[0].id,req.headers['x-request-id']||null,JSON.stringify({order:ctx.order,risk:ctx.risk})]);
    if(!ctx.risk.ok)return json(res,422,{ok:false,error:ctx.risk.code,order:r.rows[0]});
    return json(res,202,{ok:true,order:r.rows[0],message:'Order accepted into TredIN RMS. No execution/fill has been fabricated; venue execution remains disabled until an authorised execution adapter is connected.'});
  }
  if(req.method==='POST'&&/^\/orders\/[^/]+\/cancel$/.test(u.pathname)){
    const id=u.pathname.split('/')[2];
    const r=await q("select id,status from orders where id=$1 and user_id=$2",[id,a.sub]);
    if(!r.rowCount)return json(res,404,{ok:false,error:'ORDER_NOT_FOUND'});
    if(['FILLED','CANCELLED','REJECTED','EXPIRED'].includes(r.rows[0].status))return json(res,409,{ok:false,error:'ORDER_NOT_CANCELLABLE',status:r.rows[0].status});
    await q("update orders set status='CANCELLED',rms_status='CANCELLED',updated_at=now() where id=$1 and user_id=$2",[id,a.sub]);
    await q('insert into audit_log(actor_user_id,action,entity_type,entity_id,request_id,payload) values($1,$2,$3,$4,$5,$6)',[a.sub,'ORDER_CANCELLED','ORDER',id,req.headers['x-request-id']||null,JSON.stringify({source:'USER'} )]);
    return json(res,200,{ok:true,orderId:id,status:'CANCELLED'});
  }
  if(req.method==='GET'&&u.pathname==='/notifications'){
    const r=await q(`select id,type,title,message,read_at,created_at from notifications where user_id=$1 order by created_at desc limit 100`,[a.sub]);
    return json(res,200,{ok:true,notifications:r.rows,source:'SERVER_NOTIFICATIONS'});
  }
  if(req.method==='POST'&&u.pathname==='/notifications/read-all'){
    await q(`update notifications set read_at=coalesce(read_at,now()) where user_id=$1`,[a.sub]);
    return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&u.pathname==='/support'){
    const r=await q(`select id,subject,category,priority,status,created_at,updated_at,closed_at from support_tickets where user_id=$1 order by updated_at desc limit 100`,[a.sub]);
    return json(res,200,{ok:true,tickets:r.rows});
  }
  if(req.method==='GET'&&/^\/support\/[^/]+$/.test(u.pathname)){
    const id=u.pathname.split('/')[2]; const t=await q('select * from support_tickets where id=$1 and user_id=$2',[id,a.sub]);
    if(!t.rowCount)return json(res,404,{ok:false,error:'TICKET_NOT_FOUND'});
    const m=await q('select id,message,created_at from support_messages where ticket_id=$1 order by created_at asc',[id]);
    return json(res,200,{ok:true,ticket:t.rows[0],messages:m.rows});
  }
  if(req.method==='POST'&&u.pathname==='/support'){
    const x=await body(req); const subject=String(x.subject||'').trim(), message=String(x.message||'').trim();
    if(!subject||!message)return json(res,400,{ok:false,error:'SUBJECT_AND_MESSAGE_REQUIRED'});
    const t=await q(`insert into support_tickets(user_id,subject,category,priority) values($1,$2,$3,$4) returning *`,[a.sub,subject,String(x.category||'GENERAL'),String(x.priority||'NORMAL')]);
    await q(`insert into support_messages(ticket_id,sender_user_id,message) values($1,$2,$3)`,[t.rows[0].id,a.sub,message]);
    await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,request_id,payload) values($1,'SUPPORT_TICKET_CREATED','SUPPORT_TICKET',$2,$3,$4)`,[a.sub,t.rows[0].id,req.headers['x-request-id']||null,JSON.stringify({category:x.category||'GENERAL'})]);
    return json(res,201,{ok:true,ticket:t.rows[0]});
  }
  if(req.method==='POST'&&/^\/support\/[^/]+\/reply$/.test(u.pathname)){
    const id=u.pathname.split('/')[2]; const x=await body(req); const msg=String(x.message||'').trim(); if(!msg)return json(res,400,{ok:false,error:'MESSAGE_REQUIRED'});
    const t=await q('select id,status from support_tickets where id=$1 and user_id=$2',[id,a.sub]); if(!t.rowCount)return json(res,404,{ok:false,error:'TICKET_NOT_FOUND'});
    if(t.rows[0].status==='CLOSED')return json(res,409,{ok:false,error:'TICKET_CLOSED'});
    await q(`insert into support_messages(ticket_id,sender_user_id,message) values($1,$2,$3)`,[id,a.sub,msg]);
    await q(`update support_tickets set status='OPEN',updated_at=now() where id=$1`,[id]);
    return json(res,200,{ok:true,status:'OPEN'});
  }
  if(req.method==='GET'&&u.pathname==='/positions'){
    const r=await q(`select p.user_id,p.instrument_id,p.quantity,p.average_price,p.realized_pnl,p.updated_at,i.symbol,i.exchange,i.segment,m.ltp,m.unrealized_pnl,m.market_value,m.marked_at from positions p join instruments i on i.id=p.instrument_id left join portfolio_marks m on m.user_id=p.user_id and m.instrument_id=p.instrument_id where p.user_id=$1 order by i.symbol`,[a.sub]);
    return json(res,200,{ok:true,positions:r.rows,source:'VENUE_EXECUTIONS'});
  }
  if(req.method==='GET'&&u.pathname==='/portfolio/summary'){
    const r=await q(`select coalesce(sum(realized_pnl),0) realized_pnl from positions where user_id=$1`,[a.sub]);
    const m=await q(`select coalesce(sum(unrealized_pnl),0) unrealized_pnl,coalesce(sum(market_value),0) market_value from portfolio_marks where user_id=$1`,[a.sub]);
    return json(res,200,{ok:true,summary:{realizedPnl:Number(r.rows[0].realized_pnl),unrealizedPnl:Number(m.rows[0].unrealized_pnl),marketValue:Number(m.rows[0].market_value)},source:'VENUE_EXECUTIONS_AND_MARKET_MARKS'});
  }
  if(req.method==='GET'&&u.pathname==='/risk/margin'){
    const open=await q(`select coalesce(sum(amount),0) reserved_margin from margin_reservations where user_id=$1 and status='ACTIVE'`,[a.sub]);
    const lim=await q(`select broker_funding_limit,margin_multiplier,enabled from risk_limits where user_id=$1`,[a.sub]);
    return json(res,200,{ok:true,margin:{reserved:Number(open.rows[0].reserved_margin),limits:lim.rows[0]||null},source:'SERVER_RMS'});
  }
  if(req.method==='GET'&&u.pathname==='/funds'){
    const l=await q(`select coalesce(sum(case when status='POSTED' and entry_type in ('DEPOSIT','CREDIT','REALIZED_PNL') then amount when status='POSTED' and entry_type in ('WITHDRAWAL','DEBIT') then -amount else 0 end),0) balance from ledger_entries where user_id=$1`,[a.sub]);
    const pending=await q(`select coalesce(sum(case when request_type='DEPOSIT' then amount else 0 end),0) deposits,coalesce(sum(case when request_type='WITHDRAW' then amount else 0 end),0) withdrawals from finance_requests where user_id=$1 and status='PENDING'`,[a.sub]);
    return json(res,200,{ok:true,funds:{balance:Number(l.rows[0].balance),pendingDeposit:Number(pending.rows[0].deposits),pendingWithdrawal:Number(pending.rows[0].withdrawals)},source:'SERVER_LEDGER'});
  }
  if(req.method==='GET'&&u.pathname==='/funds/ledger'){
    const r=await q(`select id,entry_type,amount,reference_id,status,balance_after,created_at from ledger_entries where user_id=$1 order by created_at desc limit 500`,[a.sub]);
    return json(res,200,{ok:true,entries:r.rows,source:'SERVER_LEDGER'});
  }
  if(req.method==='POST'&&['/funds/deposit','/funds/withdraw'].includes(u.pathname)){
    const x=await body(req); const amount=Number(x.amount); if(!Number.isFinite(amount)||amount<=0)return json(res,400,{ok:false,error:'INVALID_AMOUNT'});
    const type=u.pathname.endsWith('deposit')?'DEPOSIT':'WITHDRAW';
    const r=await q(`insert into finance_requests(user_id,request_type,amount,reference) values($1,$2,$3,$4) returning id,request_type,amount,status,created_at`,[a.sub,type,amount,x.reference?String(x.reference):null]);
    await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,request_id,payload) values($1,$2,$3,$4,$5,$6)`,[a.sub,'FINANCE_REQUEST_CREATED','FINANCE_REQUEST',r.rows[0].id,req.headers['x-request-id']||null,JSON.stringify({type,amount})]);
    return json(res,202,{ok:true,request:r.rows[0],message:'Request recorded. No balance mutation occurs until Finance/Admin approval.'});
  }
  if(req.method==='GET'&&u.pathname==='/kyc'){
    const c=await q(`select * from kyc_cases where user_id=$1`,[a.sub]); if(!c.rowCount)return json(res,200,{ok:true,kyc:null});
    const d=await q(`select id,document_type,document_ref,status,created_at from kyc_documents where case_id=$1 order by created_at desc`,[c.rows[0].id]);
    return json(res,200,{ok:true,kyc:{...c.rows[0],documents:d.rows},source:'SERVER_KYC'});
  }
  if(req.method==='POST'&&u.pathname==='/kyc/documents'){
    if(!pool)return json(res,503,{ok:false,error:'DATABASE_NOT_CONFIGURED'});
    const ct=String(req.headers['content-type']||''); const raw=await rawBody(req,8e6); let parts; try{parts=parseMultipart(raw,ct)}catch(e){return json(res,400,{ok:false,error:e.code||'INVALID_MULTIPART'})}
    const typePart=parts.find(p=>p.name==='documentType'); const file=parts.find(p=>p.name==='file'&&p.filename); const documentType=String(typePart?.data?.toString('utf8')||'').trim().toUpperCase();
    const allowed=['PAN','PHOTO','BANK_PROOF','ADDRESS','BANK','SIGNATURE','OTHER']; if(!allowed.includes(documentType)||!file)return json(res,400,{ok:false,error:'INVALID_KYC_DOCUMENT'});
    if(!file.data.length||file.data.length>6e6)return json(res,413,{ok:false,error:'KYC_DOCUMENT_TOO_LARGE'});
    const existingCase=await q(`select id,status from kyc_cases where user_id=$1`,[a.sub]);
    if(existingCase.rowCount && ['APPROVED','ACTIVE','VERIFIED'].includes(String(existingCase.rows[0].status).toUpperCase())) return json(res,409,{ok:false,error:'KYC_ALREADY_VERIFIED'});
    const c=await q(`insert into kyc_cases(user_id,status) values($1,'PENDING') on conflict(user_id) do update set status=case when kyc_cases.status='REJECTED' then 'PENDING' else kyc_cases.status end returning id,status`,[a.sub]);
    const hash=crypto.createHash('sha256').update(file.data).digest('hex');
    const ref=`sha256:${hash}:${file.filename.slice(0,120)}`;
    const d=await q(`insert into kyc_documents(case_id,document_type,document_ref,status,original_name,mime_type,size_bytes,content) values($1,$2,$3,'SUBMITTED',$4,$5,$6,$7) returning id,document_type,document_ref,status,original_name,mime_type,size_bytes,created_at`,[c.rows[0].id,documentType,ref,file.filename.slice(0,180),file.contentType.slice(0,120),file.data.length,file.data]);
    await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'KYC_DOCUMENT_UPLOADED','KYC_DOCUMENT',$2,$3)`,[a.sub,d.rows[0].id,JSON.stringify({documentType,size:file.data.length,sha256:hash})]);
    return json(res,201,{ok:true,document:d.rows[0],case:{id:c.rows[0].id,status:c.rows[0].status}});
  }
  if(req.method==='DELETE'&&/^\/kyc\/documents\/[^/]+$/.test(u.pathname)){
    if(!pool)return json(res,503,{ok:false,error:'DATABASE_NOT_CONFIGURED'}); const id=u.pathname.split('/')[3];
    const r=await q(`delete from kyc_documents d using kyc_cases c where d.id=$1 and d.case_id=c.id and c.user_id=$2 and d.status not in ('APPROVED','REJECTED') returning d.id,d.case_id`,[id,a.sub]);
    if(!r.rowCount)return json(res,404,{ok:false,error:'KYC_DOCUMENT_NOT_FOUND_OR_LOCKED'});
    await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,'KYC_DOCUMENT_REMOVED','KYC_DOCUMENT',$2,'{}')`,[a.sub,id]);
    return json(res,200,{ok:true,removed:id});
  }
  if(req.method==='POST'&&u.pathname==='/kyc/submit'){
    const x=await body(req); const docs=Array.isArray(x.documents)?x.documents:[];
    const existing=await q(`select id,status from kyc_cases where user_id=$1`,[a.sub]);
    let caseId;
    if(existing.rowCount){caseId=existing.rows[0].id;await q(`update kyc_cases set status='PENDING',submitted_at=now(),reviewed_at=null,reviewed_by=null where id=$1`,[caseId]);}
    else {const c=await q(`insert into kyc_cases(user_id,status,submitted_at) values($1,'PENDING',now()) returning id`,[a.sub]);caseId=c.rows[0].id;}
    for(const d of docs){if(!d?.documentType)continue;await q(`insert into kyc_documents(case_id,document_type,document_ref,status) values($1,$2,$3,'SUBMITTED')`,[caseId,String(d.documentType),d.documentRef?String(d.documentRef):null]);}
    await q(`insert into audit_log(actor_user_id,action,entity_type,entity_id,request_id,payload) values($1,$2,$3,$4,$5,$6)`,[a.sub,'KYC_SUBMITTED','KYC_CASE',caseId,req.headers['x-request-id']||null,JSON.stringify({documentCount:docs.length})]);
    return json(res,202,{ok:true,kyc:{id:caseId,status:'PENDING'},message:'KYC submitted for Admin review.'});
  }
  if(req.method==='POST'&&u.pathname==='/admin/reconciliation/run'){
    const adm=requireRole(req,res,['SUPER_ADMIN','OPERATIONS_ADMIN','FINANCE_ADMIN','RISK_ADMIN']); if(!adm)return;
    const ex=await q('select count(*)::int c from executions');
    const pos=await q('select count(*)::int c from positions where quantity<>0');
    const led=await q('select count(*)::int c from ledger_entries');
    const run=await q(`insert into reconciliation_runs(scope,status,checked_executions,checked_positions,checked_ledger_entries,mismatch_count,details) values('GLOBAL','PASS',$1,$2,$3,0,$4) returning *`,[ex.rows[0].c,pos.rows[0].c,led.rows[0].c,JSON.stringify({note:'Structural reconciliation only; no external venue or payment ledger configured.'})]);
    await q('insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,$2,$3,$4,$5)',[adm.sub,'RECONCILIATION_RUN','RECONCILIATION',run.rows[0].id,JSON.stringify(run.rows[0])]);
    return json(res,200,{ok:true,reconciliation:run.rows[0]});
  }
  return json(res,404,{ok:false,error:'NOT_FOUND'});
 }catch(e){console.error(e);return json(res,500,{ok:false,error:'INTERNAL_SERVER_ERROR'})}
 });s.listen(PORT,()=>console.log(`TredIN core backend listening on ${PORT}`))}
server();
