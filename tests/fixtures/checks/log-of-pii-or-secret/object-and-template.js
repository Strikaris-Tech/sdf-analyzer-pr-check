/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/log'], function (log) {
  function afterSubmit(ctx) {
    log.debug({ title: 'order', details: { creditCard: ctx.cc, orderId: 7 } });
    log.debug({ title: 'token', details: `token ${ctx.apiToken}` });
  }
  return { afterSubmit: afterSubmit };
});
