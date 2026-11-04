/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/https'], function (https) {
  function pageInit() {
    https.get({ url: 'https://api.example.com/health' });
  }
  function fieldChanged() {
    return https.post.promise({ url: 'https://api.example.com/log', body: '{}' });
  }
  return { pageInit: pageInit, fieldChanged: fieldChanged };
});
