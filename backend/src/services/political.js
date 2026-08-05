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
/**
 * Bump when the cached SHAPE changes. Without this, adding a field ships a
 * feature that silently does nothing for up to TTL: the members work returned
 * an empty object in production purely because a pre-members snapshot was still
 * inside its window. A shape change must invalidate, not wait.
 */
const SCHEMA = 3;
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

/**
 * Sitting members from the National Assembly's own portal.
 *
 * nass.gov.ng renders its member tables with DataTables in server-side mode,
 * so the page HTML is an empty <table> and the data comes from
 * /mps/get_legislators/. That endpoint takes the DataTables query contract;
 * `length` is the page size, so one call with a large length returns the lot.
 *
 * IT IS INCOMPLETE, and callers must treat it that way. Measured 2026-08-05,
 * `recordsTotal` was 74 for the Senate (of 109) and 246 for the House (of 360)
 * — that is NASS's own published figure, not a paging artefact. So this names
 * the seats it can and leaves the rest unnamed rather than inventing them.
 */
const NASS = 'https://nass.gov.ng/mps/get_legislators/?chamber={c}&draw=1&start=0&length=500';
const CHAMBER = { senate: 1, house: 2 };

async function nassMembers(chamber) {
  const r = await fetch(NASS.replace('{c}', CHAMBER[chamber]), {
    headers: {
      'user-agent': UA,
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://nass.gov.ng/mps/senators',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`nass ${chamber}: HTTP ${r.status}`);
  const j = await r.json();
  const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const rows = (j.data || [])
    .map((row) => ({
      name: clean(row[0]),
      state: clean(row[1]),
      district: clean(row[2]),
      party: clean(row[3]).toUpperCase(),
      id: clean(row[4]) || null,
    }))
    .filter((m) => m.name);
  return { listed: rows.length, official: j.recordsTotal ?? rows.length, members: rows };
}

/**
 * Presiding officers, read from Wikipedia's leadership tables rather than
 * hardcoded.
 *
 * The NASS members endpoint carries no role column, and the roster pages the
 * owner pointed at turn out not to be full rosters — the Senate one is 16 rows,
 * the leadership table. That makes them the wrong source for names but the
 * RIGHT one for offices: each row states the post outright ("Senate President",
 * "Deputy Speaker", "House Majority Leader"). Reading them means a leadership
 * change flows through on the next pull instead of waiting on a code edit.
 */
const LEADER_PAGES = {
  senate: 'Nigerian_senators_of_the_10th_National_Assembly',
  // Raw en-dash, NOT %E2%80%93: wiki() runs encodeURIComponent, and a
  // pre-encoded title came back double-encoded, so the House pull silently
  // found zero offices while the Senate (no escapes in its title) worked.
  house: 'List_of_members_of_the_House_of_Representatives_of_Nigeria,_2023\u20132027',
};
const OFFICE_RE = /^(Senate President|Deputy Senate President|Speaker of the House|Deputy Speaker of the House|Senate (?:Majority|Minority) Leader|House (?:Majority|Minority) Leader|Senate Chief Whip|Chief Whip)/i;

function leaders(text) {
  const out = [];
  for (const block of text.matchAll(/\n\|-\s*\n\|(.+?)(?=\n\|-|\n\|\})/gs)) {
    const cells = block[1].split(/\|\||\n\|/).map((c) => c.trim());
    const office = (cells[0] || '').replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').trim();
    if (!OFFICE_RE.test(office)) continue;
    // {{sortname|First|Last}} is how these tables carry a person.
    const joined = cells.join(' | ');
    const sn = /\{\{sortname\|([^}|]*)\|([^}|]*)/.exec(joined);
    const name = sn ? `${sn[1].trim()} ${sn[2].trim()}`.replace(/\s+/g, ' ').trim() : '';
    // The constituency cell is the only field both rosters carry uniquely.
    const dm = /(?:Federal Constituency|Senatorial District|District)/i.exec(joined);
    let district = '';
    if (dm) {
      const around = joined.slice(Math.max(0, dm.index - 60), dm.index + 30)
        .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2');
      district = (around.split('|').pop() || '').trim();
    }
    if (name) out.push({ office, name, district });
  }
  return out;
}

/**
 * Join Wikipedia's office list onto the NASS rows.
 *
 * SURNAME ALONE IS NOT ENOUGH, and getting this wrong is worse than leaving it
 * blank. The first attempt matched "Barau Jibrin" (Deputy Senate President)
 * against a different sitting senator, "Jibrin Isah", and confidently ringed
 * the wrong seat. So a match now needs either the constituency — which both
 * sources carry and which is unique — or at least two shared name tokens, e.g.
 * Wikipedia's "Barau Jibrin" against NASS's "Ibrahim Barau Jibrin". Anything
 * less is left unringed.
 */
const nameTokens = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
const normDistrict = (s) => String(s || '').toLowerCase()
  .replace(/federal constituency|senatorial district/g, '').replace(/[^a-z]/g, '');

function tagPrincipals(members, offices) {
  for (const { office, name, district } of offices) {
    const want = nameTokens(name);
    const wd = normDistrict(district);
    const hit = members.find((m) => {
      if (m.office) return false;
      if (wd && normDistrict(m.district) === wd) return true;
      const have = new Set(nameTokens(m.name));
      return want.filter((t) => have.has(t)).length >= 2;
    });
    if (hit) hit.office = office;
  }
  return members;
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

  // Members are a bonus too — a chamber still renders from seat counts alone.
  const members = {};
  await Promise.all(Object.keys(CHAMBER).map(async (c) => {
    try {
      const m = await nassMembers(c);
      let offices = [];
      try { offices = leaders((await wiki(LEADER_PAGES[c])).text); } catch { /* no rings */ }
      members[c] = { ...m, members: tagPrincipals(m.members, offices), offices };
    } catch { /* leave the chamber unnamed */ }
  }));

  return {
    schema: SCHEMA,
    fetchedAt: new Date().toISOString(),
    revid: na.revid,
    chambers: {
      ...(senate ? { senate: { label: 'Senate', size: 109, parties: senate } } : {}),
      ...(house ? { house: { label: 'House of Representatives', size: 360, parties: house } } : {}),
    },
    members,
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
  const fresh = cached && cached.schema === SCHEMA
    && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS;
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
