import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, Share, Text, TextInput, View } from 'react-native';

import { CertificateCard, type CertificateCardHandle } from '@/components/certificate-card';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import {
  QUIZ,
  fetchMine,
  issueCert,
  loadCertName,
  saveCertName,
  type Cert,
} from '@/lib/certificate';
import { canMakePdf, shareCertificatePdf } from '@/lib/certificate-pdf';
import { currentLang_, t as i18nT, useT } from '@/lib/i18n';
import { saveReceiptPng } from '@/lib/receipt-file';
import { useUi } from '@/lib/theme';

type View_ = 'loading' | 'error' | 'practice' | 'quiz' | 'done';
type Phase = 'ask' | 'right' | 'wrong';

function Btn({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={{ minHeight: 48 }}
      className={`mt-3 items-center justify-center rounded-full py-3 active:opacity-80 ${primary ? 'bg-hawk-gold' : 'border-2 border-good-ink bg-card'} ${disabled ? 'opacity-60' : ''}`}
    >
      <Text className={`text-sm font-bold ${primary ? 'text-hawk-green' : 'text-good-ink'}`}>{label}</Text>
    </Pressable>
  );
}

type OptionLook = 'idle' | 'right' | 'wrong' | 'locked';

/**
 * One quiz answer, drawn as what it is: a choice to tap. A bordered tile with a
 * radio circle, 52 pt tall at least, and four looks — idle, pressed (the tile
 * and circle take the brand tint while a finger is on it), right (filled green
 * circle with a check) and wrong (filled red circle with a cross). The others
 * are "locked" while an answer's explanation is showing. Every pair is a theme
 * token, so both themes keep their contrast (icon on fill: 6.5:1 or better).
 */
function QuizOption({ label, look, onPress }: { label: string; look: OptionLook; onPress: () => void }) {
  const ui = useUi();
  const disabled = look !== 'idle';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: look === 'right' || look === 'wrong', disabled }}
      className="mt-3"
    >
      {({ pressed }) => {
        const on = pressed && look === 'idle';
        const tile = look === 'right' ? 'border-good-ink bg-good'
          : look === 'wrong' ? 'border-bad-ink bg-bad'
            : on ? 'border-good-ink bg-good' : 'border-faint bg-surface';
        const dot = look === 'right' ? 'border-good-ink bg-good-ink'
          : look === 'wrong' ? 'border-bad-ink bg-bad-ink'
            : on ? 'border-good-ink' : 'border-muted';
        return (
          <View style={{ minHeight: 52 }} className={`flex-row items-center rounded-2xl border-2 px-4 py-3 ${tile}`}>
            <View className={`mr-3 h-6 w-6 items-center justify-center rounded-full border-2 ${dot}`}>
              {look === 'right' ? <Feather name="check" size={14} color={ui.card} /> : null}
              {look === 'wrong' ? <Feather name="x" size={14} color={ui.card} /> : null}
              {on ? <View className="h-2.5 w-2.5 rounded-full bg-good-ink" /> : null}
            </View>
            <Text className={`flex-1 text-base font-semibold leading-6 ${look === 'locked' ? 'text-muted' : 'text-ink'}`}>{label}</Text>
          </View>
        );
      }}
    </Pressable>
  );
}

/**
 * The Hawkeye Observer certificate — native twin of app/certificate.html.
 *
 * A practice run (checked by the server, by device) plus the 7-question quiz
 * from the app's own guides. After each answer the explanation shows; a wrong
 * answer is explained and tried again, so the end is only reached with every
 * answer right — and the server grades the set again.
 *
 * THE NAME stays on this phone: typed here, kept in AsyncStorage, drawn by
 * CertificateCard. Share sends the verification LINK (no name); "Save image"
 * writes the drawn PNG to the gallery (honouring the keep-copies switch, like
 * the receipt); "Print or save as PDF" makes the PDF on the phone with
 * expo-print (lib/certificate-pdf.ts) — shown only on a binary that has it, so
 * a 1.0.8 phone running this JS keeps Share + Save image and never sees a dead
 * button. The code opens the native check (app/verify-cert.tsx). NO WEB PAGE
 * anywhere in this flow.
 */
