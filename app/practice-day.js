/**
 * National Practice Days — the home card (index.html #pday-card) and the
 * results page (practice-day.html #pday-page). One file for both, so the two
 * cannot disagree about what a phase means or how a date reads.
 *
 * Everything comes from GET /api/practice-days, which returns aggregates only.
 * The card hides itself when there is no day to talk about, and on any error:
 * a home card that says "could not load" on every offline start is noise. The
 * results page is the place a failure is worth saying out loud.
 *
 * TRANSLATED AT PAINT TIME. Every string goes through tt() when the card is
 * drawn, and the card is redrawn on 'hawkeye-lang' (i18n.js fires it after each
 * bundle loads). Nothing is resolved at load and kept — that is the
 * frozen-at-import bug in another shape. Day and month names are keys too: a
 * phone's Intl cannot be relied on for ha/ig/yo.
 */
(function () {
  'use strict';

  var tt = function (k, en) { return window.HawkeyeI18n ? window.HawkeyeI18n.t(k, en) : en; };
  var fill = function (s, p) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(p, k) ? p[k] : m; });
  };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var num = function (n) { return Number(n || 0).toLocaleString('en-US'); };
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** "Saturday, 12 December" for a WAT calendar date — read from the date
   *  itself, never through the device's zone, which could move it a day. */
  function dateText(date) {
    if (!DATE_RE.test(String(date))) return '';
    var p = date.split('-').map(Number);
    var wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    var days = tt('practiceday.weekdays', 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday').split(',');
    var months = tt('practiceday.months', 'January,February,March,April,May,June,July,August,September,October,November,December').split(',');
    return fill(tt('practiceday.date', '{weekday}, {day} {month}'), { weekday: days[wd] || '', day: p[2], month: months[p[1] - 1] || '' });
  }
  function windowText(day) {
    var w = (day && day.window) || { start: '08:00', end: '18:00' };
    return fill(tt('practiceday.window', '{start}–{end} WAT'), { start: esc(w.start), end: esc(w.end) });
  }

  function countLine(phase, n, date) {
    if (phase === 'live') {
      if (!n) return tt('practiceday.live-none', 'No one has practised yet today. Be the first.');
      if (n === 1) return tt('practiceday.live-count-one', '1 observer has practised today.');
      return fill(tt('practiceday.live-count', '{n} observers have practised today.'), { n: num(n) });
    }
    if (!n) return fill(tt('practiceday.after-none', 'No observers practised on {date}.'), { date: dateText(date) });
    if (n === 1) return fill(tt('practiceday.after-count-one', '1 observer practised on {date}.'), { date: dateText(date) });
    return fill(tt('practiceday.after-count', '{n} observers practised on {date}.'), { n: num(n), date: dateText(date) });
  }

  function load(date) {
    return fetch('/api/practice-days' + (date ? '?day=' + encodeURIComponent(date) : ''), { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 404) return { day: null, days: [] };
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  /* ------------------------------------------------------------ home card -- */
  var card = document.getElementById('pday-card');
  var cardData = null;

  function paintCard() {
    if (!card) return;
    var d = cardData && cardData.day;
    if (!d || !DATE_RE.test(d.date) || ['before', 'live', 'after'].indexOf(d.phase) < 0) { card.hidden = true; return; }
    var n = (cardData.results && cardData.results.participants) || 0;
    var href = 'practice-day.html?day=' + encodeURIComponent(d.date);
    var practise = '<a class="btn-accent pday-go" href="practice.html">' + esc(tt('practiceday.practise-now', 'Practise now')) + '</a>';
    var html;
    if (d.phase === 'before') {
      html = '<h2><span>' + esc(tt('practiceday.title', 'National Practice Day')) + '</span></h2>'
        + '<p class="pday-when">' + esc(dateText(d.date)) + ' · ' + windowText(d) + '</p>'
        + '<p class="pday-line">' + esc(tt('practiceday.before-line', 'Everyone runs the mock election on the same day, and the combined count is shared.')) + '</p>'
        + practise;
    } else if (d.phase === 'live') {
      html = '<h2><span>' + esc(tt('practiceday.live-title', 'It’s Practice Day')) + '</span> <a href="' + href + '">' + esc(tt('practiceday.see-count', 'See the count →')) + '</a></h2>'
        + '<p class="pday-line"><strong class="pday-n">' + esc(countLine('live', n, d.date)) + '</strong></p>'
        + practise;
    } else {
      var next = cardData.next && DATE_RE.test(cardData.next.date)
        ? '<p class="pday-when">' + esc(fill(tt('practiceday.next', 'Next Practice Day: {date}'), { date: dateText(cardData.next.date) })) + '</p>' : '';
      html = '<h2><span>' + esc(tt('practiceday.after-title', 'Practice Day results')) + '</span> <a href="' + href + '">' + esc(tt('practiceday.see-results', 'See the combined count →')) + '</a></h2>'
        + '<p class="pday-line"><strong class="pday-n">' + esc(countLine('after', n, d.date)) + '</strong></p>'
        + next;
    }
    card.innerHTML = html;
    card.dataset.phase = d.phase;
    card.hidden = false;
  }

  if (card && document.documentElement.classList.contains('obs-home')) {
    load(null).then(function (j) { cardData = j; paintCard(); }).catch(function () { card.hidden = true; });
    document.addEventListener('hawkeye-lang', paintCard);
  }

  /* --------------------------------------------------------- results page -- */
  var page = document.getElementById('pday-page');
  var pageData = null;
  var pageErr = false;
  var wanted = (function () {
    try { var q = new URLSearchParams(location.search).get('day'); return q && DATE_RE.test(q) ? q : null; } catch (e) { return null; }
  })();

  function statusLine(d) {
    if (d.phase === 'before') {
      return fill(tt('practiceday.status-before', 'Opens {date}, {window}. The count appears here once it opens.'), { date: esc(dateText(d.date)), window: windowText(d) });
    }
    if (d.phase === 'live') {
      return fill(tt('practiceday.status-live', 'Open now until {end} WAT. The count updates every minute.'), { end: esc((d.window && d.window.end) || '18:00') });
    }
    return fill(tt('practiceday.status-after', 'Closed. Final count for {date}.'), { date: esc(dateText(d.date)) });
  }

  function paintPage() {
    if (!page) return;
    if (pageErr) {
      page.innerHTML = '<p class="pday-error">' + esc(tt('practiceday.load-error', 'Could not load the Practice Day count. Check your connection and try again.')) + '</p>'
        + '<button type="button" class="btn-quiet pday-retry" id="pday-retry">' + esc(tt('practiceday.try-again', 'Try again')) + '</button>';
      var b = document.getElementById('pday-retry');
      if (b) b.addEventListener('click', startPage);
      return;
    }
    if (!pageData) {
      page.innerHTML = '<p class="hint">' + esc(tt('practiceday.loading', 'Loading…')) + '</p>';
      return;
    }
    var d = pageData.day;
    var parts = [];
    if (!d || !DATE_RE.test(d.date)) {
      parts.push('<p class="pday-empty">' + esc(tt('practiceday.none-scheduled', 'No Practice Day is scheduled right now.')) + '</p>');
    } else {
      parts.push('<h2 class="pday-date">' + esc(dateText(d.date)) + '</h2>');
      parts.push('<p class="pday-status">' + statusLine(d) + '</p>');
      var r = pageData.results;
      if (r && d.phase !== 'before') {
        parts.push('<div class="pday-stat"><strong>' + esc(num(r.participants)) + '</strong><span>'
          + esc(r.participants === 1 ? tt('practiceday.observer-practised', 'observer practised') : tt('practiceday.observers-practised', 'observers practised'))
          + '</span></div>');
        var totals = Array.isArray(r.totals) ? r.totals : [];
        var max = totals.reduce(function (m, x) { return Math.max(m, Number(x.votes) || 0); }, 0);
        parts.push('<h3 class="pday-h">' + esc(tt('practiceday.combined-heading', 'Combined mock count')) + '</h3>');
        if (!max) {
          parts.push('<p class="hint">' + esc(tt('practiceday.no-tally', 'No mock counts yet.')) + '</p>');
        } else {
          parts.push('<div class="pday-bars">' + totals.map(function (x) {
            var v = Number(x.votes) || 0;
            var color = /^#[0-9a-f]{3,8}$/i.test(String(x.color || '')) ? x.color : 'var(--link)';
            return '<div class="pday-bar"><span class="pday-party">' + esc(x.party) + '</span>'
              // A party with votes always shows a sliver; a party with none shows nothing.
              + '<span class="pday-track"><span class="pday-fill" style="width:' + (max ? Math.round((v / max) * 100) : 0) + '%;' + (v > 0 ? 'min-width:3px;' : '') + 'background:' + color + '"></span></span>'
              + '<span class="pday-votes">' + esc(num(v)) + '</span></div>';
          }).join('') + '</div>');
          parts.push('<p class="hint">' + esc(tt('practiceday.combined-note', 'Each observer’s latest mock count, added together. Fictional parties only.')) + '</p>');
        }
        parts.push('<p class="hint">' + esc(tt('practiceday.method', 'Counts observers who were signed in on the phone they practised on. Hawkeye team accounts are left out.')) + '</p>');
      }
      if (d.phase !== 'after') {
        parts.push('<div class="race-cta"><a class="btn-accent" href="practice.html">' + esc(tt('practiceday.practise-now', 'Practise now')) + '</a></div>');
      }
    }
    var days = Array.isArray(pageData.days) ? pageData.days.filter(function (x) { return DATE_RE.test(x.date); }) : [];
    if (days.length > 1 || (days.length === 1 && (!d || days[0].date !== d.date))) {
      var label = { before: tt('practiceday.phase-before', 'Upcoming'), live: tt('practiceday.phase-live', 'Open now'), after: tt('practiceday.phase-after', 'Closed') };
      parts.push('<h3 class="pday-h">' + esc(tt('practiceday.all-days', 'Practice Days')) + '</h3><ul class="pday-days">'
        + days.map(function (x) {
          var here = d && x.date === d.date;
          return '<li>' + (here ? '<strong>' : '<a href="practice-day.html?day=' + encodeURIComponent(x.date) + '">')
            + esc(dateText(x.date)) + (here ? '</strong>' : '</a>')
            + ' <span class="hint">· ' + esc(label[x.phase] || '') + '</span></li>';
        }).join('') + '</ul>');
    }
    page.innerHTML = parts.join('');
  }

  var timer = null;
  function startPage() {
    pageErr = false;
    paintPage();
    load(wanted).then(function (j) { pageData = j; pageErr = false; paintPage(); })
      .catch(function () { pageErr = !pageData; paintPage(); })
      .then(function () {
        // Live: refresh on the server's own cache cadence. Nothing else changes.
        clearTimeout(timer);
        if (pageData && pageData.day && pageData.day.phase === 'live') timer = setTimeout(startPage, 60000);
      });
  }

  if (page) {
    startPage();
    document.addEventListener('hawkeye-lang', paintPage);
  }

  window.HawkeyePracticeDay = { dateText: dateText };
})();
