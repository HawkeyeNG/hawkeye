import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useUi } from '@/lib/theme';

/**
 * Support Hawkeye — the founder-funded donation screen (native twin of
 * app/support.html). Crypto only for now; Nigerian and international bank
 * transfers land once the CAC nonprofit registration clears.
 *
 * The six EVM chains share ONE address, so each is listed separately with its
 * own QR carrying an EIP-681 `ethereum:<addr>@<chainId>` — the only thing that
 * can route a scan to the right network (Ethereum 1 / Base 8453 / Polygon 137 /
 * Monad 143 / Robinhood 4663 / HyperEVM 999). Solana and Bitcoin use their own
 * URI schemes; Sui has no standard one, so it stays a raw address. The QR carries
 * the prefixed URI; Copy gives the RAW address (you paste an address, not a URI).
 */
type Wallet = { label: string; address: string; qr: string };

const EVM = '0x00F7bE0EA4A6dF70afc32d591C53460008d28C11';
const SOL = 'Ac952LkbEvNAgECtd1n7LWG11M69VbGvUJCmAVkvenQN';
const BTC = 'bc1qnksyh8vvzetpjhc6kl9e7dxpa5tkk6pthehxly';
const SUI = '0x0b46490cffac31ac4f08683cc1c9ab3b56c9d0e279ab18d5d26f77cdeb138fb3';

const WALLETS: Wallet[] = [
  { label: 'Ethereum', address: EVM, qr: `ethereum:${EVM}@1` },
  { label: 'Base', address: EVM, qr: `ethereum:${EVM}@8453` },
  { label: 'Polygon', address: EVM, qr: `ethereum:${EVM}@137` },
  { label: 'Monad', address: EVM, qr: `ethereum:${EVM}@143` },
  { label: 'Robinhood Chain', address: EVM, qr: `ethereum:${EVM}@4663` },
  { label: 'HyperEVM', address: EVM, qr: `ethereum:${EVM}@999` },
  { label: 'Solana', address: SOL, qr: `solana:${SOL}` },
  { label: 'Bitcoin', address: BTC, qr: `bitcoin:${BTC}` },
  { label: 'Sui', address: SUI, qr: SUI },
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
          <Text className="-mt-2 text-xs leading-5 text-muted">
            The six EVM networks (Ethereum, Base, Polygon, Monad, Robinhood, HyperEVM)
            share one address — Copy gives you that address, and each QR is tagged for
            its network so a scan sends on the right one.
          </Text>

          {WALLETS.map((w) => (
            <View key={w.label} className="rounded-2xl border border-line bg-card p-4">
              <View className="flex-row items-center gap-3">
                <View className="rounded-lg bg-white p-1.5">
                  <QRCode value={w.qr} size={96} backgroundColor="#ffffff" color="#000000" />
                </View>
                <View className="flex-1">
                  <Text className="font-bold text-ink">{w.label}</Text>
                  <Text className="mt-1 font-mono text-xs text-muted" numberOfLines={1}>
                    {short(w.address)}
                  </Text>
                  <Pressable
                    onPress={() => copy(w.address)}
                    className="mt-2 flex-row items-center gap-1.5 self-start rounded-full bg-good px-3 py-2"
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
