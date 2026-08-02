import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useUi } from '@/lib/theme';

/**
 * Support Hawkeye — the founder-funded donation screen (native twin of
 * app/support.html). Crypto only for now; Nigerian and international bank
 * transfers land once the CAC nonprofit registration clears.
 *
 * The six EVM chains the project lists all resolve to ONE address, so they are
 * grouped under a single "Any EVM chain" row rather than repeated six times —
 * showing the same string six times reads as an error, not thoroughness.
 */
type Wallet = { label: string; note?: string; address: string };

const WALLETS: Wallet[] = [
  {
    label: 'Any EVM chain',
    note: 'Ethereum · Base · Polygon · Monad · Robinhood · HyperEVM',
    address: '0x00F7bE0EA4A6dF70afc32d591C53460008d28C11',
  },
  { label: 'Solana', address: 'Ac952LkbEvNAgECtd1n7LWG11M69VbGvUJCmAVkvenQN' },
  { label: 'Bitcoin', address: 'bc1qnksyh8vvzetpjhc6kl9e7dxpa5tkk6pthehxly' },
  { label: 'Sui', address: '0x0b46490cffac31ac4f08683cc1c9ab3b56c9d0e279ab18d5d26f77cdeb138fb3' },
];

const short = (a: string) => `${a.slice(0, 12)}…${a.slice(-8)}`;

export default function Support() {
  const ui = useUi();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (address: string) => {
    await Clipboard.setStringAsync(address);
    setCopied(address);
    setTimeout(() => setCopied((c) => (c === address ? null : c)), 1800);
  };

  return (
    <SafeAreaView className="flex-1 bg-surface" edges={['top']}>
      <View className="flex-row items-center border-b border-line px-4 py-3">
        <Pressable onPress={() => router.back()} hitSlop={10} className="mr-3">
          <Feather name="arrow-left" size={24} color={ui.ink} />
        </Pressable>
        <Text className="text-xl font-bold text-ink">Support Hawkeye</Text>
      </View>

      <ScrollView className="flex-1">
        <View className="gap-4 p-4">
          <View className="gap-2 rounded-2xl border border-line bg-card p-4">
            <Text className="text-lg font-bold text-ink">Keep Hawkeye independent</Text>
            <Text className="leading-6 text-muted">
              Hawkeye is built and paid for by its founder — no political funding, no
              advertisers, no strings attached. If the work is useful to you, a
              donation helps cover the servers, phones and time that keep it running
              and independent.
            </Text>
            <Text className="leading-6 text-muted">
              Crypto is the fastest way to give today. Nigerian and international bank
              transfers will be added once our nonprofit registration clears.
            </Text>
          </View>

          <Text className="mt-1 text-xs font-bold uppercase tracking-widest text-faint">
            Crypto wallets
          </Text>

          {WALLETS.map((w) => (
            <View key={w.label} className="gap-2 rounded-2xl border border-line bg-card p-4">
              <Text className="font-bold text-ink">{w.label}</Text>
              {w.note ? <Text className="text-xs text-muted">{w.note}</Text> : null}
              <View className="mt-1 flex-row items-center justify-between gap-3">
                <Text className="flex-1 font-mono text-xs text-muted" numberOfLines={1}>
                  {short(w.address)}
                </Text>
                <Pressable
                  onPress={() => copy(w.address)}
                  className="flex-row items-center gap-1.5 rounded-full bg-good px-3 py-2"
                >
                  <Feather
                    name={copied === w.address ? 'check' : 'copy'}
                    size={14}
                    color={ui.tint.good.ink}
                  />
                  <Text className="text-xs font-bold text-good-ink">
                    {copied === w.address ? 'Copied' : 'Copy'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ))}

          <Text className="mb-8 mt-2 px-2 text-center text-xs leading-5 text-faint">
            Always confirm the address after pasting. Hawkeye will never message you
            asking for funds or seed phrases.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
