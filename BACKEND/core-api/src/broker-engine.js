'use strict';

// Broker/RMS boundary: intentionally refuses to fabricate execution.
// Replace BrokerAdapter methods with the chosen broker API implementation.

class BrokerAdapter {
  constructor(){ this.name='UNCONFIGURED_BROKER'; }
  async placeOrder(){ throw Object.assign(new Error('Broker execution adapter is not configured'), {code:'BROKER_NOT_CONFIGURED'}); }
  async cancelOrder(){ throw Object.assign(new Error('Broker execution adapter is not configured'), {code:'BROKER_NOT_CONFIGURED'}); }
  async getOrder(){ throw Object.assign(new Error('Broker execution adapter is not configured'), {code:'BROKER_NOT_CONFIGURED'}); }
}

class RmsEngine {
  validateOrder({order, account, instrument}){
    if(!order || !account || !instrument) return {ok:false, code:'INVALID_ORDER_CONTEXT'};
    if(account.trading_enabled === false) return {ok:false, code:'TRADING_DISABLED'};
    if(instrument.trading_enabled === false) return {ok:false, code:'INSTRUMENT_DISABLED'};
    if(!Number.isFinite(Number(order.quantity)) || Number(order.quantity) <= 0) return {ok:false, code:'INVALID_QUANTITY'};
    if(order.side !== 'BUY' && order.side !== 'SELL') return {ok:false, code:'INVALID_SIDE'};
    return {ok:true};
  }
}

module.exports={BrokerAdapter,RmsEngine};
