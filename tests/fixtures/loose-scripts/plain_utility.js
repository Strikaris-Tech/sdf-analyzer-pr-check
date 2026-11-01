// A plain JavaScript helper with no SuiteScript annotations.
// Loose-file recognition must ignore this file entirely.
define(['N/record'], function (record) {
  function helper(value) {
    return record ? value : null
  }

  return {
    helper: helper,
  }
})
