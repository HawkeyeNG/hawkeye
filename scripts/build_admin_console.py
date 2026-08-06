"""
Assemble app/admin.html from the two consoles that already work.

Built by SCRIPT rather than hand-copied so the source of every block is
unambiguous and a rebuild is cheap while post.html / review.html still exist.
Their scripts are each wrapped in an IIFE: both declare $, hdr, secret and
setStatus at top level, and concatenating them raw would redeclare and throw.
"""
import re, os

APP = '/home/elrio/hawkeye/app'
read = lambda f: open(os.path.join(APP, f), encoding='utf8').read()

def block(html, tag, attrs=''):
    m = re.search(r'<%s%s>(.*?)</%s>' % (tag, attrs, tag), html, re.S)
    return m.group(1) if m else ''

post, review = read('post.html'), read('review.html')

post_style = block(post, 'style')
rev_style = block(review, 'style')
post_main = block(post, 'main', r'[^>]*')
rev_main = block(review, 'main', r'[^>]*')
post_js = re.search(r'<script>\n(.*?)</script>\s*</body>', post, re.S).group(1)
rev_js = re.search(r'<script>\n(.*?)</script>\s*</body>', review, re.S).group(1)

# review's <main> is the login gate + the console. Keep the gate as-is; split
# the console body on its <h1>s into one panel each.
login = re.search(r'(<section id="login".*?</section>)', rev_main, re.S).group(1)
console_inner = re.search(r'<section id="console" hidden>(.*?)</section>', rev_main, re.S).group(1)
parts = re.split(r'(?=<h1)', console_inner)
chunks = [p for p in parts if p.strip()]
lead = ''.join(c for c in chunks if not c.lstrip().startswith('<h1'))
h1s = [c for c in chunks if c.lstrip().startswith('<h1')]
assert len(h1s) == 3, 'expected Reach / Incident review / Label review, got %d' % len(h1s)
reach, incidents, labels = h1s

TABS = [('reach', 'Reach', lead + reach),
        ('incidents', 'Incidents', incidents),
        ('labels', 'Labels', labels),
        ('social', 'Social', post_main)]

nav = ''.join(f'<span class="tab{" on" if i == 0 else ""}" data-p="{k}">{n}</span>'
              for i, (k, n, _) in enumerate(TABS))
panels = ''.join(f'<div class="panel" data-p="{k}"{"" if i == 0 else " hidden"}>{h}</div>'
                 for i, (k, _, h) in enumerate(TABS))

html = f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#00482b" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Hawkeye — Admin Console</title>
  <link rel="icon" type="image/svg+xml" href="logo.svg?v=101" />
  <script>/*hk-theme-init*/(function(){{try{{var t=localStorage.getItem("hawkeye_theme");if(t!=="dark"&&t!=="light"){{t=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark";}}document.documentElement.dataset.theme=t;}}catch(e){{document.documentElement.dataset.theme="dark";}}}})();</script>
  <link rel="stylesheet" href="styles.css?v=141" />
  <script src="native.js?v=104"></script>
  <style>
/* ---- from review.html ---- */
{rev_style}
/* ---- from post.html ---- */
{post_style}
/* ---- unified console ---- */
    .panelbar {{ display: flex; gap: 8px; margin: 4px 0 18px; flex-wrap: wrap; border-bottom: 1px solid var(--line, #e3e8e4); padding-bottom: 10px; }}
    .panel > h1:first-child {{ margin-top: 0; }}
    /* One passphrase for the whole console, so post.html's own passphrase row
       is redundant here — hidden rather than deleted, to keep this file a
       mechanical assembly of the two originals. */
    .panel[data-p="social"] label[for="secret"],
    .panel[data-p="social"] label[for="secret"] + .row {{ display: none; }}
  </style>
  <script src="authgate.js?v=2"></script>
</head>
<body>
  <header class="gov-header">
    <div class="wrap brand-row">
      <span class="brand"><span class="crest" aria-hidden="true">🦅</span>
        <div class="brand-text"><strong>HAWKEYE</strong><span>Admin Console — private</span></div></span>
    </div>
  </header>

  <main class="wrap">
    {login}

    <section id="console" hidden>
      <div class="panelbar" id="panelbar">
        {nav}
        <span class="tab" data-p="_logout" style="margin-left:auto">Lock 🔒</span>
      </div>
      {panels}
    </section>
  </main>

  <script>
  // post.html's script. Wrapped: it declares $, secret, hdr and setStatus at
  // top level, exactly as review.html's does.
  (function () {{
{post_js}
    window.__socialRefresh = typeof refresh === 'function' ? refresh : null;
  }})();
  </script>

  <script>
  // review.html's script, same wrapping for the same reason.
  (function () {{
{rev_js}
  }})();
  </script>

  <script>
  // Panel switching + the one thing the two originals disagreed on: review.html
  // keeps the passphrase in sessionStorage, post.html reads it from
  // localStorage. Mirror it on the way into the Social panel so a single unlock
  // serves both, instead of editing either script's auth.
  (function () {{
    const bar = document.getElementById('panelbar');
    const panels = [...document.querySelectorAll('.panel')];
    bar.addEventListener('click', (e) => {{
      const t = e.target.closest('.tab');
      if (!t) return;
      const key = t.dataset.p;
      if (key === '_logout') return;            // review.html's own handler covers it
      bar.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
      panels.forEach((p) => {{ p.hidden = p.dataset.p !== key; }});
      if (key === 'social') {{
        const s = sessionStorage.getItem('hawkeye_admin');
        if (s) localStorage.setItem('hawkeye_admin', s);
        if (window.__socialRefresh) try {{ window.__socialRefresh(); }} catch {{}}
      }}
    }});
  }})();
  </script>
</body>
</html>
'''

open(os.path.join(APP, 'admin.html'), 'w', encoding='utf8').write(html)
print('wrote admin.html: %d bytes, %d tabs' % (len(html), len(TABS)))
