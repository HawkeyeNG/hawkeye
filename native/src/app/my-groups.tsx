import Feather from '@expo/vector-icons/Feather';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, RefreshControl, Share, Text, TextInput, View } from 'react-native';

import { ConfirmSheet } from '@/components/confirm-sheet';
import { NoticeSheet, useNotice } from '@/components/notice-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { BASE } from '@/lib/api';
import { authedGet } from '@/lib/auth';
import { authedSend } from '@/lib/authed-send';
import { forgetRooms, myRooms, type MyRoom } from '@/lib/check-in';
import { t as i18nT } from '@/lib/i18n';
import { trySubmitFix } from '@/lib/location';
import { useUi } from '@/lib/theme';
import { inviteToken } from '@/lib/web-routes';

/**
 * MY GROUPS — the observer's side of a campaign or observer-group membership.
 * The native twin of app/my-groups.html, over the same endpoints
 * (backend routes/groups.js): GET /api/groups, POST …/accept, POST …/decline,
 * DELETE …/membership, and POST …/check-in for attendance.
 *
 * WHY IT IS NATIVE. The app used to open the website's page in an in-app
 * browser tab — from the "Continue" after joining, and from every group alert.
 * That tab does not carry the app's session, so it met every member with the
 * website's sign-in form; and signing in there took the phone's session slot
 * and signed the APP out (backend services/sessions.js). See lib/web-routes.ts.
 *
 * EVERY VERB THE JOIN SCREEN PROMISES IS HERE. Its consent notice says a
 * suggested unit can be declined and a membership left; this is the screen
 * behind those sentences, as my-groups.html is on the web.
 *
 * THE SITUATION ROOM STAYS ON THE WEB (owner decision), and is NOT opened from
 * here. On a phone it would be the same signed-out tab, and signing in to it
 * would sign this app out. A manager gets the room's address to open on a
 * computer — the computer is a separate session slot, so both stay signed in.
 */
type Member = {
  id: number;
  name: string;
  kind: string;
  contest: string;
  scope: string | null;
  slug: string | null;
  manages: string | null;
  assigned_pu: string | null;
  assign_state: string;
  member_state: string;
  assigned_name: string | null;
  assigned_ward: string | null;
  assigned_lga: string | null;
};
type Managed = {
  id: number;
  name: string;
  kind: string;
  contest: string;
  scope: string | null;
  slug: string | null;
  role: string;
};
type Groups = { member: Member[]; managing: Managed[] };

const kindLabel = (kind: string) =>
  kind === 'cso' ? i18nT('my-groups.kind-cso') : i18nT('my-groups.kind-campaign');
const subLine = (g: { kind: string; contest: string; scope: string | null }) =>
  [kindLabel(g.kind), g.contest, g.scope].filter(Boolean).join(' · ');
const roleLine = (role: string | null) =>
  role === 'owner' ? i18nT('n.app.my-groups.you-own')
    : role === 'coordinator' ? i18nT('n.app.my-groups.you-coordinate')
      : i18nT('n.app.my-groups.you-manage');

