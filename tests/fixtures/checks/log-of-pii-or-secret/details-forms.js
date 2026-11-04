/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/log'], function (log) {
  function afterSubmit(ctx) {
    var password = 'x';
    log.audit({ title: 'auth', details: password });
    log.error({ title: 'fail', details: ctx.consumerSecret });
  }
  return { afterSubmit: afterSubmit };
});
