import fs from 'fs';
import path from 'path';

import { config } from '../config.js';

/**
 * Political reference data, refreshed from public sources.
 *
 * WHY A SERVER-SIDE FETCHER. The browser cannot read Wikipedia or nass.gov.ng
 * directly — no CORS headers — so "the page updates itself" has to mean the
 * server pulls, parses and caches, and the page reads our own JSON.
 *
 * WHY WIKIPEDIA IS NOT SIMPLY TRUSTED. Measured 2026-08-05: the National
 * Assembly infobox reports Senate APC 75 / PDP 26, while our curated file has
 * APC 68 / PDP 24 / ADC 9 — Wikipedia had not absorbed the 2025 ADC defections.
 * Taking "live" data at face value would have made the page LESS accurate. So
 * curated figures win whenever they are dated later than the Wikipedia
 * revision, and any disagreement is reported in `conflicts` rather than
 * silently resolved — this is an election-integrity product, and quietly
 * picking a winner between two sources is exactly what it exists to expose.
 *
 * State-assembly composition has no curated equivalent, so there Wikipedia is
 * the only source and is used as-is, with its own per-row "as of" preserved.
 */

const UA = 'HawkeyeBot/1.0 (+https://hawkeye.com.ng; election transparency)';
const API = 'https://en.wikipedia.org/w/api.php';
const TTL_MS = 12 * 60 * 60 * 1000;          // twice a day is plenty for seat counts
const CACHE = path.join(config.dataDir, 'political_cache.json');

/** Full party names as Wikipedia writes them -> the abbreviations we display. */
const ABBREV = {
  'all progressives congress': 'APC',
  'peoples democratic party': 'PDP',
  "people's democratic party": 'PDP',
  'labour party': 'LP',
  'all progressives grand alliance': 'APGA',
  'new nigeria peoples party': 'NNPP',
  "new nigeria people's party": 'NNPP',
  'social democratic party': 'SDP',
  'african democratic congress': 'ADC',
  'young progressives party': 'YPP',
  'accord party': 'A',
  'boot party': 'BP',
  'zenith labour party': 'ZLP',
  'action alliance': 'AA',
  'african action congress': 'AAC',
  'allied peoples movement': 'APM',
  'peoples redemption party': 'PRP',
};
const abbrev = (name) => {
  const k = String(name || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z' ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return ABBREV[k] || name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 5);
};

async function wiki(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}`
    + '&prop=wikitext|revid&format=json&formatversion=2';
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`wikipedia ${page}: HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.parse?.wikitext) throw new Error(`wikipedia ${page}: no wikitext`);
  return { text: j.parse.wikitext, revid: j.parse.revid };
}

/**
 * `| political_groupsN = {{legend|#RRGGBB|[[Party]]: 75 seats}} ...`
 * The infobox is the only machine-readable seat source on the page; the prose
 * tables are hand-formatted and change shape between revisions.
 */
function legendSeats(text, field) {
  const block = new RegExp(`\\|\\s*${field}\\s*=(.*?)(?=\\n\\s*\\|\\s*\\w+\\s*=)`, 's').exec(text);
  if (!block) return null;
  const parties = {};
  for (const m of block[1].matchAll(/\{\{legend\|([^|]+)\|(.*?)\}\}/gs)) {
    const label = m[2].replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2');
    const seats = /(\d[\d,]*)\s*seat/i.exec(label);
    if (!seats) continue;
    parties[abbrev(label.split(':')[0])] = Number(seats[1].replace(/,/g, ''));
  }
  return Object.keys(parties).length ? parties : null;
}

/** One wikitable row per state: `|24\n|{{party shading/...}}|18 PDP; 3 APC; ...` */
function assemblies(text) {
  const out = {};
  const rowRe = /\|\s*\[\[([^\]|]+?)\s+State House of Assembly[^\]]*\]\]\s*\n(?:.*?\n)?\|\s*(\d+)\s*\n\|(?:\{\{[^}]*\}\})?\s*\|?\s*([^\n]*)/g;
  for (const m of text.matchAll(rowRe)) {
    const state = m[1].trim();
    const seats = Number(m[2]);
    const parties = {};
    for (const p of m[3].matchAll(/(\d+)\s*([A-Z]{1,6})\b/g)) parties[p[2]] = Number(p[1]);
    const asOf = /\(as of ([^)]+)\)/i.exec(m[3]);
    if (Object.keys(parties).length) {
      out[state] = { seats, parties, asOf: asOf ? asOf[1].trim() : null };
    }
  }
  return out;
}

async function build() {
  const na = await wiki('National_Assembly_(Nigeria)');
  const senate = legendSeats(na.text, 'political_groups1');
  const house = legendSeats(na.text, 'political_groups2');

  let states = {};
  try {
    const sha = await wiki('Houses_of_assembly_of_Nigerian_states');
    states = assemblies(sha.text);
  } catch { /* SHA is a bonus; never fail the whole pull for it */ }

  return {
    fetchedAt: new Date().toISOString(),
    revid: na.revid,
    chambers: {
      ...(senate ? { senate: { label: 'Senate', size: 109, parties: senate } } : {}),
      ...(house ? { house: { label: 'House of Representatives', size: 360, parties: house } } : {}),
    },
    states,
    sources: [
      { name: 'National Assembly of Nigeria', url: 'https://nass.gov.ng/' },
      { name: 'Wikipedia — National Assembly (Nigeria)', url: 'https://en.wikipedia.org/wiki/National_Assembly_(Nigeria)' },
      { name: 'Wikipedia — Houses of assembly of Nigerian states', url: 'https://en.wikipedia.org/wiki/Houses_of_assembly_of_Nigerian_states' },
      { name: 'INEC', url: 'https://www.inecnigeria.org/' },
    ],
  };
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}

let inflight = null;

/**
 * Cached upstream snapshot. Never throws: a stale cache beats an error page,
 * and an absent one just means the client falls back to the committed
 * political_data.json it already ships with.
 */
export async function upstream({ force = false } = {}) {
  const cached = readCache();
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS;
  if (cached && fresh && !force) return cached;
  if (inflight) return inflight;

  inflight = build()
    .then((data) => {
      try { fs.writeFileSync(CACHE, JSON.stringify(data, null, 2)); } catch { /* read-only fs is fine */ }
      return data;
    })
    .catch((e) => (cached ? { ...cached, staleError: String(e.message || e) } : null))
    .finally(() => { inflight = null; });

  return inflight;
}

/**
 * Compare a curated chamber against the upstream one. Returns the rows that
 * disagree, so the page can SAY so instead of quietly preferring one.
 */
export function diffChamber(curated = {}, live = {}) {
  const keys = [...new Set([...Object.keys(curated), ...Object.keys(live)])];
  return keys
    .filter((p) => (curated[p] || 0) !== (live[p] || 0))
    .map((p) => ({ party: p, ours: curated[p] || 0, wikipedia: live[p] || 0 }));
}
