/*
 * dialog.js — Hawkeye's own alert, confirm and prompt.
 *
 * WHY. window.alert / confirm / prompt paint the browser's grey box: "hawkeye.com.ng
 * says", OK/Cancel in the platform's language, no brand, an input nobody can
 * style — and inside Hawkeye Lite, the WebView's chrome. Every dialog the site
 * raises for ITSELF goes through here instead. System prompts (camera, location,
 * notifications), share sheets and file pickers belong to the platform and stay
 * the platform's. tests/no_native_dialogs_test.mjs fails if a bare
 * alert()/confirm()/prompt() comes back.
 *
 * EVERY CALL RETURNS A PROMISE, so a caller that used to block on confirm() now
 * awaits it and still does nothing until the reader has answered:
 *
 *   hkAlert(message, { title, ok })                                  -> undefined
 *   hkConfirm(message, { title, ok, cancel, danger })                 -> true | false
 *   hkPrompt(message, { title, value, placeholder, ok, cancel, code, danger }) -> string | null
 *   hkChoose(message, choices, { title, ok, cancel, detail })         -> { value, text } | null
 *      choices: [{ value, label }]; detail: a label turns on an optional text box.
 *
 * ONE AT A TIME. A second call waits for the first to close, so two refusals can
 * never stack into a dialog the reader cannot see the bottom of.
 *
 * CSP-SAFE: no inline handlers, no style attributes; the look is .hk-alert /
 * .hk-dlg in styles.css, the same card the blocking refusals (menu.js
 * HAWKEYE_ALERT) already use. Text goes in with textContent, never innerHTML.
 *
 * ACCESSIBLE: role=alertdialog (dialog when it holds a form), aria-modal, named
 * and described; Tab stays inside the card; Escape cancels; focus goes back to
 * whatever had it. A destructive confirm opens with focus on Cancel, so the
 * reflex key press is never the destructive one.
 *
 * Its own file, loaded on every page that raises a dialog, because two of them
 * (the admin console and the situation room) never load menu.js.
 */
