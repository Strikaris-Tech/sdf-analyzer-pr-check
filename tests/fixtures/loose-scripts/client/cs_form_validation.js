/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
require(['N/ui/dialog', 'N/runtime'], function (dialog, runtime) {
  function pageInit(context) {
    return dialog && runtime ? context.mode : null
  }

  return {
    pageInit: pageInit,
  }
})
