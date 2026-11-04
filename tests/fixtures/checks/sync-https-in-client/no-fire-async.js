/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/https'], function (https) {
  function pageInit() {
    https.getAsync({ url: 'https://api.example.com/health' });
    https.requestAsync({ method: 'GET', url: 'https://api.example.com/ping' });
  }
  return { pageInit: pageInit };
});
