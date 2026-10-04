/*
 * follow.js — the Follow control, at either of its two sizes.
 *
 * A subscription row is `(contest, region)` and an empty region means every
 * region, so the backend has always supported both "alert me on this seat" and
 * "alert me on the whole election". Only the second was reachable, and it was
 * labelled as though it were the first: the leaderboard said "Follow" and signed
 * you up for every district in the contest.
 *
 * Those are different things and want different readers. Most people want their
 * own governor or their own senator; wanting all 36 governorships at once is a
 * party office or a newsroom. So the wording now says which one it is, and both
 * are offered where each makes sense — the whole election on a category board
 * (results.html), the single seat on that seat's own page (race.js).
 *
 * Shared by both pages so the two cannot describe the same subscription
 * differently. Native twin: native/src/components/follow-race.tsx.
 */
(function () {
  'use strict';

  /**
   * EVERY WORD THROUGH THE DICTIONARY, AT THE MOMENT IT IS PAINTED (flow
   * walkthrough FA-FOLLOW-5). The button and its messages were English
   * literals, so a Hausa race page showed "🔔 Follow this race" — this file
   * repainted the translated label race.js had just written. This loads in
   * <head>, before i18n.js, so nothing is resolved at load: paint() and say()
   * look words up when they run, and run again on 'hawkeye-lang'.
   * {name} placeholders are filled after the lookup, in one pass.
   */
  function T(k, en, p) {
    var s = String(window.HawkeyeI18n ? window.HawkeyeI18n.t(k, en) : en);
    return p ? s.replace(/\{(\w+)\}/g, function (m, a) { return a in p ? String(p[a]) : m; }) : s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /**
   * How each contest reads in "Follow all ___ races". Short forms on purpose:
   * "House of Representatives" is the contest's formal name and makes a button
   * that wraps to three lines on a phone. The English stays a plain map
   * (tests/follow_scope_test.mjs reads it against native's); each word is
   * looked up under its key when it is painted.
   */
  var CONTEST_PLURAL = {
    GOV: 'governorship',
    SEN: 'Senate',
    REP: 'House of Reps',
    SHA: 'State Assembly',
  };
  var PLURAL_KEY = { GOV: 'follow.plural-gov', SEN: 'follow.plural-sen', REP: 'follow.plural-rep', SHA: 'follow.plural-sha' };

  /**
   * What is being followed, in words. MUST match
   * native/src/components/follow-race.tsx:followSubject.
   *
   * The presidency is one national race, so it has no "all of them" reading: an
   * empty region there IS the single race, not a shortcut for many.
   */
  function followSubject(contest, scope) {
    if (scope) return T('follow.this-race', 'this race');
    if (!contest || contest === 'PRES') return T('follow.this-race', 'this race');
    var w = CONTEST_PLURAL[contest];
    return T('follow.all-races', 'all {v0} races', { v0: w ? T(PLURAL_KEY[contest], w) : contest });
  }

  /** Sign in, then come back to THIS page (authgate.js reads ?next= the same way). */
  function signInHref() {
    var here = (location.pathname.replace(/^\//, '') || 'index.html') + location.search;
    return 'observe.html?intent=signin&next=' + encodeURIComponent(here);
  }

  function token() {
    try {
      return localStorage.getItem('hawkeye_token');
    } catch (e) {
      return null;
    }
  }

  /**
   * Races INEC has declared and Hawkeye has closed — /api/declarations.
   *
   * Fetched ONCE per page load and only when something asks. results.html
   * mounts a control and a race page mounts another, and neither should pay for
   * the other's request — but a race page with no Follow button on it (every
   * finished race) should pay for nobody's.
   *
   * Failing to answer means "nothing is closed". That is the right direction: an
   * offline reader still gets a working Follow button, and the server refuses a
   * closed race anyway (routes/subscriptions.js returns 409) — this list decides
   * what to SHOW, never what is allowed.
   */
  var closedP = null;
  function closedRaces() {
    if (!closedP) {
      closedP = fetch('/api/declarations')
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; });
    }
    return closedP;
  }

  /**
   * Is this race over? Mirrors services/declarations.js:covers — an entry with
   * no scope closes the whole contest, an entry with one closes only that
   * region and leaves a whole-election follow alone.
   */
  function isClosed(list, contest, scope) {
    for (var i = 0; i < (list || []).length; i++) {
      var d = list[i];
      if (d.contest !== contest) continue;
      if (!d.scope || d.scope === scope) return d;
    }
    return null;
  }

  /** This observer's subscriptions, or null when signed out / unreachable. */
  function mySubscriptions() {
    var t = token();
    if (!t) return Promise.resolve(null);
    // D6: native.js's 120 s signed-in cache. Following or unfollowing is a
    // POST/DELETE from this page, which empties it, so the button cannot lag.
    var H = window.HAWKEYE;
    var get = H && H.authGet
      ? H.authGet('/api/observers/me').then(function (x) { return x.status === 200 ? x.body : null; })
      : fetch('/api/observers/me', { headers: { authorization: 'Bearer ' + t } })
        .then(function (r) { return r.ok ? r.json() : null; });
    return get
      .then(function (me) { return (me && me.subscriptions) || null; })
      .catch(function () { return null; });
  }

  /**
   * The row already covering (contest, scope), or null. A whole-election row
   * counts: the backend pings it for every region, so claiming "not following"
   * would be false. Returned as the ROW because DELETE matches on
   * (contest, region) exactly — unfollowing a whole-election row with this
   * seat's region deletes nothing and silently leaves the alerts on.
   */
  function coveredBy(subs, contest, scope) {
    var list = subs || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.contest !== contest) continue;
      if ((s.state || '') === scope || (s.state || '') === '') return s;
    }
    return null;
  }

  /**
   * Wire an existing button (and optional message paragraph) as a Follow toggle.
   *
   * @param o.button   the <button> to drive — its label is written here
   * @param o.message  optional <p> for the outcome / sign-in prompt
   * @param o.contest  contest code
   * @param o.scope    region to follow; '' means every region in the contest
   */
  function mountFollow(o) {
    var btn = o && o.button;
    var msg = (o && o.message) || null;
    var contest = o && o.contest;
    var scope = (o && o.scope) || '';
    if (!btn || !contest) return;

    var followed = null; // the row doing the following, or null
    var busy = false;

    /**
     * A BUTTON IS LABELLED WITH WHAT IT DOES, NOT WITH HOW THINGS ARE.
     *
     * "Following this race" described the state and left the action to be
     * guessed at — a reader looking to stop had no reason to think the thing
     * telling them they were subscribed was also the way out, and the only
     * clue was an aria-pressed nobody sees.
     *
     * So the label is the action: "Unfollow this race" once subscribed. The
     * STATE is not lost — aria-pressed carries it for assistive tech, the bell
     * glyph shows it, and `say()` confirms it right after the click. (The app's
     * control also keeps a standing "Alerts on" line under the label; this one
     * has no room for a second line, which is why the confirmation does that
     * job here.) Twin: native components/follow-race.tsx.
     */
    function paint() {
      var subject = followSubject(contest, scope);
      btn.textContent = followed
        ? '🔕 ' + T('follow.unfollow', 'Unfollow {v0}', { v0: subject })
        : '🔔 ' + T('follow.follow', 'Follow {v0}', { v0: subject });
      btn.setAttribute('aria-pressed', followed ? 'true' : 'false');
      // Once subscribed this is the only control that can undo it, so it stops
      // being a quiet tertiary link and takes the outlined treatment the rest
      // of the row's secondary actions use.
      btn.classList.toggle('btn-following', !!followed);
    }
    /* A message is kept as the FUNCTION that writes it, not as its text, so a
       language change says it again in the new language instead of leaving
       the old one on a repainted page. */
    var saying = null;
    function say(fn) {
      saying = fn || null;
      if (!msg) return;
      var html = saying ? saying() : '';
      msg.innerHTML = html;
      msg.hidden = !html;
    }
    /**
     * "ALERTS ON · HOW THEY REACH YOU" — the one thing the label cannot say
     * (FA-FOLLOW-4). "Unfollow this race" proves you follow it; it does not
     * say where the alerts go, and there are three places (this app's Alerts,
     * this device's notifications, the Telegram channel). Profile lists them
     * (#alerts); this line is the way there, shown for as long as you follow.
     * Native shows the same line under its button (follow-race.tsx).
     */
    function alertsOn() {
      return esc(T('follow.alerts-on', 'Alerts on.')) + ' <a href="profile.html#alerts">'
        + esc(T('follow.how-they-reach-you', 'How they reach you →')) + '</a>';
    }

    paint();
    document.addEventListener('hawkeye-lang', function () { paint(); say(saying); });

    /**
     * A FINISHED RACE IS NOT SOMETHING TO FOLLOW.
     *
     * Once INEC has declared it, nothing more will be reported into it, so the
     * control has nothing to offer and the row it would create is one the server
     * deletes on its next pass. It goes away entirely rather than becoming a
     * disabled button with an explanation: the declared result is already the
     * first thing on the page above it, so there is nothing left to say.
     *
     * IT HIDES ON THE ANSWER, not before it. Starting hidden would blank the
     * button on every open race for as long as the request takes, to spare a
     * flash on the handful that are closed — and the label is already written
     * twice on load anyway, since `mySubscriptions` decides between Follow and
     * Unfollow the same way.
     */
    closedRaces().then(function (list) {
      if (isClosed(list, contest, scope)) {
        btn.hidden = true;
        say(null);
      }
    });

    // Signed out, or the check failed: the button still reads "Follow" and the
    // click path handles both. A page must not wait on this to be usable.
    mySubscriptions().then(function (subs) {
      if (!subs) return;
      followed = coveredBy(subs, contest, scope);
      paint();
      if (followed && !btn.hidden) say(alertsOn);
    });

    btn.addEventListener('click', function () {
      if (busy) return;
      // SIGNED OUT: sign in, and come straight back here (?next=). It said
      // "verify your phone", which is the sign-UP step, to people who already
      // have an account.
      if (!token()) {
        say(function () {
          return esc(T('follow.signed-out', 'To follow a race, sign in first.'))
            + ' <a href="' + esc(signInHref()) + '">' + esc(T('follow.sign-in', 'Sign in →')) + '</a>';
        });
        return;
      }
      busy = true;
      btn.disabled = true;
      var on = !followed;
      var state = followed ? (followed.state || '') : scope;
      fetch('/api/subscriptions', {
        method: on ? 'POST' : 'DELETE',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token() },
        body: JSON.stringify({ contest: contest, state: state }),
      })
        .then(function (r) {
          // The body's `error` code is what tells a dead session (401
          // unknown_observer) from any other refusal — native.js's rule.
          return r.json().catch(function () { return null; })
            .then(function (b) { return { status: r.status, error: b && b.error }; });
        })
        .catch(function () { return { status: 0, error: null }; })
        .then(function (res) {
          var status = res.status;
          busy = false;
          btn.disabled = false;
          /**
           * 409 = the race was declared while this page was open (or the page
           * was served from cache after it closed). The control is obsolete, so
           * it leaves — but SAYS WHY first (FA-FOLLOW-3): a button vanishing
           * under your thumb with no word reads as a fault.
           */
          if (status === 409) {
            btn.hidden = true;
            say(function () { return esc(T('follow.declared', 'This race has been declared — there is nothing more to follow.')); });
            return;
          }
          /**
           * EACH FAILURE SAYS WHAT HAPPENED (FA-FOLLOW-1). Every one of these
           * used to say "make sure your phone is verified" — to signed-in,
           * verified observers whose real problem was a dropped connection or
           * an expired session, neither of which that sentence helps with.
           *   401  the session is over: sign in again, and come back here
           *   else no signal, or our server failed: try again
           */
          if (status === 401) {
            var H = window.HAWKEYE;
            var dead = H && H.authRejected ? H.authRejected(status, res.error) : true;
            if (dead) { try { localStorage.removeItem('hawkeye_token'); } catch (e) { /* signed out either way */ } }
            say(function () {
              return esc(T('follow.session-ended', 'Your session has ended.'))
                + ' <a href="' + esc(signInHref()) + '">' + esc(T('follow.sign-in-again', 'Sign in again →')) + '</a>';
            });
            return;
          }
          if (!(status >= 200 && status < 300)) {
            say(on
              ? function () { return esc(T('follow.could-not-follow', 'Could not follow — check your connection and try again.')); }
              : function () { return esc(T('follow.could-not-unfollow', 'Could not unfollow — check your connection and try again.')); });
            return;
          }
          // The label is the confirmation ("Unfollow this race"); the line under
          // it says where the alerts go (alertsOn above). Unfollowing clears it.
          followed = on ? { contest: contest, state: state } : null;
          paint();
          say(followed ? alertsOn : null);
        });
    });
  }

  window.followSubject = followSubject;
  window.mountFollow = mountFollow;
  /**
   * Is this race declared and closed? Resolves to the declaration, or null.
   *
   * For results.html, which does NOT use mountFollow — the leaderboard has its
   * own Follow button, wired to its own scope picker, and only borrows
   * followSubject from here. That board is where this rule matters most: a race
   * page hides its own CTAs once polling day has passed, but the leaderboard's
   * picker lists every contest in the catalogue, and a by-election stays in the
   * catalogue after it is won. Without this, the day after the Udu by-election
   * the board would still offer to alert you about reports that cannot arrive.
   */
  window.raceIsClosed = function (contest, scope) {
    return closedRaces().then(function (list) { return isClosed(list, contest, scope || ''); });
  };
})();
