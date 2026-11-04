/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/https'], function (https) {
  function afterSubmit() {
    https.get({ url: 'https://api.example.com/health' });
  }
  return { afterSubmit: afterSubmit };
});
