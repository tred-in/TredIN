import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'change-this-in-production' || JWT_SECRET.length < 32) {
  console.warn('WARNING: set a random JWT_SECRET of at least 32 characters in production');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000 });
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const rateBuckets = new Map();
app.use((req, res, next) => {
  const key = `${req.ip || 'unknown'}:${Math.floor(Date.now() / 60000)}`;
  const n = (rateBuckets.get(key) || 0) + 1;
  rateBuckets.set(key, n);
  if (n > 120) return res.status(429).json({ error: 'RATE_LIMITED' });
  if (rateBuckets.size > 5000) rateBuckets.clear();
  next();
});

async function initDb() {
  const sql = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
  for (let attempt = 1; attempt <= 20; attempt++) {
    try { await pool.query(sql); return; }
    catch (e) { if (attempt === 20) throw e; await new Promise(r => setTimeout(r, 1500)); }
  }
}

async function seedAdmin() {
  if (!process.env.ADMIN_PHONE || !process.env.ADMIN_PASSWORD) return;
  const existing = await pool.query('select id from users where phone=$1 or email=$1 limit 1', [process.env.ADMIN_PHONE]);
  if (existing.rowCount) return;
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  await pool.query('insert into users(name,phone,email,password_hash,role) values($1,$2,$3,$4,\'admin\')', [process.env.ADMIN_NAME || 'TredIN Admin', process.env.ADMIN_PHONE, process.env.ADMIN_EMAIL || null, hash]);
}

const auth = (req, res, next) => {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'INVALID_SESSION' }); }
};
const adminOnly = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'ADMIN_REQUIRED' });
const audit = async (actor, action, type, id, metadata = {}) => pool.query('insert into audit_log(actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,$3,$4,$5)', [actor, action, type, id, metadata]);

app.get('/api/health', async (_req, res) => {
  try { await pool.query('select 1'); res.json({ ok: true, service: 'tredin-api', database: 'ok', broker: 'disabled', mode: 'paper' }); }
  catch { res.status(503).json({ ok: false, service: 'tredin-api', database: 'unavailable', broker: 'disabled', mode: 'paper' }); }
});

app.post('/api/auth/register', async (req, res) => {
  const p = z.object({name:z.string().min(2).max(120),phone:z.string().min(7).max(20),email:z.string().email().optional(),password:z.string().min(8).max(200)}).safeParse(req.body);
  if (!p.success) return res.status(400).json({error:'VALIDATION_ERROR',details:p.error.flatten()});
  try { const x=p.data; const exists=await pool.query('select id from users where phone=$1 or ($2::text is not null and email=$2)',[x.phone,x.email||null]); if(exists.rowCount)return res.status(409).json({error:'USER_EXISTS'}); const hash=await bcrypt.hash(x.password,12); const r=await pool.query('insert into users(name,phone,email,password_hash) values($1,$2,$3,$4) returning id,name,phone,email,status,role,created_at',[x.name,x.phone,x.email||null,hash]); const u=r.rows[0]; const token=jwt.sign({sub:u.id,role:'user'},JWT_SECRET,{expiresIn:'7d'}); res.status(201).json({user:u,token}); } catch { res.status(500).json({error:'SERVER_ERROR'}); }
});
app.post('/api/auth/login', async (req,res)=>{const p=z.object({login:z.string().min(3),password:z.string().min(1)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'VALIDATION_ERROR'});try{const r=await pool.query('select * from users where phone=$1 or email=$1 limit 1',[p.data.login]);if(!r.rowCount||!(await bcrypt.compare(p.data.password,r.rows[0].password_hash)))return res.status(401).json({error:'INVALID_CREDENTIALS'});const u=r.rows[0];const token=jwt.sign({sub:u.id,role:u.role},JWT_SECRET,{expiresIn:'7d'});res.json({user:{id:u.id,name:u.name,phone:u.phone,email:u.email,status:u.status,role:u.role},token});}catch{res.status(500).json({error:'SERVER_ERROR'});}});
app.get('/api/me',auth,async(req,res)=>{const r=await pool.query('select id,name,phone,email,status,role,created_at from users where id=$1',[req.user.sub]);if(!r.rowCount)return res.status(404).json({error:'USER_NOT_FOUND'});res.json(r.rows[0]);});
app.get('/api/kyc',auth,async(req,res)=>{const r=await pool.query('select id,status,document_type,submitted_at,reviewed_at,review_note from kyc_cases where user_id=$1 order by created_at desc limit 1',[req.user.sub]);res.json(r.rows[0]||{status:'not_started'});});
app.post('/api/kyc',auth,async(req,res)=>{const p=z.object({document_type:z.string().min(2).max(80),document_ref:z.string().min(2).max(200)}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'VALIDATION_ERROR'});const r=await pool.query('insert into kyc_cases(user_id,document_type,document_ref,status,submitted_at) values($1,$2,$3,\'pending\',now()) returning id,status,document_type,submitted_at',[req.user.sub,p.data.document_type,p.data.document_ref]);res.status(201).json(r.rows[0]);});
app.get('/api/funds',auth,async(req,res)=>{const r=await pool.query("select coalesce(sum(case when direction='credit' then amount else -amount end),0) balance from fund_ledger where user_id=$1 and status='posted'",[req.user.sub]);res.json({balance:Number(r.rows[0].balance)});});
app.get('/api/funds/transactions',auth,async(req,res)=>{const r=await pool.query('select id,type,direction,amount,status,reference,created_at from fund_ledger where user_id=$1 order by created_at desc limit 100',[req.user.sub]);res.json(r.rows);});
app.post('/api/funds/requests',auth,async(req,res)=>{const p=z.object({type:z.enum(['deposit','withdrawal']),amount:z.number().positive().max(100000000),reference:z.string().max(120).optional()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'VALIDATION_ERROR'});const r=await pool.query('insert into fund_requests(user_id,type,amount,reference,status) values($1,$2,$3,$4,\'pending\') returning *',[req.user.sub,p.data.type,p.data.amount,p.data.reference||null]);res.status(201).json(r.rows[0]);});

