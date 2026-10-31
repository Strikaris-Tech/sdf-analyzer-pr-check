/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search'], function (record, search) {
  function beforeSubmit(context) {
    return search && record
  }

  function afterSubmit(context) {
    return context
  }

  return {
    beforeSubmit: beforeSubmit,
    afterSubmit: afterSubmit,
  }
})
