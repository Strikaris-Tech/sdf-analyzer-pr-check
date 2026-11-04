/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([], function () {
  function afterSubmit() {
    var fieldId = 'memo';
    eval('var x = 1;');
    eval(`var y = ${fieldId};`);
  }
  return { afterSubmit: afterSubmit };
});
