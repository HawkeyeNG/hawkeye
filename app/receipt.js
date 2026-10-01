/*
 * receipt.js — the observer's own copy of what they just reported.
 *
 * WHY THIS EXISTS. Hawkeye's constraint is not capability, it is how few people
 * stand at a unit with it: Osun drew twelve organic observers against 3,763
 * polling units. Asking someone to file a report is asking them for a favour.
 * Handing them a receipt for the thing they just did is giving them something —
 * a copy of the result at their unit, with the time, the tallies as they entered
 * them, and the ledger entry that proves when it was recorded. The public entry
 * is the by-product.
 *
 * A PICTURE, NOT A PAGE, because of where it goes. This gets forwarded into
 * WhatsApp, where a link needs a network and a login and an image needs neither.
 *
 * THE TEXT IS A FUNCTION, THE DRAWING IS NOT. `lines()` turns a report into the
 * exact strings the card shows and can be asserted directly; `render()` only
 * puts them on a canvas. A rule buried in a paint routine can only be checked by
 * looking at pixels, and then nobody checks it.
 *
 * TWO STATES, and conflating them would be a lie. A report that is QUEUED
 * offline has no entry hash yet, because it has not reached the chain — so its
 * card carries no hash and no verify link, and says so. A card that showed a
 * verify URL before the entry existed would send someone to a 404 and teach them
 * the receipt cannot be trusted.
 *
 * ONE CARD, THREE KINDS OF REPORT (`kind`): a unit RESULT (the default), a
 * COLLATION form and an INCIDENT. Same design, same states, same saving; a
 * label in the top corner says which. Each kind claims only what is true of
 * it — see lines().
 */
