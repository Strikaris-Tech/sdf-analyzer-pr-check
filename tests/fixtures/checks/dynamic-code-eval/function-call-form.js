/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([], function () {
  function afterSubmit() {
    var g = Function('return 42;');
    return g();
  }
  return { afterSubmit: afterSubmit };
});
