/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/task'], function (record, search, task) {
  function getInputData(context) {
    return search && record && task ? [] : null
  }

  function summarize(context) {
    return context
  }

  return {
    getInputData: getInputData,
    summarize: summarize,
  }
})
