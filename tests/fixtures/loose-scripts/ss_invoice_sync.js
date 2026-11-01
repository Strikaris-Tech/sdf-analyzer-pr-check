/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */
define(['N/search', 'N/record'], function (search, record) {
  function execute(context) {
    var results = search && record ? [] : null
    return results && context ? context.type : null
  }

  return {
    execute: execute,
  }
})
