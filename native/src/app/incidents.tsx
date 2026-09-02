import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { InfoDot } from '@/components/info-dot';
import { useNotice, NoticeSheet } from '@/components/notice-sheet';
import { ReportContent } from '@/components/report-content';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScrollList } from '@/hooks/use-hide-on-scroll';
import { api, BRAND, type Incident } from '@/lib/api';
import { useUi } from '@/lib/theme';
import { humanError } from '@/lib/errors';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

/**
 * Same eight codes the report screen offers (KINDS in report/incident.tsx), so
 * the label an observer picked when filing is the label everyone reads back
 * here. That file keeps its list private — it pairs each code with a Feather
 * icon for the picker, which a text feed has no use for — so the labels are
 * restated rather than the picker's shape imported wholesale.
 */
const KIND_LABEL: Record<string, string> = {
  violence: 'Violence',
  ballot_snatching: 'Ballot snatching',
  vote_buying: 'Vote buying',
  intimidation: 'Intimidation',
  bvas_failure: 'BVAS failure',
  late_materials: 'Late materials',
  obstruction: 'Obstruction',
  other: 'Other',
};

/**
 * lib/api.ts's Incident predates this screen: it names the body `text` and types
 * the place fields as non-null. The live feed (backend routes/incidents.js) sends
 * `description`, and `state` is null for a report filed without a polling unit.
 * Widened here rather than by editing a type three other callers share.
 */
type Published = Omit<Incident, 'text' | 'state' | 'lga'> & {
  description?: string | null;
  text?: string | null;
  state?: string | null;
  lga?: string | null;
};

