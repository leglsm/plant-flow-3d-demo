// Loaded before lib/babylon.js. Some embeds (iframes with a restrictive permissions policy)
// throw on navigator.getGamepads(); the 3D library polls it. Wrap it so it never throws.
(function () {
  try {
    var nav = window.navigator;
    var orig = nav.getGamepads ? nav.getGamepads.bind(nav) : null;
    Object.defineProperty(nav, 'getGamepads', {
      configurable: true,
      value: function () { try { return orig ? orig() : []; } catch (e) { return []; } },
    });
  } catch (e) { /* leave as is */ }
})();