export default function CertificateScreen() {
  useT();
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [view, setView] = useState<View_>('loading');
  const [cert, setCert] = useState<Cert | null>(null);
  const [name, setName] = useState('');
  const [qi, setQi] = useState(0);
  const [phase, setPhase] = useState<Phase>('ask');
  const [wrong, setWrong] = useState<number[]>([]);
  const [answers, setAnswers] = useState<number[]>([]);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState(false);
  const [note, setNote] = useState<string | null>(null);   // a key, painted at render
  const [pdfBusy, setPdfBusy] = useState(false);
  const cardRef = useRef<CertificateCardHandle>(null);
  // Decided once: the binary does not change under a running screen.
  const [pdfOk] = useState(canMakePdf);

  const startQuiz = useCallback(() => {
    setQi(0); setPhase('ask'); setWrong([]); setAnswers([]); setIssueError(false);
    setView('quiz');
  }, []);

  /* What the server said decides the view. Called only from a promise's
     callback, so the mount effect never sets state synchronously; `load`
     (retry / check again) shows the spinner first. */
  const route = useCallback((r: Awaited<ReturnType<typeof fetchMine>>) => {
    if (r === 'signed_out') { router.replace('/sign-in' as never); return; }
    if (!r) { setView('error'); return; }
    if (r.certified && r.code && r.issuedOn && r.verifyUrl) {
      setCert({ code: r.code, issuedOn: r.issuedOn, verifyUrl: r.verifyUrl });
      setView('done');
      return;
    }
    if (!r.practised) { setView('practice'); return; }
    startQuiz();
  }, [startQuiz]);
  const load = useCallback(() => {
    setView('loading');
    fetchMine().then(route);
  }, [route]);

  useEffect(() => {
    let alive = true;
    fetchMine().then((r) => { if (alive) route(r); });
    loadCertName().then((n) => { if (alive) setName(n); });
    return () => { alive = false; };
  }, [route]);

  const q = QUIZ[qi];
  const last = qi === QUIZ.length - 1;

  const pick = (i: number) => {
    if (phase !== 'ask') return;
    if (i === q.answer) {
      setAnswers((a) => { const next = a.slice(); next[qi] = i; return next; });
      setPhase('right');
    } else {
      setWrong((w) => [...w, i]);
      setPhase('wrong');
    }
  };

  const next = async () => {
    if (!last) { setQi(qi + 1); setPhase('ask'); setWrong([]); return; }
    if (issuing) return;
    setIssuing(true);
    setIssueError(false);
    const all = answers.slice();
    all[qi] = q.answer;
    const r = await issueCert(all);
    setIssuing(false);
    if (r.ok) { setCert(r.cert); setView('done'); return; }
    if (r.error === 'signed_out') { router.replace('/sign-in' as never); return; }
    if (r.error === 'no_practice') { setView('practice'); return; }
    if (r.error === 'quiz_failed') { startQuiz(); return; }
    setIssueError(true);
  };

  const onName = (v: string) => {
    const s = v.slice(0, 60);
    setName(s);
    setNote(null);
    saveCertName(s);
  };

  const share = async () => {
    if (!cert) return;
    const message = i18nT('cert.share-text', { url: cert.verifyUrl });
    try {
      await Share.share(
        Platform.OS === 'ios' ? { message, url: cert.verifyUrl } : { message },
        { dialogTitle: i18nT('cert.share') },
      );
    } catch { /* dismissed */ }
  };

  const save = async () => {
    setNote(null);
    const ok = await saveReceiptPng(cardRef.current, 'hawkeye-observer-certificate');
    setNote(ok ? 'n.app.certificate.saved' : 'n.app.certificate.save-failed');
  };

  const pdf = async () => {
    if (!cert || pdfBusy) return;
    setNote(null);
    setPdfBusy(true);
    const r = await shareCertificatePdf(cert, name, currentLang_(), i18nT('n.app.certificate.title'));
    setPdfBusy(false);
    if (r !== 'shown') setNote('n.app.certificate.pdf-failed');
  };

  const verify = () => {
    if (!cert) return;
    router.push({ pathname: '/verify-cert', params: { code: cert.code } } as never);
  };

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('n.app.certificate.title')} translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 48 }}
      >
        {view !== 'done' ? (
          <Text className="pb-4 text-sm leading-5 text-muted">{i18nT('cert.lede')}</Text>
        ) : null}

        {view === 'loading' ? <ActivityIndicator className="pt-6" color={ui.tint.good.ink} /> : null}

        {view === 'error' ? (
          <View className="rounded-2xl bg-warn px-4 py-3">
            <Text className="text-sm text-ink">{i18nT('cert.load-error')}</Text>
            <Pressable onPress={load} className="mt-2 self-start py-1 active:opacity-70" accessibilityRole="button">
              <Text className="text-sm font-bold text-warn-ink">{i18nT('cert.try-again')}</Text>
            </Pressable>
          </View>
        ) : null}

        {view === 'practice' ? (
          <View className="rounded-2xl bg-card px-4 py-4">
            <Text className="text-lg font-bold text-ink">{i18nT('cert.practice-first-h')}</Text>
            <Text className="pt-1 text-sm leading-5 text-muted">{i18nT('cert.practice-first-body')}</Text>
            <Btn primary label={i18nT('cert.practice-go')} onPress={() => router.push('/practice' as never)} />
            <Btn label={i18nT('cert.practice-recheck')} onPress={load} />
          </View>
        ) : null}

        {view === 'quiz' ? (
          <View className="rounded-2xl bg-card px-4 py-4">
            <Text className="text-xs font-bold uppercase tracking-wider text-faint">
              {i18nT('cert.progress', { n: qi + 1, total: QUIZ.length })}
            </Text>
            <Text className="pt-2 text-lg font-bold leading-6 text-ink">{i18nT(q.q)}</Text>
            <View accessibilityRole="radiogroup">
              {q.options.map((key, i) => {
                const look: OptionLook = phase === 'right' && i === q.answer ? 'right'
                  : wrong.includes(i) ? 'wrong'
                    : phase !== 'ask' ? 'locked' : 'idle';
                return <QuizOption key={key} label={i18nT(key)} look={look} onPress={() => pick(i)} />;
              })}
            </View>
            {phase !== 'ask' ? (
              <View className={`mt-4 rounded-xl px-3 py-3 ${phase === 'right' ? 'bg-good' : 'bg-bad'}`}>
                <Text className={`text-sm font-bold ${phase === 'right' ? 'text-good-ink' : 'text-bad-ink'}`}>
                  {phase === 'right' ? i18nT('cert.correct') : i18nT('cert.wrong')}
                </Text>
                <Text className="pt-1 text-sm leading-5 text-ink">{i18nT(q.why)}</Text>
              </View>
            ) : null}
            {phase === 'wrong' ? <Btn label={i18nT('cert.retry')} onPress={() => setPhase('ask')} /> : null}
            {phase === 'right' ? (
              <Btn
                primary
                disabled={issuing}
                label={issuing ? i18nT('cert.issuing') : last ? i18nT('cert.finish') : i18nT('cert.next')}
                onPress={next}
              />
            ) : null}
            {issueError ? <Text className="pt-2 text-sm font-semibold text-bad-ink">{i18nT('cert.issue-failed')}</Text> : null}
          </View>
        ) : null}

        {view === 'done' && cert ? (
          <View className="rounded-2xl bg-card px-4 py-4">
            <Text className="text-lg font-bold text-ink">{i18nT('cert.done-h')}</Text>
            <Text className="pt-1 text-sm leading-5 text-muted">{i18nT('cert.done-body')}</Text>

            <Text className="pb-1 pt-4 text-sm font-bold text-ink">{i18nT('cert.name-label')}</Text>
            {/* NEVER SENT: this value is drawn on the card below and stored in
                AsyncStorage; no request made by this screen carries it. */}
            <TextInput
              value={name}
              onChangeText={onName}
              maxLength={60}
              autoCorrect={false}
              autoComplete="name"
              className="rounded-xl border border-line bg-surface px-3 py-3 text-base text-ink"
              placeholderTextColor={ui.faint}
            />
            <Text className="pt-1 text-xs leading-4 text-muted">{i18nT('cert.name-note')}</Text>

            <View className="mt-4 items-center">
              <CertificateCard ref={cardRef} cert={cert} name={name} width={320} />
            </View>

            <Btn primary label={i18nT('cert.share')} onPress={share} />
            <Btn label={i18nT('cert.save')} onPress={save} />
            {/* Only where expo-print is in the binary (1.0.9+). On 1.0.8 the
                button is not drawn at all: Share and Save image still work. */}
            {pdfOk ? (
              <Btn
                label={pdfBusy ? i18nT('n.app.certificate.making-pdf') : i18nT('n.app.certificate.print')}
                onPress={pdf}
                disabled={pdfBusy}
              />
            ) : null}
            {note ? <Text className="pt-2 text-sm font-semibold text-muted">{i18nT(note)}</Text> : null}

            <Text className="pt-5 text-xs text-muted">{i18nT('cert.code-label')}</Text>
            <Text selectable className="text-lg font-bold tracking-widest text-ink">{cert.code}</Text>
            <Text className="pt-2 text-xs text-muted">{i18nT('cert.check-at')}</Text>
            {/* The printed address, opening the app's own check — not a browser. */}
            <Pressable onPress={verify} accessibilityRole="link" className="self-start py-2 active:opacity-70">
              <Text className="text-sm font-semibold text-good-ink">{cert.verifyUrl.replace(/^https?:\/\//, '')}</Text>
            </Pressable>
          </View>
        ) : null}
      </Animated.ScrollView>
    </View>
  );
}
