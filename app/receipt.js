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
 */
(function () {
  'use strict';

  var W = 1080, H_MAX = 2200, FOOT = 150;
  var GREEN_950 = '#00251a', GREEN_DARK = '#00482b', GOLD = '#f5b301';
  var INK = '#ffffff', MUTED = '#a9c2b4', FAINT = '#8ba99a';

  function two(n) { return String(n).padStart(2, '0'); }

  /** "19 Sept 2026, 14:32" — local time, because that is when the reader was there. */
  function stamp(ms) {
    var d = new Date(ms);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear()
      + ', ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  /**
   * Everything the card says, as data.
   *
   * `pending` is derived from the ABSENCE of an entry hash rather than passed in
   * as a flag: the hash is the thing that makes a report verifiable, so it is
   * the only honest source for whether this copy can claim to be on the ledger.
   */
  function lines(d) {
    d = d || {};
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
    var votes = (d.votes || []).filter(function (v) { return Number(v.count) > 0; })
      .slice()
      .sort(function (a, b) { return String(a.party).localeCompare(String(b.party)); });
    var total = votes.reduce(function (n, v) { return n + Number(v.count); }, 0);
    var pending = !d.entryHash;
    var where = [d.ward, d.lga, d.state].filter(Boolean).join(' \u00b7 ');
    return {
      practice: practice,
      pending: pending,
      title: practice ? 'Practice run \u2014 not a real result'
        : pending ? 'Saved on your phone' : 'Your copy of this result',
      unit: d.puName || '',
      code: d.puCode || '',
      where: where,
      contest: d.contest || '',
      when: 'Reported ' + stamp(d.at || Date.now()),
      votes: votes,
      total: total,
      /* Short form for the face of the card; the full hash is what verifies, and
         it is printed underneath so a photograph of this card is enough. */
      hashShort: pending ? '' : String(d.entryHash).slice(0, 16),
      hash: pending ? '' : String(d.entryHash),
      /* NO VERIFY LINK ON A PRACTICE CARD. The practice chain is not the public
         ledger and ledger.html cannot show it; a link there would 404 and, far
         worse, imply the rehearsal was published. */
      verify: (pending || practice) ? '' : 'hawkeye.com.ng/ledger.html#' + String(d.entryHash),
      status: practice
        ? 'Practice chain only \u2014 this is a rehearsal and is never counted.'
        : pending
          ? 'Not yet on the public ledger \u2014 it sends when you are back online.'
          : 'Recorded on the public ledger.',
      foot: 'Hawkeye does not declare results \u2014 official results are announced by INEC.',
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
       a column of numbers that does not line up invites being misread. */
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
      x.fillText('Total on this sheet', PAD, y + 8);
      x.textAlign = 'right';
      x.font = '700 32px ui-monospace, SFMono-Regular, Menlo, monospace';
      x.fillStyle = INK; x.fillText(String(L.total), W - PAD, y + 8);
      x.textAlign = 'left';
      y += 60;
    }
    y = boxTop + boxH + 52;

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
        x.fillText('PRACTICE CHAIN ENTRY', PAD, y); y += 36;
        x.fillStyle = FAINT;
        x.font = '400 26px ui-monospace, SFMono-Regular, Menlo, monospace';
        chunk(x, L.hash, W - PAD * 2).forEach(function (ln) { x.fillText(ln, PAD, y); y += 32; });
        y += 10;
      }
    } else if (L.pending) {
      x.fillStyle = 'rgba(245,179,1,0.14)';
      x.roundRect2(PAD - 24, y - 40, W - (PAD - 24) * 2, 96, 16); x.fill();
      x.fillStyle = GOLD;
      x.font = '600 28px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      wrap(x, L.status, W - PAD * 2 - 8).forEach(function (ln) { x.fillText(ln, PAD, y); y += 38; });
      y += 34;
    } else {
      x.fillStyle = MUTED;
      x.font = '600 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      x.fillText('LEDGER ENTRY', PAD, y); y += 42;
      x.fillStyle = GOLD;
      x.font = '700 30px ui-monospace, SFMono-Regular, Menlo, monospace';
      chunk(x, L.hash, W - PAD * 2).forEach(function (ln) { x.fillText(ln, PAD, y); y += 38; });
      y += 14;
      x.fillStyle = FAINT;
      x.font = '400 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      x.fillText('Verify at hawkeye.com.ng/ledger.html', PAD, y);
      y += 44;
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
  function render(data, logo) {
    var L = lines(data);
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

  window.HAWKEYE_RECEIPT = { lines: lines, render: render, loadLogo: loadLogo, W: W };
})();
