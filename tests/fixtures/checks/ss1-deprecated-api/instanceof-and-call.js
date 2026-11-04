/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([], function () {
  function afterSubmit(err) {
    if (err instanceof nlobjError) {
      nlapiSubmitField('salesorder', 42, 'memo', 'noted');
    }
    return true;
  }
  return { afterSubmit: afterSubmit };
});
