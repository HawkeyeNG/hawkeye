/**
 * D1 EVIDENCE STORE — the photos of a hash-only report, kept on this phone.
 *
 * Once a result sheet holds its quorum of agreeing photo-backed reports, a
 * later agreeing report sends its photo HASHES only (backend
 * routes/submissions.js, photoQuorumMet). Its photos then exist nowhere but
 * here, so they are copied into the app's own document directory and kept
 * until the election-petition window closes (31 July 2027), whatever the
 * "keep copies on this phone" switch says. That switch governs the GALLERY
 * copy (lib/save-to-device.ts); this copy is private to the app and is what a
 * case or docket review would later ask for.
 *
 * "Kept" is a claim about the phone, not about the request: keepEvidence
 * resolves true only when both files exist at their full size, and the caller
 * uploads the photos as before whenever it resolves false.
 *
 * Plain file-system work on expo-file-system, already in every shipped build:
 * no new native module, so this reaches phones by OTA.
 */
import { Directory, File, Paths } from 'expo-file-system';

/** End of 31 July 2027 in Lagos (UTC+1): the 2027 election-petition window. */
export const EVIDENCE_KEEP_UNTIL = Date.UTC(2027, 6, 31, 23, 0, 0);
/** A report filed later (a by-election) still gets a window of its own. */
const MIN_KEEP_MS = 180 * 24 * 3600 * 1000;
export const keepUntil = (now = Date.now()) => Math.max(EVIDENCE_KEEP_UNTIL, now + MIN_KEEP_MS);

export type EvidenceEntry = {
  sha256: string;
  slot: 'sheet' | 'venue';
  puCode: string;
  contest: string;
  keptAt: number;
  keepUntil: number;
  uri: string;
};

const SHA = /^[0-9a-f]{64}$/;

function evidenceDir() {
  return new Directory(Paths.document, 'evidence');
}
function indexFile() {
  return new File(evidenceDir(), 'index.json');
}

async function readIndex(): Promise<EvidenceEntry[]> {
  try {
    const f = indexFile();
    if (!f.exists) return [];
    const parsed = JSON.parse(await f.text());
    return Array.isArray(parsed) ? (parsed as EvidenceEntry[]) : [];
  } catch {
    return [];
  }
}

// Serialised, like the outbox index: two reports kept back to back must not
// each write the list they read and lose the other's entry.
let writing: Promise<unknown> = Promise.resolve();
function update(fn: (list: EvidenceEntry[]) => EvidenceEntry[]): Promise<void> {
  const run = writing.then(async () => {
    const next = fn(await readIndex());
    const f = indexFile();
    if (!f.exists) f.create({ intermediates: true, overwrite: true });
    f.write(JSON.stringify(next));
  });
  writing = run.catch(() => undefined);
  return run;
}

/**
 * Copy both photos of a hash-only report into the evidence store.
 * Resolves true only when every copy exists at the source's size.
 */
export async function keepEvidence(args: {
  puCode: string;
  contest: string;
  photos: { slot: 'sheet' | 'venue'; uri: string; sha256: string }[];
  now?: number;
}): Promise<boolean> {
  try {
    if (!args.photos.length || !args.photos.every((p) => SHA.test(p.sha256))) return false;
    const dir = evidenceDir();
    dir.create({ intermediates: true, idempotent: true });
    const now = args.now ?? Date.now();
    const kept: EvidenceEntry[] = [];
    for (const p of args.photos) {
      const src = new File(p.uri);
      // Content-addressed: the name IS the hash the ledger commits.
      const dest = new File(dir, `${p.sha256}.jpg`);
      if (!dest.exists) await src.copy(dest, { overwrite: true });
      if (!dest.exists || !dest.size || (src.size != null && dest.size !== src.size)) return false;
      kept.push({
        sha256: p.sha256, slot: p.slot, puCode: args.puCode, contest: args.contest,
        keptAt: now, keepUntil: keepUntil(now), uri: dest.uri,
      });
    }
    await update((list) => [...list.filter((e) => !kept.some((k) => k.sha256 === e.sha256)), ...kept]);
    void pruneEvidence(now);
    return true;
  } catch {
    return false;
  }
}

/** Every kept photo, for a later evidence request. */
export function listEvidence(): Promise<EvidenceEntry[]> {
  return readIndex();
}

/**
 * Delete entries whose window has closed. Only entries in the index with a
 * past keepUntil are touched, and nothing is due before August 2027.
 */
export async function pruneEvidence(now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    await update((list) =>
      list.filter((e) => {
        if (e.keepUntil > now) return true;
        try {
          const f = new File(evidenceDir(), `${e.sha256}.jpg`);
          if (f.exists) f.delete();
        } catch {
          return true; // could not delete: keep the entry so a later pass retries
        }
        removed += 1;
        return false;
      }),
    );
  } catch {
    /* housekeeping only */
  }
  return removed;
}
