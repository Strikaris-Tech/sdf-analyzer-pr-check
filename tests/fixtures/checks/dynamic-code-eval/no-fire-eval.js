/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([], function () {
  function evaluate(name) { return name; }
  function afterSubmit(ctx) {
    eval(ctx.payload);
    var data = JSON.parse('{"a": 1}');
    var label = evaluate('status');
    setTimeout(function () { return data; }, 100);
    setInterval(tick, 1000);
    return label;
  }
  function tick() { return 1; }
  return { afterSubmit: afterSubmit };
});
