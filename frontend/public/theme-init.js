/* Applies the persisted (or OS-preferred) theme before first paint. Kept as an external file so the CSP can stay free of inline scripts. */
(function () {
  var theme = 'dark';
  try {
    var stored = window.localStorage.getItem('seatrace.settings');
    var parsed = stored ? JSON.parse(stored) : null;
    var pref = parsed && parsed.state ? parsed.state.theme : null;
    if (pref === 'light' || pref === 'dark') {
      theme = pref;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
  } catch (e) {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