app.get('/api/instruments',auth,async(_req,res)=>{const r=await pool.query("select id,symbol,name,exchange,last_price,tick_size,status,updated_at from instruments where status='active' order by symbol");res.json(r.rows);});
app.get('/api/orders',auth,async(req,res)=>{const r=await pool.query('select o.id,o.side,o.order_type,o.quantity,o.limit_price,o.status,o.filled_quantity,o.avg_fill_price,o.created_at,i.symbol,i.name,i.exchange from orders o join instruments i on i.id=o.instrument_id where o.user_id=$1 order by o.created_at desc limit 200',[req.user.sub]);res.json(r.rows);});
app.post('/api/orders',auth,async(req,res)=>{const p=z.object({instrument_id:z.string().uuid(),side:z.enum(['buy','sell']),order_type:z.enum(['market','limit']).default('market'),quantity:z.number().positive().max(10000000),limit_price:z.number().positive().max(100000000).optional()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'VALIDATION_ERROR',details:p.error.flatten()});const c=await pool.connect();try{await c.query('begin');const i=await c.query("select * from instruments where id=$1 and status='active' for update",[p.data.instrument_id]);if(!i.rowCount){await c.query('rollback');return res.status(404).json({error:'INSTRUMENT_NOT_FOUND'});}const inst=i.rows[0];const execPrice=p.data.order_type==='market'?Number(inst.last_price):Number(p.data.limit_price);if(p.data.order_type==='limit'&&((p.data.side==='buy'&&execPrice<Number(inst.last_price))||(p.data.side==='sell'&&execPrice>Number(inst.last_price)))){const o=await c.query('insert into orders(user_id,instrument_id,side,order_type,quantity,limit_price,status) values($1,$2,$3,$4,$5,$6,\'open\') returning *',[req.user.sub,inst.id,p.data.side,p.data.order_type,p.data.quantity,p.data.limit_price]);await c.query('commit');return res.status(201).json({...o.rows[0],execution:'paper',message:'Limit order accepted and waiting for price condition'});}const value=execPrice*p.data.quantity;if(p.data.side==='buy'){const bal=await c.query("select coalesce(sum(case when direction='credit' then amount else -amount end),0) balance from fund_ledger where user_id=$1 and status='posted'",[req.user.sub]);if(Number(bal.rows[0].balance)<value){await c.query('rollback');return res.status(409).json({error:'INSUFFICIENT_FUNDS'});}await c.query("insert into fund_ledger(user_id,type,direction,amount,reference,status) values($1,'trade_debit','debit',$2,$3,'posted')",[req.user.sub,value,'ORDER_PENDING']);}else{const pos=await c.query('select quantity from positions where user_id=$1 and instrument_id=$2 for update',[req.user.sub,inst.id]);if(!pos.rowCount||Number(pos.rows[0].quantity)<p.data.quantity){await c.query('rollback');return res.status(409).json({error:'INSUFFICIENT_POSITION'});}}const o=await c.query('insert into orders(user_id,instrument_id,side,order_type,quantity,limit_price,status,filled_quantity,avg_fill_price) values($1,$2,$3,$4,$5,$6,\'filled\',$5,$7) returning *',[req.user.sub,inst.id,p.data.side,p.data.order_type,p.data.quantity,p.data.limit_price,execPrice]);const order=o.rows[0];await c.query('insert into executions(order_id,user_id,instrument_id,side,quantity,price,value) values($1,$2,$3,$4,$5,$6,$7)',[order.id,req.user.sub,inst.id,p.data.side,p.data.quantity,execPrice,value]);const pos=await c.query('select * from positions where user_id=$1 and instrument_id=$2 for update',[req.user.sub,inst.id]);if(p.data.side==='buy'){if(pos.rowCount){const oldQ=Number(pos.rows[0].quantity),oldA=Number(pos.rows[0].avg_price),q=oldQ+p.data.quantity;await c.query('update positions set quantity=$1,avg_price=$2,updated_at=now() where user_id=$3 and instrument_id=$4',[q,(oldQ*oldA+value)/q,req.user.sub,inst.id]);}else await c.query('insert into positions(user_id,instrument_id,quantity,avg_price) values($1,$2,$3,$4)',[req.user.sub,p.data.instrument_id,p.data.quantity,execPrice]);}else{const oldQ=Number(pos.rows[0].quantity),oldA=Number(pos.rows[0].avg_price),sellQ=p.data.quantity,realized=(execPrice-oldA)*sellQ,newQ=oldQ-sellQ;if(newQ===0)await c.query('update positions set quantity=0,avg_price=0,realized_pnl=realized_pnl+$1,updated_at=now() where user_id=$2 and instrument_id=$3',[realized,req.user.sub,inst.id]);else await c.query('update positions set quantity=$1,realized_pnl=realized_pnl+$2,updated_at=now() where user_id=$3 and instrument_id=$4',[newQ,realized,req.user.sub,inst.id]);await c.query("insert into fund_ledger(user_id,type,direction,amount,reference,status) values($1,'trade_credit','credit',$2,$3,'posted')",[req.user.sub,value,order.id]);}await c.query('commit');res.status(201).json({...order,execution:'paper'});}catch(e){await c.query('rollback');res.status(500).json({error:'SERVER_ERROR'});}finally{c.release();}});
app.get('/api/tradebook',auth,async(req,res)=>{const r=await pool.query('select e.*,i.symbol,i.name from executions e join instruments i on i.id=e.instrument_id where e.user_id=$1 order by e.executed_at desc limit 200',[req.user.sub]);res.json(r.rows);});
app.get('/api/positions',auth,async(req,res)=>{const r=await pool.query('select p.instrument_id,i.symbol,i.name,i.exchange,p.quantity,p.avg_price,i.last_price,p.realized_pnl,(p.quantity*(i.last_price-p.avg_price)) unrealized_pnl from positions p join instruments i on i.id=p.instrument_id where p.user_id=$1 and p.quantity>0 order by i.symbol',[req.user.sub]);res.json(r.rows.map(x=>({...x,market_value:Number(x.quantity)*Number(x.last_price)})));});
app.get('/api/portfolio',auth,async(req,res)=>{const r=await pool.query("select coalesce(sum(case when direction='credit' then amount else -amount end),0) cash from fund_ledger where user_id=$1 and status='posted'",[req.user.sub]);const p=await pool.query('select p.quantity,i.last_price,p.avg_price,p.realized_pnl from positions p join instruments i on i.id=p.instrument_id where p.user_id=$1 and p.quantity>0',[req.user.sub]);let marketValue=0,unrealized=0,realized=0;for(const x of p.rows){marketValue+=Number(x.quantity)*Number(x.last_price);unrealized+=Number(x.quantity)*(Number(x.last_price)-Number(x.avg_price));realized+=Number(x.realized_pnl)}const cash=Number(r.rows[0].cash);res.json({cash,market_value:marketValue,total_value:cash+marketValue,realized_pnl:realized,unrealized_pnl:unrealized});});
app.post('/api/orders/:id/cancel',auth,async(req,res)=>{const r=await pool.query("update orders set status='cancelled',updated_at=now() where id=$1 and user_id=$2 and status='open' returning *",[req.params.id,req.user.sub]);if(!r.rowCount)return res.status(404).json({error:'OPEN_ORDER_NOT_FOUND'});res.json(r.rows[0]);});

