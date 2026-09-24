import re

APP = '/home/elrio/hawkeye/app/'
admin = open(APP + 'admin.html', encoding='utf8').read()
post = open(APP + 'post.html', encoding='utf8').read()
review = open(APP + 'review.html', encoding='utf8').read()

ids = lambda h: set(re.findall(r'\bid="([^"]+)"', h))
a, p, r = ids(admin), ids(post), ids(review)

print('admin.html %d bytes' % len(admin))
print('tabs:', re.findall(r'data-p="([a-z_]+)"[^>]*>([^<]*)<', admin)[:5])
missing_p = sorted(p - a)
missing_r = sorted(r - a)
print('post.html ids missing from admin:  ', missing_p or 'none')
print('review.html ids missing from admin:', missing_r or 'none')

# things that must be present for each panel to work
need = ['stats', 'obs-list', 'list', 'lab-list', 'caption', 'media', 'file', 'upload',
        'post', 'result', 'login', 'console', 'panelbar', 'inc-seen']
print('required ids present:', all(n in a for n in need),
      '| absent:', [n for n in need if n not in a] or 'none')

# duplicate ids would break getElementById silently
dup = [i for i in a if admin.count('id="%s"' % i) > 1]
print('duplicate ids:', dup or 'none')

# both scripts wrapped
print('IIFE wrappers:', admin.count('(function () {'))
print('dropdowns carried through: inc-seen=%d seen-wrap=%d doneRows=%d'
      % (admin.count('inc-seen'), admin.count('seen-wrap'), admin.count('doneRows')))

# --- the inline-handler class, and the drift that makes a regenerate unsafe ---
# Comments are stripped first: a fix's own comment tends to quote the code it
# replaced, and a scan of the raw text then finds the explanation and reports
# the bug as still present. Zero is the answer we WANT here, so the check has
# to be able to return non-zero — hence the positive control on a known-bad
# sample. A checker that cannot fail is not a checker.
strip = lambda h: re.sub(r'/\*.*?\*/', '', h, flags=re.S)
pat = re.compile(r'on(?:error|load|click)="[^"]*\$\{')
print('interpolated on*= in real code:', len(pat.findall(strip(admin))), '(want 0)')
print('  control, the pattern DOES fire on a known-bad sample:',
      bool(pat.search("""<button onclick="act(${i.id},'x')">""")))
print('data-act / data-qa buttons:',
      admin.count('data-act="'), '/', admin.count('data-qa="'))
# review.html has no illegible exit — admin.html is AHEAD of its own source, so
# build_admin_console.py would delete this. Fail loudly if it ever goes missing.
print("illegible exit present (a regenerate would DROP it):",
      'data-qa="illegible"' in admin, '| review.html has it:', 'illegible' in review)
