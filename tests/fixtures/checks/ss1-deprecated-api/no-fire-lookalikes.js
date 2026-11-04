/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([], function () {
  function afterSubmit(helper) {
    var viaMember = helper.nlapiLoadRecord('salesorder', 1);
    var keyed = { nlapiLoadRecord: 1, nlobjField: 2 };
    var mentioned = 'nlapiSubmitField is the old way';
    return viaMember + keyed.nlapiLoadRecord + mentioned.length;
  }
  return { afterSubmit: afterSubmit };
});
