/**
 * OUR OWN WEB PAGES THAT NOW HAVE A NATIVE SCREEN — groups, invites, captains.
 *
 * WHY THIS EXISTS. These pages used to open in an in-app browser tab, and that
 * tab does not share the app's session: it is a separate browser, signed OUT.
 * Every one of them is signed-in only, so the tab landed on the website's
 * sign-in form. Signing in there was worse than annoying — the in-app browser on
 * a phone takes the PHONE session slot (backend services/sessions.js, "one phone
 * and one computer per account"), so it signed THIS APP out, and the observer
 * came back to "you signed in on another device".
 *
 * One table for every way a link reaches the app: a notification url
 * (lib/push.ts), an App Link or hawkeye:// link (app/+native-intent.tsx), and a
 * pasted invite link (app/my-groups.tsx). NO IMPORTS on purpose, so
 * tests/native_no_web_pages_test.mjs can load it as plain JavaScript and prove
 * every live backend url lands on a native screen.
 *
 * The situation room itself stays on the web (owner decision) — but a
 * notification ABOUT a room lands on My Groups, which explains how to open the
 * room on a computer instead of opening a signed-out browser on the phone.
 */

const OUR_HOSTS = new Set(['hawkeye.com.ng', 'www.hawkeye.com.ng']);

/** An invite token: crypto.randomBytes(16).toString('base64url') on the server. */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The path-and-query of a link, when it is one of OURS. `null` for another
 * site. Accepts an absolute https url, a hawkeye:// link (whose "host" is the
 * first path segment), or a bare path.
 */
function ownPath(url: string): string | null {
  const s = String(url || '').trim();
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(s);
  // No scheme: a bare path, or a link pasted without its https://.
  if (!m) return s.replace(/^(?:www\.)?hawkeye\.com\.ng(?=[/?]|$)/i, '').replace(/^\/+/, '');
  const scheme = m[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    if (!OUR_HOSTS.has(m[2].toLowerCase())) return null;
    return m[3].replace(/^\/+/, '');
  }
  // hawkeye://my-groups.html — the app's own scheme; anything else is not ours.
  if (scheme !== 'hawkeye') return null;
  return `${m[2]}${m[3]}`.replace(/^\/+/, '');
}

/**
 * The native route for one of the group/invite/captain web pages, or `null`
 * when the link is not one of them (the caller then does what it did before).
 */
export function webPageRoute(url: string): string | null {
  const own = ownPath(url);
  if (own == null) return null;
  const [pathPart, query = ''] = own.split('#')[0].split('?');
  const file = pathPart.replace(/\/+$/, '').toLowerCase();

  // /join/<token> is already a native route; keep the token's own case.
  const join = /^join\/([^/]+)$/i.exec(pathPart.replace(/\/+$/, ''));
  if (join) return TOKEN.test(join[1]) ? `/join/${join[1]}` : null;
  // join.html?t=<token> — the form the website's sign-in round-trip uses.
  if (file === 'join.html') {
    const t = /(?:^|&)t=([^&]+)/.exec(query)?.[1];
    const tok = t ? decodeURIComponent(t) : '';
    return TOKEN.test(tok) ? `/join/${tok}` : '/my-groups';
  }
  if (file === 'my-groups.html' || file === 'my-groups') return '/my-groups';
  // The room is web-only; a link to it lands where the app explains that.
  if (file === 'situation-room.html' || /^room\/[^/]+$/.test(file)) return '/my-groups';
  if (file === 'captain.html' || file === 'captain') return '/captain';
  // The guide is shown inside the native captain screen, opened.
  if (file === 'captain-guide.html') return '/captain?guide=1';
  return null;
}

/**
 * The token out of whatever someone pasted: the whole invite link, the
 * join.html?t= form, or the bare token. `null` when it is none of those.
 */
export function inviteToken(text: string): string | null {
  const s = String(text || '').trim();
  if (TOKEN.test(s)) return s;
  const route = webPageRoute(s);
  const m = route ? /^\/join\/(.+)$/.exec(route) : null;
  return m ? m[1] : null;
}
