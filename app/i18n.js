/**
 * Language for the web app.
 *
 * WHY NO LIBRARY. i18next is 14.8 kB gzip and brings a plural engine this shell
 * does not need — the browser already has Intl.PluralRules for the handful of
 * counted strings. What follows is the whole runtime: a dictionary fetch, a
 * lookup with an English fallback, and a DOM pass.
 *
 * WHY ENGLISH IS THE FALLBACK AND NOT A KEY. A missing key renders the English
 * string, never `profile.language` and never an empty element. A half-translated
 * page is usable; a page of raw keys is not, and on election day an observer
 * cannot wait for a fix.
 *
 * TRANSLATION STATUS IS PART OF THE DATA. Every bundle carries `_meta.review`,
 * and anything not "human" is shown as a draft in the picker. An election
 * platform should not quietly present machine output as if a person had checked
 * it — see the note in i18n/README.md.
 */
(function () {
  'use strict';

  var KEY = 'hawkeye_lang';

  /* Offered languages. A language appears here only when a bundle exists for
     it; listing one we cannot serve produces an empty page in that language,
     which is worse than not offering it. */
  var LANGS = [
    { code: 'en', name: 'English', native: 'English' },
    { code: 'ha', name: 'Hausa', native: 'Hausa' },
    { code: 'ig', name: 'Igbo', native: 'Asụsụ Igbo' },
    { code: 'yo', name: 'Yoruba', native: 'Èdè Yorùbá' },
  ];

  /* Not offered yet, shown so the choice is visibly coming rather than absent.
     Pidgin has no usable machine translation and has to be written by a person;
     BBC News Pidgin's orthography is the one to follow when it is. */
  var PENDING = [
    { code: 'pcm', name: 'Nigerian Pidgin', native: 'Naija' },
  ];

  var dict = {};
  var meta = {};
  var current = 'en';

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  /** The language to use before anyone has chosen: the browser's, if we have it. */
  function preferred() {
    var saved = stored();
    if (saved && has(saved)) return saved;
    var nav = (navigator.languages || [navigator.language || 'en']);
    for (var i = 0; i < nav.length; i++) {
      var code = String(nav[i] || '').toLowerCase().split('-')[0];
      if (has(code)) return code;
    }
    return 'en';
  }

  function has(code) {
    return LANGS.some(function (l) { return l.code === code; });
  }

  /**
   * Look up a key; fall back to the English text baked into the page.
   *
   * `null` AND `undefined` ARE DIFFERENT ANSWERS HERE. `t(k, null)` means "give
   * me the translation or nothing, I have the English already" — apply() relies
   * on it to leave the markup alone. `t(k)` with no second argument returns the
   * key, which is only useful to a caller debugging a lookup.
   *
   * This read `fallback == null`, which is true for BOTH, so an untranslated
   * key overwrote the page's English with the key itself. It surfaced the day
   * the first deliberately-untranslated string appeared — the INEC disclaimer,
   * which is kept in English on purpose — and printed
   * "index.not-affiliated-with-inec-or-any" where the disclaimer should be.
   */
  function t(key, fallback) {
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    return fallback === undefined ? key : fallback;
  }

  /**
   * Apply the dictionary to a subtree.
   *
   *   <span data-i18n="profile.language">Language</span>
   *   <input data-i18n-attr="placeholder:search.hint" placeholder="Search">
   *
   * The English text stays in the HTML as the fallback, so a page renders
   * correctly with this script absent, blocked, or still loading.
   */
  /* The English that was in the markup, remembered the first time we overwrite
     an element. Without this, "the English is the fallback" holds only until
     the first translation lands: switching BACK to English, or to a language
     whose bundle is missing that key, would leave the previous language's words
     on the page — the markup fallback having been overwritten and lost. */
  var original = new WeakMap();

  function remember(el, kind, name, value) {
    var slot = original.get(el);
    if (!slot) { slot = {}; original.set(el, slot); }
    var id = kind + ':' + name;
    if (!(id in slot)) slot[id] = value;
    return slot[id];
  }

  /**
   * SENTENCES THAT CONTAIN MARKUP.
   *
   * data-i18n sets textContent, which DELETES every child element. That is
   * correct for a leaf, and destructive for the thing English prose does all the
   * time: `<li>Tap <strong>Install app</strong> to confirm.</li>`. Keying the
   * <li> would drop the <strong>; keying only the <strong> — which is what the
   * extractor did — translates two words and leaves the sentence around them in
   * English, which reads worse than leaving the whole line alone.
   *
   * Splitting the bare runs into their own <span>s does not fix it either: word
   * order is not a translation invariant, and "Tap X to confirm" does not
   * survive being reassembled from fragments pinned in English order.
   *
   * So a sentence carrying inline markup is ONE string, and the markup travels
   * inside it. The value is written as innerHTML.
   *
   * WHY innerHTML IS SAFE HERE, and only here: these strings come from
   * app/i18n/<lang>.json — static first-party files we ship, in the same trust
   * bucket as the markup they replace. Nothing a user or a server sends ever
   * reaches this path. If a bundle ever becomes user-supplied, this branch is
   * the one that has to go.
   *
   * A data-i18n-html subtree must contain NO nested data-i18n: replacing the
   * innerHTML builds fresh elements, and a later pass would then record the
   * TRANSLATED text as their English and make the switch back impossible.
   * scripts/i18n/i18n_check.mjs enforces this.
   */
  function apply(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var k = el.getAttribute('data-i18n-html');
      var english = remember(el, 'html', k, el.innerHTML);
      var v = t(k, english);
      if (v !== el.innerHTML) el.innerHTML = v;
    });
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      var k = el.getAttribute('data-i18n');
      var english = remember(el, 'text', k, el.textContent);
      var v = t(k, english);
      if (v !== el.textContent) el.textContent = v;
    });
    scope.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(',').forEach(function (pair) {
        var bits = pair.split(':');
        if (bits.length !== 2) return;
        var attr = bits[0].trim();
        var english = remember(el, 'attr', attr, el.getAttribute(attr));
        var v = t(bits[1].trim(), english);
        if (v != null) el.setAttribute(attr, v);
      });
    });
    document.documentElement.lang = current;
  }

  /**
   * ANNOUNCED ON EVERY LOAD, not only on an explicit change.
   *
   * `apply()` reaches anything carrying data-i18n, but not text a script paints
   * itself — and the first-run tour paints its first card from menu.js, which
   * runs before this fetch resolves. It called t(), got the English fallback,
   * and card one stayed in English while cards two to five came out translated.
   * The event fires after the dictionary is in place so those consumers can
   * repaint; the listeners are all idempotent.
   *
   * Not dispatched from apply(): menu.js listens for this and calls apply(),
   * which would then dispatch again, forever.
   */
  function announce() {
    document.dispatchEvent(new CustomEvent('hawkeye-lang', { detail: { lang: current } }));
  }

  /** Fetch a bundle and apply it. English needs no fetch: it is the markup. */
  function load(code) {
    current = has(code) ? code : 'en';
    if (current === 'en') {
      dict = {}; meta = { review: 'source' };
      apply();
      announce();
      return Promise.resolve();
    }
    return fetch('/i18n/' + current + '.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
      .then(function (json) {
        meta = json._meta || {};
        delete json._meta;
        dict = json;
        apply();
        announce();
      })
      .catch(function () {
        /* A missing or broken bundle must not blank the page — stay on the
           English already in the markup and leave the stored choice alone so a
           later load can succeed. */
        dict = {};
        apply();
        announce();
      });
  }

  /**
   * Review status of every bundle, for the picker's badges.
   *
   * FETCHED, NOT HARDCODED. A table in this file would be a second place to
   * remember when a reviewer signs off, and the one that quietly goes stale —
   * the app would keep calling a reviewed translation a draft, or worse, stop
   * calling a draft a draft. The bundle carries its own status; ask it.
   * Lazily, on first use: the picker is rarely opened and the service worker
   * has these files anyway.
   */
  var statusCache = null;
  function statuses() {
    if (statusCache) return statusCache;
    statusCache = Promise.all(LANGS.filter(function (l) { return l.code !== 'en'; })
      .map(function (l) {
        return fetch('/i18n/' + l.code + '.json', { cache: 'no-cache' })
          .then(function (r) { return r.ok ? r.json() : {}; })
          .then(function (j) { return [l.code, (j._meta || {}).review || 'unknown']; })
          .catch(function () { return [l.code, 'unknown']; });
      })).then(function (pairs) {
        var out = { en: 'source' };
        pairs.forEach(function (p) { out[p[0]] = p[1]; });
        return out;
      });
    return statusCache;
  }

  function set(code) {
    try { localStorage.setItem(KEY, code); } catch (e) { /* private mode */ }
    return load(code);   // load() announces
  }

  window.HawkeyeI18n = {
    LANGS: LANGS,
    PENDING: PENDING,
    t: t,
    apply: apply,
    set: set,
    statuses: statuses,
    get current() { return current; },
    get review() { return meta.review || 'unknown'; },
    /** True once the user has made an explicit choice. */
    get chosen() { return !!stored(); },
    name: function (code) {
      var all = LANGS.concat(PENDING);
      for (var i = 0; i < all.length; i++) if (all[i].code === code) return all[i].name;
      return code;
    },
  };

  load(preferred());
})();
