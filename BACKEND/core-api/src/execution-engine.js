'use strict';

// TredIN internal execution control-plane. This does NOT fabricate fills.
// A real exchange/venue adapter must explicitly acknowledge an order before
// an execution row, position, or financial ledger mutation can be created.

const TERMINAL = new Set(['REJECTED','CANCELLED','FILLED','EXPIRED']);
const TRANSITIONS = {
  CREATED:['RMS_PENDING','REJECTED'],
  RMS_PENDING:['ROUTING','REJECTED'],
  ROUTING:['ACKNOWLEDGED','REJECTED','CANCELLED'],
  ACKNOWLEDGED:['PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED'],
  PARTIALLY_FILLED:['PARTIALLY_FILLED','FILLED','CANCELLED'],
  FILLED:[], CANCELLED:[], REJECTED:[], EXPIRED:[]
};

function canTransition(from,to){return Array.isArray(TRANSITIONS[from])&&TRANSITIONS[from].includes(to)}
function assertTransition(from,to){if(!canTransition(from,to))throw Object.assign(new Error(`Invalid order transition ${from} -> ${to}`),{code:'INVALID_ORDER_TRANSITION'})}
function normalizeOrder(x){
  const side=String(x.side||'').toUpperCase();
  const orderType=String(x.orderType||'').toUpperCase();
  const quantity=Number(x.quantity);
  if(!x.instrumentId||!['BUY','SELL'].includes(side)||!['MARKET','LIMIT','SL','SL-M'].includes(orderType)||!Number.isFinite(quantity)||quantity<=0)
    throw Object.assign(new Error('Invalid order payload'),{code:'INVALID_ORDER_PAYLOAD'});
  return {instrumentId:String(x.instrumentId),side,orderType,quantity,limitPrice:x.limitPrice==null?null:Number(x.limitPrice),triggerPrice:x.triggerPrice==null?null:Number(x.triggerPrice)};
}

class InternalExecutionEngine {
  constructor({rms}){this.rms=rms}
  createContext({order,account,instrument}){
    const normalized=normalizeOrder(order);
    const risk=this.rms.validateOrder({order:normalized,account,instrument});
    return {order:normalized,risk,state:risk.ok?'RMS_PENDING':'REJECTED'};
  }
  advance(state,next){assertTransition(state.state,next);return {...state,state:next}}
  executionGuard(){
    return {allowed:false,code:'NO_VENUE_EXECUTION_ADAPTER',message:'TredIN will not fabricate an execution. Connect an authorised exchange/venue adapter before creating fills or financial mutations.'};
  }
}

module.exports={InternalExecutionEngine,normalizeOrder,canTransition,assertTransition};
