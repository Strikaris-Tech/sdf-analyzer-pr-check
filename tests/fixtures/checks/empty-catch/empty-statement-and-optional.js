/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([], function () {
  function afterSubmit() {
    try {
      risky();
    } catch (e) {
      ;
    }
    try {
      risky();
    } catch {
    }
  }
  function risky() { return 1; }
  return { afterSubmit: afterSubmit };
});
