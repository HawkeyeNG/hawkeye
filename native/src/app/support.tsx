import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Animated, Modal, Pressable, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SvgXml } from 'react-native-svg';

import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';

/**
 * Support Hawkeye — the founder-funded donation screen (native twin of
 * app/support.html), kept in step with it: a brand icon per wallet, Copy for the
 * RAW address, and a QR that opens ONE large code at a time in a modal (all nine
 * on screen at once are too small for a camera to isolate).
 *
 * The six EVM chains share ONE address, so each carries an EIP-681
 * `ethereum:<addr>@<chainId>` so a scan routes to the right network (Ethereum 1 /
 * Base 8453 / Polygon 137 / Monad 143 / Robinhood 4663 / HyperEVM 999). Solana and
 * Bitcoin use their own URI schemes; Sui has none, so it stays a raw address.
 */
type Wallet = { slug: string; label: string; address: string; qr: string; net: string };

const EVM = '0x00F7bE0EA4A6dF70afc32d591C53460008d28C11';
const SOL = 'Ac952LkbEvNAgECtd1n7LWG11M69VbGvUJCmAVkvenQN';
const BTC = 'bc1qnksyh8vvzetpjhc6kl9e7dxpa5tkk6pthehxly';
const SUI = '0x0b46490cffac31ac4f08683cc1c9ab3b56c9d0e279ab18d5d26f77cdeb138fb3';

// Same brand marks as app/support.html — reused verbatim via SvgXml.
const ICONS: Record<string, string> = {
  bitcoin: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#F7931A"/><path fill="#fff" d="M22 14.2c.26-1.76-1.08-2.7-2.9-3.33l.6-2.37-1.45-.36-.58 2.3c-.38-.09-.77-.18-1.16-.27l.58-2.32-1.44-.36-.6 2.37c-.31-.07-.62-.14-.91-.22l-2-.5-.38 1.54s1.07.25 1.05.26c.59.15.69.54.68.85l-1.63 6.54c-.07.18-.26.44-.66.34.01.02-1.05-.26-1.05-.26l-.72 1.65 1.88.47c.35.09.69.18 1.03.26l-.6 2.4 1.44.36.6-2.37c.39.11.77.2 1.15.3l-.59 2.36 1.44.36.6-2.4c2.46.47 4.31.28 5.09-1.95.63-1.79-.03-2.83-1.33-3.5.94-.22 1.65-.84 1.84-2.12zm-3.29 4.62c-.45 1.79-3.46.82-4.44.58l.8-3.18c.98.24 4.11.73 3.64 2.6zm.45-4.65c-.41 1.63-2.91.8-3.72.6l.72-2.88c.81.2 3.42.58 3 2.28z"/></svg>',
  ethereum: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="#fff"><path fill-opacity=".6" d="M16.5 4v8.87l7.5 3.35z"/><path d="M16.5 4 9 16.22l7.5-3.35z"/><path fill-opacity=".6" d="M16.5 21.97V28L24 17.62z"/><path d="M16.5 28v-6.03L9 17.62z"/><path fill-opacity=".2" d="m16.5 20.57 7.5-4.35-7.5-3.34z"/><path fill-opacity=".6" d="m9 16.22 7.5 4.35v-7.69z"/></g></svg>',
  base: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0052FF"/><path fill="#fff" d="M15.9 25.6a9.6 9.6 0 1 1 0-19.2 9.6 9.6 0 0 1 9.5 8.2H11.2v2.8h14.2a9.6 9.6 0 0 1-9.5 8.2z"/></svg>',
  polygon: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="M20.4 13.2c-.35-.2-.8-.2-1.2 0l-2.6 1.55-1.8 1-2.6 1.55c-.35.2-.8.2-1.2 0l-2.05-1.24c-.35-.2-.6-.58-.6-1v-2.4c0-.42.2-.8.6-1.02l2.03-1.18c.35-.2.8-.2 1.2 0l2.02 1.2c.35.2.6.58.6 1v1.55l1.8-1.03v-1.56c0-.42-.2-.8-.6-1.02l-3.8-2.24c-.35-.2-.8-.2-1.2 0l-3.86 2.24c-.4.22-.6.6-.6 1.02v4.48c0 .42.2.8.6 1.02l3.86 2.24c.35.2.8.2 1.2 0l2.6-1.53 1.8-1.03 2.6-1.53c.35-.2.8-.2 1.2 0l2.04 1.2c.35.2.6.58.6 1v2.4c0 .42-.2.8-.6 1.02l-2.02 1.2c-.35.2-.8.2-1.2 0l-2.03-1.2c-.35-.2-.6-.58-.6-1v-1.52l-1.8 1.03v1.55c0 .42.2.8.6 1.02l3.86 2.24c.35.2.8.2 1.2 0l3.86-2.24c.35-.2.6-.58.6-1.02v-4.5c0-.42-.2-.8-.6-1.02z"/></svg>',
  monad: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#836EF9"/><path fill="#fff" d="M16 6c-3.3 0-6 4.48-6 10s2.7 10 6 10 6-4.48 6-10-2.7-10-6-10zm0 15.6c-1.75 0-3.2-2.5-3.2-5.6s1.45-5.6 3.2-5.6 3.2 2.5 3.2 5.6-1.45 5.6-3.2 5.6z"/></svg>',
  robinhood: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0B3D2E"/><path fill="#CCFF00" d="M10 9.5l1.9 8.7L13.5 12l1.6 7 1.6-7 1.6 6.2L20 9.5l2.1.4-2.7 12.6-2.3-.3-1.3-5.3-1.3 5.3-2.3.3L7.9 9.9z"/></svg>',
  hyperevm: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#072723"/><path fill="#97FCE4" d="M6.5 17.4c1.7 0 1.7-2.3 3.6-2.3 2 0 2 3.1 4 3.1 2.1 0 2.3-6.2 4.4-6.2 1.8 0 2 3.1 3.6 3.1 1 0 1.6-.7 2.4-1.5v3.4c-.7.5-1.4 1-2.4 1-2 0-2.2-3.1-3.7-3.1-1.9 0-2.1 6.2-4.4 6.2-2.1 0-2.2-3.1-4-3.1-1.6 0-1.9 2.3-3.7 2.3z"/></svg>',
  solana: '<svg viewBox="0 0 32 32"><defs><linearGradient id="solg" x1="4" y1="23" x2="28" y2="9" gradientUnits="userSpaceOnUse"><stop stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="#111"/><g fill="url(#solg)"><path d="M9.7 20.3a.7.7 0 0 1 .5-.2h12.6c.32 0 .48.38.25.6l-2.3 2.3a.7.7 0 0 1-.5.2H7.65c-.32 0-.48-.38-.25-.6z"/><path d="M9.7 8.8a.7.7 0 0 1 .5-.2h12.6c.32 0 .48.38.25.6l-2.3 2.3a.7.7 0 0 1-.5.2H7.65c-.32 0-.48-.38-.25-.6z"/><path d="M20.55 14.5a.7.7 0 0 0-.5-.2H7.45c-.32 0-.48.38-.25.6l2.3 2.3a.7.7 0 0 0 .5.2h12.6c.32 0 .48-.38.25-.6z"/></g></svg>',
  sui: '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#4DA2FF"/><path fill="#fff" d="M16 7c2.9 3.8 5.8 6.3 5.8 10a5.8 5.8 0 1 1-11.6 0C10.2 13.3 13.1 10.8 16 7zm0 3.5c-1.7 2.1-3.6 3.8-3.6 6.5a3.6 3.6 0 0 0 7.2 0c0-2.7-1.9-4.4-3.6-6.5z"/></svg>',
};

