/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([], function () {
  function afterSubmit() {
    var rec = nlapiLoadRecord('customrecord_vendor', 42);
    var filter = new nlobjSearchFilter('name', null, 'is', 'Acme');
    return rec && filter;
  }
  return { afterSubmit: afterSubmit };
});
