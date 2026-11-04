/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/https'], function (https) {
  function buildOAuthHeader(opts) { return 'OAuth ' + opts.consumerKey; }
  function afterSubmit() {
    var header = buildOAuthHeader({
      consumerKey: 'ckqzx7w9k2m4p8a1b3',
      consumerSecret: 'csqzx7w9k2m4p8a1b3',
      tokenKey: 'tkqzx7w9k2m4p8a1b3',
      tokenSecret: 'tsqzx7w9k2m4p8a1b3'
    });
    https.post({
      url: 'https://api.example.com/v1/order',
      headers: { Authorization: header }
    });
  }
  return { afterSubmit: afterSubmit };
});