const WALLETS: Wallet[] = [
  { slug: 'solana', label: 'Solana', address: SOL, qr: `solana:${SOL}`, net: 'Solana Pay request.' },
  { slug: 'ethereum', label: 'Ethereum', address: EVM, qr: `ethereum:${EVM}@1`, net: 'Tagged for Ethereum (chain 1).' },
  { slug: 'bitcoin', label: 'Bitcoin', address: BTC, qr: `bitcoin:${BTC}`, net: 'BIP-21 Bitcoin request.' },
  { slug: 'base', label: 'Base', address: EVM, qr: `ethereum:${EVM}@8453`, net: 'Tagged for Base (chain 8453).' },
  { slug: 'polygon', label: 'Polygon', address: EVM, qr: `ethereum:${EVM}@137`, net: 'Tagged for Polygon (chain 137).' },
  { slug: 'robinhood', label: 'Robinhood Chain', address: EVM, qr: `ethereum:${EVM}@4663`, net: 'Tagged for Robinhood Chain (chain 4663).' },
  { slug: 'monad', label: 'Monad', address: EVM, qr: `ethereum:${EVM}@143`, net: 'Tagged for Monad (chain 143).' },
  { slug: 'sui', label: 'Sui', address: SUI, qr: SUI, net: 'Plain Sui address — Sui has no URI scheme, so no network tag.' },
  { slug: 'hyperevm', label: 'HyperEVM', address: EVM, qr: `ethereum:${EVM}@999`, net: 'Tagged for HyperEVM (chain 999).' },
];