function timeAgo(ts: number) {
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Uploads are served flat off /uploads; `file` already carries its subfolder. */
const mediaUrl = (file: string) => `${BASE}/uploads/${encodeURI(file)}`;

/**
 * Published incidents — native twin of app/incidents.html's feed.
 *
 * Public and signed-out on purpose: the point of publishing an incident is that
 * anyone can see it, and requiring an account to read would defeat that. Only
 * human-approved reports ever reach this endpoint — the server filters to
 * status='published' — so nothing here is unmoderated.
 */
export default function Incidents() {
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScrollList();
  const [rows, setRows] = useState<Published[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const notice = useNotice();

  // Returns the failure so the caller can decide how loudly to say it: a first
  // load has an empty screen to explain itself in, a pull-to-refresh does not.
  const load = useCallback(async () => {
    try {
      const { incidents } = await api.incidents();
      setRows(incidents);
      setErr(null);
      return null;
    } catch (e) {
      const msg = humanError(e);
      setErr(msg);
      return msg;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    const failed = await load();
    setRefreshing(false);
    // Under a full-height list an inline error sits below the fold and is never
    // read. The pull was deliberate, so a failed one gets an answer that can't
    // be scrolled past.
    if (failed && rows?.length) {
      notice.show('Could not refresh', `The incident feed did not load. (${failed})`);
    }
  };

  const header = (
    <View className="px-4 pb-1 pt-3">
      <View className="flex-row items-center">
        <Text className="flex-1 text-sm text-muted">
          Election-day incidents reported by observers, each reviewed before it appears.
        </Text>
        <InfoDot
          title="What appears here"
          text="Violence, vote-buying, BVAS failures, obstruction and more, filed by observers at the scene. Every report is reviewed by a person before it is published, and reporters are identified by observer ID only — never by name or phone number."
        />
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Published Incidents" translateY={translateY} onClose={() => router.back()} />
      <FlashList
        data={rows ?? []}
        keyExtractor={(i) => String(i.id)}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingTop: headerH, paddingBottom: 16 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ui.tint.good.ink} />
        }
        ListEmptyComponent={
          rows === null && !err ? (
            <ActivityIndicator className="pt-8" color={ui.tint.good.ink} />
          ) : err ? (
            <View className="mx-4 mt-3 items-center rounded-2xl bg-card px-6 py-10">
              <Feather name="wifi-off" size={26} color={ui.faint} />
              <Text className="pt-3 text-base font-semibold text-ink">
                Could Not Load the Feed
              </Text>
              <Text className="pt-1 text-center text-sm text-muted">
                Pull down to try again. ({err})
              </Text>
            </View>
          ) : (
            <View className="mx-4 mt-3 items-center rounded-2xl bg-card px-6 py-10">
              <Feather name="check-circle" size={26} color={ui.tint.good.ink} />
              <Text className="pt-3 text-base font-semibold text-ink">
                No Incidents Published Yet
              </Text>
              <Text className="pt-1 text-center text-sm text-muted">
                Reports appear here once a moderator has reviewed them.
              </Text>
            </View>
          )
        }
        renderItem={({ item: i }) => {
          const body = i.description ?? i.text ?? '';
          const place = [i.lga, i.state].filter(Boolean).join(', ');
          const media = i.media ?? [];
          return (
            <View className="mx-4 mb-2 rounded-2xl bg-card px-4 py-3">
              <View className="flex-row items-center">
                <View className="rounded-full bg-surface px-2.5 py-1">
                  <Text className="text-[10px] font-bold uppercase tracking-wide text-good-ink">
                    {KIND_LABEL[i.kind] ?? i.kind}
                  </Text>
                </View>
                {place ? (
                  <Text className="flex-1 pl-2 text-xs text-muted" numberOfLines={1}>
                    {place}
                  </Text>
                ) : (
                  <View className="flex-1" />
                )}
                <Text className="pl-2 text-xs text-faint">{timeAgo(i.created_at)}</Text>
              </View>

              {body ? (
                <Text className="pt-2 text-sm text-ink">{body}</Text>
              ) : null}

              {media.length ? (
                <View className="flex-row flex-wrap pt-2">
                  {media.map((m) => (
                    <Pressable
                      key={m.file}
                      className="mb-2 mr-2 h-24 w-24 overflow-hidden rounded-xl bg-surface active:opacity-80"
                      accessibilityLabel={`Open ${m.type === 'video' ? 'video' : 'photo'} evidence full size`}
                      onPress={() => WebBrowser.openBrowserAsync(mediaUrl(m.file))}
                    >
                      {m.type === 'video' ? (
                        // No frame is extracted server-side, so a remote .mp4 in
                        // <Image> renders as a broken tile. A play badge is the
                        // honest thumbnail: it says "video, tap to watch".
                        <View className="h-full w-full items-center justify-center bg-hawk-ink">
                          <Feather name="play" size={22} color="#fff" />
                          <Text className="pt-1 text-[10px] font-semibold text-white">Video</Text>
                        </View>
                      ) : (
                        <Image
                          source={{ uri: mediaUrl(m.file) }}
                          style={{ width: '100%', height: '100%' }}
                          contentFit="cover"
                        />
                      )}
                    </Pressable>
                  ))}
                </View>
              ) : null}

              {/* Published observer media and text are user content: Play's UGC
                  policy and App Store 1.2 both require a way to object to any
                  single item, from inside the app, without an account. */}
              <ReportContent kind="incident" targetId={i.id} />
            </View>
          );
        }}
      />

      {/* Sibling of the list, not a row in it: the feed runs to a hundred cards,
          so a CTA scrolled with them would be unreachable exactly when reading
          one incident makes someone want to file their own. */}
      <View className="border-t border-line bg-surface px-4 pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
        <Pressable
          className="flex-row items-center justify-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
          onPress={() => router.push('/report/incident')}
        >
          <Feather name="alert-triangle" size={16} color={BRAND.gold} />
          <Text className="pl-2 text-base font-bold text-hawk-gold">Report an incident</Text>
        </Pressable>
      </View>

      <NoticeSheet {...notice.props} />
    </View>
  );
}