app.get('/api/admin/users',auth,adminOnly,async(_req,res)=>{const r=await pool.query('select id,name,phone,email,status,role,created_at from users order by created_at desc limit 500');res.json(r.rows);});
app.get('/api/admin/kyc',auth,adminOnly,async(_req,res)=>{const r=await pool.query('select k.*,u.name,u.phone from kyc_cases k join users u on u.id=k.user_id order by k.created_at desc limit 500');res.json(r.rows);});
app.post('/api/admin/kyc/:id/review',auth,adminOnly,async(req,res)=>{const p=z.object({status:z.enum(['approved','rejected']),note:z.string().max(500).optional()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'VALIDATION_ERROR'});const r=await pool.query('update kyc_cases set status=$1,reviewed_at=now(),review_note=$2 where id=$3 returning *',[p.data.status,p.data.note||null,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'KYC_NOT_FOUND'});await audit(req.user.sub,'KYC_REVIEW','kyc_case',req.params.id,{status:p.data.status});res.json(r.rows[0]);});
app.get('/api/admin/funds',auth,adminOnly,async(_req,res)=>{const r=await pool.query('select f.*,u.name,u.phone from fund_requests f join users u on u.id=f.user_id order by f.created_at desc limit 500');res.json(r.rows);});
app.post('/api/admin/funds/:id/review',auth,adminOnly,async(req,res)=>{const p=z.object({status:z.enum(['approved','rejected']),note:z.string().max(500).optional()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'VALIDATION_ERROR'});const c=await pool.connect();try{await c.query('begin');const r=await c.query('select * from fund_requests where id=$1 for update',[req.params.id]);if(!r.rowCount){await c.query('rollback');return res.status(404).json({error:'FUND_REQUEST_NOT_FOUND'});}const f=r.rows[0];if(f.status!=='pending'){await c.query('rollback');return res.status(409).json({error:'ALREADY_REVIEWED'});}const u=await c.query('update fund_requests set status=$1,reviewed_at=now(),reviewed_by=$2 where id=$3 returning *',[p.data.status,req.user.sub,f.id]);if(p.data.status==='approved'){const direction=f.type==='deposit'?'credit':'debit';if(direction==='debit'){const bal=await c.query("select coalesce(sum(case when direction='credit' then amount else -amount end),0) balance from fund_ledger where user_id=$1 and status='posted'",[f.user_id]);if(Number(bal.rows[0].balance)<Number(f.amount)){await c.query('rollback');return res.status(409).json({error:'INSUFFICIENT_FUNDS'});}}await c.query('insert into fund_ledger(user_id,type,direction,amount,reference,status) values($1,$2,$3,$4,$5,\'posted\')',[f.user_id,f.type,direction,f.amount,f.reference||f.id]);}await c.query('insert into audit_log(actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,$3,$4,$5)',[req.user.sub,'FUND_REVIEW','fund_request',f.id,{status:p.data.status}]);await c.query('commit');res.json(u.rows[0]);}catch{await c.query('rollback');res.status(500).json({error:'SERVER_ERROR'});}finally{c.release();}});

app.use(express.static(path.join(root,'public'), { extensions: ['html'] }));
app.get('*', (req,res,next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(root,'public','index.html')); });
app.use((_,res)=>res.status(404).json({error:'NOT_FOUND'}));

async function main(){await initDb();await seedAdmin();app.listen(PORT,()=>console.log(`TredIN listening on ${PORT} — paper mode, broker disabled`));}
main().catch(e=>{console.error('Startup failed:',e);process.exit(1);});