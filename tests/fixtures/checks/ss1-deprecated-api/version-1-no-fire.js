/**
 * @NApiVersion 1.0
 * @NScriptType UserEventScript
 */
define([], function () {
  function afterSubmit() {
    return nlapiLoadRecord('salesorder', 1);
  }
  return { afterSubmit: afterSubmit };
});
