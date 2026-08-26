/**
 * ONE SENTENCE FOR A FAILED LOCATION FIX — shared by every web screen that asks.
 *
 * Three pages ask the browser where the phone is (the report flow's near-me
 * search in app.js, incidents.html, map-unit.html) and all three used to print
 * the same 43-word paragraph: a denial, a diagnosis, and a walkthrough of the
 * address bar, on one status line. Nobody standing at a polling unit reads that.
 * Worse, it was ONE sentence for FOUR different problems, so it told an observer
 * whose GPS simply had not locked yet to go and change a permission they had
 * already granted.
 *
 * This is the web port of native/src/lib/location.ts:describeFixFailure, and it
 * keeps the property that matters there: a TIMEOUT never mentions permission.
 * The commonest caller has already been granted location and is simply indoors.
 *
 * House rules this obeys, from the concise-UI-copy note:
 *   - one sentence per line of UI, and detail goes behind an info affordance
 *   - never surface the provider's own e.message
 * So `line()` is the whole visible string — no parentheses, no bracketed code,
 * no "tap the padlock" tour — and `code()` is the machine tail that belongs in
 * console.warn, where a screenshot of the console still says which branch fired.
 *
 * Contract (other pages are written against it — do not change the shape):
 *   window.HAWKEYE_GEO.line(err) -> one short sentence ending in a full stop
 *   window.HAWKEYE_GEO.code(err) -> 'permission_denied' | 'position_unavailable'
 *                                 | 'gps_timeout' | 'location_error'
 * `err` is a GeolocationPositionError (code 1/2/3) or null/undefined; anything
 * else is treated as the generic branch rather than throwing, because this
 * helper runs on the failure path and must never become the failure.
 */
(function () {
  // GeolocationPositionError.code — spelled out so the switch reads as the spec.
  var PERMISSION_DENIED = 1;
  var POSITION_UNAVAILABLE = 2;
  var TIMEOUT = 3;

  /**
   * Wording notes, branch by branch:
   *
   * 1 PERMISSION_DENIED — the web has no equivalent of native's `canAskAgain`,
   *   so there is no honest way to tell "you tapped Block once" from "your
   *   browser will never ask again". One sentence covers both: say what is
   *   needed, not where the control lives. The address-bar directions differ per
   *   browser anyway, which is why they were wrong as often as they were right.
   * 2 POSITION_UNAVAILABLE — the provider answered and had nothing. Not the
   *   observer's fault and not fixable by them, so the only honest ask is to
   *   wait a moment.
   * 3 TIMEOUT — permission IS granted. Never the words denied, blocked or
   *   allow here: the fix is to move, not to change a setting.
   */
  function reasonOf(err) {
    var code = err && typeof err.code === 'number' ? err.code : 0;
    if (code === PERMISSION_DENIED) return 'denied';
    if (code === POSITION_UNAVAILABLE) return 'unavailable';
    if (code === TIMEOUT) return 'timeout';
    return 'error';
  }

  var LINE = {
    denied: 'Hawkeye needs your location — allow Location for this site and try again.',
    unavailable: 'Your device could not work out where it is — try again in a moment.',
    timeout: 'Could not get a GPS fix — move near a window or step outside and try again.',
    error: 'This device could not report its location just now — try again.',
  };

  var CODE = {
    denied: 'permission_denied',
    unavailable: 'position_unavailable',
    timeout: 'gps_timeout',
    error: 'location_error',
  };

  window.HAWKEYE_GEO = {
    line: function (err) { return LINE[reasonOf(err)]; },
    code: function (err) { return CODE[reasonOf(err)]; },
  };
})();
