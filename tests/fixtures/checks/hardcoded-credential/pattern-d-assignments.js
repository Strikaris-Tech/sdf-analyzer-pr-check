/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/log'], function (log) {
  var apiSecret = 'qzx7w9k2m4p8a1b3cdef';
  var config = { password: 'qzx7w9k2m4p8a1b3cdef', retries: 3 };
  function run() {
    config.tokenSecret = 'qzx7w9k2m4p8a1b3cdef';
    log.debug({ title: 'lengths', details: apiSecret.length + config.password.length });
    return true;
  }
  return { run: run };
});
