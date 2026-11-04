/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/https'], function (https) {
  var password = 'short';
  function afterSubmit() {
    https.get({
      url: 'https://api.example.com/health',
      headers: { 'Content-Type': 'application/json' }
    });
    return password.length;
  }
  return { afterSubmit: afterSubmit };
});