const short = (a: string) => `${a.slice(0, 12)}…${a.slice(-8)}`;

export default function Support() {
  const ui = useUi();
  const [copied, setCopied] = useState<string | null>(null);
  const [qr, setQr] = useState<Wallet | null>(null);
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();

  const copy = async (address: string) => {
    await Clipboard.setStringAsync(address);
    setCopied(address);
    setTimeout(() => setCopied((c) => (c === address ? null : c)), 1800);
  };

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Support Hawkeye" translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH }}
      >
        <View className="gap-4 p-4">
          <View className="gap-2 rounded-2xl border border-line bg-card p-4">
            <Text className="text-lg font-bold text-ink">Keep Hawkeye Independent</Text>
            <Text className="leading-6 text-muted">
              Hawkeye is built and paid for by its founder — no political funding, no
              advertisers, no strings attached. If the work is useful to you, a donation helps
              cover the servers, phones and time that keep it running and independent.
            </Text>
          </View>

          <Text className="mt-1 text-xs font-bold uppercase tracking-widest text-faint">
            Crypto Wallets
          </Text>
          <Text className="-mt-2 text-xs leading-5 text-muted">
            Tap Copy for wallet address, or QR to generate a scannable code.
          </Text>

          {WALLETS.map((w) => (
            <View key={w.label} className="rounded-2xl border border-line bg-card p-3.5">
              <View className="flex-row items-center gap-3">
                <SvgXml xml={ICONS[w.slug]} width={30} height={30} />
                <View className="flex-1">
                  <Text className="font-bold text-ink">{w.label}</Text>
                  <Text className="mt-0.5 font-mono text-xs text-muted" numberOfLines={1}>
                    {short(w.address)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => copy(w.address)}
                  className="flex-row items-center gap-1.5 rounded-full bg-good px-3 py-2 active:opacity-70"
                >
                  <Feather name={copied === w.address ? 'check' : 'copy'} size={13} color={ui.tint.good.ink} />
                  <Text className="text-xs font-bold text-good-ink">
                    {copied === w.address ? 'Copied' : 'Copy'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setQr(w)}
                  className="flex-row items-center gap-1.5 rounded-full border border-line px-3 py-2 active:opacity-70"
                >
                  <Feather name="maximize" size={13} color={ui.ink} />
                  <Text className="text-xs font-bold text-ink">QR</Text>
                </Pressable>
              </View>
            </View>
          ))}

          <Text className="mb-8 mt-2 px-2 text-center text-xs leading-5 text-faint">
            Always confirm the address after pasting. Hawkeye will never message you asking for
            funds or seed phrases.
          </Text>
        </View>
      </Animated.ScrollView>

      {/* One QR at a time, large enough for a camera. */}
      <Modal visible={!!qr} transparent animationType="fade" onRequestClose={() => setQr(null)}>
        <Pressable
          className="flex-1 items-center justify-center bg-black/60 p-5"
          onPress={() => setQr(null)}
        >
          {qr ? (
            <Pressable
              className="w-full max-w-[340px] rounded-2xl border border-line bg-card p-5"
              onPress={() => {}}
            >
              <Pressable onPress={() => setQr(null)} hitSlop={12} className="absolute right-3 top-2.5 z-10">
                <Feather name="x" size={20} color={ui.muted} />
              </Pressable>
              <View className="flex-row items-center justify-center gap-2">
                <SvgXml xml={ICONS[qr.slug]} width={24} height={24} />
                <Text className="text-base font-bold text-ink">{qr.label}</Text>
              </View>
              {/* White plate always — a QR must stay dark-on-light to scan. */}
              <View className="mx-auto my-4 rounded-xl bg-white p-3">
                <QRCode value={qr.qr} size={216} backgroundColor="#ffffff" color="#000000" />
              </View>
              <Text className="text-center text-xs text-muted">{qr.net}</Text>
              <Text className="mt-2 text-center font-mono text-[11px] text-muted">{qr.address}</Text>
              <Pressable
                onPress={() => copy(qr.address)}
                className="mt-4 flex-row items-center justify-center gap-1.5 self-center rounded-full bg-good px-4 py-2.5 active:opacity-70"
              >
                <Feather name={copied === qr.address ? 'check' : 'copy'} size={14} color={ui.tint.good.ink} />
                <Text className="text-sm font-bold text-good-ink">
                  {copied === qr.address ? 'Copied' : 'Copy address'}
                </Text>
              </Pressable>
            </Pressable>
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}
