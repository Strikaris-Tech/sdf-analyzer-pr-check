/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/log'], function (log) {
  function afterSubmit() {
    try {
      risky();
    } catch (e) {
      log.error({ title: 'afterSubmit failed', details: e });
    }
    try {
      risky();
    } catch (e) {
      throw e;
    }
  }
  function risky() { return 1; }
  return { afterSubmit: afterSubmit };
});
