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
   * How each contest reads in "Follow all ___ races". Short forms on purpose:
   * "House of Representatives" is the contest's formal name and makes a button
   * that wraps to three lines on a phone.
   */
  var CONTEST_PLURAL = {
    GOV: 'governorship',
    SEN: 'Senate',
    REP: 'House of Reps',
    SHA: 'State Assembly',
  };

  /**
   * What is being followed, in words. MUST match
   * native/src/components/follow-race.tsx:followSubject.
   *
   * The presidency is one national race, so it has no "all of them" reading: an
   * empty region there IS the single race, not a shortcut for many.
   */
  function followSubject(contest, scope) {
    if (scope) return 'this race';
    if (!contest || contest === 'PRES') return 'this race';
    return 'all ' + (CONTEST_PLURAL[contest] || contest) + ' races';
  }

  function token() {
    try {
      return localStorage.getItem('hawkeye_token');
    } catch (e) {
      return null;
    }
  }

  /** This observer's subscriptions, or null when signed out / unreachable. */
  function mySubscriptions() {
    var t = token();
    if (!t) return Promise.resolve(null);
    return fetch('/api/observers/me', { headers: { authorization: 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.json() : null; })
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
    var subject = followSubject(contest, scope);

    function paint() {
      btn.textContent = (followed ? '🔔 Following ' : '🔔 Follow ') + subject;
      btn.setAttribute('aria-pressed', followed ? 'true' : 'false');
    }
    function say(html) {
      if (!msg) return;
      msg.innerHTML = html || '';
      msg.hidden = !html;
    }

    paint();
    // Signed out, or the check failed: the button still reads "Follow" and the
    // click path handles both. A page must not wait on this to be usable.
    mySubscriptions().then(function (subs) {
      if (!subs) return;
      followed = coveredBy(subs, contest, scope);
      paint();
    });

    btn.addEventListener('click', function () {
      if (busy) return;
      if (!token()) {
        say('To follow a race, first <a href="observe.html">verify your phone</a>, then return here.');
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
        .then(function (r) { return r && r.ok; })
        .catch(function () { return false; })
        .then(function (ok) {
          busy = false;
          btn.disabled = false;
          if (!ok) {
            say('Could not update following — make sure your phone is verified.');
            return;
          }
          if (on) {
            followed = { contest: contest, state: state };
            say('🔔 Following ' + subject + '. You will be alerted on every new report — Telegram or WhatsApp, your choice, plus the in-app feed.');
          } else {
            followed = null;
            say('Alerts off. You can follow again at any time.');
          }
          paint();
        });
    });
  }

  window.followSubject = followSubject;
  window.mountFollow = mountFollow;
})();
