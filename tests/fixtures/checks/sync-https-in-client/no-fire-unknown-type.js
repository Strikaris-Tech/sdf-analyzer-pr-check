define(['N/https'], function (https) {
  function fetchHealth() {
    return https.get({ url: 'https://api.example.com/health' });
  }
  return { fetchHealth: fetchHealth };
});