function Btn({
  label, icon, onPress, tone = 'quiet', busy,
}: {
  label: string;
  icon?: keyof typeof Feather.glyphMap;
  onPress: () => void;
  tone?: 'primary' | 'quiet' | 'warn';
  busy?: boolean;
}) {
  const ui = useUi();
  return (
    <Pressable
      disabled={busy}
      onPress={onPress}
      accessibilityRole="button"
      className={`mb-2 mr-2 flex-row items-center rounded-xl px-3.5 py-2.5 active:opacity-70 ${
        tone === 'primary' ? 'bg-hawk-green' : 'border border-line bg-surface'
      }`}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tone === 'primary' ? '#fff' : ui.muted} style={{ marginRight: 6 }} />
      ) : icon ? (
        <Feather
          name={icon}
          size={14}
          color={tone === 'primary' ? '#f5b301' : tone === 'warn' ? ui.tint.bad.ink : ui.tint.good.ink}
          style={{ marginRight: 6 }}
        />
      ) : null}
      <Text
        className={`text-sm font-semibold ${
          tone === 'primary' ? 'text-hawk-gold' : tone === 'warn' ? 'text-bad-ink' : 'text-ink'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function MyGroups() {
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const notice = useNotice();
  const [groups, setGroups] = useState<Groups | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [rooms, setRooms] = useState<MyRoom[]>([]);
  /** `${verb}:${groupId}` while that request is in flight. */
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'leave' | 'refuse'; id: number; name: string } | null>(null);
  const [room, setRoom] = useState<{ name: string; url: string } | null>(null);
  const [checkIn, setCheckIn] = useState<Record<number, 'working' | 'failed' | undefined>>({});
  const [link, setLink] = useState('');
  const [linkBad, setLinkBad] = useState(false);

  const load = useCallback(async () => {
    try {
      const g = await authedGet<Groups>('/api/groups');
      setGroups({ member: g.member ?? [], managing: g.managing ?? [] });
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
    // Attendance, per room, for today. Empty for anyone the server does not
    // have on a roster — and never able to hold up the list above.
    myRooms().then(setRooms).catch(() => {});
  }, []);

  // On focus, not mount: coming back from a join or an accepted invite must
  // show the new membership without a pull.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    forgetRooms();
    await load();
    setRefreshing(false);
  };

  /** One membership action; on success the list is re-read, as on the web. */
  const act = async (
    verb: 'accept' | 'decline' | 'leave',
    id: number,
    failKey: string,
  ) => {
    setBusy(`${verb}:${id}`);
    try {
      const r = verb === 'accept' ? await authedSend('POST', `/api/groups/${id}/accept`)
        : verb === 'decline' ? await authedSend('POST', `/api/groups/${id}/decline`)
          : await authedSend('DELETE', `/api/groups/${id}/membership`);
      if (r.status !== 200) throw new Error(String(r.status));
      forgetRooms();
      await load();
    } catch {
      notice.show(i18nT(failKey), i18nT('n.app.my-groups.try-again-later'));
    } finally {
      setBusy(null);
    }
  };

  const doCheckIn = async (id: number, puCode: string) => {
    setCheckIn((c) => ({ ...c, [id]: 'working' }));
    const got = await trySubmitFix();
    if (!got.ok) {
      setCheckIn((c) => ({ ...c, [id]: 'failed' }));
      return;
    }
    try {
      const r = await authedSend('POST', `/api/groups/${id}/check-in`, {
        pu_code: puCode, lat: got.fix.lat, lng: got.fix.lng, accuracy: got.fix.accuracy,
      });
      if (r.status !== 200) throw new Error(String(r.status));
      forgetRooms();
      setRooms(await myRooms());
      setCheckIn((c) => ({ ...c, [id]: undefined }));
    } catch {
      setCheckIn((c) => ({ ...c, [id]: 'failed' }));
    }
  };

  const openLink = () => {
    const tok = inviteToken(link);
    if (!tok) {
      setLinkBad(true);
      return;
    }
    setLinkBad(false);
    setLink('');
    router.push(`/join/${tok}` as never);
  };

  const roomButton = (g: { name: string; slug: string | null }) =>
    g.slug ? (
      <Btn
        label={i18nT('my-groups.open-room')}
        icon="monitor"
        onPress={() => setRoom({ name: g.name, url: `${BASE}/room/${encodeURIComponent(g.slug!)}` })}
      />
    ) : null;

  /* The attendance line for one membership: a button until today's check-in is
     in, then what was recorded. Only where there is a unit to be at. */
  const attendance = (g: Member) => {
    const r = rooms.find((x) => x.id === g.id);
    if (!r || !r.assigned) return null;
    const state = checkIn[g.id];
    if (r.checkedIn) {
      const ok = r.checkedIn.standing === 'verified';
      return (
        <Text className={`pt-3 text-xs font-semibold ${ok ? 'text-good-ink' : 'text-warn-ink'}`}>
          {ok ? i18nT('n.app.report.result.checked-in-ok') : i18nT('n.app.report.result.checked-in-weak')}
        </Text>
      );
    }
    return (
      <View className="pt-3">
        <Text className="pb-2 text-xs text-muted">{i18nT('n.app.report.result.check-in-sub')}</Text>
        <Pressable
          disabled={state === 'working'}
          onPress={() => doCheckIn(g.id, r.assigned!.pu_code)}
          accessibilityRole="button"
          className="items-center rounded-xl bg-hawk-gold py-2.5 active:opacity-80"
        >
          <Text className="text-sm font-bold text-hawk-ink">
            {state === 'working'
              ? i18nT('n.app.report.result.check-in-locating')
              : i18nT('n.app.report.result.check-in')}
          </Text>
        </Pressable>
        {state === 'failed' ? (
          <Text className="pt-2 text-xs text-warn-ink">{i18nT('n.app.report.result.check-in-failed')}</Text>
        ) : null}
      </View>
    );
  };

  const memberCard = (g: Member) => {
    /* ASKED, NOT JOINED — a campaign copied them over from another roster.
       Nothing about them reaches that campaign until they answer, so this card
       is a question, not a membership: no unit, no room, no leaving. */
    if (g.member_state === 'invited') {
      return (
        <View key={`m${g.id}`} className="mb-3 rounded-2xl border-l-4 border-hawk-gold bg-card p-4">
          <Text className="text-base font-bold text-ink">{g.name}</Text>
          <Text className="pt-0.5 text-xs text-muted">{subLine(g)}</Text>
          <Text className="pt-2 text-sm text-ink">{i18nT('my-groups.invited-lede')}</Text>
          <Text className="pt-1.5 text-xs leading-5 text-muted">{i18nT('my-groups.invited-body')}</Text>
          <View className="flex-row flex-wrap pt-3">
            <Btn
              tone="primary"
              label={i18nT('my-groups.accept')}
              busy={busy === `accept:${g.id}`}
              onPress={() => act('accept', g.id, 'my-groups.accept-failed')}
            />
            <Btn
              label={i18nT('my-groups.no-thanks')}
              onPress={() => setConfirm({ kind: 'refuse', id: g.id, name: g.name })}
            />
          </View>
        </View>
      );
    }
    const declined = g.assign_state === 'declined';
    return (
      <View key={`m${g.id}`} className="mb-3 rounded-2xl bg-card p-4">
        <Text className="text-base font-bold text-ink">{g.name}</Text>
        <Text className="pt-0.5 text-xs text-muted">{subLine(g)}</Text>
        {g.manages ? <Text className="pt-1 text-xs text-muted">{roleLine(g.manages)}</Text> : null}
        {g.assigned_pu ? (
          <View className="mt-3 rounded-xl border border-line bg-surface p-3">
            <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {declined ? i18nT('my-groups.unit-declined') : i18nT('my-groups.unit-assigned')}
            </Text>
            <Text className="pt-0.5 text-sm font-semibold text-ink">
              {g.assigned_name || i18nT('race.polling-unit')}
            </Text>
            <Text className="font-mono text-xs text-muted">
              {[g.assigned_pu, g.assigned_ward, g.assigned_lga].filter(Boolean).join(' · ')}
            </Text>
          </View>
        ) : (
          <Text className="pt-2 text-xs text-muted">{i18nT('my-groups.no-unit')}</Text>
        )}
        {declined ? <Text className="pt-2 text-xs text-muted">{i18nT('my-groups.declined-note')}</Text> : null}
        {attendance(g)}
        <View className="flex-row flex-wrap pt-3">
          {g.manages ? roomButton(g) : null}
          {g.assigned_pu && !declined ? (
            <Btn
              label={i18nT('my-groups.not-where')}
              icon="map-pin"
              busy={busy === `decline:${g.id}`}
              onPress={() => act('decline', g.id, 'my-groups.send-failed')}
            />
          ) : null}
          <Btn
            tone="warn"
            label={i18nT('my-groups.leave')}
            icon="log-out"
            onPress={() => setConfirm({ kind: 'leave', id: g.id, name: g.name })}
          />
        </View>
      </View>
    );
  };

  /* A group someone runs without being on its roster — an owner, typically.
     No unit and nothing to leave; the room is the thing they came for. */
  const managedCard = (g: Managed) => (
    <View key={`g${g.id}`} className="mb-3 rounded-2xl bg-card p-4">
      <Text className="text-base font-bold text-ink">{g.name}</Text>
      <Text className="pt-0.5 text-xs text-muted">{subLine(g)}</Text>
      <Text className="pt-1 text-xs text-muted">{roleLine(g.role)}</Text>
      <View className="flex-row flex-wrap pt-3">{roomButton(g)}</View>
    </View>
  );

  const member = groups?.member ?? [];
  const onlyManaged = (groups?.managing ?? []).filter((m) => !member.some((g) => g.id === m.id));
  const empty = groups && member.length === 0 && onlyManaged.length === 0;

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('my-groups.your-groups')} translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ui.tint.good.ink} />}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 32 }}
      >
        {!groups && !loadFailed ? (
          <ActivityIndicator className="pt-8" color={ui.tint.good.ink} />
        ) : !groups ? (
          <View className="items-center rounded-2xl bg-card px-6 py-10">
            <Feather name="wifi-off" size={26} color={ui.faint} />
            <Text className="pt-3 text-center text-sm text-ink">{i18nT('my-groups.load-failed')}</Text>
            <View className="pt-4">
              <Btn label={i18nT('n.app._layout.try-again')} icon="refresh-cw" onPress={() => load()} />
            </View>
          </View>
        ) : empty ? (
          <View className="items-center rounded-2xl bg-card px-6 py-10">
            <Feather name="users" size={26} color={ui.faint} />
            <Text className="pt-3 text-center text-base font-semibold text-ink">
              {i18nT('n.app.my-groups.none')}
            </Text>
            <Text className="pt-1 text-center text-sm leading-5 text-muted">
              {i18nT('n.app.my-groups.none-sub')}
            </Text>
          </View>
        ) : (
          <>
            <Text className="pb-4 text-sm leading-5 text-muted">{i18nT('my-groups.lede')}</Text>
            {member.map(memberCard)}
            {onlyManaged.map(managedCard)}
            <Text className="pt-2 text-xs leading-5 text-muted">{i18nT('my-groups.note')}</Text>
          </>
        )}

        {/* JOIN FROM A PASTED LINK. The invite normally opens the app by itself
            (an App Link); when it opened the browser instead — a link that went
            through an app that rewrites urls, or an unverified domain — this is
            the way in that does not go through the website's sign-in. */}
        <View className="mt-6 rounded-2xl bg-card p-4">
          <Text className="text-sm font-bold text-ink">{i18nT('n.app.my-groups.have-link')}</Text>
          <Text className="pt-1 text-xs leading-5 text-muted">{i18nT('n.app.my-groups.have-link-sub')}</Text>
          <TextInput
            value={link}
            onChangeText={(v) => {
              setLink(v);
              if (linkBad) setLinkBad(false);
            }}
            onSubmitEditing={openLink}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            placeholder="https://hawkeye.com.ng/join/…"
            placeholderTextColor={ui.faint}
            className="mt-3 rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink"
          />
          {linkBad ? <Text className="pt-2 text-xs text-warn-ink">{i18nT('n.app.my-groups.bad-link')}</Text> : null}
          <View className="flex-row pt-3">
            <Btn tone="primary" label={i18nT('n.app.my-groups.open-link')} icon="link" onPress={openLink} />
          </View>
        </View>
      </Animated.ScrollView>

      <ConfirmSheet
        visible={!!confirm}
        icon={confirm?.kind === 'leave' ? 'log-out' : 'x-circle'}
        danger={confirm?.kind === 'leave'}
        title={confirm?.kind === 'leave' ? i18nT('my-groups.leave') : i18nT('my-groups.no-thanks')}
        body={
          confirm?.kind === 'leave'
            ? i18nT('my-groups.leave-confirm', { name: confirm?.name ?? '' })
            : i18nT('my-groups.refuse-confirm', { name: confirm?.name ?? '' })
        }
        confirmLabel={confirm?.kind === 'leave' ? i18nT('my-groups.leave') : i18nT('my-groups.no-thanks')}
        cancelLabel={i18nT('common.cancel')}
        busy={!!busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          /* Refusing REMOVES the row, the same endpoint as leaving: a campaign
             that could keep a list of who said no would have been handed the
             very fact the person withheld. */
          if (c) act('leave', c.id, c.kind === 'leave' ? 'my-groups.leave-failed' : 'my-groups.refuse-failed');
        }}
      />

      <ConfirmSheet
        visible={!!room}
        icon="monitor"
        title={i18nT('nav.situation-room')}
        body={i18nT('n.app.my-groups.room-body', { name: room?.name ?? '', url: room?.url ?? '' })}
        confirmLabel={i18nT('n.app.my-groups.share-link')}
        cancelLabel={i18nT('common.close')}
        onCancel={() => setRoom(null)}
        onConfirm={() => {
          const r = room;
          setRoom(null);
          // The share sheet carries Copy as well as every messenger, so the
          // address can reach whichever computer the manager uses.
          if (r) Share.share({ message: r.url }).catch(() => {});
        }}
      />

      <NoticeSheet {...notice.props} />
    </View>
  );
}
