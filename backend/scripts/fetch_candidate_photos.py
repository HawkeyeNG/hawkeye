# Candidate portraits from Wikipedia page thumbnails (Wikimedia-hosted, freely
# licensed). Saves app/photos/candidates/<slug>.jpg + manifest.json with source
# page per photo (attribution). Uses the API's thumbnail URL verbatim.
import json, os, urllib.request

D = os.path.expanduser('~/hawkeye/app/photos/candidates')
os.makedirs(D, exist_ok=True)
UA = 'HawkeyeBot/1.0 (https://hawkeye.com.ng; info@hawkeye.com.ng)'
PAGES = {
    'tinubu': 'Bola_Tinubu',
    'atiku': 'Atiku_Abubakar',
    'obi': 'Peter_Obi',
    'jonathan': 'Goodluck_Jonathan',
    'makinde': 'Seyi_Makinde',
    'datti': 'Yusuf_Datti_Baba-Ahmed',
    'adebayo': 'Adewole_Adebayo',
}

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    return urllib.request.urlopen(req, timeout=30).read()

manifest = {}
for slug, page in PAGES.items():
    try:
        s = json.loads(get(f'https://en.wikipedia.org/api/rest_v1/page/summary/{page}'))
        url = (s.get('thumbnail') or {}).get('source')
        if not url:
            print(f'{slug}: NO THUMBNAIL')
            continue
        img = get(url)
        if img[:3] not in (b'\xff\xd8\xff', b'\x89PN'):
            print(f'{slug}: not an image ({len(img)}b)')
            continue
        with open(os.path.join(D, f'{slug}.jpg'), 'wb') as f:
            f.write(img)
        manifest[slug] = {'file': f'photos/candidates/{slug}.jpg',
                          'source': f'https://en.wikipedia.org/wiki/{page}'}
        print(f'{slug}: OK {len(img)}b')
    except Exception as e:
        print(f'{slug}: FAIL {e}')

with open(os.path.join(D, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=1)
print('manifest:', len(manifest))
