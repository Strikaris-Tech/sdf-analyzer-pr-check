/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/https'], function (https) {
  function saveRecord() {
    var response = https.request({ method: 'GET', url: 'https://api.example.com/ping' });
    return response.code === 200;
  }
  return { saveRecord: saveRecord };
});
