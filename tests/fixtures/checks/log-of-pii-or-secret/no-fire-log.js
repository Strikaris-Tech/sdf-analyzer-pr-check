/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/log'], function (log) {
  function tokenize(value) { return value; }
  function afterSubmit(order) {
    log.audit({ title: 'order', details: order.id });
    log.debug({ title: 'contact', details: { email: order.email, total: 5 } });
    log.debug(tokenize);
    log.debug(order);
  }
  return { afterSubmit: afterSubmit };
});
