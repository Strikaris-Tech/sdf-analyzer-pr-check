/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/https'], function (https) {
  function afterSubmit() {
    https.post({
      url: 'https://api.example.com/v1/order?api_key=qzx7w9k2m4p8',
      headers: { Authorization: 'Bearer qzx7w9k2m4p8' },
      body: '{}'
    });
  }
  return { afterSubmit: afterSubmit };
});