(function () {
  'use strict';

  var W = 1080, H_MAX = 2200, FOOT = 150;
  var GREEN_950 = '#00251a', GREEN_DARK = '#00482b', GOLD = '#f5b301';
  var INK = '#ffffff', MUTED = '#a9c2b4', FAINT = '#8ba99a';

  /**
   * THE TRANSLATOR IS INJECTED, not imported.
   *
   * lines() is the twin of native's receiptLines(), and the two clients do not
   * share a translate function - the web has HawkeyeI18n, the app has lib/i18n.
   * Taking `t` as an argument is what lets the rule stay one comparable rule
   * while still speaking Hausa: the parity test hands BOTH sides the same `t`,
   * so a divergence is a real divergence and not a locale artefact.
   *
   * Defaults to the English argument, so a card still renders with no bundle
   * loaded at all - the same contract as T() in app.js.
   */
  function defaultT(key, english) {
    return window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english;
  }

  function two(n) { return String(n).padStart(2, '0'); }

  /** "19 Sept 2026, 14:32" — local time, because that is when the reader was there. */
  /**
   * The month names are TRANSLATED TOO - one comma-separated key rather than
   * twelve, split here. Intl.DateTimeFormat would be the obvious answer and is
   * the wrong one: the app runs on Hermes, whose ICU data is not the browser's,
   * so the same date would render differently on the two clients and the parity
   * test could not tell that apart from a bug.
   */
  function stamp(ms, t) {
    var d = new Date(ms);
    var M = String(t('receipt.months', 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sept,Oct,Nov,Dec')).split(',');
    return d.getDate() + ' ' + (M[d.getMonth()] || '') + ' ' + d.getFullYear()
      + ', ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  /**
   * Everything the card says, as data.
   *
   * `pending` is derived from the ABSENCE of an entry hash rather than passed in
   * as a flag: the hash is the thing that makes a report verifiable, so it is
   * the only honest source for whether this copy can claim to be on the ledger.
   */
  function lines(d, t) {
    d = d || {};
    t = t || defaultT;
    /**
     * WHICH REPORT THIS IS. Unknown = a unit result, the original card, so
     * every existing caller draws exactly what it drew before.
     *
     *  - collation: the same card with the collation AREA as its headline and
     *    the FORM (EC8B/C/D) under it. Its hash is on the collation chain, which
     *    ledger.html does not list — so it carries the hash but NO verify link.
     *  - incident: NOT on any ledger. It is "sent for review" once the server
     *    has given it a reference, "saved on your phone" before. It shows only
     *    what the public incident feed shows once a report is published — the
     *    type, the state, the time — never the description, the media, the
     *    unit or a position: this card gets forwarded before anyone has
     *    reviewed the report. No figures box: there are no figures.
     */
    var kind = d.kind === 'collation' || d.kind === 'incident' ? d.kind : 'result';
    var incident = kind === 'incident';
    /**
     * THREE STATES, NOT TWO.
     *
     * Practice is the reason someone knows what this card is before they ever
     * stand at a unit — so a practice run gets one too, and it has to be
     * unmistakable. It carries the practice chain's own hash (a separate chain
     * with its own genesis, never anchored, never counted) and says so in the
     * words the rest of the product uses: a rehearsal, not a result.
     *
     * Checked FIRST, before the pending branch, because a practice run has an
     * entry hash and would otherwise render as a recorded public result — which
     * is the one thing this card must never do.
     */
    var practice = !!d.practice;
    var votes = incident ? [] : (d.votes || []).filter(function (v) { return Number(v.count) > 0; })
      .slice()
      .sort(function (a, b) {
        return (b.count - a.count) || String(a.party).localeCompare(String(b.party));
      });
    var total = votes.reduce(function (n, v) { return n + Number(v.count); }, 0);
    /* An incident is never on a chain: what it can be is SENT (the server gave
       it a reference) or not yet. Everything else is pending until it has an
       entry hash, exactly as before. */
    var pending = incident ? !d.reference : !d.entryHash;
    var hash = (pending || incident) ? '' : String(d.entryHash);
    /* The incident's TYPE is its headline, in place of a unit; the only place
       the public feed ever names is the state, so that is all `where` may say
       (the server derives it from an attached unit; a caller without it passes
       none). No race line, and no figures. */
    var where = incident ? (d.state || '') : [d.ward, d.lga, d.state].filter(Boolean).join(' \u00b7 ');
    var unit = kind === 'collation' ? (d.area || '') : incident ? (d.incident || '') : (d.puName || '');
    var contest = incident ? '' : (d.contest || '');
    return {
      practice: practice,
      pending: pending,
      title: practice ? t('receipt.title-practice', 'Practice run \u2014 not a real result')
        : pending ? t('receipt.title-pending', 'Saved on your phone')
          : incident ? t('receipt.title-report', 'Your copy of this report')
            : t('receipt.title-recorded', 'Your copy of this result'),
      unit: unit,
      code: kind === 'collation' ? (d.form || '') : incident ? '' : (d.puCode || ''),
      where: where,
      contest: contest,
      when: t('receipt.reported', 'Reported {v0}').replace('{v0}', stamp(d.at || Date.now(), t)),
      votes: votes,
      total: total,
      /* Short form for the face of the card; the full hash is what verifies, and
         it is printed underneath so a photograph of this card is enough. */
      hashShort: hash.slice(0, 16),
      hash: hash,
      /* NO VERIFY LINK ON A PRACTICE CARD. The practice chain is not the public
         ledger and ledger.html cannot show it; a link there would 404 and, far
         worse, imply the rehearsal was published. The same for a collation
         (its own chain, not listed there) and an incident (no chain at all). */
      verify: (pending || practice || kind !== 'result') ? '' : 'hawkeye.com.ng/ledger.html#' + hash,
      status: practice
        ? t('receipt.status-practice', 'Practice chain only \u2014 this is a rehearsal and is never counted.')
        : incident
          ? (pending
            ? t('receipt.status-incident-pending', 'Not sent yet \u2014 it sends when you are back online.')
            : t('receipt.status-review', 'Sent for review \u2014 a person checks every report before anything is published.'))
          : pending
            ? t('receipt.status-pending', 'Not yet on the public ledger \u2014 it sends when you are back online.')
            : t('receipt.status-recorded', 'Recorded on the public ledger.'),
      foot: incident
        ? t('receipt.foot-incident', 'Hawkeye publishes an incident only after a person has reviewed it.')
        : t('receipt.foot', 'Hawkeye does not declare results \u2014 official results are announced by INEC.'),
      /* THE RENDERER'S OWN LABELS LIVE HERE TOO. They used to be typed
         straight into the paint calls, which put them outside everything
         that compares or translates the card - the one place a string is
         guaranteed to be forgotten. */
      totalLabel: t('receipt.total-on-this-sheet', 'Total on this sheet'),
      hashLabel: practice
        ? t('receipt.practice-chain-entry', 'PRACTICE CHAIN ENTRY')
        : kind === 'collation'
          ? t('receipt.collation-ledger-entry', 'COLLATION LEDGER ENTRY')
          : t('receipt.ledger-entry', 'LEDGER ENTRY'),
      verifyLabel: t('receipt.verify-at', 'Verify at hawkeye.com.ng/ledger.html'),
      kind: kind,
      /* The one thing that differs on the face of the card: which report it is.
         None on a unit result, which keeps the card it always was. */
      label: kind === 'collation' ? t('receipt.kind-collation', 'Collation')
        : incident ? t('receipt.kind-incident', 'Incident') : '',
      /* No figures box on an incident: it has none to show. */
      figures: !incident,
    };
  }

  function roundRect(x, y, w, h, r) {
    var c = this;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** Wrap `text` to `max` px, returning the lines. */
  function wrap(c, text, max) {
    var words = String(text).split(/\s+/), out = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var t = line ? line + ' ' + words[i] : words[i];
      if (c.measureText(t).width > max && line) { out.push(line); line = words[i]; }
      else line = t;
    }
    if (line) out.push(line);
    return out;
  }

  /** Break a long hash to fit, on character boundaries — it has no spaces. */
  function chunk(c, s, max) {
    var out = [], line = '';
    for (var i = 0; i < s.length; i++) {
      if (c.measureText(line + s[i]).width > max && line) { out.push(line); line = ''; }
      line += s[i];
    }
    if (line) out.push(line);
    return out;
  }

  function paint(x, L, logo, H) {
    x.roundRect2 = roundRect;

    var g = x.createLinearGradient(0, 0, W * 0.4, H);
    g.addColorStop(0, GREEN_950); g.addColorStop(1, GREEN_DARK);
    x.fillStyle = g; x.fillRect(0, 0, W, H);

    var PAD = 84, y = 96;

    if (logo) { try { x.drawImage(logo, PAD, y, 84, 84); } catch (e) { /* no logo, no problem */ } }
    x.fillStyle = INK;
    x.font = '700 46px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    x.textBaseline = 'alphabetic';
    x.fillText('Hawkeye', PAD + (logo ? 104 : 0), y + 56);
    /* WHICH REPORT, top right on the wordmark's baseline: COLLATION or
       INCIDENT. A unit result has no label and draws as it always has. */
    if (L.label) {
      x.fillStyle = GOLD;
      x.font = '700 30px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      x.textAlign = 'right';
      x.fillText(L.label.toUpperCase(), W - PAD, y + 56);
      x.textAlign = 'left';
    }
    y += 84 + 64;

    x.fillStyle = GOLD;
    x.font = '700 30px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    x.fillText(L.title.toUpperCase(), PAD, y);
    y += 62;

    x.fillStyle = INK;
    x.font = '700 58px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    wrap(x, L.unit, W - PAD * 2).slice(0, 2).forEach(function (ln) { x.fillText(ln, PAD, y); y += 68; });

    x.fillStyle = MUTED;
    x.font = '400 32px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    if (L.code) { x.fillText(L.code, PAD, y); y += 44; }
    if (L.where) { wrap(x, L.where, W - PAD * 2).forEach(function (ln) { x.fillText(ln, PAD, y); y += 44; }); }
    y += 18;

    x.fillStyle = INK;
    x.font = '600 36px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    wrap(x, L.contest, W - PAD * 2).forEach(function (ln) { x.fillText(ln, PAD, y); y += 48; });
    x.fillStyle = FAINT;
    x.font = '400 30px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    x.fillText(L.when, PAD, y);
    y += 56;

    /* THE TALLIES, as they were entered. Right-aligned so the digits line up —
       a column of numbers that does not line up invites being misread. An
       incident has no figures, so no box: straight on to its status band. */
    if (L.figures) y = paintFigures(x, L, PAD, y);
    else y += 52;
    return paintTail(x, L, PAD, y);
  }

  function paintFigures(x, L, PAD, y) {
    var boxTop = y;
    var rowH = 58;
    var boxH = 30 + L.votes.length * rowH + (L.votes.length ? 60 : 0);
    x.fillStyle = 'rgba(255,255,255,0.05)';
    x.roundRect2(PAD - 24, boxTop - 12, W - (PAD - 24) * 2, boxH, 20); x.fill();
    y += 34;
    L.votes.forEach(function (v) {
      x.fillStyle = INK;
      x.font = '600 34px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      x.textAlign = 'left'; x.fillText(v.party, PAD, y);
      x.textAlign = 'right';
      x.font = '700 34px ui-monospace, SFMono-Regular, Menlo, monospace';
      x.fillText(String(v.count), W - PAD, y);
      x.textAlign = 'left';
      y += rowH;
    });
    if (L.votes.length) {
      x.strokeStyle = 'rgba(255,255,255,0.16)'; x.lineWidth = 2;
      x.beginPath(); x.moveTo(PAD, y - 34); x.lineTo(W - PAD, y - 34); x.stroke();
      x.fillStyle = MUTED;
      x.font = '600 30px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      x.fillText(L.totalLabel, PAD, y + 8);
      x.textAlign = 'right';
      x.font = '700 32px ui-monospace, SFMono-Regular, Menlo, monospace';
      x.fillStyle = INK; x.fillText(String(L.total), W - PAD, y + 8);
      x.textAlign = 'left';
      y += 60;
    }
    return boxTop + boxH + 52;
  }

  function paintTail(x, L, PAD, y) {
    /* THE LEDGER LINE — or its absence, said out loud. */
    if (L.practice) {
      /* SAID TWICE, because this is the card most likely to be forwarded out of
         context: once in the title at the top, once in a band of its own. */
      x.fillStyle = 'rgba(245,179,1,0.14)';
      x.roundRect2(PAD - 24, y - 40, W - (PAD - 24) * 2, 96, 16); x.fill();
      x.fillStyle = GOLD;
      x.font = '600 28px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      wrap(x, L.status, W - PAD * 2 - 8).forEach(function (ln) { x.fillText(ln, PAD, y); y += 38; });
      y += 34;
      if (L.hash) {
        x.fillStyle = MUTED;
        x.font = '600 24px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        x.fillText(L.hashLabel, PAD, y); y += 36;
        x.fillStyle = FAINT;
        x.font = '400 26px ui-monospace, SFMono-Regular, Menlo, monospace';
        chunk(x, L.hash, W - PAD * 2).forEach(function (ln) { x.fillText(ln, PAD, y); y += 32; });
        y += 10;
      }
    } else if (L.pending || !L.hash) {
      /* Waiting to send — or, for an incident, sent for review: no hash to
         show either way, so the status gets the band. */
      x.fillStyle = 'rgba(245,179,1,0.14)';
      x.roundRect2(PAD - 24, y - 40, W - (PAD - 24) * 2, 96, 16); x.fill();
      x.fillStyle = GOLD;
      x.font = '600 28px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      wrap(x, L.status, W - PAD * 2 - 8).forEach(function (ln) { x.fillText(ln, PAD, y); y += 38; });
      y += 34;
    } else {
      x.fillStyle = MUTED;
      x.font = '600 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      x.fillText(L.hashLabel, PAD, y); y += 42;
      x.fillStyle = GOLD;
      x.font = '700 30px ui-monospace, SFMono-Regular, Menlo, monospace';
      chunk(x, L.hash, W - PAD * 2).forEach(function (ln) { x.fillText(ln, PAD, y); y += 38; });
      y += 14;
      /* Only where there IS a page that shows this entry (a unit result). */
      if (L.verify) {
        x.fillStyle = FAINT;
        x.font = '400 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        x.fillText(L.verifyLabel, PAD, y);
        y += 44;
      }
    }

    /* The disclaimer sits under the content, not pinned to a far-away bottom
       edge: the card is cut to fit, so there is no bottom to pin it to. */
    y += 30;
    x.fillStyle = FAINT;
    x.font = '400 25px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    wrap(x, L.foot, W - PAD * 2).forEach(function (ln) { x.fillText(ln, PAD, y); y += 34; });

    return y;
  }

  /**
   * MEASURE, THEN DRAW. A fixed height left a third of the card empty on a
   * short report and would have clipped a long one — and which it did depended
   * on how many parties polled above zero, which is not something a canvas
   * height can be guessed from. The paint runs once on a scratch surface to
   * find where it ends, then again on a canvas cut to that.
   */
  function render(data, logo, t) {
    var L = lines(data, t);
    var scratch = document.createElement('canvas');
    scratch.width = W; scratch.height = H_MAX;
    var end = paint(scratch.getContext('2d'), L, logo, H_MAX);

    var c = document.createElement('canvas');
    c.width = W;
    c.height = Math.min(H_MAX, Math.round(end + FOOT * 0.4));
    paint(c.getContext('2d'), L, logo, c.height);
    return c;
  }

  /** The logo, if it loads. Never blocks the card — a receipt without a crest
   *  is still a receipt, and this runs right after a submission. */
  function loadLogo() {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { res(null); };
      img.src = '/logo.svg';
      setTimeout(function () { res(img.complete ? img : null); }, 1200);
    });
  }

  /**
   * DRAW IT, SHOW IT, KEEP IT — what every page that hands an observer a card
   * does: observe.html (app.js), collation.html and incidents.html.
   * `els` = { wrap, img, note, tag }: the hidden wrapper to reveal, the <img>,
   * the line under it, and the save-media tag. Practice keeps its own glue
   * (practice.js), because what it says about saving is practice-specific.
   *
   * IT SAVES WITH THE PHOTOS, at the same hand-off and under the same Profile
   * switch; when copies are off nothing is written and the card stays on
   * screen to be screenshotted. The note says which happened either way,
   * because a save that silently does nothing looks like a broken feature.
   *
   * NEVER THROWS: a report is not worth failing over a picture of itself.
   * Resolves to the PNG blob, or null.
   */
  async function show(data, els, t) {
    try {
      t = t || defaultT;
      var canvas = render(data, await loadLogo(), t);
      var blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
      if (!blob) return null;
      els.img.src = URL.createObjectURL(blob);
      els.img.alt = lines(data, t).title;
      els.wrap.hidden = false;
      var on = (function () { try { return localStorage.getItem('hawkeye_save_media') !== '0'; } catch (e) { return true; } })();
      if (on && window.HAWKEYE_SAVE_MEDIA) window.HAWKEYE_SAVE_MEDIA([{ blob: blob, kind: 'photo' }], els.tag || 'receipt');
      if (els.note) {
        els.note.textContent = on
          ? t('observe.card-saved-with-photos', 'Saved to your phone with your report photos.')
          : t('observe.copies-off-note', 'Copies to this phone are turned off in My Profile. Screenshot this card if you want to keep it.');
      }
      return blob;
    } catch (e) {
      return null;
    }
  }

  window.HAWKEYE_RECEIPT = { lines: lines, render: render, loadLogo: loadLogo, show: show, W: W };
})();
