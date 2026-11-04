/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/https', 'N/runtime'], function (https, runtime) {
  function afterSubmit() {
    var token = runtime.getCurrentScript().getParameter({ name: 'custscript_api_token' });
    https.post({
      url: 'https://api.example.com/v1/order',
      headers: {
        Authorization: token,
        'X-API-Key': 'your_api_key_here',
        'X-Request-Id': 'req-abcdef-0123456789'
      },
      body: '{}'
    });
  }
  return { afterSubmit: afterSubmit };
});
