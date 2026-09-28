/**
 * "You were signed out because this account signed in on another device."
 *
 * One device at a time (owner decision D3): the server revokes this device's
 * session when the account signs in elsewhere, and lib/auth.ts records that it
 * happened. The root layout then lands a signed-out observer on /welcome, so the
 * note sits there and on /sign-in — the two screens a displaced observer sees.
 *
 * It also says how many signed reports are still in this phone's outbox: a 401
 * never drops a queued report (outbox.ts defers it), and they send once this
 * device signs in again. Renders nothing unless the flag is set.
 */
import Feather from '@expo/vector-icons/Feather';
import { Text, View } from 'react-native';

import { useSignedOutElsewhere } from '@/lib/auth';
import { authT } from '@/lib/auth-copy';
import { useOutbox } from '@/lib/outbox';
import { useUi } from '@/lib/theme';

export function SignedOutElsewhereNote({ tone = 'card' }: { tone?: 'card' | 'onGreen' }) {
  const ui = useUi();
  const shown = useSignedOutElsewhere();
  const { pending } = useOutbox();
  if (!shown) return null;
  const text = authT('n.auth.signed-out-elsewhere')
    + (pending > 0 ? ' ' + authT('n.auth.signed-out-elsewhere-queued', { n: pending }) : '');
  // On welcome the screen is the fixed brand green, so the scrim is fixed white
  // at low alpha (as welcome's own rows are); elsewhere it is the warn tint.
  const onGreen = tone === 'onGreen';
  return (
    <View
      accessibilityRole="alert"
      className={`mb-4 flex-row items-start rounded-2xl px-4 py-3 ${onGreen ? 'bg-white/15' : 'bg-warn'}`}
    >
      <Feather name="log-out" size={16} color={onGreen ? '#ffffff' : ui.tint.warn.ink} style={{ marginTop: 2 }} />
      <Text className={`flex-1 pl-3 text-sm ${onGreen ? 'text-white' : 'text-warn-ink'}`}>{text}</Text>
    </View>
  );
}
