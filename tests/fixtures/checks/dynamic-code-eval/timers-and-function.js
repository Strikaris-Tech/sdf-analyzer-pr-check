/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define([], function () {
  function pageInit() {
    setTimeout('pollServer()', 100);
    setInterval('refreshCounts()', 1000);
    var f = new Function('a', 'return a * 2;');
    return f(21);
  }
  return { pageInit: pageInit };
});
