'use strict';

// Position/P&L engine. It consumes only venue-backed executions stored in PostgreSQL.
// No execution => no position mutation and no P&L mutation.

function n(v){ const x=Number(v); return Number.isFinite(x)?x:0; }

function applyFill(position, fill){
  const oldQty=n(position.quantity), oldAvg=n(position.average_price), qty=n(fill.fill_qty), px=n(fill.fill_price);
  if(qty<=0 || px<0) throw new Error('INVALID_FILL');
  const signed = String(fill.side).toUpperCase()==='SELL' ? -qty : qty;
  let q=oldQty, avg=oldAvg, realized=n(position.realized_pnl);
  if(q===0){ q=signed; avg=px; }
  else if(Math.sign(q)===Math.sign(signed)){ const newQty=q+signed; avg=((Math.abs(q)*avg)+(Math.abs(signed)*px))/Math.abs(newQty); q=newQty; }
  else {
    const closeQty=Math.min(Math.abs(q),Math.abs(signed));
    realized += (q>0 ? (px-avg) : (avg-px))*closeQty;
    q += signed;
    if(q===0) avg=0;
    else if(Math.sign(q)!==Math.sign(oldQty)) avg=px;
  }
  return {quantity:q,average_price:avg,realized_pnl:realized};
}

function markToMarket(position, ltp){
  const q=n(position.quantity), avg=n(position.average_price), p=n(ltp);
  return {unrealized_pnl:q===0?0:(p-avg)*q, market_value:Math.abs(q)*p};
}

module.exports={applyFill,markToMarket};
