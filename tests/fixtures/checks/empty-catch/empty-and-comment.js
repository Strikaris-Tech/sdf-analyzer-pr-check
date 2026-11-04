/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record'], function (record) {
  function afterSubmit() {
    try {
      record.load({ type: 'salesorder', id: 1 });
    } catch (e) {
    }
    try {
      record.load({ type: 'salesorder', id: 2 });
    } catch (e) {
      // Deliberate: the load is best-effort.
    }
  }
  return { afterSubmit: afterSubmit };
});
