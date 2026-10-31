/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/record', 'N/ui/message'], function (record, message) {
  function pageInit(context) {
    return message && record && context
  }

  function fieldChanged(context) {
    return context
  }

  return {
    pageInit: pageInit,
    fieldChanged: fieldChanged,
  }
})
