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
