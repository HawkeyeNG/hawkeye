/**
 * Copy and code parsing for the one-phone-one-computer sign-out (D3) and the
 * sign-up form's ONE code field (invite or organisation code, D4).
 *
 * The translations live in scripts/i18n/batches/auth_native.json and reach the
 * bundles when that batch is merged. Until then `t()` hands back the KEY for a
 * string it has never seen, which would put "n.auth.code-label" on the sign-up
 * form — so these go through authT(), which falls back to the English below.
 * Keep the English here identical to the batch file's `en`.
 */
import { t } from '@/lib/i18n';
import { typedInviteCode } from '@/lib/invite-parse';

const EN: Record<string, string> = {
  'n.auth.signed-out-elsewhere': 'You were signed out because this account signed in on another device.',
  'n.auth.signed-out-elsewhere-queued': 'Signed reports waiting on this phone: {n}. Sign in again here to send them.',
  'n.auth.code-label': 'Invite or organisation code (optional)',
  'n.auth.code-hint': "A friend's invite code, or an ORG- code from your party or civic group.",
  'n.auth.code-kind-invite': 'Invite from a friend.',
  'n.auth.code-kind-org': 'Organisation code: no one-time code will be sent.',
  'n.auth.code-invalid': "Not a code we recognise. A friend's invite has 6 letters and numbers; an organisation code looks like ORG-ABCD-EFGH-JKMN.",
  'n.auth.org-create-account': 'Create account',
  'n.auth.org-confirm-title': 'Is this your number?',
  'n.auth.org-confirm-body': 'This code will be tied to {phone} for good.',
  'n.auth.org-confirm-yes': 'Yes, create my account',
  'n.auth.org-confirm-no': 'Change number',
  'n.auth.org-code-unknown': 'That organisation code is not valid. Check it with your organisation, or leave the box empty to sign up with a one-time code.',
  'n.auth.org-code-used': 'This organisation code has already been used. Ask your organisation for another one, or sign up with a one-time code.',
  'n.auth.org-code-revoked': 'This organisation code has been withdrawn. Ask your organisation for another one, or sign up with a one-time code.',
  'n.auth.org-code-number-taken': 'An organisation code can only create a new account, and this code is now used up. If this number already has an account, sign in with a one-time code. If you deleted your account, signing in that way restores it.',
  'n.auth.org-code-too-many': 'Too many attempts from this network. Wait an hour and try again.',
};

export function authT(key: keyof typeof EN | string, params?: Record<string, string | number>): string {
  const s = t(key, params);
  if (s !== key) return s;
  const en = EN[key] ?? key;
  return en.replace(/\{(\w+)\}/g, (m, name: string) => (params && name in params ? String(params[name]) : m));
}

/** Server error code → the line the sign-up form shows. */
export const ORG_ERROR_KEYS: Record<string, string> = {
  org_code_invalid: 'n.auth.org-code-unknown',
  code_is_invite: 'n.auth.code-invalid',
  org_code_used: 'n.auth.org-code-used',
  org_code_revoked: 'n.auth.org-code-revoked',
  org_code_number_taken: 'n.auth.org-code-number-taken',
  too_many_requests: 'n.auth.org-code-too-many',
};

const squash = (raw: string) => String(raw || '').toUpperCase().replace(/[\s-]+/g, '');

/** Starts with the ORG prefix — the reader means an organisation code, finished or not. */
export const looksLikeOrgCode = (raw: string) => squash(raw).startsWith('ORG');

/**
 * 'ORG-XXXX-XXXX-XXXX' for a well-formed organisation code, '' for nothing
 * typed, null otherwise. Twin of app/app.js typedOrgCode().
 */
export function typedOrgCode(raw: string): string | null {
  const c = squash(raw);
  if (!c) return '';
  const m = /^ORG([2-9A-HJKMNP-TV-Z]{12})$/.exec(c);
  return m ? `ORG-${m[1].match(/.{4}/g)!.join('-')}` : null;
}

/**
 * Which kind the ONE code field holds: '' (empty), 'invite', 'org', or null
 * (neither). The ORG prefix decides — no invite can start "ORG", its alphabet
 * has no O. Twin of app/app.js codeKind().
 */
export function codeKind(raw: string): '' | 'invite' | 'org' | null {
  const c = squash(raw);
  if (!c) return '';
  if (c.startsWith('ORG')) return typedOrgCode(raw) ? 'org' : null;
  return typedInviteCode(raw) ? 'invite' : null;
}