(function () {
  'use strict';
  if (window.hkDialog) return;

  // Resolved when the dialog OPENS, never at load: i18n.js may not have its
  // bundle yet when this file runs.
  function T(key, english) {
    return window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  var seq = 0;

  function show(o) {
    return new Promise(function (resolve) {
      var id = 'hk-dlg-' + (++seq);
      var before = document.activeElement;
      var box = el('div', 'hk-alert hk-dlg');
      box.setAttribute('data-hk-dialog', o.kind);
      var card = el('div', 'hk-alert-card');
      var form = o.kind === 'prompt' || o.kind === 'choose';
      card.setAttribute('role', form ? 'dialog' : 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      card.tabIndex = -1;

      var msg = el('p', 'hk-dlg-msg', o.message || '');
      msg.id = id + '-m';
      if (o.title) {
        var h = el('h3', 'hk-dlg-title', o.title);
        h.id = id + '-t';
        card.appendChild(h);
        card.setAttribute('aria-labelledby', h.id);
        card.setAttribute('aria-describedby', msg.id);
      } else {
        card.setAttribute('aria-labelledby', msg.id);
      }
      if (o.message) card.appendChild(msg);

      var field = null;
      var radios = [];
      if (o.kind === 'choose') {
        var group = el('div', 'hk-dlg-choices');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-labelledby', msg.id);
        (o.choices || []).forEach(function (c, i) {
          var lab = el('label', 'hk-dlg-choice');
          var r = document.createElement('input');
          r.type = 'radio';
          r.name = id + '-c';
          r.value = String(c.value);
          r.id = id + '-c' + i;
          lab.appendChild(r);
          lab.appendChild(el('span', null, c.label));
          group.appendChild(lab);
          radios.push(r);
        });
        card.appendChild(group);
        if (o.detail) {
          var dl = el('label', 'hk-dlg-label', o.detail);
          dl.htmlFor = id + '-d';
          card.appendChild(dl);
          field = document.createElement('textarea');
          field.id = id + '-d';
          field.className = 'hk-dlg-input';
          field.rows = 3;
          field.maxLength = 500;
          card.appendChild(field);
        }
      } else if (o.kind === 'prompt') {
        field = document.createElement('input');
        field.type = 'text';
        field.id = id + '-i';
        field.className = 'hk-dlg-input';
        field.setAttribute('aria-labelledby', msg.id);
        field.autocomplete = 'off';
        if (o.code) { field.spellcheck = false; field.setAttribute('autocapitalize', 'off'); }
        if (o.placeholder) field.placeholder = o.placeholder;
        field.value = o.value == null ? '' : String(o.value);
        card.appendChild(field);
      }

      var btns = el('div', 'hk-dlg-btns');
      var cancel = null;
      if (o.kind !== 'alert') {
        cancel = el('button', 'secondary hk-dlg-cancel', o.cancel || T('common.cancel', 'Cancel'));
        cancel.type = 'button';
        btns.appendChild(cancel);
      }
      var ok = el('button', 'hk-dlg-ok' + (o.danger ? ' danger' : ''), o.ok || T('common.ok', 'OK'));
      ok.type = 'button';
      btns.appendChild(ok);
      card.appendChild(btns);
      box.appendChild(card);

      // A choice has to be made before OK means anything — the old prompt()
      // answered "Enter a number from 1 to 4" after the fact.
      if (o.kind === 'choose') {
        ok.disabled = true;
        radios.forEach(function (r) { r.addEventListener('change', function () { ok.disabled = false; }); });
      }

      function value(accepted) {
        if (o.kind === 'alert') return undefined;
        if (o.kind === 'confirm') return !!accepted;
        if (!accepted) return null;
        if (o.kind === 'prompt') return field.value;
        var picked = radios.filter(function (r) { return r.checked; })[0];
        return picked ? { value: picked.value, text: field ? field.value : '' } : null;
      }

      var done = false;
      function finish(accepted) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        box.remove();
        if (!document.querySelector('.hk-dlg')) document.documentElement.classList.remove('hk-dlg-open');
        try { if (before && before.isConnected && before.focus) before.focus(); } catch (e) { /* gone */ }
        resolve(value(accepted));
      }

      function focusables() {
        return Array.prototype.filter.call(
          card.querySelectorAll('button, input, textarea'),
          function (n) { return !n.disabled && n.offsetParent !== null; });
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(o.kind === 'alert');
          return;
        }
        if (e.key === 'Enter' && e.target === field && field && field.tagName === 'INPUT') {
          e.preventDefault();
          finish(true);
          return;
        }
        if (e.key !== 'Tab') return;
        var f = focusables();
        if (!f.length) { e.preventDefault(); card.focus(); return; }
        var first = f[0];
        var last = f[f.length - 1];
        var at = document.activeElement;
        if (e.shiftKey && (at === first || !card.contains(at))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (at === last || !card.contains(at))) { e.preventDefault(); first.focus(); }
      }

      ok.addEventListener('click', function () { finish(true); });
      if (cancel) cancel.addEventListener('click', function () { finish(false); });
      // Tapping outside is "no" — never "yes". An alert has only one answer.
      box.addEventListener('click', function (e) { if (e.target === box) finish(o.kind === 'alert'); });
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(box);
      document.documentElement.classList.add('hk-dlg-open');
      var start = field && o.kind === 'prompt' ? field
        : radios.length ? radios[0]
          : o.danger && cancel ? cancel : ok;
      try {
        start.focus();
        if (start === field && field.select) field.select();
      } catch (e) { /* focus is a courtesy */ }
    });
  }

  var chain = Promise.resolve();
  function queue(o) {
    var p = chain.then(function () {
      if (document.body) return show(o);
      return new Promise(function (r) {
        document.addEventListener('DOMContentLoaded', function () { r(show(o)); }, { once: true });
      });
    });
    chain = p.catch(function () { /* one failure never blocks the next */ });
    return p;
  }
  function opts(o) { return o && typeof o === 'object' ? o : {}; }

  window.hkAlert = function (message, o) {
    o = opts(o);
    return queue({ kind: 'alert', message: message, title: o.title, ok: o.ok });
  };
  window.hkConfirm = function (message, o) {
    o = opts(o);
    return queue({ kind: 'confirm', message: message, title: o.title, ok: o.ok, cancel: o.cancel, danger: !!o.danger });
  };
  window.hkPrompt = function (message, o) {
    o = opts(o);
    return queue({ kind: 'prompt', message: message, title: o.title, ok: o.ok, cancel: o.cancel,
      value: o.value, placeholder: o.placeholder, code: !!o.code, danger: !!o.danger });
  };
  window.hkChoose = function (message, choices, o) {
    o = opts(o);
    return queue({ kind: 'choose', message: message, choices: choices, title: o.title, ok: o.ok,
      cancel: o.cancel, detail: o.detail });
  };
  window.hkDialog = { alert: window.hkAlert, confirm: window.hkConfirm, prompt: window.hkPrompt, choose: window.hkChoose };
})();
