/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/record', 'N/error', 'N/log'], function (record, error, log) {
  function get(context) {
    log.debug({ title: 'rl_customer_api', details: context })
    return { ok: true, record: !!record, error: !!error }
  }

  function post(context) {
    return { received: context }
  }

  return {
    get: get,
    post: post,
  }
})
