import http from 'node:http';
import { URL } from 'node:url';
import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

const PORT = Number(process.env.PORT || 8787);
const TD_PORT = Number(process.env.TRUEDATA_REALTIME_PORT || 8086);
const TD_WS_URL = process.env.TRUEDATA_WS_URL || `wss://push.truedata.in:${TD_PORT}`;
const TD_USER = process.env.TRUEDATA_USER || '';
const TD_PASS = process.env.TRUEDATA_PASSWORD || '';

function parseMap() {
  try { return JSON.parse(process.env.TREDIN_SYMBOL_MAP || '[]'); }
  catch { throw new Error('TREDIN_SYMBOL_MAP must be valid JSON'); }
}
const instruments = parseMap();
const byTD = new Map(instruments.map(x => [String(x.truedataSymbol), x]));
const byId = new Map(instruments.map(x => [String(x.id), x]));
const quotes = new Map();
const clients = new Set();
let td = null;
let tdReady = false;
let tdInfo = null;
let reconnectTimer = null;

function publicQuote(q) {
  return {
    id: q.id, symbol: q.symbol, exchange: q.exchange, segment: q.segment,
    ltp: q.ltp ?? null, bid: q.bid ?? null, bidQty: q.bidQty ?? null,
    ask: q.ask ?? null, askQty: q.askQty ?? null, open: q.open ?? null,
    high: q.high ?? null, low: q.low ?? null, prevClose: q.prevClose ?? null,
    volume: q.volume ?? null, oi: q.oi ?? null, atp: q.atp ?? null,
    turnover: q.turnover ?? null, timestamp: q.timestamp ?? null,
    source: 'TrueData', stale: false
  };
}

function broadcast(q) {
  const msg = JSON.stringify({ type: 'quote', data: publicQuote(q) });
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

function upsertQuoteFromTouchline(row) {
  if (!Array.isArray(row) || row.length < 17) return;
  const tdSymbol = String(row[0]);
  const meta = byTD.get(tdSymbol);
  if (!meta) return;
  const q = {
    id: meta.id, symbol: meta.symbol, exchange: meta.exchange, segment: meta.segment,
    timestamp: row[2], ltp: num(row[3]), volume: num(row[6]), atp: num(row[5]),
    open: num(row[7]), high: num(row[8]), low: num(row[9]), prevClose: num(row[10]),
    oi: num(row[11]), turnover: num(row[13]), bid: num(row[14]), bidQty: num(row[15]),
    ask: num(row[16]), askQty: num(row[17])
  };
  quotes.set(meta.id, q); broadcast(q);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function applyTrade(a) {
  if (!Array.isArray(a) || a.length < 19) return;
  const meta = [...byTD.values()].find(x => String(x.truedataSymbol) === String(a[0]));
  if (!meta) return;
  const q = quotes.get(meta.id) || {id:meta.id,symbol:meta.symbol,exchange:meta.exchange,segment:meta.segment};
  Object.assign(q, { timestamp:a[1], ltp:num(a[2]), atp:num(a[4]), volume:num(a[5]), open:num(a[6]), high:num(a[7]), low:num(a[8]), prevClose:num(a[9]), oi:num(a[10]), turnover:num(a[12]), bid:num(a[15]), bidQty:num(a[16]), ask:num(a[17]), askQty:num(a[18]) });
  quotes.set(meta.id,q); broadcast(q);
}
function applyBidAsk(a) {
  if (!Array.isArray(a) || a.length < 6) return;
  const meta = [...byTD.values()].find(x => String(x.truedataSymbol) === String(a[0]));
  if (!meta) return;
  const q = quotes.get(meta.id) || {id:meta.id,symbol:meta.symbol,exchange:meta.exchange,segment:meta.segment};
  Object.assign(q,{timestamp:a[1],bid:num(a[2]),bidQty:num(a[3]),ask:num(a[4]),askQty:num(a[5])});
  quotes.set(meta.id,q); broadcast(q);
}

function connectTrueData() {
  clearTimeout(reconnectTimer);
  if (!TD_USER || !TD_PASS) { tdReady=false; tdInfo={error:'TrueData credentials are not configured on the server.'}; return; }
  const url = `${TD_WS_URL}?user=${encodeURIComponent(TD_USER)}&password=${encodeURIComponent(TD_PASS)}`;
  td = new WebSocket(url);
  td.on('open', () => {
    // Authentication is performed by the WebSocket URL. Subscribe only to server-configured symbols.
    td.send(JSON.stringify({method:'addsymbol', symbols:instruments.map(x=>x.truedataSymbol)}));
  });
  td.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.success === true && m.message === 'TrueData Real Time Data Service') {
        tdReady = true; tdInfo = {segments:m.segments,maxsymbols:m.maxsymbols,subscription:m.subscription,validity:m.validity}; return;
      }
      if (m.success === false && m.message) { tdReady=false; tdInfo={error:m.message}; return; }
      if (m.message === 'touchline' && Array.isArray(m.symbollist)) m.symbollist.forEach(upsertQuoteFromTouchline);
      if (Array.isArray(m.trade)) applyTrade(m.trade);
      if (Array.isArray(m.bidask)) applyBidAsk(m.bidask);
    } catch { /* ignore malformed provider frame; do not fabricate data */ }
  });
  td.on('close', () => { tdReady=false; tdInfo={error:'TrueData stream disconnected'}; reconnectTimer=setTimeout(connectTrueData,3000); });
  td.on('error', err => { tdReady=false; tdInfo={error:err.message}; });
}

function json(res, code, data) {
  const body=JSON.stringify(data); res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}); res.end(body);
}
function server() {
  const s=http.createServer((req,res)=>{
    const u=new URL(req.url,`http://${req.headers.host}`);
    if (req.method==='GET' && u.pathname==='/health') return json(res,200,{ok:true,provider:'TrueData',connected:tdReady,providerInfo:tdInfo,quotes:quotes.size});
    if (req.method==='GET' && u.pathname==='/market/instruments') return json(res,200,{source:'TrueData',instruments});
    if (req.method==='GET' && u.pathname==='/market/quotes') return json(res,200,{source:'TrueData',quotes:[...quotes.values()].map(publicQuote),connected:tdReady});
    if (req.method==='GET' && u.pathname==='/market/stream') {
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
      res.write(`event: status\ndata: ${JSON.stringify({connected:tdReady,provider:'TrueData'})}\n\n`);
      const c={send:m=>res.write(`data: ${m}\n\n`)}; clients.add({readyState:WebSocket.OPEN,send:c.send});
      req.on('close',()=>{for(const x of clients) if(x.send===c.send) clients.delete(x);});
      return;
    }
    json(res,404,{ok:false,error:'Not found'});
  });
  s.listen(PORT,()=>console.log(`TredIN TrueData adapter listening on ${PORT}`));
}

connectTrueData();
server();
