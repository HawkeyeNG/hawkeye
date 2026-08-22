/**
 * races.ts — the authoritative catalogue of every elective race Hawkeye covers
 * in a Nigerian general election (the January 2027 general election is the
 * target). Both the live-reporting picker and the practice picker import this.
 *
 * An observer selects their race from this data. A missing constituency means
 * someone cannot report; a wrong one means a report filed against the wrong
 * race. Accuracy is the whole point — where a name could not be sourced with
 * confidence it is marked unavailable rather than invented (state assembly
 * constituency names, below).
 *
 * ── Totals (validated at the bottom of this file, and by tools/validate) ──
 *   Presidential            1   national race
 *   Governorship           36   states (FCT elects no governor)
 *   Senate                109   senatorial districts (36 states x 3 + FCT "Abuja")
 *   House of Reps         360   federal constituencies
 *   State Assembly      1019   state constituencies (FCT has none — Area Councils)
 *                             993 until 2026, then 26 suppressed seats were
 *                             restored by court judgment across Benue, Delta,
 *                             Jigawa and Kogi — INEC press releases of 10 June
 *                             and 14 August 2026.
 *
 * ── Contest matching ──
 * Each concrete race carries `contestCode` (one of PRES/GOV/SEN/REP/SHA) and,
 * where applicable, `state`. To decide OPEN/closed, match against the objects
 * returned by GET /api/contests (see backend/src/routes/national.js and
 * backend/src/data/contests.json): a contest has a `code`, a `states[]` array
 * and a computed `open` flag. The one live contest today is GOV / Osun.
 * `matchContest()` / `isRaceOpen()` at the bottom implement the match.
 *
 * ── Sources (per figure) ──
 *   State register spellings (the 37 `StateName` keys): backend hawkeye.db
 *     polling_units.state (DISTINCT) — the exact strings reports are keyed on.
 *   Senatorial districts (109): standard INEC set, cross-checked against
 *     backend/src/data/district_index.json (which yields 111 only because two
 *     rows are cross-state contaminated: a Kaduna LGA tagged "Kano South" and
 *     Kano LGAs tagged "Kaduna North" — corrected here).
 *   Federal constituencies (360): district_index.json groupings (LGA→
 *     constituency, which are correct) reconciled to 360 and de-typo'd, with
 *     Lagos (24), Rivers (13) and Borno (10) replaced by their Wikipedia
 *     per-state election lists (district_index undercounts those three:
 *     20/12/9 because it keys by LGA and cannot represent split LGAs or the
 *     Maiduguri Metropolitan seat, whose row had a null federal value).
 *   State-assembly constituencies (993, named): INEC 2023 final candidates list
 *     for State Elections (its preface states 993 constituencies). Benue (32)
 *     and Borno (28) follow INEC, not the Wikipedia table that had both at 30
 *     — the two errors offset, so the 993 total hid the transposition.
 *   [superseded] earlier seat counts: per-state table, corrected for Kaduna
 *     (34, per the dedicated Kaduna State House of Assembly source and IFES
 *     993 national total; the stale summary table listed 31). FCT has none.
 *   State-constituency LOCATIONS (`ASSEMBLY_LOCATIONS`, all 993 — see that
 *     block's own comment for the shape). Three merged sources, in order of
 *     precedence, with per-entry `provenance` recording which one won:
 *       1. `corrected` (10) — a match audit of the auto-matcher's output, which
 *          found a dict-collision bug that silently attached "X South"
 *          constituencies to the "X North" LGA, plus a compound-split bug that
 *          dropped a real second LGA. Each correction was confirmed by per-state
 *          LGA-vs-seat arithmetic (Delta 25/29, Ebonyi 13/24, Kano 44/40,
 *          Osun 30/26, Plateau 17/24 reconcile only with these applied).
 *       2. `researched` (59) — constituencies no string match could reach,
 *          resolved from the Nigeria Civil Society Situation Room 2015 Election
 *          Guide (INEC-derived, one PDF per state), whose STATE CONSTITUENCIES
 *          tables give each seat's component wards and collation centre;
 *          ward-count arithmetic acted as the checksum. 58 high confidence,
 *          1 medium (Taraba "Donda" -> Donga LGA, by elimination).
 *       3. `auto-matched` (922) — normalised string match of the INEC
 *          constituency name against the register's own LGA spellings.
 *       `suspect` (2) — Abia "Umuahia East" (audit's proposal taken, cites the
 *          sitting member's LGA but no INEC delimitation source) and Abia
 *          "Aba Central" (auto value retained, explicitly NOT audited).
 *       `unresolved` (0 of 993) — every constituency now has at least one LGA.
 *     Centroids: median latitude and median longitude (median per axis, not a
 *     mean — the register has mis-keyed outliers) over every polling unit in the
 *     constituency's LGA set, taking each unit's best coordinate in the order
 *     official `lat/lng` > `crowd_lat/lng` > GRID3-envelope `approx_lat/lng`,
 *     BUT with `crowd_*` gated on plausibility — see the next paragraph, this
 *     matters. `unitsBacking` and `coordTier` expose how strong each centroid
 *     is; 992 of 993 have one. The exception is Ogun "Egbado South" —
 *     its LGA has 257 registered units and not one carries any coordinate, so
 *     the centroid is left `undefined` rather than faked to 0,0 or the state
 *     centre. A centroid is LGA-granular, so two constituencies inside one LGA
 *     share a point (Abia "Osisioma North"/"Osisioma South") — it locates the
 *     seat within its state, it does not delineate it.
 *
 * ── polling_units.crowd_lat/crowd_lng is partly corrupt (open backend bug) ──
 * Do not use that column raw, here or anywhere else. Building these centroids
 * surfaced it: 30,018 of 117,159 units carrying a crowd coordinate (26%) sit
 * more than 25 km from the SAME ROW's `approx_lat/lng`, and the displacement is
 * not noise but a whole-block shift — each affected state's crowd cloud lands on
 * top of a different state, roughly one step along an alphabetical ordering
 * (Sokoto's lands in Rivers, Taraba's in Sokoto, Yobe's in Taraba, Kwara's in
 * Kogi, Kogi's in Kebbi, Kebbi's in Katsina, Jigawa's in Imo). Twelve states are
 * affected; the rest agree closely (the national median crowd-vs-approx distance
 * is 2.7 km, and 75% are within 10 km). Also `crowd_reports` is 0 on ALL 117,159
 * of those rows, so despite the column name none of them is actually backed by an
 * observer report.
 * Taken raw this put Sokoto "Sokoto North I" in the Niger Delta. So each unit's
 * crowd coordinate is accepted only if it is within 25 km of that same unit's own
 * approx coordinate (or, for the 7,652 units with crowd but no approx, within
 * 50 km of their LGA's approx median); otherwise the unit falls through to approx.
 * That rejected 30,018 units and left 87,141 crowd + 80,642 approx + the 8 real
 * official fixes behind the 992 centroids. Every resulting centroid was then
 * checked to fall inside its own state's approx footprint, and capital-LGA seats
 * were spot-checked against known city coordinates. When the backend column is
 * fixed, rerun the centroid build — the gate is a workaround, not a fix, and
 * anything else in the app reading `crowd_lat/lng` (nearby-unit discovery, maps)
 * is still exposed to the same bug.
 */

export type ElectionTypeCode = 'PRES' | 'GOV' | 'SEN' | 'REP' | 'SHA';

/** The fields a picker must resolve, in order, to reach a single race. */
export type NarrowField = 'state' | 'district' | 'constituency' | 'seat';

export interface ElectionType {
  code: ElectionTypeCode;
  /** Menu label. */
  label: string;
  /** What a single winner of this race holds. */
  seatLabel: string;
  /** Selection path for the picker. [] = the race is the whole nation. */
  narrowBy: NarrowField[];
  /** Total elective seats nationwide. */
  seats: number;
}

export const ELECTION_TYPES: readonly ElectionType[] = [
  { code: 'PRES', label: 'Presidential',              seatLabel: 'President',              narrowBy: [],                        seats: 1 },
  { code: 'GOV',  label: 'Governorship',              seatLabel: 'Governor',               narrowBy: ['state'],                 seats: 36 },
  { code: 'SEN',  label: 'Senate',                    seatLabel: 'Senator',                narrowBy: ['state', 'district'],     seats: 109 },
  { code: 'REP',  label: 'House of Representatives',   seatLabel: 'Member (Rep)',           narrowBy: ['state', 'constituency'], seats: 360 },
  { code: 'SHA',  label: 'State House of Assembly',    seatLabel: 'Member (State)',         narrowBy: ['state', 'seat'],         seats: 993 },
] as const;

/** Register spellings — must string-match polling_units.state exactly. */
export type StateName =
  | 'Abia' | 'Adamawa' | 'Akwa Ibom' | 'Anambra' | 'Bauchi' | 'Bayelsa'
  | 'Benue' | 'Borno' | 'Cross River' | 'Delta' | 'Ebonyi' | 'Edo' | 'Ekiti'
  | 'Enugu' | 'FCT' | 'Gombe' | 'Imo' | 'Jigawa' | 'Kaduna' | 'Kano'
  | 'Katsina' | 'Kebbi' | 'Kogi' | 'Kwara' | 'Lagos' | 'Nasarawa' | 'Niger'
  | 'Ogun' | 'Ondo' | 'Osun' | 'Oyo' | 'Plateau' | 'Rivers' | 'Sokoto'
  | 'Taraba' | 'Yobe' | 'Zamfara';

/** All 37 register keys (36 states + FCT), alphabetical as in the register. */
export const STATES: readonly StateName[] = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue',
  'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT',
  'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi',
  'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo',
  'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
] as const;

/** The 36 states that elect a governor. FCT does not. */
export const GOVERNORSHIP_STATES: readonly StateName[] = STATES.filter((s) => s !== 'FCT');

/**
 * Senatorial districts, 3 per state + FCT's single "Abuja". Total 109.
 * FCT's register value for this field is the bare string "Abuja".
 */
export const SENATORIAL_DISTRICTS: Record<StateName, string[]> = {
  'Abia': ['Abia North', 'Abia Central', 'Abia South'],
  'Adamawa': ['Adamawa North', 'Adamawa Central', 'Adamawa South'],
  'Akwa Ibom': ['Akwa Ibom North-East', 'Akwa Ibom North-West', 'Akwa Ibom South'],
  'Anambra': ['Anambra North', 'Anambra Central', 'Anambra South'],
  'Bauchi': ['Bauchi North', 'Bauchi Central', 'Bauchi South'],
  'Bayelsa': ['Bayelsa East', 'Bayelsa Central', 'Bayelsa West'],
  'Benue': ['Benue North-East', 'Benue North-West', 'Benue South'],
  'Borno': ['Borno North', 'Borno Central', 'Borno South'],
  'Cross River': ['Cross River North', 'Cross River Central', 'Cross River South'],
  'Delta': ['Delta North', 'Delta Central', 'Delta South'],
  'Ebonyi': ['Ebonyi North', 'Ebonyi Central', 'Ebonyi South'],
  'Edo': ['Edo North', 'Edo Central', 'Edo South'],
  'Ekiti': ['Ekiti North', 'Ekiti Central', 'Ekiti South'],
  'Enugu': ['Enugu East', 'Enugu North', 'Enugu West'],
  'FCT': ['Abuja'],
  'Gombe': ['Gombe North', 'Gombe Central', 'Gombe South'],
  'Imo': ['Imo East', 'Imo North', 'Imo West'],
  'Jigawa': ['Jigawa North-East', 'Jigawa North-West', 'Jigawa South-West'],
  'Kaduna': ['Kaduna North', 'Kaduna Central', 'Kaduna South'],
  'Kano': ['Kano North', 'Kano Central', 'Kano South'],
  'Katsina': ['Katsina North', 'Katsina Central', 'Katsina South'],
  'Kebbi': ['Kebbi North', 'Kebbi Central', 'Kebbi South'],
  'Kogi': ['Kogi East', 'Kogi Central', 'Kogi West'],
  'Kwara': ['Kwara North', 'Kwara Central', 'Kwara South'],
  'Lagos': ['Lagos East', 'Lagos Central', 'Lagos West'],
  'Nasarawa': ['Nasarawa North', 'Nasarawa South', 'Nasarawa West'],
  'Niger': ['Niger East', 'Niger North', 'Niger South'],
  'Ogun': ['Ogun East', 'Ogun Central', 'Ogun West'],
  'Ondo': ['Ondo North', 'Ondo Central', 'Ondo South'],
  'Osun': ['Osun East', 'Osun Central', 'Osun West'],
  'Oyo': ['Oyo North', 'Oyo Central', 'Oyo South'],
  'Plateau': ['Plateau North', 'Plateau Central', 'Plateau South'],
  'Rivers': ['Rivers East', 'Rivers West', 'Rivers South-East'],
  'Sokoto': ['Sokoto East', 'Sokoto North', 'Sokoto South'],
  'Taraba': ['Taraba North', 'Taraba Central', 'Taraba South'],
  'Yobe': ['Yobe East', 'Yobe North', 'Yobe South'],
  'Zamfara': ['Zamfara Central', 'Zamfara North', 'Zamfara West'],
};

/**
 * Federal constituencies (House of Representatives), grouped by state. Total 360.
 * Names use the "LGA/LGA" grouping style INEC uses. See the header for how the
 * three under-counted states were reconciled. A handful of names carry residual
 * spelling variants from the source that could not be independently pinned down
 * — flagged in the delivery report (Niger "Kontagora/Wushishi/Mariga/Mashegu",
 * Delta "Warri", Taraba "Donga/Ussa/Takum").
 */
export const FEDERAL_CONSTITUENCIES: Record<StateName, string[]> = {
  'Abia': [
    'Aba North/Aba South', 'Arochukwu/Ohafia', 'Bende',
    'Ikwuano/Umuahia North/Umuahia South', 'Isiala Ngwa North/Isiala Ngwa South',
    'Isuikwuato/Umunneochi', 'Obingwa/Osisioma/Ugwunagbo', 'Ukwa East/Ukwa West',
  ],
  'Adamawa': [
    'Demsa/Numan/Lamurde', 'Fufore/Song', 'Jada/Ganye/Mayo Belwa/Toungo',
    'Guyuk/Shelleng', 'Hong/Gombi', 'Yola North/Yola South/Girei',
    'Michika/Madagali', 'Mubi North/Mubi South/Maiha',
  ],
  'Akwa Ibom': [
    'Abak/Etim Ekpo/Ika', 'Ikot Abasi/Mkpat Enin/Eastern Obolo',
    'Eket/Esit Eket/Onna/Ibeno', 'Ikot Ekpene/Essien Udim/Obot Akara',
    'Etinan/Nsit Ibom/Nsit Ubium', 'Uyo/Uruan/Nsit Atai/Ibesikpo Asutan',
    'Itu/Ibiono Ibom', 'Ikono/Ini',
    'Oron/Mbo/Okobo/Urue-Offong Oruko/Udung Uko', 'Ukanafun/Oruk Anam',
  ],
  'Anambra': [
    'Aguata', 'Anambra East/Anambra West', 'Anaocha/Njikoka/Dunukofia',
    'Awka North/Awka South', 'Oyi/Ayamelum', 'Nnewi North/Nnewi South/Ekwusigo',
    'Idemili North/Idemili South', 'Ihiala', 'Ogbaru',
    'Onitsha North/Onitsha South', 'Orumba North/Orumba South',
  ],
  'Bauchi': [
    'Alkaleri/Kirfi', 'Bauchi', 'Bogoro/Dass/Tafawa Balewa', 'Misau/Dambam',
    'Darazo/Ganjuwa', 'Gamawa', 'Shira/Giade', "Jama'are/Itas-Gadau",
    'Katagum', 'Ningi/Warji', 'Toro', 'Zaki',
  ],
  'Bayelsa': [
    'Brass/Nembe', 'Sagbama/Ekeremor', 'Yenagoa/Kolokuma-Opokuma', 'Ogbia',
    'Southern Ijaw',
  ],
  'Benue': [
    'Apa/Agatu', 'Ado/Ogbadibo/Okpokwu', 'Buruku', 'Gboko/Tarka',
    'Makurdi/Guma', 'Gwer East/Gwer West', 'Katsina-Ala/Ukum/Logo',
    'Vandeikya/Konshisha', 'Kwande/Ushongo', 'Oju/Obi', 'Otukpo/Ohimini',
  ],
  'Borno': [
    'Kukawa/Mobbar/Abadam/Guzamala', 'Askira-Uba/Hawul', 'Bama/Ngala/Kalabalge',
    'Biu/Bayo/Shani/Kwaya Kusar', 'Damboa/Gwoza/Chibok', 'Dikwa/Mafa/Konduga',
    'Kaga/Gubio/Magumeri', 'Jere', 'Maiduguri Metropolitan',
    'Monguno/Marte/Nganzai',
  ],
  'Cross River': [
    'Yakurr/Abi', 'Akamkpa/Biase', 'Akpabuyo/Bakassi/Calabar South',
    'Bekwarra/Obudu/Obanliku', 'Ikom/Boki', 'Calabar Municipal/Odukpani',
    'Obubra/Etung', 'Ogoja/Yala',
  ],
  'Delta': [
    'Aniocha North/Aniocha South/Oshimili North/Oshimili South', 'Bomadi/Patani',
    'Burutu', 'Ethiope East/Ethiope West', 'Ika North East/Ika South',
    'Isoko North/Isoko South', 'Ndokwa East/Ndokwa West/Ukwuani',
    'Okpe/Sapele/Uvwie', 'Ughelli North/Ughelli South/Udu', 'Warri',
  ],
  'Ebonyi': [
    'Abakaliki/Izzi', 'Afikpo North/Afikpo South', 'Ohaukwu/Ebonyi',
    'Ezza North/Ishielu', 'Ikwo/Ezza South', 'Ivo/Ohaozara/Onicha',
  ],
  'Edo': [
    'Akoko-Edo', 'Egor/Ikpoba-Okha', 'Esan Central/Esan West/Igueben',
    'Esan North-East/Esan South-East', 'Etsako East/Etsako West/Etsako Central',
    'Orhionmwon/Uhunmwonde', 'Oredo', 'Ovia South-West/Ovia North-East',
    'Owan West/Owan East',
  ],
  'Ekiti': [
    'Ado Ekiti/Irepodun-Ifelodun', 'Ijero/Ekiti West/Efon',
    'Emure/Gbonyin/Ekiti East', 'Ekiti South West/Ikere/Ise/Orun',
    'Ido-Osi/Moba/Ilejemeje', 'Ikole/Oye',
  ],
  'Enugu': [
    'Aninri/Awgu/Oji River', 'Enugu East/Isi-Uzo', 'Enugu North/Enugu South',
    'Ezeagu/Udi', 'Igbo-Etiti/Uzo-Uwani', 'Udenu/Igbo-Eze North',
    'Nsukka/Igbo-Eze South', 'Nkanu East/Nkanu West',
  ],
  'FCT': ['Kuje/Abaji/Gwagwalada/Kwali', 'Abuja Municipal/Bwari'],
  'Gombe': [
    'Akko', 'Balanga/Billiri', 'Dukku/Nafada', 'Gombe/Kwami/Funakaye',
    'Kaltungo/Shongom', 'Yamaltu-Deba',
  ],
  'Imo': [
    'Aboh Mbaise/Ngor Okpala', 'Ahiazu Mbaise/Ezinihitte',
    'Ehime Mbano/Ihitte Uboma/Obowo', 'Ideato North/Ideato South',
    'Mbaitoli/Ikeduru', 'Isiala Mbano/Okigwe/Onuimo',
    'Isu/Njaba/Nkwerre/Nwangele', 'Oguta/Ohaji-Egbema/Oru West',
    'Orlu/Oru East/Orsu', 'Owerri Municipal/Owerri North/Owerri West',
  ],
  'Jigawa': [
    'Hadejia/Kafin Hausa/Auyo', 'Babura/Garki', 'Birniwa/Guri/Kiri Kasamma',
    'Birnin Kudu/Buji', 'Dutse/Kiyawa',
    'Gumel/Maigatari/Sule Tankarkar/Gagarawa', 'Gwaram',
    'Kazaure/Roni/Gwiwa/Yankwashi', 'Miga/Jahun', 'Mallam Madori/Kaugama',
    'Ringim/Taura',
  ],
  'Kaduna': [
    'Birnin Gwari/Giwa', 'Chikun/Kajuru', 'Igabi', 'Ikara/Kubau',
    'Zangon Kataf/Jaba', "Jema'a/Sanga", 'Kachia/Kagarko', 'Kaduna North',
    'Kaduna South', 'Kaura', 'Kauru', 'Makarfi/Kudan', 'Lere', 'Sabon Gari',
    'Soba', 'Zaria',
  ],
  'Kano': [
    'Albasu/Gaya/Ajingi', 'Bagwai/Shanono', 'Bebeji/Kiru', 'Bichi',
    'Rano/Bunkure/Kibiya', 'Dala', 'Dambatta/Makoda', 'Dawakin Kudu/Warawa',
    'Dawakin Tofa/Tofa/Rimin Gado', 'Tudun Wada/Doguwa', 'Fagge',
    'Gezawa/Gabasawa', 'Wudil/Garko', 'Kura/Madobi/Garun Malam', 'Gwale',
    'Gwarzo/Kabo', 'Kano Municipal', 'Karaye/Rogo', 'Kumbotso',
    'Tsanyawa/Kunchi', 'Minjibir/Ungogo', 'Nassarawa', 'Sumaila/Takai',
    'Tarauni',
  ],
  'Katsina': [
    'Bakori/Danja', 'Rimi/Charanchi/Batagarawa', 'Safana/Dan Musa/Batsari',
    'Baure/Zango', 'Mani/Bindawa', 'Funtua/Dandume', "Daura/Sandamu/Mai'Adua",
    'Mashi/Dutsi', 'Dutsin-Ma/Kurfi', 'Kankara/Sabuwa/Faskari',
    'Kankia/Ingawa/Kusada', 'Kaita/Jibia', 'Malumfashi/Kafur', 'Katsina',
    'Musawa/Matazu',
  ],
  'Kebbi': [
    'Gwandu/Aliero/Jega', 'Arewa/Dandi', 'Argungu/Augie', 'Bagudo/Suru',
    'Birnin Kebbi/Kalgo/Bunza', 'Zuru/Fakai/Sakaba/Danko-Wasagu',
    'Maiyama/Koko-Besse', 'Yauri/Shanga/Ngaski',
  ],
  'Kogi': [
    'Adavi/Okehi', 'Ajaokuta', 'Ankpa/Omala/Olamaboro', 'Dekina/Bassa',
    'Idah/Ibaji/Igalamela-Odolu/Ofu', 'Kabba-Bunu/Ijumu',
    'Lokoja/Koton Karfe/Kogi', 'Yagba East/Yagba West/Mopa-Muro',
    'Okene/Ogori-Magongo',
  ],
  'Kwara': [
    'Asa/Ilorin West', 'Baruten/Kaiama', 'Edu/Moro/Patigi',
    'Ekiti/Isin/Irepodun/Oke-Ero', 'Offa/Oyun/Ifelodun',
    'Ilorin East/Ilorin South',
  ],
  'Lagos': [
    'Agege', 'Ajeromi-Ifelodun', 'Alimosho', 'Amuwo Odofin', 'Apapa',
    'Badagry', 'Epe', 'Eti-Osa', 'Ibeju-Lekki', 'Ifako-Ijaiye', 'Ikeja',
    'Ikorodu', 'Kosofe', 'Lagos Island I', 'Lagos Island II', 'Lagos Mainland',
    'Mushin I', 'Mushin II', 'Ojo', 'Oshodi-Isolo I', 'Oshodi-Isolo II',
    'Somolu', 'Surulere I', 'Surulere II',
  ],
  'Nasarawa': [
    'Akwanga/Nasarawa Eggon/Wamba', 'Awe/Doma/Keana', 'Karu/Keffi/Kokona',
    'Lafia/Obi', 'Nasarawa/Toto',
  ],
  'Niger': [
    'Agaie/Lapai', 'Agwara/Borgu', 'Bida/Gbako/Katcha', 'Bosso/Paikoro',
    'Chanchaga', 'Lavun/Mokwa/Edati', 'Gurara/Suleja/Tafa',
    'Kontagora/Wushishi/Mariga/Mashegu', 'Magama/Rijau', 'Shiroro/Rafi/Munya',
  ],
  'Ogun': [
    'Abeokuta North/Obafemi-Owode/Odeda', 'Abeokuta South', 'Ado-Odo/Ota',
    'Imeko Afon/Yewa North', 'Yewa South/Ipokia', 'Ifo/Ewekoro',
    'Ijebu North/Ijebu East/Ogun Waterside', 'Ijebu Ode/Odogbolu/Ijebu North East',
    'Ikenne/Sagamu/Remo North',
  ],
  'Ondo': [
    'Akoko North East/Akoko North West', 'Akoko South East/Akoko South West',
    'Akure North/Akure South', 'Ese-Odo/Ilaje', 'Idanre/Ifedore',
    'Ile-Oluji-Okeigbo/Odigbo', 'Okitipupa/Irele', 'Ondo East/Ondo West',
    'Owo/Ose',
  ],
  'Osun': [
    'Atakunmosa East/Atakunmosa West/Ilesa East/Ilesa West',
    'Ayedaade/Irewole/Isokan', 'Ayedire/Iwo/Ola-Oluwa',
    'Boluwaduro/Ifedayo/Ila', 'Odo-Otin/Ifelodun/Boripe',
    'Ede North/Ede South/Egbedore/Ejigbo',
    'Ife Central/Ife East/Ife North/Ife South',
    'Irepodun/Olorunda/Osogbo/Orolu', 'Obokun/Oriade',
  ],
  'Oyo': [
    'Afijio/Atiba/Oyo East/Oyo West', 'Lagelu/Akinyele',
    'Atisbo/Saki East/Saki West', 'Ona-Ara/Egbeda', 'Ibadan North',
    'Ibadan North-East/Ibadan South-East', 'Ibadan North West/Ibadan South West',
    'Ibarapa Central/Ibarapa North', 'Ibarapa East/Ido',
    'Irepo/Olorunsogo/Orelope', 'Iseyin/Kajola/Iwajowa/Itesiwaju',
    'Ogbomoso North/Ogbomoso South/Orire', 'Ogo-Oluwa/Surulere', 'Oluyole',
  ],
  'Plateau': [
    'Mangu/Bokkos', 'Barkin Ladi/Riyom', 'Bassa/Jos North', 'Jos South/Jos East',
    'Pankshin/Kanke/Kanam', 'Langtang North/Langtang South',
    "Mikang/Qua'an Pan/Shendam", 'Wase',
  ],
  'Rivers': [
    'Abua/Odual/Ahoada East', 'Ahoada West/Ogba-Egbema-Ndoni',
    'Akuku-Toru/Asari-Toru', 'Andoni/Opobo-Nkoro', 'Degema/Bonny',
    'Eleme/Tai/Oyigbo', 'Etche/Omuma', 'Ikwerre/Emohua', 'Khana/Gokana',
    'Obio/Akpor', 'Okrika/Ogu-Bolo', 'Port Harcourt I', 'Port Harcourt II',
  ],
  'Sokoto': [
    'Binji/Silame', 'Bodinga/Dange-Shuni/Tureta', 'Goronyo/Gada',
    'Gudu/Tangaza', 'Gwadabawa/Illela', 'Sabon Birni/Isa', 'Kebbe/Tambuwal',
    'Kware/Wamakko', 'Wurno/Rabah', 'Shagari/Yabo', 'Sokoto North/Sokoto South',
  ],
  'Taraba': [
    'Lau/Karim Lamido/Ardo Kola', 'Bali/Gassol', 'Donga/Ussa/Takum',
    'Gashaka/Kurmi/Sardauna', 'Ibi/Wukari', 'Jalingo/Yorro/Zing',
  ],
  'Yobe': [
    'Bade/Jakusko', 'Bursari/Geidam/Yunusari', 'Damaturu/Gujba/Gulani/Tarmuwa',
    'Fika/Fune', 'Machina/Nguru/Karasuwa/Yusufari', 'Nangere/Potiskum',
  ],
  'Zamfara': [
    'Anka/Talata Mafara', 'Bakura/Maradun', 'Kaura Namoda/Birnin Magaji',
    'Gummi/Bukkuyum', 'Bungudu/Maru', 'Gusau/Tsafe', 'Shinkafi/Zurmi',
  ],
};

export interface AssemblyInfo {
  /** State constituency seat count (single-member). */
  seats: number;
  /**
   * Named constituencies, or null where a reliable per-seat name list could
   * not be sourced. Deliberately not invented — see the header note.
   */
  constituencies: string[] | null;
  note?: string;
}

/**
 * State Houses of Assembly. Per-state seat counts total 993; FCT has no
 * Assembly (Area Councils instead). Constituency names are marked unavailable
 * (null) pending a per-seat source — the count is authoritative, the names are
 * not yet sourced and are not invented.
 */
export const STATE_ASSEMBLY: Record<StateName, AssemblyInfo> = {
  'Abia': { seats: 24, constituencies: ['Aba South', 'Ukwa East', 'Ikwuano', 'Osisioma North', 'Osisioma South', 'Umuahia Central', 'Umuahia North', 'Ohafia South', 'Isiala Ngwa North', 'Umunneochi', 'Aba Central', 'Bende South', 'Ugwunaagbo', 'Bende North', 'Isuikwuato', 'Obingwa East', 'Aba North', 'Umuahia East', 'Ukwa West', 'Arochukwu', 'Isiala Ngwa South', 'Umuahia South', 'Obingwa West', 'Ohafia North'] },
  'Adamawa': { seats: 25, constituencies: ['Yola North', 'Fufore/Gurin (Fufore I)', 'Mubi North', 'Verre (Fufore II)', 'Koma/Leko (Jada I)', 'Hong (Hong II)', 'Nassarawo/Binyeri (Mayo Belwa I)', 'Lamurde', 'Girei', 'Shelleng', 'Gombi', 'Mubi South', 'Song', 'Michika', 'Jada/Mbulo (Jada II)', 'Maiha', 'Numan', 'Ganye', 'Toungo', 'Uba/Gaya (Hong I)', 'Mayo-Belwa (Mayo Belwa II)', 'Madagali', 'Guyuk', 'Demsa', 'Yola South'] },
  'Akwa Ibom': { seats: 26, constituencies: ['Esit Eket/Ibeno', 'Ikot Ekpene/Obot Akara', 'Etim Ekpo/Ika', 'Nsit Ubium', 'Itu', 'Nsit Atai', 'Uruan', 'Okobo', 'Ukanafun', 'Ibiono Ibom', 'Essien Udim', 'Uyo', 'Ini', 'Urue Offong/Oruko', 'Ikot Abasi/Eastern Obolo', 'Ikono', 'Onna', 'Etinan', 'Ibesikpo Asutan', 'Abak', 'Mkpat Enin', 'Oron/Udung Uko', 'Oruk Anam', 'Eket', 'Nsit Ibom', 'Mbo'] },
  'Anambra': { seats: 30, constituencies: ['Awka North', 'Onitsha North II', 'Ogbaru II', 'Onitsha North I', 'Aguata I', 'Ihiala II', 'Oyi', 'Idemili North', 'Orumba North', 'Nnewi South II', 'Awka South II', 'Ihiala I', 'Ayamelum', 'Nnewi South I', 'Orumba South', 'Anaocha II', 'Nnewi North', 'Aguata II', 'Anambra West', 'Ogbaru I', 'Anaocha I', 'Njikoka I', 'Ekwusigo', 'Njikoka II', 'Idemili South', 'Awka South I', 'Anambra East', 'Onitsha South II', 'Onitsha South I', 'Dunukofia'] },
  'Bauchi': { seats: 31, constituencies: ['Zungur/Galambi (Bauchi II)', 'Bauchi (Bauchi I)', 'Sakwa (Zaki I)', 'Jama\'are', 'Ganjuwa West', 'Ganjuwa East', 'Sade (Darazo II)', 'Lere/Bula (Tafawa/balewa)', 'Katagum (Katagum I)', 'Darazo (Darazo I)', 'Dambam/Dagauda/Jalam', 'Burra (Ningi II)', 'Ningi (Ningi I)', 'Jama\'a/Toro (Toro II)', 'Bogoro', 'Kirfi', 'Azare (Zaki II)', 'Lame (Toro I)', 'Giade', 'Udubo (Gamawa I)', 'Madara/Chinade (Katagum II)', 'Gamawa (Gamawa II)', 'Duguri/Gwana (Alkaleri II)', 'Pali (Alkaleri I)', 'Warji', 'Shira I (Disina)', 'Dass', 'Itas/Gadau', 'Hardawa (Misau II)', 'Chiroma (Misau I)', 'Shira II (Shira)'] },
  'Bayelsa': { seats: 24, constituencies: ['Brass II', 'Kolokuma/Opokuma II', 'Brass III', 'Yenagoa III', 'Ekeremor I', 'Nembe III', 'Yenagoa I', 'Yenagoa II', 'Nembe I', 'Ekeremor II', 'Ogbia III', 'Nembe II', 'Ogbia II', 'Ogbia I', 'Kolokuma/Opokuma I', 'Sagbama III', 'Southern Ijaw IV', 'Ekeremor III', 'Sagbama I', 'Sagbama II', 'Southern Ijaw II', 'Southern Ijaw I', 'Southern Ijaw III', 'Brass I'] },
  'Benue': { seats: 37, constituencies: ['Adoka/Ugboju', 'Okpokwu', 'Kwande East', 'Otukpo/Akpa', 'Ogbadibo', 'Ado', 'Gwer East', 'Makurdi I (North)', 'Logo', 'Makurdi South', 'Vandeikya I', 'Kwande West', 'Tarka', 'Gboko West', 'Katsina-Ala West', 'Ukum I (Ngenev)', 'Mata (Ushongo I)', 'Katsina Ala East', 'Vandeikya II', 'Mbagwa (Ushongo II)', 'Obi', 'Oju I', 'Oju II', 'Agbatu', 'Guma (Guma I)', 'Ohimini', 'Konshisha I (Gaav)', 'Buruku', 'Agasha (Guma II)', 'Apa', 'Gboko I (East)', 'Gwer West', 'Nyamatsor', 'Ukum Afia', 'Konshisha III (Shangev-Tiev)', 'Makurdi III (South East)', 'Gboko III'] },
  'Borno': { seats: 28, constituencies: ['Maiduguri M.C', 'Konduga', 'Gwoza', 'Hawul', 'Askira', 'Bayo', 'Kukawa', 'Biu', 'Kwaya Kusar', 'Kala Balge', 'Kaga', 'Chibok', 'Jere', 'Damaboa', 'Mafa', 'Guzamala', 'Dikwa', 'Abadam', 'Ngala', 'Nganzai', 'Mobbar', 'Marte', 'Monguno', 'Bama II (Gulumba)', 'Bama I (Bama)', 'Magumeri', 'Gubio', 'Shani'] },
  'Cross River': { seats: 25, constituencies: ['Boki II', 'Calabar South I', 'Yala I', 'Yakurr I', 'Odukpani', 'Obudu', 'Obubra II', 'Obubra I', 'Obanleku', 'Ikom II', 'Ikom I', 'Etung', 'Calabar South II', 'Yakurr II', 'Akpabuyo', 'Abi', 'Bekwarra', 'Akamkpa II', 'Boki I', 'Calabar Municipal', 'Bakassi', 'Ogoja', 'Akamkpa I', 'Biase', 'Yala II'] },
  'Delta': { seats: 38, constituencies: ['Ughelli South', 'Burutu', 'Ndokwa East', 'Aniocha North', 'Ika North East', 'Burutu North', 'Ndokwa West', 'Ika South', 'Oshimili North', 'Aniocha South', 'Oshimili South', 'Udu', 'Uvwie', 'Isoko South I', 'Isoko South II', 'Patani', 'Ethiope West', 'Isoko North', 'Warri South II', 'Ughelli North I', 'Warri South-West', 'Warri South I', 'Ethiope East', 'Sapele', 'Warri North', 'Ukwuani', 'Ughelli North II', 'Bomadi', 'Okpe', 'Aniocha North II', 'Ika North East II', 'Sapele II', 'Ethiope West II', 'Warri South West II', 'Warri North II', 'Abraka', 'Isoko North II', 'Ughelli South II'] },
  'Ebonyi': { seats: 24, constituencies: ['Izzi West', 'Ezza South', 'Afikpo North West', 'Ikwo North', 'Ohaozara West', 'Afikpo North East', 'Ikwo South', 'Afikpo South East', 'Ishielu North', 'Izzi East', 'Ishielu South', 'Onicha West', 'Ohaozara East', 'Ezza North East', 'Abakaliki South', 'Ebonyi North West', 'Ohaukwu North', 'Ezza North West', 'Onicha East', 'Ohaukwu South', 'Afikpo South West', 'Abakaliki North', 'Ebonyi North East', 'Ivo'] },
  'Edo': { seats: 24, constituencies: ['Esan South East', 'Owan East', 'Uhunmwode', 'Esan Central', 'Orhionmwon II', 'Owan West', 'Ikpoba-Okha', 'Ovia North East I', 'Egor', 'Oredo West', 'Ovia North East II', 'Oredo East', 'Etsako West II', 'Etsako East', 'Esan North East II', 'Orhionmwon I', 'Akoko Edo II', 'Akoko Edo I', 'Esan North East I', 'Etsako Central', 'Etsako West I', 'Igueben', 'Esan West', 'Ovia South West'] },
  'Ekiti': { seats: 26, constituencies: ['Ekiti West II', 'Ado I', 'Ekiti East I', 'Moba II', 'Ekiti East II', 'Ado II', 'Irepodun/Ifelodun II', 'Ekiti South West I', 'Efon', 'Ido/Osi II', 'Ilejemeje', 'Ekiti South West II', 'Moba I', 'Emure', 'Ekiti West I', 'Irepodun/Ifelodun I', 'Ido/Osi I', 'Oye I', 'Ikere I', 'Oye II', 'Ikere II', 'Ijero', 'Gbonyin', 'Ise/Orun', 'Ikole I', 'Ikole II'] },
  'Enugu': { seats: 24, constituencies: ['Enugu North', 'Awgu South', 'Igbo-Eze North I', 'Nsukka East', 'Aniniri', 'Awgu North', 'Igbo-Etiti West', 'Udi North', 'Isi-Uzo', 'Enugu South I', 'Igbo-Eze South', 'Oji River', 'Nkanu West', 'Ezeagu', 'Nsukka West', 'Nkanu East', 'Udi South', 'Igbo-Eze North II', 'Enugu East II', 'Enugu East I', 'Enugu South II', 'Igbo-Etiti East', 'Udenu', 'Uzo Uwani'] },
  'FCT': { seats: 0, constituencies: null, note: 'FCT has no State House of Assembly — it is governed via six Area Councils.' },
  'Gombe': { seats: 24, constituencies: ['Kwami West', 'Kwami East', 'Akko North', 'Deba', 'Akko Central', 'Gombe North', 'Funakaye South', 'Yamaltu West', 'Billiri East', 'Funakaye North', 'Dukku South', 'Balanga South', 'Dukku North', 'Billiri West', 'Gombe South', 'Kaltungo West', 'Yamaltu East', 'Shongom', 'Balanga North', 'Nafada South', 'Nafada North', 'Kaltungo East', 'Pero Chonge', 'Akko West'] },
  'Imo': { seats: 27, constituencies: ['Ezinihitte', 'Orlu', 'Ideato South', 'Oguta', 'Owerri West', 'Ehime Mbano', 'Ngor Okpala', 'Nwangele', 'Owerri North', 'Ohaji/Egbema', 'Ikeduru', 'Owerri Municipal', 'Mbaitoli', 'Ideato North', 'Orsu', 'Oru East', 'Obowo', 'Okigwe', 'Onuimo', 'Ahiazu Mbaise', 'Isiala Mbano', 'Ihite/Uboma', 'Aboh Mbaise', 'Njaba', 'Nkwerre', 'Isu', 'Oru West'] },
  'Jigawa': { seats: 31, constituencies: ['Dutse', 'Gumel', 'Garki', 'Babura', 'Gwiwa', 'Kazaure', 'Kaugama', 'Kiri-Kasamma', 'Birniwa', 'Balangu', 'Kafin Hausa', 'Jahun', 'Hadejia', 'Fagam', 'Gwaram', 'Birnin Kudu', 'Guri', 'Buji', 'Kanya', 'Taura', 'Gagarawa', 'Maigatari', 'Roni', 'Auyo', 'Yankwashi', 'Mallam Madori', 'Ringim', 'Kiyawa', 'Miga', 'Sule-Tankarkar', 'Aujara'] },
  'Kaduna': { seats: 34, constituencies: ['Zaria Kewaye', 'Doka/Gabasawa', 'Unguwar Sanusi', 'Makera', 'Zaria City', 'Soba', 'Lere West', 'Igabi West', 'Kachia', 'Chikun I', 'Kawo', 'Tudun Wada', 'Jaba', 'Sabon Gari', 'Kudan', 'Sanga', 'Makarfi', 'Giwa West', 'Chawai/Kauru', 'Lere East', 'Igabi East', 'Kubau', 'Jema\'a', 'Basawa', 'Magajin Gari', 'Ikara', 'Zangon Kataf', 'Kakangi', 'Kajuru', 'Kagarko', 'Zonkwa', 'Giwa East', 'Kaura', 'Maigana'] },
  'Kano': { seats: 40, constituencies: ['Munjibir', 'Ajingi', 'Ungogo', 'Dawakin Kudu', 'Madobi', 'Bichi', 'Rimi Gado/Tofa', 'Dawakin Tofa', 'Bunkure', 'Takai', 'Kura/Gurun Mallam', 'Gaya', 'Nassarawa', 'Karaye', 'Kumbotso', 'Gabasawa', 'Gwarzo', 'Dala', 'Fagge', 'Rano', 'Gwale', 'Tsanyawa/Kunchi', 'Kibiya', 'Sumaila', 'Bebeji', 'Albasu', 'Kabo', 'Wudil', 'Shanono/Bagwai', 'Kano Municipal', 'Kiru', 'Rogo', 'Makoda', 'Tudun Wada', 'Tarauni', 'Dambatta', 'Doguwa', 'Gezawa', 'Garko', 'Warawa'] },
  'Katsina': { seats: 34, constituencies: ['Malumfashi East', 'Bakori', 'Batsari', 'Funtua', 'Mashi', 'Rimi', 'Kurfi', 'Dutsin-Ma', 'Safana', 'Faskari', 'Katsina', 'Mai\'adua', 'Sandamu', 'Bindawa', 'Dutsi', 'Musawa', 'Charanchi', 'Baure', 'Daura', 'Danja', 'Batagarawa', 'Sabuwa', 'Kusada', 'Zango', 'Kankia', 'Danmusa', 'Kafur', 'Kankara', 'Ingawa', 'Mani', 'Jibia', 'Kaita', 'Dandume', 'Matazu'] },
  'Kebbi': { seats: 24, constituencies: ['Yauri', 'Shanga', 'Fakai', 'Birnin Kebbi South', 'Birnin Kebbi North', 'Bagudo East', 'Wasagu/Danko East', 'Zuru', 'Jega', 'Sakaba', 'Ngaski', 'Gwandu', 'Koko/Besse', 'Wasagu/Danko West', 'Arewa', 'Bunza', 'Dandi', 'Kalgo', 'Argungu', 'Aleiro', 'Maiyama', 'Suru', 'Augie', 'Bagudo West'] },
  'Kogi': { seats: 36, constituencies: ['Kabba/Bunu', 'Ofu', 'Ankpa II', 'Bassa', 'Igalamela-Odolu', 'Idah', 'Adavi', 'Ibaji', 'Okene II (South)', 'Yagba West', 'Kogi (K.K)', 'Omala', 'Ijumu', 'Lokoja I', 'Okura', 'Yagba East', 'Mopamuro', 'Lokoja II', 'Olamaboro I', 'Dekina/Biraidu', 'Ajaokuta', 'Okene Town', 'Ankpa I', 'Okehi', 'Ogori/Magongo', 'Adavi East', 'Eika', 'Ajaokuta North', 'Bassa-Komu', 'Dekina Town & District', 'Ijumu II', 'Kabba-Bunu II', 'Koton Karfe II', 'Igalaogwa', 'Ogugu', 'Yagba West II'] },
  'Kwara': { seats: 24, constituencies: ['Oke-Ogun/Oyun II', 'Balogun/Ojumu/Offa I', 'Isin', 'Share/Oke-Ode Ifelodun II', 'Irepodun', 'Ekiti', 'Shawo/Essa/Offa II', 'Oke-Ero', 'Odo-Ogun/Oyun I', 'Omupo/Igbaja Ifelodun I', 'Patigi', 'Okuta/Ayashkira Barutin II', 'Oloru/Malete/Ipaiye/Moro II', 'Lanwa/Ejidongari/Moro I', 'Lafiagi/Edu', 'Kaiama/Wajibe/Kemanji/Kaiama II', 'Ilorin South', 'Ilorin East', 'Ilorin West/Ilorin West II', 'Ilorin Central/Ilorin West I', 'Gwanabe/Adena/Banni/Kaiama I', 'Onire/Owode', 'Afon', 'Ilesha/Gwanara Barutin I'] },
  'Lagos': { seats: 40, constituencies: ['Shomolu II', 'Agege I', 'Agege II', 'Ojo II', 'Amuwo Odofin I', 'Lagos Island II', 'Ifako/Ijaiye I', 'Ajeromi/Ifelodun II', 'Badagry II', 'Lagos Mainland II', 'Ikorodu I', 'Oshodi/Isolo I', 'Lagos Mainland I', 'Ifako/Ijaiye II', 'Ojo I', 'Oshodi/Isolo II', 'Apapa II', 'Eti-Osa II', 'Ikeja II', 'Alimosho II', 'Mushin II', 'Badagry I', 'Ikeja I', 'Alimosho I', 'Surulere II', 'Mushin I', 'Eti-Osa I', 'Epe II', 'Ikorodu II', 'Ajeromi/Ifelodun I', 'Amuwo Odofin II', 'Epe I', 'Kosofe I', 'Apapa I', 'Kosofe II', 'Shomolu I', 'Ibeju-Lekki I', 'Lagos Island I', 'Surulere I', 'Ibeju-Lekki II'] },
  'Nasarawa': { seats: 24, constituencies: ['Karshi/Uke', 'Akwanga South', 'Nasarawa-Eggon West', 'Keffi West', 'Keffi East', 'Wamba', 'Nasarawa-Eggon East', 'Karu/Gitata', 'Lafia North', 'Lafia Central', 'Akwanga North', 'Keana', 'Kokona East', 'Doma South', 'Kokona West', 'Obi I', 'Awe North', 'Awe South', 'Nasarawa West (Loki/udege)', 'Gadabuke/Toto (Toto I)', 'Nasarawa Central', 'Doma North', 'Obi II', 'Umaisha/Dausu (Toto II)'] },
  'Niger': { seats: 27, constituencies: ['Bosso', 'Gbako', 'Chanchanga', 'Bida I (North)', 'Kontagora I', 'Mashegu', 'Mariga', 'Magama', 'Lavun', 'Kotangora II', 'Bida II (South)', 'Lapai', 'Borgu', 'Suleja', 'Gurara', 'Katcha', 'Edatti', 'Agaie', 'Wushishi', 'Paikoro', 'Shiroro', 'Mokwa', 'Rijau', 'Agwara', 'Rafi', 'Munya', 'Tafa'] },
  'Ogun': { seats: 26, constituencies: ['Sagamu II Makun', 'Abeokuta North', 'Ogun Waterside', 'Ikenne', 'Ado/Odo/Ota I', 'Ifo II', 'Ijebu North I', 'Ijebu North II', 'Obafemi/Owode', 'Egbado South', 'Odeda Area', 'Ijebu-Ode', 'Remo North', 'Abeokuta South II', 'Ijebu East Area', 'Ifo I', 'Sagamu I Offin', 'Abeokuta South I', 'Idiroko Ipokia', 'Egbado North I', 'Ado-Odo/Ota II', 'Ijebu North East', 'Imeko-Afon', 'Ewekoro', 'Odogbolu', 'Egbado North II'] },
  'Ondo': { seats: 26, constituencies: ['Ilaje I', 'Akoko North West II', 'Akoko South East', 'Akoko South West I', 'Akoko South West II', 'Akure North', 'Akure South I', 'Akure South II', 'Ese Odo', 'Ifedore', 'Okitipupa II', 'Owo I', 'Ilaje II', 'Odigbo II', 'Okitipupa I', 'Owo II', 'Idanre', 'Akoko North West I', 'Akoko North East', 'Ile Oluji/Oke Igbo', 'Ondo West I', 'Irele', 'Ose', 'Odigbo I', 'Ondo West II', 'Ondo East'] },
  'Osun': { seats: 26, constituencies: ['Ayedire', 'Ifelodun', 'Iwo', 'Odo-Otin', 'Ayedade', 'Ifedayo', 'Irepodun/Orulu', 'Boripe/Boluwa-Duro', 'Ife East', 'Egbedore', 'Ede South', 'Ejigbo', 'Ife North', 'Oriade', 'Ife Central', 'Osogbo', 'Ilesa West', 'Ede North', 'Olorunda', 'Ila', 'Ola-Oluwa', 'Irewole/Isokan', 'Obokun', 'Atakunmosa East and West', 'Ilesa East', 'Ife South'] },
  'Oyo': { seats: 32, constituencies: ['Ibadan South West II', 'Iwajowa', 'Oorelope', 'Saki West', 'Ibarapa North & Ibarapa Central', 'Ibadan North-East II', 'Oluyole', 'Kajola', 'Akinyele II', 'Oyo West/Oyo East', 'Ibadan North I', 'Egbeda', 'Lagelu', 'Saki East and Atisbo', 'Ogbomoso South', 'Atiba', 'Ibadan South-West I', 'Ogbomoso North', 'Ibarapa East', 'Oriire', 'Ibadan North West', 'Ido', 'Irepo & Olorunsogo', 'Akinyele I', 'Afijio', 'Ibadan North II', 'Ibadan South-East II', 'Iseyin and Itesiwaju', 'Ona-Ara', 'Ogo-Oluwa/Surulere', 'Ibadan North East I', 'Ibadan South-East I'] },
  'Plateau': { seats: 24, constituencies: ['Jos South', 'Riyom', 'Jos North', 'Mangu South', 'Langtang Central', 'Langtang North', 'Mikang', 'Kantana', 'Qua\'an Pan South', 'Pankshin North', 'Langtang South', 'Shendam', 'Kanke', 'Pankshin South', 'Dengi', 'Jos East', 'Mangu North', 'Jos North West', 'Bokkos', 'Barkin Ladi', 'Wase', 'Pengana', 'Rukuba/Irigwe', 'Qua\'an Pan North'] },
  'Rivers': { seats: 32, constituencies: ['Khana I', 'Port-Harcourt III', 'Emohua', 'Obio/Akpor II', 'Asari-Toru II', 'Ogba/Egbema/Ndoni', 'Ahoada West', 'Degema', 'Akuku-Toru II', 'Okrika', 'Khana II', 'Akuku-Toru I', 'Onelga II', 'Etche I', 'Bonny', 'Tai', 'Ikwere I', 'Asari-Toru I', 'Andoni I', 'Obio/Akpor I', 'Ahoada East I', 'Abua/Odual', 'Etche II', 'Port-Harcourt II', 'Eleme', 'Oyigbo', 'Ogu/Bolo', 'Opobo/Nkoro', 'Gokana', 'Port-Harcourt I', 'Omuma', 'Ahoada East II'] },
  'Sokoto': { seats: 30, constituencies: ['Tureta', 'Tambuwal East', 'Kware', 'Sokoto North I', 'Sokoto South I', 'Shagari', 'Tambuwal West', 'Gada West', 'Dange Shuni', 'Goronyo', 'Sokoto South II', 'Gada East', 'Wamakko', 'Tangaza', 'Yabo', 'Kebbe', 'Isa', 'Gwadabawa South', 'Gwadabawa North', 'Gudu', 'Illela', 'Rabah', 'Sabon Birni North', 'Sabon Birni South', 'Silame', 'Sokoto North II', 'Wurno', 'Bodinga South', 'Bodinga North', 'Binji'] },
  'Taraba': { seats: 24, constituencies: ['Jalingo I', 'Wukari II', 'Gashaka', 'Karim Lamido II', 'Gassol I', 'Mbamnga', 'Yorro', 'Jalingo II', 'Ibi', 'Lau', 'Nguroje', 'Zing', 'Kurmi', 'Ardo-Kola', 'Bali II', 'Takum I', 'Wukari I', 'Bali I', 'Gembu (Sardauna I)', 'Karim Lamido I', 'Gassol II', 'Donda', 'Kashimbila (Takum II)', 'Ussa/Likam'] },
  'Yobe': { seats: 24, constituencies: ['Gulani', 'Tarmuwa', 'Nangere', 'Mamudo', 'Potiskum Town', 'Goya/Ngeji', 'Geidam North', 'Fika/Ngalda', 'Damaturu I', 'Nguru I', 'Nguru II', 'Yunusari I', 'Machina', 'Karasuwa', 'Jakusko', 'Yusufari II', 'Bade West', 'Damaturu II', 'Damagum', 'Jajere', 'Geidam South', 'Gujba', 'Bade East', 'Bursari'] },
  'Zamfara': { seats: 24, constituencies: ['Kaura Namoda North', 'Bukkuyum South', 'Anka', 'Bukkuyum North', 'Tsafe West', 'Gummi II', 'Talata Mafara North', 'Maru South', 'Gusau East', 'Bungudu East', 'Gusau West', 'Zurmi East', 'Zurmi West', 'Bakura', 'Maradun I', 'Bungudu West', 'Talata Mafara South', 'Maradun II', 'Maru North', 'Tsafe East', 'Gummi I', 'Shinkafi', 'Kaura Namoda South', 'Birnin Magaji'] },
};

/**
 * Which coordinate tier supplied most of the units behind a centroid:
 * `official` = surveyed `polling_units.lat/lng`, `crowd` = a `crowd_lat/lng`
 * value that passed the plausibility gate (see the file header), `approx` = a
 * GRID3 envelope centre, `none` = no centroid at all.
 */
export type CoordTier = 'official' | 'crowd' | 'approx' | 'operator' | 'none';

/** How a constituency's LGA set was established. See the file header. */
export type LocationProvenance =
  /** Normalised string match against the register's LGA spellings. */
  | 'auto-matched'
  /** Sourced from the Situation Room INEC-derived state guides. */
  | 'researched'
  /** Auto-match was wrong; the match audit replaced it. */
  | 'corrected'
  /**
   * A seat restored by court judgment in 2026, taking the LGA and centroid of
   * the seat its name reduces to — "Ughelli South II" to the Ughelli South LGA.
   * Mechanical and checkable, but WEAKER than auto-matched: the restored seat is
   * a split of its parent, so the LGA is right while the centroid is the
   * parent's midpoint rather than this seat's. Fine for "roughly where", wrong
   * for anything that needs the boundary. The 14 whose names reduce to nothing
   * the register knows have no entry at all.
   */
  | 'restored-2026'
  /** Not established on evidence — carries a `note`. Do not rely on it blind. */
  | 'suspect'
  /** No LGA could be established at all; `lgas` is empty. */
  | 'unresolved';

/** Where one state constituency sits, in register terms. */
export interface AssemblyLocation {
  /**
   * Register LGA spellings (`polling_units.lga`) this constituency covers —
   * these exact strings, so they join. Usually one; 19 of the 993 span two.
   */
  lgas: string[];
  /**
   * Representative point: median lat / median lng over the polling units in
   * `lgas`. `undefined` when no unit there has any coordinate — never 0,0.
   */
  centroid?: { lat: number; lng: number };
  /**
   * Polling units that contributed a coordinate — not the LGA's unit count:
   * units whose only coordinate was a rejected `crowd_*` value are excluded.
   * 0 means no centroid.
   */
  unitsBacking: number;
  /**
   * Dominant coordinate tier among those units. `approx` is the weakest (a GRID3
   * envelope centre, so it locates the ward, not the unit) and is what a state
   * hit by the crowd-column bug falls back to wholesale.
   */
  coordTier: CoordTier;
  provenance: LocationProvenance;
  /** Present whenever the mapping carries a caveat a caller should surface. */
  note?: string;
}

/**
 * Location detail for all 993 state constituencies, keyed `` `${state}|${seat}` ``
 * — the same key shape the upstream sha_lga_map.json uses, and `seat` is exactly
 * the string in `STATE_ASSEMBLY[state].constituencies`. Parallel to
 * STATE_ASSEMBLY on purpose: nothing here changes that map's shape, so existing
 * consumers (seat counts + names) are untouched.
 *
 * The seat half of the key is STATE_ASSEMBLY's spelling, NOT the upstream JSON's:
 * nine of the 993 differ there by stray space or case only ("Warri South- West",
 * "Maiduguri M.c", "Ikpoba - Okha", "Kogi (K.k)", "Boripe/Boluwa- Duro" and four
 * Oyo "Ibadan …- East/West" seats). They were reconciled 1:1 on a normalised
 * comparison so every key here indexes cleanly from STATE_ASSEMBLY and from
 * `listRaces('SHA')`; anything joining back to sha_lga_map.json must normalise.
 *
 * Provenance and centroid method are documented in the file header. Read
 * `provenance`, `unitsBacking` and `coordTier` before trusting an entry: an
 * `approx`-tier centroid over 40 units is a much weaker claim than a `crowd`-tier
 * one over 500, and a `suspect` provenance means the LGA itself is unconfirmed.
 */
export const ASSEMBLY_LOCATIONS: Record<string, AssemblyLocation> = {
  // RESTORED 2026 — 26 state constituencies returned by court judgment,
  // announced by INEC on 10 June and 14 August 2026. Each takes the LGA and
  // centroid of the seat its name reduces to ("Ughelli South II" -> the
  // Ughelli South LGA), which is mechanical and checkable. Seats whose name
  // reduces to nothing the register knows are deliberately absent rather
  // than guessed — see backend/src/data/restored-constituencies.json.
  'Benue|Konshisha III (Shangev-Tiev)': { lgas: ['Konshisha'], centroid: { lat: 7.00008, lng: 8.78883 }, unitsBacking: 250, coordTier: 'crowd', provenance: 'restored-2026' },
  'Benue|Makurdi III (South East)': { lgas: ['Makurdi'], centroid: { lat: 7.73214, lng: 8.53161 }, unitsBacking: 562, coordTier: 'crowd', provenance: 'restored-2026' },
  'Benue|Gboko III': { lgas: ['Gboko'], centroid: { lat: 7.33333, lng: 9.00047 }, unitsBacking: 475, coordTier: 'crowd', provenance: 'restored-2026' },
  'Delta|Aniocha North II': { lgas: ['Aniocha North'], centroid: { lat: 6.33979, lng: 6.47645 }, unitsBacking: 153, coordTier: 'crowd', provenance: 'restored-2026' },
  'Delta|Sapele II': { lgas: ['Sapele'], centroid: { lat: 5.881, lng: 5.68294 }, unitsBacking: 264, coordTier: 'crowd', provenance: 'restored-2026' },
  'Delta|Ethiope West II': { lgas: ['Ethiope West'], centroid: { lat: 5.93186, lng: 5.72018 }, unitsBacking: 220, coordTier: 'crowd', provenance: 'restored-2026' },
  'Delta|Warri South West II': { lgas: ['Warri South West'], centroid: { lat: 5.60771, lng: 5.21306 }, unitsBacking: 316, coordTier: 'approx', provenance: 'restored-2026' },
  'Delta|Warri North II': { lgas: ['Warri North'], centroid: { lat: 5.97255, lng: 5.18688 }, unitsBacking: 192, coordTier: 'approx', provenance: 'restored-2026' },
  'Delta|Isoko North II': { lgas: ['Isoko North'], centroid: { lat: 5.54135, lng: 6.22504 }, unitsBacking: 263, coordTier: 'crowd', provenance: 'restored-2026' },
  'Delta|Ughelli South II': { lgas: ['Ughelli South'], centroid: { lat: 5.428, lng: 5.90673 }, unitsBacking: 244, coordTier: 'crowd', provenance: 'restored-2026' },
  'Kogi|Ijumu II': { lgas: ['Ijumu'], centroid: { lat: 7.84381, lng: 5.9615 }, unitsBacking: 118, coordTier: 'approx', provenance: 'restored-2026' },
  'Kogi|Yagba West II': { lgas: ['Yagba West'], centroid: { lat: 8.22664, lng: 5.51327 }, unitsBacking: 96, coordTier: 'approx', provenance: 'restored-2026' },
  // Abia ----------------------------------------------------
  'Abia|Aba South': { lgas: ['Aba South'], centroid: { lat: 5.101, lng: 7.367 }, unitsBacking: 518, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Ukwa East': { lgas: ['Ukwa East'], centroid: { lat: 4.9412, lng: 7.4065 }, unitsBacking: 85, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Ikwuano': { lgas: ['Ikwuano'], centroid: { lat: 5.423, lng: 7.572 }, unitsBacking: 143, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Osisioma North': { lgas: ['Osisioma'], centroid: { lat: 5.14191, lng: 7.32993 }, unitsBacking: 301, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Osisioma South': { lgas: ['Osisioma'], centroid: { lat: 5.14191, lng: 7.32993 }, unitsBacking: 301, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Umuahia Central': { lgas: ['Umuahia North'], centroid: { lat: 5.53626, lng: 7.4968 }, unitsBacking: 378, coordTier: 'crowd', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher indexed LGA names with their compass word stripped, so \'Umuahia North\' and \'Umuahia South\' collapsed to one key and this seat was attached to the wrong sibling. Placed in Umuahia North on the sitting members\' LGA (Chinedum Orji, member 2015-2023, is from Ibeku, Umuahia North); Umuahia South already has its own seat.' },
  'Abia|Umuahia North': { lgas: ['Umuahia North'], centroid: { lat: 5.53626, lng: 7.4968 }, unitsBacking: 378, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Ohafia South': { lgas: ['Ohafia'], centroid: { lat: 5.67505, lng: 7.80215 }, unitsBacking: 282, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Isiala Ngwa North': { lgas: ['Isiala Ngwa North'], centroid: { lat: 5.38236, lng: 7.388 }, unitsBacking: 185, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Umunneochi': { lgas: ['Umunneochi'], centroid: { lat: 5.9719, lng: 7.3884 }, unitsBacking: 153, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Aba Central': { lgas: ['Aba South'], centroid: { lat: 5.101, lng: 7.367 }, unitsBacking: 518, coordTier: 'crowd', provenance: 'suspect', note: 'auto-matcher value retained but NOT audited: the audit found it was produced by an unsound collision and could not confirm or refute it — verify before relying on it.' },
  'Abia|Bende South': { lgas: ['Bende'], centroid: { lat: 5.66745, lng: 7.62818 }, unitsBacking: 214, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Ugwunaagbo': { lgas: ['Ugwunagbo'], centroid: { lat: 5.03985, lng: 7.337 }, unitsBacking: 160, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Bende North': { lgas: ['Bende'], centroid: { lat: 5.66745, lng: 7.62818 }, unitsBacking: 214, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Isuikwuato': { lgas: ['Isuikwuato'], centroid: { lat: 5.7761, lng: 7.4601 }, unitsBacking: 149, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Obingwa East': { lgas: ['Obingwa'], centroid: { lat: 5.1302, lng: 7.4475 }, unitsBacking: 312, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Aba North': { lgas: ['Aba North'], centroid: { lat: 5.11664, lng: 7.3561 }, unitsBacking: 503, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Umuahia East': { lgas: ['Umuahia North'], centroid: { lat: 5.53626, lng: 7.4968 }, unitsBacking: 378, coordTier: 'crowd', provenance: 'suspect', note: 'match audit proposed this on named external evidence but could not confirm it against an INEC delimitation source — verify before relying on it.' },
  'Abia|Ukwa West': { lgas: ['Ukwa West'], centroid: { lat: 4.93857, lng: 7.2623 }, unitsBacking: 129, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Arochukwu': { lgas: ['Arochukwu'], centroid: { lat: 5.4569, lng: 7.8877 }, unitsBacking: 183, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Isiala Ngwa South': { lgas: ['Isiala Ngwa South'], centroid: { lat: 5.29115, lng: 7.3961 }, unitsBacking: 194, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Umuahia South': { lgas: ['Umuahia South'], centroid: { lat: 5.4828, lng: 7.4484 }, unitsBacking: 173, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Obingwa West': { lgas: ['Obingwa'], centroid: { lat: 5.1302, lng: 7.4475 }, unitsBacking: 312, coordTier: 'crowd', provenance: 'auto-matched' },
  'Abia|Ohafia North': { lgas: ['Ohafia'], centroid: { lat: 5.67505, lng: 7.80215 }, unitsBacking: 282, coordTier: 'crowd', provenance: 'auto-matched' },
  // Adamawa -------------------------------------------------
  'Adamawa|Yola North': { lgas: ['Yola North'], centroid: { lat: 9.278, lng: 12.4472 }, unitsBacking: 377, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Fufore/Gurin (Fufore I)': { lgas: ['Fufore'], centroid: { lat: 9.219, lng: 12.664 }, unitsBacking: 274, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Mubi North': { lgas: ['Mubi North'], centroid: { lat: 10.274, lng: 13.27424 }, unitsBacking: 276, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Verre (Fufore II)': { lgas: ['Fufore'], centroid: { lat: 9.219, lng: 12.664 }, unitsBacking: 274, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Koma/Leko (Jada I)': { lgas: ['Jada'], centroid: { lat: 8.7062, lng: 12.16 }, unitsBacking: 215, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Hong (Hong II)': { lgas: ['Hong'], centroid: { lat: 10.24973, lng: 12.98597 }, unitsBacking: 225, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Nassarawo/Binyeri (Mayo Belwa I)': { lgas: ['Mayobelwa'], centroid: { lat: 9.0515, lng: 12.0103 }, unitsBacking: 206, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Lamurde': { lgas: ['Lamurde'], centroid: { lat: 9.56905, lng: 11.7985 }, unitsBacking: 152, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Girei': { lgas: ['Gire 1'], centroid: { lat: 9.36621, lng: 12.48763 }, unitsBacking: 152, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Shelleng': { lgas: ['Shelleng'], centroid: { lat: 9.86035, lng: 12.04771 }, unitsBacking: 124, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Gombi': { lgas: ['Gombi'], centroid: { lat: 10.1645, lng: 12.5956 }, unitsBacking: 180, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Mubi South': { lgas: ['Mubi South'], centroid: { lat: 10.24204, lng: 13.277 }, unitsBacking: 143, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Song': { lgas: ['Song'], centroid: { lat: 9.8062, lng: 12.5709 }, unitsBacking: 207, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Michika': { lgas: ['Michika'], centroid: { lat: 10.603, lng: 13.39 }, unitsBacking: 223, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Jada/Mbulo (Jada II)': { lgas: ['Jada'], centroid: { lat: 8.7062, lng: 12.16 }, unitsBacking: 215, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Maiha': { lgas: ['Maiha'], centroid: { lat: 9.99835, lng: 13.1813 }, unitsBacking: 122, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Numan': { lgas: ['Numan'], centroid: { lat: 9.46277, lng: 12.02465 }, unitsBacking: 170, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Ganye': { lgas: ['Ganye'], centroid: { lat: 8.43915, lng: 12.04978 }, unitsBacking: 198, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Toungo': { lgas: ['Toungo'], centroid: { lat: 8.1201, lng: 12.003 }, unitsBacking: 101, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Uba/Gaya (Hong I)': { lgas: ['Hong'], centroid: { lat: 10.24973, lng: 12.98597 }, unitsBacking: 225, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Mayo-Belwa (Mayo Belwa II)': { lgas: ['Mayobelwa'], centroid: { lat: 9.0515, lng: 12.0103 }, unitsBacking: 206, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Madagali': { lgas: ['Madagali'], centroid: { lat: 10.81516, lng: 13.52365 }, unitsBacking: 160, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Guyuk': { lgas: ['Guyuk'], centroid: { lat: 9.8527, lng: 11.92039 }, unitsBacking: 150, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Demsa': { lgas: ['Demsa'], centroid: { lat: 9.45257, lng: 12.09366 }, unitsBacking: 177, coordTier: 'crowd', provenance: 'auto-matched' },
  'Adamawa|Yola South': { lgas: ['Yola South'], centroid: { lat: 9.20839, lng: 12.478 }, unitsBacking: 272, coordTier: 'crowd', provenance: 'auto-matched' },
  // Akwa Ibom -----------------------------------------------
  'Akwa Ibom|Esit Eket/Ibeno': { lgas: ['Esit Eket', 'Ibeno'], centroid: { lat: 4.6384, lng: 8.02945 }, unitsBacking: 163, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Ikot Ekpene/Obot Akara': { lgas: ['Ikot Ekpene', 'Obot Akara'], centroid: { lat: 5.19506, lng: 7.67895 }, unitsBacking: 276, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Etim Ekpo/Ika': { lgas: ['Etim Ekpo', 'Ika'], centroid: { lat: 4.9931, lng: 7.5575 }, unitsBacking: 189, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Nsit Ubium': { lgas: ['Nsit Ubium'], centroid: { lat: 4.7466, lng: 7.955 }, unitsBacking: 117, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Itu': { lgas: ['Itu'], centroid: { lat: 5.12807, lng: 7.95615 }, unitsBacking: 140, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Nsit Atai': { lgas: ['Nsit Atai'], centroid: { lat: 4.8291, lng: 8.0356 }, unitsBacking: 85, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Uruan': { lgas: ['Uruan'], centroid: { lat: 4.98778, lng: 8.03116 }, unitsBacking: 166, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Okobo': { lgas: ['Okobo'], centroid: { lat: 4.8319, lng: 8.13023 }, unitsBacking: 112, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Ukanafun': { lgas: ['Ukanafun'], centroid: { lat: 4.88506, lng: 7.5993 }, unitsBacking: 134, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Ibiono Ibom': { lgas: ['Ibiono Ibom'], centroid: { lat: 5.19789, lng: 7.8788 }, unitsBacking: 199, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Essien Udim': { lgas: ['Essien Udim'], centroid: { lat: 5.1109, lng: 7.66968 }, unitsBacking: 219, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Uyo': { lgas: ['Uyo'], centroid: { lat: 5.02595, lng: 7.92531 }, unitsBacking: 424, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Ini': { lgas: ['Ini'], centroid: { lat: 5.3509, lng: 7.74 }, unitsBacking: 113, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Urue Offong/Oruko': { lgas: ['Urue Offong/Oruko'], centroid: { lat: 4.7333, lng: 8.17 }, unitsBacking: 73, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Ikot Abasi/Eastern Obolo': { lgas: ['Eastern Obolo', 'Ikot Abasi'], centroid: { lat: 4.58082, lng: 7.64914 }, unitsBacking: 168, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Ikono': { lgas: ['Ikono'], centroid: { lat: 5.2215, lng: 7.7783 }, unitsBacking: 168, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Onna': { lgas: ['Onna'], centroid: { lat: 4.63805, lng: 7.8437 }, unitsBacking: 142, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Etinan': { lgas: ['Etinan'], centroid: { lat: 4.83745, lng: 7.84016 }, unitsBacking: 146, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Ibesikpo Asutan': { lgas: ['Ibesikpo Asutan'], centroid: { lat: 4.92216, lng: 7.9498 }, unitsBacking: 180, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Abak': { lgas: ['Abak'], centroid: { lat: 5.024, lng: 7.78438 }, unitsBacking: 186, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Mkpat Enin': { lgas: ['Mkpat Enin'], centroid: { lat: 4.6924, lng: 7.762 }, unitsBacking: 145, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Oron/Udung Uko': { lgas: ['Oron', 'Udung Uko'], centroid: { lat: 4.7944, lng: 8.2346 }, unitsBacking: 161, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Oruk Anam': { lgas: ['Oruk Anam'], centroid: { lat: 4.8, lng: 7.6675 }, unitsBacking: 221, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Eket': { lgas: ['Eket'], centroid: { lat: 4.65193, lng: 7.9378 }, unitsBacking: 203, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Nsit Ibom': { lgas: ['Nsit Ibom'], centroid: { lat: 4.90024, lng: 7.88517 }, unitsBacking: 114, coordTier: 'crowd', provenance: 'auto-matched' },
  'Akwa Ibom|Mbo': { lgas: ['Mbo'], centroid: { lat: 4.65732, lng: 8.25399 }, unitsBacking: 100, coordTier: 'crowd', provenance: 'auto-matched' },
  // Anambra -------------------------------------------------
  'Anambra|Awka North': { lgas: ['Awka North'], centroid: { lat: 6.3104, lng: 7.05336 }, unitsBacking: 150, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Onitsha North II': { lgas: ['Onitsha-North'], centroid: { lat: 6.15202, lng: 6.794 }, unitsBacking: 313, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Ogbaru II': { lgas: ['Ogbaru'], centroid: { lat: 6.1153, lng: 6.77553 }, unitsBacking: 383, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Onitsha North I': { lgas: ['Onitsha-North'], centroid: { lat: 6.15202, lng: 6.794 }, unitsBacking: 313, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Aguata I': { lgas: ['Aguata'], centroid: { lat: 5.9951, lng: 7.0813 }, unitsBacking: 342, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Ihiala II': { lgas: ['Ihala'], centroid: { lat: 5.8608, lng: 6.8606 }, unitsBacking: 313, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Oyi': { lgas: ['Oyi'], centroid: { lat: 6.22977, lng: 6.9198 }, unitsBacking: 207, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Idemili North': { lgas: ['Idemili North'], centroid: { lat: 6.1337, lng: 6.8556 }, unitsBacking: 467, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Orumba North': { lgas: ['Orumba North'], centroid: { lat: 6.0689, lng: 7.126 }, unitsBacking: 253, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Nnewi South II': { lgas: ['Nnewi South'], centroid: { lat: 5.9495, lng: 6.9756 }, unitsBacking: 297, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Awka South II': { lgas: ['Awka South'], centroid: { lat: 6.2035, lng: 7.07077 }, unitsBacking: 390, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Ihiala I': { lgas: ['Ihala'], centroid: { lat: 5.8608, lng: 6.8606 }, unitsBacking: 313, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Ayamelum': { lgas: ['Ayamelum'], centroid: { lat: 6.5208, lng: 6.9597 }, unitsBacking: 191, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Nnewi South I': { lgas: ['Nnewi South'], centroid: { lat: 5.9495, lng: 6.9756 }, unitsBacking: 297, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Orumba South': { lgas: ['Orumba South'], centroid: { lat: 5.9925, lng: 7.2333 }, unitsBacking: 208, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Anaocha II': { lgas: ['Anaocha'], centroid: { lat: 6.0858, lng: 7.0182 }, unitsBacking: 320, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Nnewi North': { lgas: ['Nnewi North'], centroid: { lat: 6.019, lng: 6.914 }, unitsBacking: 318, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Aguata II': { lgas: ['Aguata'], centroid: { lat: 5.9951, lng: 7.0813 }, unitsBacking: 342, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Anambra West': { lgas: ['Anambra West'], centroid: { lat: 6.38555, lng: 6.7581 }, unitsBacking: 164, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Ogbaru I': { lgas: ['Ogbaru'], centroid: { lat: 6.1153, lng: 6.77553 }, unitsBacking: 383, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Anaocha I': { lgas: ['Anaocha'], centroid: { lat: 6.0858, lng: 7.0182 }, unitsBacking: 320, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Njikoka I': { lgas: ['Njikoka'], centroid: { lat: 6.17721, lng: 6.9937 }, unitsBacking: 231, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Ekwusigo': { lgas: ['Ekwusigo'], centroid: { lat: 5.9714, lng: 6.856 }, unitsBacking: 193, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Njikoka II': { lgas: ['Njikoka'], centroid: { lat: 6.17721, lng: 6.9937 }, unitsBacking: 231, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Idemili South': { lgas: ['Idemili-South'], centroid: { lat: 6.0607, lng: 6.935 }, unitsBacking: 243, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Awka South I': { lgas: ['Awka South'], centroid: { lat: 6.2035, lng: 7.07077 }, unitsBacking: 390, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Anambra East': { lgas: ['Anambra East'], centroid: { lat: 6.336, lng: 6.87846 }, unitsBacking: 241, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Onitsha South II': { lgas: ['Onitsha -South'], centroid: { lat: 6.1373, lng: 6.7804 }, unitsBacking: 321, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Onitsha South I': { lgas: ['Onitsha -South'], centroid: { lat: 6.1373, lng: 6.7804 }, unitsBacking: 321, coordTier: 'crowd', provenance: 'auto-matched' },
  'Anambra|Dunukofia': { lgas: ['Dunukofia'], centroid: { lat: 6.195, lng: 6.9582 }, unitsBacking: 163, coordTier: 'crowd', provenance: 'auto-matched' },
  // Bauchi --------------------------------------------------
  'Bauchi|Zungur/Galambi (Bauchi II)': { lgas: ['Bauchi'], centroid: { lat: 10.30461, lng: 9.84209 }, unitsBacking: 894, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Bauchi (Bauchi I)': { lgas: ['Bauchi'], centroid: { lat: 10.30461, lng: 9.84209 }, unitsBacking: 894, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Sakwa (Zaki I)': { lgas: ['Zaki'], centroid: { lat: 12.24269, lng: 10.3274 }, unitsBacking: 261, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Jama\'are': { lgas: ['Jama\'Are'], centroid: { lat: 11.66764, lng: 9.929 }, unitsBacking: 133, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Ganjuwa West': { lgas: ['Ganjuwa'], centroid: { lat: 10.692, lng: 9.933 }, unitsBacking: 253, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Ganjuwa East': { lgas: ['Ganjuwa'], centroid: { lat: 10.692, lng: 9.933 }, unitsBacking: 253, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Sade (Darazo II)': { lgas: ['Darazo'], centroid: { lat: 11.114, lng: 10.5363 }, unitsBacking: 270, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Lere/Bula (Tafawa/balewa)': { lgas: ['Tafawa Balewa'], centroid: { lat: 9.78793, lng: 9.5506 }, unitsBacking: 286, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Katagum (Katagum I)': { lgas: ['Katagum'], centroid: { lat: 11.66954, lng: 10.1953 }, unitsBacking: 364, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Darazo (Darazo I)': { lgas: ['Darazo'], centroid: { lat: 11.114, lng: 10.5363 }, unitsBacking: 270, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Dambam/Dagauda/Jalam': { lgas: ['Dambam'], centroid: { lat: 11.6703, lng: 10.7433 }, unitsBacking: 163, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Burra (Ningi II)': { lgas: ['Ningi'], centroid: { lat: 11.0776, lng: 9.4519 }, unitsBacking: 371, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Ningi (Ningi I)': { lgas: ['Ningi'], centroid: { lat: 11.0776, lng: 9.4519 }, unitsBacking: 371, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Jama\'a/Toro (Toro II)': { lgas: ['Toro'], centroid: { lat: 10.225, lng: 9.073 }, unitsBacking: 423, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Bogoro': { lgas: ['Bogoro'], centroid: { lat: 9.63899, lng: 9.57594 }, unitsBacking: 119, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Kirfi': { lgas: ['Kirfi'], centroid: { lat: 10.40585, lng: 10.43847 }, unitsBacking: 154, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Azare (Zaki II)': { lgas: ['Zaki'], centroid: { lat: 12.24269, lng: 10.3274 }, unitsBacking: 261, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Lame (Toro I)': { lgas: ['Toro'], centroid: { lat: 10.225, lng: 9.073 }, unitsBacking: 423, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Giade': { lgas: ['Giade'], centroid: { lat: 11.4159, lng: 10.2459 }, unitsBacking: 145, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Udubo (Gamawa I)': { lgas: ['Gamawa'], centroid: { lat: 12.1182, lng: 10.5887 }, unitsBacking: 289, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Madara/Chinade (Katagum II)': { lgas: ['Katagum'], centroid: { lat: 11.66954, lng: 10.1953 }, unitsBacking: 364, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Gamawa (Gamawa II)': { lgas: ['Gamawa'], centroid: { lat: 12.1182, lng: 10.5887 }, unitsBacking: 289, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Duguri/Gwana (Alkaleri II)': { lgas: ['Alkaleri'], centroid: { lat: 10.00065, lng: 10.33875 }, unitsBacking: 300, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Pali (Alkaleri I)': { lgas: ['Alkaleri'], centroid: { lat: 10.00065, lng: 10.33875 }, unitsBacking: 300, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Warji': { lgas: ['Warji'], centroid: { lat: 11.17719, lng: 9.7535 }, unitsBacking: 142, coordTier: 'approx', provenance: 'auto-matched' },
  'Bauchi|Shira I (Disina)': { lgas: ['Shira'], centroid: { lat: 11.4679, lng: 9.9997 }, unitsBacking: 249, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Dass': { lgas: ['Dass'], centroid: { lat: 10.00127, lng: 9.5109 }, unitsBacking: 116, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Itas/Gadau': { lgas: ['Itas/Gadau'], centroid: { lat: 11.844, lng: 9.96338 }, unitsBacking: 235, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Hardawa (Misau II)': { lgas: ['Misau'], centroid: { lat: 11.412, lng: 10.46725 }, unitsBacking: 256, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Chiroma (Misau I)': { lgas: ['Misau'], centroid: { lat: 11.412, lng: 10.46725 }, unitsBacking: 256, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bauchi|Shira II (Shira)': { lgas: ['Shira'], centroid: { lat: 11.4679, lng: 9.9997 }, unitsBacking: 249, coordTier: 'crowd', provenance: 'auto-matched' },
  // Bayelsa -------------------------------------------------
  'Bayelsa|Brass II': { lgas: ['Brass'], centroid: { lat: 4.31319, lng: 6.24017 }, unitsBacking: 172, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Kolokuma/Opokuma II': { lgas: ['Kolokuma/Opokuma'], centroid: { lat: 5.11277, lng: 6.2997 }, unitsBacking: 148, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Brass III': { lgas: ['Brass'], centroid: { lat: 4.31319, lng: 6.24017 }, unitsBacking: 172, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Yenagoa III': { lgas: ['Yenagoa'], centroid: { lat: 5.00626, lng: 6.34636 }, unitsBacking: 427, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Ekeremor I': { lgas: ['Ekeremor'], centroid: { lat: 5.04369, lng: 5.78011 }, unitsBacking: 258, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Nembe III': { lgas: ['Nembe'], centroid: { lat: 4.54919, lng: 6.40335 }, unitsBacking: 228, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Yenagoa I': { lgas: ['Yenagoa'], centroid: { lat: 5.00626, lng: 6.34636 }, unitsBacking: 427, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Yenagoa II': { lgas: ['Yenagoa'], centroid: { lat: 5.00626, lng: 6.34636 }, unitsBacking: 427, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Nembe I': { lgas: ['Nembe'], centroid: { lat: 4.54919, lng: 6.40335 }, unitsBacking: 228, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Ekeremor II': { lgas: ['Ekeremor'], centroid: { lat: 5.04369, lng: 5.78011 }, unitsBacking: 258, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Ogbia III': { lgas: ['Ogbia'], centroid: { lat: 4.78417, lng: 6.338 }, unitsBacking: 301, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Nembe II': { lgas: ['Nembe'], centroid: { lat: 4.54919, lng: 6.40335 }, unitsBacking: 228, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Ogbia II': { lgas: ['Ogbia'], centroid: { lat: 4.78417, lng: 6.338 }, unitsBacking: 301, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Ogbia I': { lgas: ['Ogbia'], centroid: { lat: 4.78417, lng: 6.338 }, unitsBacking: 301, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Kolokuma/Opokuma I': { lgas: ['Kolokuma/Opokuma'], centroid: { lat: 5.11277, lng: 6.2997 }, unitsBacking: 148, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Sagbama III': { lgas: ['Sagbama'], centroid: { lat: 5.12422, lng: 6.10821 }, unitsBacking: 244, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Southern Ijaw IV': { lgas: ['Southern Ijaw'], centroid: { lat: 4.74471, lng: 6.0722 }, unitsBacking: 465, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Ekeremor III': { lgas: ['Ekeremor'], centroid: { lat: 5.04369, lng: 5.78011 }, unitsBacking: 258, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Sagbama I': { lgas: ['Sagbama'], centroid: { lat: 5.12422, lng: 6.10821 }, unitsBacking: 244, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Sagbama II': { lgas: ['Sagbama'], centroid: { lat: 5.12422, lng: 6.10821 }, unitsBacking: 244, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Southern Ijaw II': { lgas: ['Southern Ijaw'], centroid: { lat: 4.74471, lng: 6.0722 }, unitsBacking: 465, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Southern Ijaw I': { lgas: ['Southern Ijaw'], centroid: { lat: 4.74471, lng: 6.0722 }, unitsBacking: 465, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Southern Ijaw III': { lgas: ['Southern Ijaw'], centroid: { lat: 4.74471, lng: 6.0722 }, unitsBacking: 465, coordTier: 'crowd', provenance: 'auto-matched' },
  'Bayelsa|Brass I': { lgas: ['Brass'], centroid: { lat: 4.31319, lng: 6.24017 }, unitsBacking: 172, coordTier: 'crowd', provenance: 'auto-matched' },
  // Benue ---------------------------------------------------
  'Benue|Adoka/Ugboju': { lgas: ['Otukpo'], centroid: { lat: 7.21319, lng: 8.11624 }, unitsBacking: 279, coordTier: 'crowd', provenance: 'researched' },
  'Benue|Okpokwu': { lgas: ['Okpokwu'], centroid: { lat: 7.06, lng: 7.82001 }, unitsBacking: 147, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Kwande East': { lgas: ['Kwande'], centroid: { lat: 6.82577, lng: 9.365 }, unitsBacking: 317, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Otukpo/Akpa': { lgas: ['Otukpo'], centroid: { lat: 7.21319, lng: 8.11624 }, unitsBacking: 279, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Ogbadibo': { lgas: ['Ogbadibo'], centroid: { lat: 7.05827, lng: 7.66148 }, unitsBacking: 132, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Ado': { lgas: ['Ado'], centroid: { lat: 6.80997, lng: 8.04406 }, unitsBacking: 157, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Gwer East': { lgas: ['Gwer East'], centroid: { lat: 7.30089, lng: 8.48287 }, unitsBacking: 189, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Makurdi I (North)': { lgas: ['Makurdi'], centroid: { lat: 7.73214, lng: 8.53161 }, unitsBacking: 562, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Logo': { lgas: ['Logo'], centroid: { lat: 7.68314, lng: 9.32557 }, unitsBacking: 184, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Makurdi South': { lgas: ['Makurdi'], centroid: { lat: 7.73214, lng: 8.53161 }, unitsBacking: 562, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Vandeikya I': { lgas: ['Vandeikya'], centroid: { lat: 6.84297, lng: 9.085 }, unitsBacking: 286, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Kwande West': { lgas: ['Kwande'], centroid: { lat: 6.82577, lng: 9.365 }, unitsBacking: 317, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Tarka': { lgas: ['Tarka'], centroid: { lat: 7.59979, lng: 8.87732 }, unitsBacking: 96, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Gboko West': { lgas: ['Gboko'], centroid: { lat: 7.33333, lng: 9.00047 }, unitsBacking: 475, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Katsina-Ala West': { lgas: ['Katsina-Ala'], centroid: { lat: 7.25919, lng: 9.52303 }, unitsBacking: 295, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Ukum I (Ngenev)': { lgas: ['Ukum'], centroid: { lat: 7.60662, lng: 9.63176 }, unitsBacking: 272, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Mata (Ushongo I)': { lgas: ['Ushongo'], centroid: { lat: 7.12764, lng: 9.01134 }, unitsBacking: 213, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Katsina Ala East': { lgas: ['Katsina-Ala'], centroid: { lat: 7.25919, lng: 9.52303 }, unitsBacking: 295, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Vandeikya II': { lgas: ['Vandeikya'], centroid: { lat: 6.84297, lng: 9.085 }, unitsBacking: 286, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Mbagwa (Ushongo II)': { lgas: ['Ushongo'], centroid: { lat: 7.12764, lng: 9.01134 }, unitsBacking: 213, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Obi': { lgas: ['Obi'], centroid: { lat: 7.0268, lng: 8.32038 }, unitsBacking: 120, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Oju I': { lgas: ['Oju'], centroid: { lat: 6.83203, lng: 8.4086 }, unitsBacking: 204, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Oju II': { lgas: ['Oju'], centroid: { lat: 6.83203, lng: 8.4086 }, unitsBacking: 204, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Agbatu': { lgas: ['Agatu'], centroid: { lat: 7.88505, lng: 7.89234 }, unitsBacking: 112, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Guma (Guma I)': { lgas: ['Guma'], centroid: { lat: 7.90613, lng: 8.75198 }, unitsBacking: 200, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Ohimini': { lgas: ['Ohimini'], centroid: { lat: 7.27083, lng: 7.925 }, unitsBacking: 87, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Konshisha I (Gaav)': { lgas: ['Konshisha'], centroid: { lat: 7.00008, lng: 8.78883 }, unitsBacking: 250, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Buruku': { lgas: ['Buruku'], centroid: { lat: 7.30352, lng: 9.21033 }, unitsBacking: 240, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Agasha (Guma II)': { lgas: ['Guma'], centroid: { lat: 7.90613, lng: 8.75198 }, unitsBacking: 200, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Apa': { lgas: ['Apa'], centroid: { lat: 7.636, lng: 7.88729 }, unitsBacking: 124, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Gboko I (East)': { lgas: ['Gboko'], centroid: { lat: 7.33333, lng: 9.00047 }, unitsBacking: 475, coordTier: 'crowd', provenance: 'auto-matched' },
  'Benue|Gwer West': { lgas: ['Gwer West'], centroid: { lat: 7.60917, lng: 8.202 }, unitsBacking: 123, coordTier: 'crowd', provenance: 'auto-matched' },
  // Borno ---------------------------------------------------
  'Borno|Maiduguri M.C': { lgas: ['Maiduguri M. C.'], centroid: { lat: 11.84373, lng: 13.15723 }, unitsBacking: 886, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Konduga': { lgas: ['Konduga'], centroid: { lat: 11.69794, lng: 13.26492 }, unitsBacking: 222, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Gwoza': { lgas: ['Gwoza'], centroid: { lat: 11.09417, lng: 13.73641 }, unitsBacking: 304, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Hawul': { lgas: ['Hawul'], centroid: { lat: 10.50124, lng: 12.2521 }, unitsBacking: 214, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Askira': { lgas: ['Askira / Uba'], centroid: { lat: 10.63661, lng: 13.12455 }, unitsBacking: 260, coordTier: 'crowd', provenance: 'researched' },
  'Borno|Bayo': { lgas: ['Bayo'], centroid: { lat: 10.37764, lng: 11.662 }, unitsBacking: 95, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Kukawa': { lgas: ['Kukawa'], centroid: { lat: 13.02648, lng: 13.776 }, unitsBacking: 131, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Biu': { lgas: ['Biu'], centroid: { lat: 10.67389, lng: 12.18577 }, unitsBacking: 245, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Kwaya Kusar': { lgas: ['Kwaya / Kusar'], centroid: { lat: 10.47349, lng: 11.90702 }, unitsBacking: 105, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Kala Balge': { lgas: ['Kala Balge'], centroid: { lat: 12.16885, lng: 14.49255 }, unitsBacking: 100, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Kaga': { lgas: ['Kaga'], centroid: { lat: 11.75791, lng: 12.49231 }, unitsBacking: 109, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Chibok': { lgas: ['Chibok'], centroid: { lat: 10.84361, lng: 12.85818 }, unitsBacking: 118, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Jere': { lgas: ['Jere'], centroid: { lat: 11.842, lng: 13.17661 }, unitsBacking: 386, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Damaboa': { lgas: ['Damboa'], centroid: { lat: 11.145, lng: 12.71805 }, unitsBacking: 189, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Mafa': { lgas: ['Mafa'], centroid: { lat: 11.92633, lng: 13.46229 }, unitsBacking: 125, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Guzamala': { lgas: ['Guzamala'], centroid: { lat: 12.74127, lng: 13.26844 }, unitsBacking: 87, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Dikwa': { lgas: ['Dikwa'], centroid: { lat: 12.027, lng: 13.98866 }, unitsBacking: 107, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Abadam': { lgas: ['Abadam'], centroid: { lat: 13.6149, lng: 13.33711 }, unitsBacking: 92, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Ngala': { lgas: ['Ngala'], centroid: { lat: 12.353, lng: 14.18765 }, unitsBacking: 131, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Nganzai': { lgas: ['Nganzai'], centroid: { lat: 12.492, lng: 13.19274 }, unitsBacking: 94, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Mobbar': { lgas: ['Mobbar'], centroid: { lat: 13.10821, lng: 12.543 }, unitsBacking: 98, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Marte': { lgas: ['Marte'], centroid: { lat: 12.34053, lng: 13.86598 }, unitsBacking: 133, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Monguno': { lgas: ['Monguno'], centroid: { lat: 12.6365, lng: 13.59364 }, unitsBacking: 109, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Bama II (Gulumba)': { lgas: ['Bama'], centroid: { lat: 11.52151, lng: 13.75869 }, unitsBacking: 284, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Bama I (Bama)': { lgas: ['Bama'], centroid: { lat: 11.52151, lng: 13.75869 }, unitsBacking: 284, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Magumeri': { lgas: ['Magumeri'], centroid: { lat: 12.227, lng: 12.787 }, unitsBacking: 99, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Gubio': { lgas: ['Gubio'], centroid: { lat: 12.56909, lng: 12.78122 }, unitsBacking: 121, coordTier: 'crowd', provenance: 'auto-matched' },
  'Borno|Shani': { lgas: ['Shani'], centroid: { lat: 10.18613, lng: 11.96871 }, unitsBacking: 144, coordTier: 'crowd', provenance: 'auto-matched' },
  // Cross River ---------------------------------------------
  'Cross River|Boki II': { lgas: ['Boki'], centroid: { lat: 6.4206, lng: 8.93822 }, unitsBacking: 205, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Calabar South I': { lgas: ['Calabar South'], centroid: { lat: 4.9438, lng: 8.322 }, unitsBacking: 191, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Yala I': { lgas: ['Yala'], centroid: { lat: 6.692, lng: 8.64757 }, unitsBacking: 226, coordTier: 'approx', provenance: 'auto-matched' },
  'Cross River|Yakurr I': { lgas: ['Yakurr'], centroid: { lat: 5.819, lng: 8.118 }, unitsBacking: 194, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Odukpani': { lgas: ['Odukpani'], centroid: { lat: 5.16495, lng: 8.1706 }, unitsBacking: 160, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Obudu': { lgas: ['Obudu'], centroid: { lat: 6.61118, lng: 9.148 }, unitsBacking: 255, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Obubra II': { lgas: ['Obubra'], centroid: { lat: 5.99494, lng: 8.341 }, unitsBacking: 226, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Obubra I': { lgas: ['Obubra'], centroid: { lat: 5.99494, lng: 8.341 }, unitsBacking: 226, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Obanleku': { lgas: ['Obanliku'], centroid: { lat: 6.55512, lng: 9.24319 }, unitsBacking: 88, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Ikom II': { lgas: ['Ikom'], centroid: { lat: 6.00575, lng: 8.68105 }, unitsBacking: 221, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Ikom I': { lgas: ['Ikom'], centroid: { lat: 6.00575, lng: 8.68105 }, unitsBacking: 221, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Etung': { lgas: ['Etung'], centroid: { lat: 5.89095, lng: 8.83374 }, unitsBacking: 83, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Calabar South II': { lgas: ['Calabar South'], centroid: { lat: 4.9438, lng: 8.322 }, unitsBacking: 191, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Yakurr II': { lgas: ['Yakurr'], centroid: { lat: 5.819, lng: 8.118 }, unitsBacking: 194, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Akpabuyo': { lgas: ['Akpabuyo'], centroid: { lat: 4.90319, lng: 8.465 }, unitsBacking: 145, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Abi': { lgas: ['Abi'], centroid: { lat: 5.89867, lng: 8.02085 }, unitsBacking: 120, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Bekwarra': { lgas: ['Bekwarra'], centroid: { lat: 6.69142, lng: 8.90876 }, unitsBacking: 127, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Akamkpa II': { lgas: ['Akamkpa'], centroid: { lat: 5.32387, lng: 8.361 }, unitsBacking: 195, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Boki I': { lgas: ['Boki'], centroid: { lat: 6.4206, lng: 8.93822 }, unitsBacking: 205, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Calabar Municipal': { lgas: ['Calabar Municipality'], centroid: { lat: 4.983, lng: 8.33592 }, unitsBacking: 250, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Bakassi': { lgas: ['Bakassi'], centroid: { lat: 4.76254, lng: 8.51638 }, unitsBacking: 70, coordTier: 'approx', provenance: 'auto-matched' },
  'Cross River|Ogoja': { lgas: ['Ogoja'], centroid: { lat: 6.55908, lng: 8.80032 }, unitsBacking: 178, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Akamkpa I': { lgas: ['Akamkpa'], centroid: { lat: 5.32387, lng: 8.361 }, unitsBacking: 195, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Biase': { lgas: ['Biase'], centroid: { lat: 5.62414, lng: 8.03914 }, unitsBacking: 152, coordTier: 'crowd', provenance: 'auto-matched' },
  'Cross River|Yala II': { lgas: ['Yala'], centroid: { lat: 6.692, lng: 8.64757 }, unitsBacking: 226, coordTier: 'approx', provenance: 'auto-matched' },
  // Delta ---------------------------------------------------
  'Delta|Ughelli South': { lgas: ['Ughelli South'], centroid: { lat: 5.428, lng: 5.90673 }, unitsBacking: 244, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Burutu': { lgas: ['Burutu'], centroid: { lat: 5.16191, lng: 5.72367 }, unitsBacking: 233, coordTier: 'approx', provenance: 'auto-matched' },
  'Delta|Ndokwa East': { lgas: ['Ndokwa East'], centroid: { lat: 5.634, lng: 6.473 }, unitsBacking: 158, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Aniocha North': { lgas: ['Aniocha North'], centroid: { lat: 6.33979, lng: 6.47645 }, unitsBacking: 153, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Ika North East': { lgas: ['Ika North- East'], centroid: { lat: 6.241, lng: 6.251 }, unitsBacking: 238, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Burutu North': { lgas: ['Burutu'], centroid: { lat: 5.16191, lng: 5.72367 }, unitsBacking: 233, coordTier: 'approx', provenance: 'auto-matched' },
  'Delta|Ndokwa West': { lgas: ['Ndokwa West'], centroid: { lat: 5.72245, lng: 6.347 }, unitsBacking: 203, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Ika South': { lgas: ['Ikasouth'], centroid: { lat: 6.2388, lng: 6.178 }, unitsBacking: 169, coordTier: 'crowd', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher indexed LGA names with their compass word stripped, so \'Ika North- East\' and \'Ikasouth\' collapsed to one key and this seat was attached to the wrong sibling. The register spells it \'Ikasouth\' (no space). \'Ikasouth\' was otherwise the only Delta LGA left with no constituency.' },
  'Delta|Oshimili North': { lgas: ['Oshimilinorth'], centroid: { lat: 6.23777, lng: 6.635 }, unitsBacking: 165, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Aniocha South': { lgas: ['Aniochasouth'], centroid: { lat: 6.18015, lng: 6.48799 }, unitsBacking: 168, coordTier: 'crowd', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher indexed LGA names with their compass word stripped, so \'Aniocha North\' and \'Aniochasouth\' collapsed to one key and this seat was attached to the wrong sibling. The register spells it \'Aniochasouth\' (no space), which is why no exact match found it. Confirmed by Delta reconciling exactly at 25 LGAs / 29 seats.' },
  'Delta|Oshimili South': { lgas: ['Oshimilisouth'], centroid: { lat: 6.19129, lng: 6.72976 }, unitsBacking: 319, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Udu': { lgas: ['Udu'], centroid: { lat: 5.48929, lng: 5.805 }, unitsBacking: 265, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Uvwie': { lgas: ['Uvwie'], centroid: { lat: 5.557, lng: 5.77775 }, unitsBacking: 327, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Isoko South I': { lgas: ['Isoko South'], centroid: { lat: 5.415, lng: 6.20535 }, unitsBacking: 257, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Isoko South II': { lgas: ['Isoko South'], centroid: { lat: 5.415, lng: 6.20535 }, unitsBacking: 257, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Patani': { lgas: ['Patani'], centroid: { lat: 5.18965, lng: 6.15517 }, unitsBacking: 99, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Ethiope West': { lgas: ['Ethiope West'], centroid: { lat: 5.93186, lng: 5.72018 }, unitsBacking: 220, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Isoko North': { lgas: ['Isoko North'], centroid: { lat: 5.54135, lng: 6.22504 }, unitsBacking: 263, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Warri South II': { lgas: ['Warri South'], centroid: { lat: 5.5203, lng: 5.748 }, unitsBacking: 314, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Ughelli North I': { lgas: ['Ughelli North'], centroid: { lat: 5.51187, lng: 6.011 }, unitsBacking: 400, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Warri South-West': { lgas: ['Warri South West'], centroid: { lat: 5.60771, lng: 5.21306 }, unitsBacking: 316, coordTier: 'approx', provenance: 'auto-matched' },
  'Delta|Warri South I': { lgas: ['Warri South'], centroid: { lat: 5.5203, lng: 5.748 }, unitsBacking: 314, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Ethiope East': { lgas: ['Ethiope East'], centroid: { lat: 5.72649, lng: 5.99733 }, unitsBacking: 220, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Sapele': { lgas: ['Sapele'], centroid: { lat: 5.881, lng: 5.68294 }, unitsBacking: 264, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Warri North': { lgas: ['Warri North'], centroid: { lat: 5.97255, lng: 5.18688 }, unitsBacking: 192, coordTier: 'approx', provenance: 'auto-matched' },
  'Delta|Ukwuani': { lgas: ['Ukwuani'], centroid: { lat: 5.845, lng: 6.18671 }, unitsBacking: 168, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Ughelli North II': { lgas: ['Ughelli North'], centroid: { lat: 5.51187, lng: 6.011 }, unitsBacking: 400, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Bomadi': { lgas: ['Bomadi'], centroid: { lat: 5.22248, lng: 5.83448 }, unitsBacking: 192, coordTier: 'crowd', provenance: 'auto-matched' },
  'Delta|Okpe': { lgas: ['Okpe'], centroid: { lat: 5.64034, lng: 5.81985 }, unitsBacking: 236, coordTier: 'crowd', provenance: 'auto-matched' },
  // Ebonyi --------------------------------------------------
  'Ebonyi|Izzi West': { lgas: ['Izzi'], centroid: { lat: 6.4755, lng: 8.2391 }, unitsBacking: 299, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ezza South': { lgas: ['Ezza South'], centroid: { lat: 6.1357, lng: 8.0291 }, unitsBacking: 189, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Afikpo North West': { lgas: ['Afikpo North'], centroid: { lat: 5.8851, lng: 7.9377 }, unitsBacking: 199, coordTier: 'crowd', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher indexed LGA names with their compass word stripped, so \'Afikpo North\' and \'Afikpo South\' collapsed to one key and this seat was attached to the wrong sibling. Same correction as \'Afikpo North East\'.' },
  'Ebonyi|Ikwo North': { lgas: ['Ikwo'], centroid: { lat: 6.079, lng: 8.1552 }, unitsBacking: 308, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ohaozara West': { lgas: ['Ohaozara'], centroid: { lat: 6.03685, lng: 7.81685 }, unitsBacking: 170, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Afikpo North East': { lgas: ['Afikpo North'], centroid: { lat: 5.8851, lng: 7.9377 }, unitsBacking: 199, coordTier: 'crowd', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher indexed LGA names with their compass word stripped, so \'Afikpo North\' and \'Afikpo South\' collapsed to one key and this seat was attached to the wrong sibling. Afikpo South had absorbed four seats while Afikpo North had none; Ebonyi then reconciles exactly at 13 LGAs / 24 seats.' },
  'Ebonyi|Ikwo South': { lgas: ['Ikwo'], centroid: { lat: 6.079, lng: 8.1552 }, unitsBacking: 308, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Afikpo South East': { lgas: ['Afikpo South'], centroid: { lat: 5.78955, lng: 7.8469 }, unitsBacking: 160, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ishielu North': { lgas: ['Ishielu'], centroid: { lat: 6.3825, lng: 7.7949 }, unitsBacking: 243, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Izzi East': { lgas: ['Izzi'], centroid: { lat: 6.4755, lng: 8.2391 }, unitsBacking: 299, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ishielu South': { lgas: ['Ishielu'], centroid: { lat: 6.3825, lng: 7.7949 }, unitsBacking: 243, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Onicha West': { lgas: ['Onicha'], centroid: { lat: 6.1131, lng: 7.834 }, unitsBacking: 217, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ohaozara East': { lgas: ['Ohaozara'], centroid: { lat: 6.03685, lng: 7.81685 }, unitsBacking: 170, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ezza North East': { lgas: ['Ezza North'], centroid: { lat: 6.2801, lng: 7.9916 }, unitsBacking: 207, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Abakaliki South': { lgas: ['Abakaliki'], centroid: { lat: 6.3056, lng: 8.1196 }, unitsBacking: 297, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ebonyi North West': { lgas: ['Ebonyi'], centroid: { lat: 6.36843, lng: 8.1008 }, unitsBacking: 229, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ohaukwu North': { lgas: ['Ohaukwu'], centroid: { lat: 6.5167, lng: 7.9923 }, unitsBacking: 303, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ezza North West': { lgas: ['Ezza North'], centroid: { lat: 6.2801, lng: 7.9916 }, unitsBacking: 207, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Onicha East': { lgas: ['Onicha'], centroid: { lat: 6.1131, lng: 7.834 }, unitsBacking: 217, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ohaukwu South': { lgas: ['Ohaukwu'], centroid: { lat: 6.5167, lng: 7.9923 }, unitsBacking: 303, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Afikpo South West': { lgas: ['Afikpo South'], centroid: { lat: 5.78955, lng: 7.8469 }, unitsBacking: 160, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Abakaliki North': { lgas: ['Abakaliki'], centroid: { lat: 6.3056, lng: 8.1196 }, unitsBacking: 297, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ebonyi North East': { lgas: ['Ebonyi'], centroid: { lat: 6.36843, lng: 8.1008 }, unitsBacking: 229, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ebonyi|Ivo': { lgas: ['Ivo'], centroid: { lat: 5.91972, lng: 7.56925 }, unitsBacking: 124, coordTier: 'crowd', provenance: 'auto-matched' },
  // Edo -----------------------------------------------------
  'Edo|Esan South East': { lgas: ['Esan South East'], centroid: { lat: 6.55958, lng: 6.40369 }, unitsBacking: 160, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Owan East': { lgas: ['Owan East'], centroid: { lat: 7.069, lng: 6.04283 }, unitsBacking: 189, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Uhunmwode': { lgas: ['Uhunmwode'], centroid: { lat: 6.428, lng: 5.88319 }, unitsBacking: 154, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Esan Central': { lgas: ['Esan Central'], centroid: { lat: 6.763, lng: 6.24 }, unitsBacking: 117, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Orhionmwon II': { lgas: ['Orhionmwon'], centroid: { lat: 6.15398, lng: 6.03968 }, unitsBacking: 265, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Owan West': { lgas: ['Owan West'], centroid: { lat: 6.932, lng: 5.91318 }, unitsBacking: 151, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Ikpoba-Okha': { lgas: ['Ikpoba/Okha'], centroid: { lat: 6.31606, lng: 5.65728 }, unitsBacking: 636, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Ovia North East I': { lgas: ['Ovia North East'], centroid: { lat: 6.49425, lng: 5.567 }, unitsBacking: 292, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Egor': { lgas: ['Egor'], centroid: { lat: 6.36655, lng: 5.60557 }, unitsBacking: 436, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Oredo West': { lgas: ['Oredo'], centroid: { lat: 6.335, lng: 5.619 }, unitsBacking: 603, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Ovia North East II': { lgas: ['Ovia North East'], centroid: { lat: 6.49425, lng: 5.567 }, unitsBacking: 292, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Oredo East': { lgas: ['Oredo'], centroid: { lat: 6.335, lng: 5.619 }, unitsBacking: 603, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Etsako West II': { lgas: ['Etsako West'], centroid: { lat: 7.06889, lng: 6.28061 }, unitsBacking: 322, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Etsako East': { lgas: ['Etsako East'], centroid: { lat: 7.21111, lng: 6.446 }, unitsBacking: 166, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Esan North East II': { lgas: ['Esan North East'], centroid: { lat: 6.715, lng: 6.32449 }, unitsBacking: 172, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Orhionmwon I': { lgas: ['Orhionmwon'], centroid: { lat: 6.15398, lng: 6.03968 }, unitsBacking: 265, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Akoko Edo II': { lgas: ['Akoko Edo'], centroid: { lat: 7.32756, lng: 6.11963 }, unitsBacking: 223, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Akoko Edo I': { lgas: ['Akoko Edo'], centroid: { lat: 7.32756, lng: 6.11963 }, unitsBacking: 223, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Esan North East I': { lgas: ['Esan North East'], centroid: { lat: 6.715, lng: 6.32449 }, unitsBacking: 172, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Etsako Central': { lgas: ['Etsako Central'], centroid: { lat: 7.037, lng: 6.495 }, unitsBacking: 97, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Etsako West I': { lgas: ['Etsako West'], centroid: { lat: 7.06889, lng: 6.28061 }, unitsBacking: 322, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Igueben': { lgas: ['Igueben'], centroid: { lat: 6.51112, lng: 6.24286 }, unitsBacking: 95, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Esan West': { lgas: ['Esan West'], centroid: { lat: 6.7405, lng: 6.14 }, unitsBacking: 200, coordTier: 'crowd', provenance: 'auto-matched' },
  'Edo|Ovia South West': { lgas: ['Ovia South West'], centroid: { lat: 6.56216, lng: 5.32294 }, unitsBacking: 195, coordTier: 'crowd', provenance: 'auto-matched' },
  // Ekiti ---------------------------------------------------
  'Ekiti|Ekiti West II': { lgas: ['Ekiti West'], centroid: { lat: 7.7097, lng: 5.00535 }, unitsBacking: 184, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ado I': { lgas: ['Ado Ekiti'], centroid: { lat: 7.62034, lng: 5.22208 }, unitsBacking: 344, coordTier: 'crowd', provenance: 'researched' },
  'Ekiti|Ekiti East I': { lgas: ['Ekiti East'], centroid: { lat: 7.7585, lng: 5.7216 }, unitsBacking: 112, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Moba II': { lgas: ['Moba'], centroid: { lat: 7.9902, lng: 5.14 }, unitsBacking: 116, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ekiti East II': { lgas: ['Ekiti East'], centroid: { lat: 7.7585, lng: 5.7216 }, unitsBacking: 112, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ado II': { lgas: ['Ado Ekiti'], centroid: { lat: 7.62034, lng: 5.22208 }, unitsBacking: 344, coordTier: 'crowd', provenance: 'researched' },
  'Ekiti|Irepodun/Ifelodun II': { lgas: ['Irepodun / Ifelodun'], centroid: { lat: 7.67935, lng: 5.1589 }, unitsBacking: 174, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ekiti South West I': { lgas: ['Ekiti South West'], centroid: { lat: 7.52205, lng: 5.066 }, unitsBacking: 188, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Efon': { lgas: ['Efon'], centroid: { lat: 7.6549, lng: 4.9223 }, unitsBacking: 119, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ido/Osi II': { lgas: ['Ido / Osi'], centroid: { lat: 7.84545, lng: 5.17835 }, unitsBacking: 144, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ilejemeje': { lgas: ['Ilejemeje'], centroid: { lat: 7.953, lng: 5.2362 }, unitsBacking: 91, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ekiti South West II': { lgas: ['Ekiti South West'], centroid: { lat: 7.52205, lng: 5.066 }, unitsBacking: 188, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Moba I': { lgas: ['Moba'], centroid: { lat: 7.9902, lng: 5.14 }, unitsBacking: 116, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Emure': { lgas: ['Emure'], centroid: { lat: 7.43725, lng: 5.46165 }, unitsBacking: 94, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ekiti West I': { lgas: ['Ekiti West'], centroid: { lat: 7.7097, lng: 5.00535 }, unitsBacking: 184, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Irepodun/Ifelodun I': { lgas: ['Irepodun / Ifelodun'], centroid: { lat: 7.67935, lng: 5.1589 }, unitsBacking: 174, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ido/Osi I': { lgas: ['Ido / Osi'], centroid: { lat: 7.84545, lng: 5.17835 }, unitsBacking: 144, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Oye I': { lgas: ['Oye'], centroid: { lat: 7.8013, lng: 5.3553 }, unitsBacking: 191, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ikere I': { lgas: ['Ikere'], centroid: { lat: 7.4929, lng: 5.227 }, unitsBacking: 125, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Oye II': { lgas: ['Oye'], centroid: { lat: 7.8013, lng: 5.3553 }, unitsBacking: 191, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ikere II': { lgas: ['Ikere'], centroid: { lat: 7.4929, lng: 5.227 }, unitsBacking: 125, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ijero': { lgas: ['Ijero'], centroid: { lat: 7.8484, lng: 5.0717 }, unitsBacking: 145, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Gbonyin': { lgas: ['Gbonyin'], centroid: { lat: 7.6051, lng: 5.5249 }, unitsBacking: 115, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ise/Orun': { lgas: ['Ise / Orun'], centroid: { lat: 7.463, lng: 5.42225 }, unitsBacking: 114, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ikole I': { lgas: ['Ikole'], centroid: { lat: 7.8165, lng: 5.5109 }, unitsBacking: 189, coordTier: 'crowd', provenance: 'auto-matched' },
  'Ekiti|Ikole II': { lgas: ['Ikole'], centroid: { lat: 7.8165, lng: 5.5109 }, unitsBacking: 189, coordTier: 'crowd', provenance: 'auto-matched' },
  // Enugu ---------------------------------------------------
  'Enugu|Enugu North': { lgas: ['Enugu North'], centroid: { lat: 6.44196, lng: 7.49989 }, unitsBacking: 393, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Awgu South': { lgas: ['Awgu'], centroid: { lat: 6.14175, lng: 7.46994 }, unitsBacking: 240, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Igbo-Eze North I': { lgas: ['Igbo Eze North'], centroid: { lat: 6.99782, lng: 7.46055 }, unitsBacking: 266, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Nsukka East': { lgas: ['Nsukka'], centroid: { lat: 6.8359, lng: 7.40043 }, unitsBacking: 397, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Aniniri': { lgas: ['Aninri'], centroid: { lat: 6.09405, lng: 7.6031 }, unitsBacking: 153, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Awgu North': { lgas: ['Awgu'], centroid: { lat: 6.14175, lng: 7.46994 }, unitsBacking: 240, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Igbo-Etiti West': { lgas: ['Igbo Etiti'], centroid: { lat: 6.6966, lng: 7.395 }, unitsBacking: 201, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Udi North': { lgas: ['Udi'], centroid: { lat: 6.435, lng: 7.40343 }, unitsBacking: 279, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Isi-Uzo': { lgas: ['Isi Uzo'], centroid: { lat: 6.74, lng: 7.732 }, unitsBacking: 159, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Enugu South I': { lgas: ['Enugu South'], centroid: { lat: 6.4073, lng: 7.496 }, unitsBacking: 321, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Igbo-Eze South': { lgas: ['Igbo Eze South'], centroid: { lat: 6.9186, lng: 7.41893 }, unitsBacking: 213, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Oji River': { lgas: ['Oji-River'], centroid: { lat: 6.156, lng: 7.2909 }, unitsBacking: 175, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Nkanu West': { lgas: ['Nkanu West'], centroid: { lat: 6.3167, lng: 7.542 }, unitsBacking: 207, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Ezeagu': { lgas: ['Ezeagu'], centroid: { lat: 6.3849, lng: 7.2594 }, unitsBacking: 180, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Nsukka West': { lgas: ['Nsukka'], centroid: { lat: 6.8359, lng: 7.40043 }, unitsBacking: 397, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Nkanu East': { lgas: ['Nkanu East'], centroid: { lat: 6.27425, lng: 7.6707 }, unitsBacking: 164, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Udi South': { lgas: ['Udi'], centroid: { lat: 6.435, lng: 7.40343 }, unitsBacking: 279, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Igbo-Eze North II': { lgas: ['Igbo Eze North'], centroid: { lat: 6.99782, lng: 7.46055 }, unitsBacking: 266, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Enugu East II': { lgas: ['Enugu East'], centroid: { lat: 6.4839, lng: 7.51988 }, unitsBacking: 386, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Enugu East I': { lgas: ['Enugu East'], centroid: { lat: 6.4839, lng: 7.51988 }, unitsBacking: 386, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Enugu South II': { lgas: ['Enugu South'], centroid: { lat: 6.4073, lng: 7.496 }, unitsBacking: 321, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Igbo-Etiti East': { lgas: ['Igbo Etiti'], centroid: { lat: 6.6966, lng: 7.395 }, unitsBacking: 201, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Udenu': { lgas: ['Udenu'], centroid: { lat: 6.8738, lng: 7.5153 }, unitsBacking: 265, coordTier: 'crowd', provenance: 'auto-matched' },
  'Enugu|Uzo Uwani': { lgas: ['Uzo-Uwani'], centroid: { lat: 6.75075, lng: 7.16245 }, unitsBacking: 146, coordTier: 'crowd', provenance: 'auto-matched' },
  // Gombe ---------------------------------------------------
  'Gombe|Kwami West': { lgas: ['Kwami'], centroid: { lat: 10.4479, lng: 11.2294 }, unitsBacking: 237, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Kwami East': { lgas: ['Kwami'], centroid: { lat: 10.4479, lng: 11.2294 }, unitsBacking: 237, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Akko North': { lgas: ['Akko'], centroid: { lat: 10.0725, lng: 11.15057 }, unitsBacking: 468, coordTier: 'crowd', provenance: 'auto-matched' },
  'Gombe|Deba': { lgas: ['Yalmaltu/ Deba'], centroid: { lat: 10.26163, lng: 11.4126 }, unitsBacking: 401, coordTier: 'approx', provenance: 'researched' },
  'Gombe|Akko Central': { lgas: ['Akko'], centroid: { lat: 10.0725, lng: 11.15057 }, unitsBacking: 468, coordTier: 'crowd', provenance: 'auto-matched' },
  'Gombe|Gombe North': { lgas: ['Gombe'], centroid: { lat: 10.28698, lng: 11.177 }, unitsBacking: 408, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Funakaye South': { lgas: ['Funakaye'], centroid: { lat: 10.85005, lng: 11.41305 }, unitsBacking: 258, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Yamaltu West': { lgas: ['Yalmaltu/ Deba'], centroid: { lat: 10.26163, lng: 11.4126 }, unitsBacking: 401, coordTier: 'approx', provenance: 'researched' },
  'Gombe|Billiri East': { lgas: ['Billiri'], centroid: { lat: 9.86288, lng: 11.16113 }, unitsBacking: 202, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Funakaye North': { lgas: ['Funakaye'], centroid: { lat: 10.85005, lng: 11.41305 }, unitsBacking: 258, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Dukku South': { lgas: ['Dukku'], centroid: { lat: 10.8381, lng: 10.776 }, unitsBacking: 260, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Balanga South': { lgas: ['Balanga'], centroid: { lat: 9.8278, lng: 11.66333 }, unitsBacking: 254, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Dukku North': { lgas: ['Dukku'], centroid: { lat: 10.8381, lng: 10.776 }, unitsBacking: 260, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Billiri West': { lgas: ['Billiri'], centroid: { lat: 9.86288, lng: 11.16113 }, unitsBacking: 202, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Gombe South': { lgas: ['Gombe'], centroid: { lat: 10.28698, lng: 11.177 }, unitsBacking: 408, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Kaltungo West': { lgas: ['Kaltungo'], centroid: { lat: 9.84869, lng: 11.363 }, unitsBacking: 247, coordTier: 'crowd', provenance: 'auto-matched' },
  'Gombe|Yamaltu East': { lgas: ['Yalmaltu/ Deba'], centroid: { lat: 10.26163, lng: 11.4126 }, unitsBacking: 401, coordTier: 'approx', provenance: 'researched' },
  'Gombe|Shongom': { lgas: ['Shongom'], centroid: { lat: 9.63055, lng: 11.1916 }, unitsBacking: 122, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Balanga North': { lgas: ['Balanga'], centroid: { lat: 9.8278, lng: 11.66333 }, unitsBacking: 254, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Nafada South': { lgas: ['Nafada'], centroid: { lat: 11.06769, lng: 11.26829 }, unitsBacking: 131, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Nafada North': { lgas: ['Nafada'], centroid: { lat: 11.06769, lng: 11.26829 }, unitsBacking: 131, coordTier: 'approx', provenance: 'auto-matched' },
  'Gombe|Kaltungo East': { lgas: ['Kaltungo'], centroid: { lat: 9.84869, lng: 11.363 }, unitsBacking: 247, coordTier: 'crowd', provenance: 'auto-matched' },
  'Gombe|Pero Chonge': { lgas: ['Shongom'], centroid: { lat: 9.63055, lng: 11.1916 }, unitsBacking: 122, coordTier: 'approx', provenance: 'researched' },
  'Gombe|Akko West': { lgas: ['Akko'], centroid: { lat: 10.0725, lng: 11.15057 }, unitsBacking: 468, coordTier: 'crowd', provenance: 'auto-matched' },
  // Imo -----------------------------------------------------
  'Imo|Ezinihitte': { lgas: ['Ezinihitte Mbaise'], centroid: { lat: 5.47499, lng: 7.32469 }, unitsBacking: 175, coordTier: 'approx', provenance: 'researched' },
  'Imo|Orlu': { lgas: ['Orlu'], centroid: { lat: 5.7896, lng: 7.0273 }, unitsBacking: 209, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Ideato South': { lgas: ['Ideato South'], centroid: { lat: 5.80585, lng: 7.1502 }, unitsBacking: 152, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Oguta': { lgas: ['Oguta'], centroid: { lat: 5.64434, lng: 6.85515 }, unitsBacking: 179, coordTier: 'crowd', provenance: 'auto-matched' },
  'Imo|Owerri West': { lgas: ['Owerri West'], centroid: { lat: 5.4304, lng: 6.99305 }, unitsBacking: 251, coordTier: 'crowd', provenance: 'auto-matched' },
  'Imo|Ehime Mbano': { lgas: ['Ehime Mbano'], centroid: { lat: 5.664, lng: 7.2755 }, unitsBacking: 154, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Ngor Okpala': { lgas: ['Ngor Okpala'], centroid: { lat: 5.314, lng: 7.19086 }, unitsBacking: 193, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Nwangele': { lgas: ['Nwangele'], centroid: { lat: 5.70345, lng: 7.14454 }, unitsBacking: 82, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Owerri North': { lgas: ['Owerri North'], centroid: { lat: 5.474, lng: 7.07721 }, unitsBacking: 236, coordTier: 'crowd', provenance: 'auto-matched' },
  'Imo|Ohaji/Egbema': { lgas: ['Ohaji/Egbema'], centroid: { lat: 5.3565, lng: 6.84022 }, unitsBacking: 210, coordTier: 'crowd', provenance: 'auto-matched' },
  'Imo|Ikeduru': { lgas: ['Ikeduru'], centroid: { lat: 5.56959, lng: 7.14131 }, unitsBacking: 227, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Owerri Municipal': { lgas: ['Owerri Municipal'], centroid: { lat: 5.486, lng: 7.02531 }, unitsBacking: 239, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Mbaitoli': { lgas: ['Mbaitoli'], centroid: { lat: 5.59999, lng: 7.01543 }, unitsBacking: 286, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Ideato North': { lgas: ['Ideato North'], centroid: { lat: 5.88687, lng: 7.09966 }, unitsBacking: 196, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Orsu': { lgas: ['Orsu'], centroid: { lat: 5.845, lng: 6.979 }, unitsBacking: 137, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Oru East': { lgas: ['Oru-East'], centroid: { lat: 5.75592, lng: 6.94986 }, unitsBacking: 146, coordTier: 'crowd', provenance: 'auto-matched' },
  'Imo|Obowo': { lgas: ['Obowo'], centroid: { lat: 5.56065, lng: 7.3539 }, unitsBacking: 128, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Okigwe': { lgas: ['Okigwe'], centroid: { lat: 5.82423, lng: 7.32631 }, unitsBacking: 154, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Onuimo': { lgas: ['Onuimo'], centroid: { lat: 5.772, lng: 7.23069 }, unitsBacking: 89, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Ahiazu Mbaise': { lgas: ['Ahiazu Mbaise'], centroid: { lat: 5.542, lng: 7.27393 }, unitsBacking: 185, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Isiala Mbano': { lgas: ['Isiala Mbano'], centroid: { lat: 5.66604, lng: 7.18263 }, unitsBacking: 196, coordTier: 'crowd', provenance: 'auto-matched' },
  'Imo|Ihite/Uboma': { lgas: ['Ihitte/Uboma'], centroid: { lat: 5.61297, lng: 7.3675 }, unitsBacking: 108, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Aboh Mbaise': { lgas: ['Aboh Mbaise'], centroid: { lat: 5.465, lng: 7.243 }, unitsBacking: 212, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Njaba': { lgas: ['Njaba'], centroid: { lat: 5.71837, lng: 7.0132 }, unitsBacking: 124, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Nkwerre': { lgas: ['Nkwerre'], centroid: { lat: 5.74885, lng: 7.11873 }, unitsBacking: 131, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Isu': { lgas: ['Isu'], centroid: { lat: 5.6863, lng: 7.05256 }, unitsBacking: 123, coordTier: 'approx', provenance: 'auto-matched' },
  'Imo|Oru West': { lgas: ['Oru West'], centroid: { lat: 5.749, lng: 6.9037 }, unitsBacking: 147, coordTier: 'crowd', provenance: 'auto-matched' },
  // Jigawa --------------------------------------------------
  'Jigawa|Dutse': { lgas: ['Dutse'], centroid: { lat: 11.73688, lng: 9.334 }, unitsBacking: 267, coordTier: 'crowd', provenance: 'auto-matched' },
  'Jigawa|Gumel': { lgas: ['Gumel'], centroid: { lat: 12.63, lng: 9.39063 }, unitsBacking: 103, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Garki': { lgas: ['Garki'], centroid: { lat: 12.4195, lng: 9.09863 }, unitsBacking: 172, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Babura': { lgas: ['Babura'], centroid: { lat: 12.62188, lng: 8.845 }, unitsBacking: 214, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Gwiwa': { lgas: ['Gwiwa'], centroid: { lat: 12.76499, lng: 8.276 }, unitsBacking: 107, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Kazaure': { lgas: ['Kazaure'], centroid: { lat: 12.64841, lng: 8.42922 }, unitsBacking: 144, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Kaugama': { lgas: ['Kaugama'], centroid: { lat: 12.39627, lng: 9.733 }, unitsBacking: 155, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Kiri-Kasamma': { lgas: ['Kirika Samma'], centroid: { lat: 12.568, lng: 10.227 }, unitsBacking: 149, coordTier: 'crowd', provenance: 'auto-matched' },
  'Jigawa|Birniwa': { lgas: ['Birniwa'], centroid: { lat: 12.80335, lng: 10.0955 }, unitsBacking: 148, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Balangu': { lgas: ['Kafin Hausa'], centroid: { lat: 12.17775, lng: 9.99522 }, unitsBacking: 239, coordTier: 'approx', provenance: 'researched' },
  'Jigawa|Kafin Hausa': { lgas: ['Kafin Hausa'], centroid: { lat: 12.17775, lng: 9.99522 }, unitsBacking: 239, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Jahun': { lgas: ['Jahun'], centroid: { lat: 12.084, lng: 9.53348 }, unitsBacking: 232, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Hadejia': { lgas: ['Hadejia'], centroid: { lat: 12.45028, lng: 10.04216 }, unitsBacking: 138, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Fagam': { lgas: ['Gwaram'], centroid: { lat: 11.2723, lng: 9.88887 }, unitsBacking: 298, coordTier: 'approx', provenance: 'researched' },
  'Jigawa|Gwaram': { lgas: ['Gwaram'], centroid: { lat: 11.2723, lng: 9.88887 }, unitsBacking: 298, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Birnin Kudu': { lgas: ['Birnin Kudu'], centroid: { lat: 11.44735, lng: 9.47745 }, unitsBacking: 322, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Guri': { lgas: ['Guri'], centroid: { lat: 12.675, lng: 10.433 }, unitsBacking: 113, coordTier: 'crowd', provenance: 'auto-matched' },
  'Jigawa|Buji': { lgas: ['Buji'], centroid: { lat: 11.581, lng: 9.72956 }, unitsBacking: 117, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Kanya': { lgas: ['Babura'], centroid: { lat: 12.62188, lng: 8.845 }, unitsBacking: 214, coordTier: 'approx', provenance: 'researched' },
  'Jigawa|Taura': { lgas: ['Taura'], centroid: { lat: 12.273, lng: 9.374 }, unitsBacking: 157, coordTier: 'crowd', provenance: 'auto-matched' },
  'Jigawa|Gagarawa': { lgas: ['Gagarawa'], centroid: { lat: 12.46466, lng: 9.537 }, unitsBacking: 89, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Maigatari': { lgas: ['Maigatari'], centroid: { lat: 12.74556, lng: 9.502 }, unitsBacking: 161, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Roni': { lgas: ['Roni'], centroid: { lat: 12.6145, lng: 8.316 }, unitsBacking: 110, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Auyo': { lgas: ['Auyo'], centroid: { lat: 12.35873, lng: 9.95826 }, unitsBacking: 137, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Yankwashi': { lgas: ['Yankwashi'], centroid: { lat: 12.765, lng: 8.51432 }, unitsBacking: 77, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Mallam Madori': { lgas: ['Malam Madori'], centroid: { lat: 12.52994, lng: 9.92047 }, unitsBacking: 154, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Ringim': { lgas: ['Ringim'], centroid: { lat: 12.15269, lng: 9.14391 }, unitsBacking: 240, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Kiyawa': { lgas: ['Kiyawa'], centroid: { lat: 11.815, lng: 9.582 }, unitsBacking: 167, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Miga': { lgas: ['Miga'], centroid: { lat: 12.213, lng: 9.70273 }, unitsBacking: 113, coordTier: 'approx', provenance: 'auto-matched' },
  'Jigawa|Sule-Tankarkar': { lgas: ['Sule-Tankarkar'], centroid: { lat: 12.64067, lng: 9.219 }, unitsBacking: 167, coordTier: 'crowd', provenance: 'auto-matched' },
  // Kaduna --------------------------------------------------
  'Kaduna|Zaria Kewaye': { lgas: ['Zaria'], centroid: { lat: 11.06381, lng: 7.70624 }, unitsBacking: 584, coordTier: 'crowd', provenance: 'researched' },
  'Kaduna|Doka/Gabasawa': { lgas: ['Kaduna North'], centroid: { lat: 10.55035, lng: 7.44792 }, unitsBacking: 664, coordTier: 'crowd', provenance: 'researched' },
  'Kaduna|Unguwar Sanusi': { lgas: ['Kaduna South'], centroid: { lat: 10.50865, lng: 7.41186 }, unitsBacking: 796, coordTier: 'crowd', provenance: 'researched' },
  'Kaduna|Makera': { lgas: ['Kaduna South'], centroid: { lat: 10.50865, lng: 7.41186 }, unitsBacking: 796, coordTier: 'crowd', provenance: 'researched' },
  'Kaduna|Zaria City': { lgas: ['Zaria'], centroid: { lat: 11.06381, lng: 7.70624 }, unitsBacking: 584, coordTier: 'crowd', provenance: 'researched' },
  'Kaduna|Soba': { lgas: ['Soba'], centroid: { lat: 10.99379, lng: 7.97374 }, unitsBacking: 298, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Lere West': { lgas: ['Lere'], centroid: { lat: 10.4104, lng: 8.631 }, unitsBacking: 457, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Igabi West': { lgas: ['Igabi'], centroid: { lat: 10.68453, lng: 7.5052 }, unitsBacking: 585, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kaduna|Kachia': { lgas: ['Kachia'], centroid: { lat: 9.78, lng: 7.93578 }, unitsBacking: 317, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Chikun I': { lgas: ['Chikun'], centroid: { lat: 10.45465, lng: 7.445 }, unitsBacking: 542, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kaduna|Kawo': { lgas: ['Kaduna North'], centroid: { lat: 10.55035, lng: 7.44792 }, unitsBacking: 664, coordTier: 'crowd', provenance: 'researched' },
  'Kaduna|Tudun Wada': { lgas: ['Kaduna South'], centroid: { lat: 10.50865, lng: 7.41186 }, unitsBacking: 796, coordTier: 'crowd', provenance: 'researched' },
  'Kaduna|Jaba': { lgas: ['Jaba'], centroid: { lat: 9.46, lng: 8.01106 }, unitsBacking: 132, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Sabon Gari': { lgas: ['Sabon Gari'], centroid: { lat: 11.13095, lng: 7.72287 }, unitsBacking: 398, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Kudan': { lgas: ['Kudan'], centroid: { lat: 11.26765, lng: 7.74484 }, unitsBacking: 193, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Sanga': { lgas: ['Sanga'], centroid: { lat: 9.25107, lng: 8.517 }, unitsBacking: 195, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Makarfi': { lgas: ['Makarfi'], centroid: { lat: 11.3325, lng: 7.8995 }, unitsBacking: 186, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Giwa West': { lgas: ['Giwa'], centroid: { lat: 11.20237, lng: 7.44757 }, unitsBacking: 248, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Chawai/Kauru': { lgas: ['Kauru'], centroid: { lat: 10.38174, lng: 8.273 }, unitsBacking: 243, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Lere East': { lgas: ['Lere'], centroid: { lat: 10.4104, lng: 8.631 }, unitsBacking: 457, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Igabi East': { lgas: ['Igabi'], centroid: { lat: 10.68453, lng: 7.5052 }, unitsBacking: 585, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kaduna|Kubau': { lgas: ['Kubau'], centroid: { lat: 10.86405, lng: 8.31588 }, unitsBacking: 310, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Jema\'a': { lgas: ['Jema\'A'], centroid: { lat: 9.48301, lng: 8.28924 }, unitsBacking: 325, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Basawa': { lgas: ['Sabon Gari'], centroid: { lat: 11.13095, lng: 7.72287 }, unitsBacking: 398, coordTier: 'approx', provenance: 'researched' },
  'Kaduna|Magajin Gari': { lgas: ['Birnin Gwari'], centroid: { lat: 10.6943, lng: 6.57002 }, unitsBacking: 245, coordTier: 'approx', provenance: 'researched' },
  'Kaduna|Ikara': { lgas: ['Ikara'], centroid: { lat: 11.22592, lng: 8.16501 }, unitsBacking: 251, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Zangon Kataf': { lgas: ['Zangon Kataf'], centroid: { lat: 9.78537, lng: 8.291 }, unitsBacking: 337, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kaduna|Kakangi': { lgas: ['Birnin Gwari'], centroid: { lat: 10.6943, lng: 6.57002 }, unitsBacking: 245, coordTier: 'approx', provenance: 'researched' },
  'Kaduna|Kajuru': { lgas: ['Kajuru'], centroid: { lat: 10.29145, lng: 7.74113 }, unitsBacking: 188, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Kagarko': { lgas: ['Kagarko'], centroid: { lat: 9.49847, lng: 7.705 }, unitsBacking: 222, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Zonkwa': { lgas: ['Zangon Kataf'], centroid: { lat: 9.78537, lng: 8.291 }, unitsBacking: 337, coordTier: 'crowd', provenance: 'researched' },
  'Kaduna|Giwa East': { lgas: ['Giwa'], centroid: { lat: 11.20237, lng: 7.44757 }, unitsBacking: 248, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Kaura': { lgas: ['Kaura'], centroid: { lat: 9.65393, lng: 8.43935 }, unitsBacking: 186, coordTier: 'approx', provenance: 'auto-matched' },
  'Kaduna|Maigana': { lgas: ['Soba'], centroid: { lat: 10.99379, lng: 7.97374 }, unitsBacking: 298, coordTier: 'approx', provenance: 'researched' },
  // Kano ----------------------------------------------------
  'Kano|Munjibir': { lgas: ['Minjibir'], centroid: { lat: 12.18113, lng: 8.62296 }, unitsBacking: 172, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Ajingi': { lgas: ['Ajingi'], centroid: { lat: 11.975, lng: 9.03658 }, unitsBacking: 175, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Ungogo': { lgas: ['Ungogo'], centroid: { lat: 12.05032, lng: 8.48025 }, unitsBacking: 384, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Dawakin Kudu': { lgas: ['Dawaki Kudu'], centroid: { lat: 11.8419, lng: 8.6372 }, unitsBacking: 303, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Madobi': { lgas: ['Madobi'], centroid: { lat: 11.817, lng: 8.356 }, unitsBacking: 171, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Bichi': { lgas: ['Bichi'], centroid: { lat: 12.26121, lng: 8.2389 }, unitsBacking: 277, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Rimi Gado/Tofa': { lgas: ['Rimin Gado', 'Tofa'], centroid: { lat: 11.9823, lng: 8.30306 }, unitsBacking: 283, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Dawakin Tofa': { lgas: ['Dawaki Tofa'], centroid: { lat: 12.13557, lng: 8.41054 }, unitsBacking: 224, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Bunkure': { lgas: ['Bunkure'], centroid: { lat: 11.68836, lng: 8.581 }, unitsBacking: 183, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Takai': { lgas: ['Takai'], centroid: { lat: 11.523, lng: 9.1526 }, unitsBacking: 251, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Kura/Gurun Mallam': { lgas: ['Garun Malam', 'Kura'], centroid: { lat: 11.769, lng: 8.428 }, unitsBacking: 368, coordTier: 'approx', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher\'s compound split dropped \'Garun Malam\', which INEC spells \'Gurun Mallam\' — leaving that LGA with no constituency at all. Kano needs exactly four two-LGA seats to reconcile 44 LGAs against 40 constituencies; the other three matched, making this the fourth.' },
  'Kano|Gaya': { lgas: ['Gaya'], centroid: { lat: 11.84893, lng: 8.977 }, unitsBacking: 206, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Nassarawa': { lgas: ['Nasarawa'], centroid: { lat: 12.02435, lng: 8.56349 }, unitsBacking: 817, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Karaye': { lgas: ['Karaye'], centroid: { lat: 11.77824, lng: 7.99045 }, unitsBacking: 148, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Kumbotso': { lgas: ['Kumbotso'], centroid: { lat: 11.929, lng: 8.5118 }, unitsBacking: 410, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Gabasawa': { lgas: ['Gabasawa'], centroid: { lat: 12.151, lng: 8.8535 }, unitsBacking: 164, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Gwarzo': { lgas: ['Gwarzo'], centroid: { lat: 11.9065, lng: 7.9355 }, unitsBacking: 210, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Dala': { lgas: ['Dala'], centroid: { lat: 12.014, lng: 8.50389 }, unitsBacking: 668, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Fagge': { lgas: ['Fagge'], centroid: { lat: 12.017, lng: 8.52988 }, unitsBacking: 521, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Rano': { lgas: ['Rano'], centroid: { lat: 11.533, lng: 8.56514 }, unitsBacking: 165, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Gwale': { lgas: ['Gwale'], centroid: { lat: 11.988, lng: 8.4995 }, unitsBacking: 450, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Tsanyawa/Kunchi': { lgas: ['Kunchi', 'Tsanyawa'], centroid: { lat: 12.365, lng: 8.095 }, unitsBacking: 299, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Kibiya': { lgas: ['Kibiya'], centroid: { lat: 11.53005, lng: 8.672 }, unitsBacking: 149, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Sumaila': { lgas: ['Sumaila'], centroid: { lat: 11.3846, lng: 8.94909 }, unitsBacking: 221, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Bebeji': { lgas: ['Bebeji'], centroid: { lat: 11.5866, lng: 8.28 }, unitsBacking: 161, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Albasu': { lgas: ['Albasu'], centroid: { lat: 11.645, lng: 9.059 }, unitsBacking: 177, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Kabo': { lgas: ['Kabo'], centroid: { lat: 11.877, lng: 8.165 }, unitsBacking: 177, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Wudil': { lgas: ['Wudil'], centroid: { lat: 11.793, lng: 8.84443 }, unitsBacking: 216, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Shanono/Bagwai': { lgas: ['Bagwai', 'Shanono'], centroid: { lat: 12.1032, lng: 8.069 }, unitsBacking: 337, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Kano Municipal': { lgas: ['Kano Municipal'], centroid: { lat: 11.99473, lng: 8.51935 }, unitsBacking: 630, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Kiru': { lgas: ['Kiru'], centroid: { lat: 11.63486, lng: 8.167 }, unitsBacking: 246, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Rogo': { lgas: ['Rogo'], centroid: { lat: 11.5145, lng: 7.823 }, unitsBacking: 220, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Makoda': { lgas: ['Makoda'], centroid: { lat: 12.37, lng: 8.488 }, unitsBacking: 134, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Tudun Wada': { lgas: ['Tudun Wada'], centroid: { lat: 11.277, lng: 8.4244 }, unitsBacking: 281, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Tarauni': { lgas: ['Tarauni'], centroid: { lat: 11.96506, lng: 8.55717 }, unitsBacking: 425, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kano|Dambatta': { lgas: ['Danbata'], centroid: { lat: 12.41598, lng: 8.58047 }, unitsBacking: 237, coordTier: 'approx', provenance: 'researched' },
  'Kano|Doguwa': { lgas: ['Doguwa'], centroid: { lat: 10.7455, lng: 8.6068 }, unitsBacking: 128, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Gezawa': { lgas: ['Gezawa'], centroid: { lat: 12.04, lng: 8.716 }, unitsBacking: 229, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Garko': { lgas: ['Garko'], centroid: { lat: 11.607, lng: 8.827 }, unitsBacking: 190, coordTier: 'approx', provenance: 'auto-matched' },
  'Kano|Warawa': { lgas: ['Warawa'], centroid: { lat: 11.9326, lng: 8.7652 }, unitsBacking: 143, coordTier: 'crowd', provenance: 'auto-matched' },
  // Katsina -------------------------------------------------
  'Katsina|Malumfashi East': { lgas: ['Malufashi'], centroid: { lat: 11.7916, lng: 7.62027 }, unitsBacking: 325, coordTier: 'crowd', provenance: 'researched' },
  'Katsina|Bakori': { lgas: ['Bakori'], centroid: { lat: 11.588, lng: 7.42615 }, unitsBacking: 242, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Batsari': { lgas: ['Batsari'], centroid: { lat: 12.77471, lng: 7.247 }, unitsBacking: 219, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Funtua': { lgas: ['Funtua'], centroid: { lat: 11.51745, lng: 7.31028 }, unitsBacking: 298, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Mashi': { lgas: ['Mashi'], centroid: { lat: 13.063, lng: 7.99225 }, unitsBacking: 174, coordTier: 'crowd', provenance: 'auto-matched' },
  'Katsina|Rimi': { lgas: ['Rimi'], centroid: { lat: 12.8517, lng: 7.72572 }, unitsBacking: 173, coordTier: 'crowd', provenance: 'auto-matched' },
  'Katsina|Kurfi': { lgas: ['Kurfi'], centroid: { lat: 12.6565, lng: 7.4815 }, unitsBacking: 140, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Dutsin-Ma': { lgas: ['Dutsin-Ma'], centroid: { lat: 12.4343, lng: 7.50185 }, unitsBacking: 209, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Safana': { lgas: ['Safana'], centroid: { lat: 12.53505, lng: 7.29285 }, unitsBacking: 168, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Faskari': { lgas: ['Faskari'], centroid: { lat: 11.71969, lng: 7.07835 }, unitsBacking: 231, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Katsina': { lgas: ['Katsina'], centroid: { lat: 12.994, lng: 7.597 }, unitsBacking: 469, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Mai\'adua': { lgas: ['Mai\'Adua'], centroid: { lat: 13.14084, lng: 8.22865 }, unitsBacking: 186, coordTier: 'crowd', provenance: 'auto-matched' },
  'Katsina|Sandamu': { lgas: ['Sandamu'], centroid: { lat: 12.9, lng: 8.38 }, unitsBacking: 145, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Bindawa': { lgas: ['Bindawa'], centroid: { lat: 12.7179, lng: 7.886 }, unitsBacking: 169, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Dutsi': { lgas: ['Dutsi'], centroid: { lat: 12.911, lng: 8.14885 }, unitsBacking: 118, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Musawa': { lgas: ['Musawa'], centroid: { lat: 12.112, lng: 7.74143 }, unitsBacking: 161, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Charanchi': { lgas: ['Charanchi'], centroid: { lat: 12.66823, lng: 7.70251 }, unitsBacking: 141, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Baure': { lgas: ['Baure'], centroid: { lat: 12.80951, lng: 8.79705 }, unitsBacking: 206, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Daura': { lgas: ['Daura'], centroid: { lat: 13.02443, lng: 8.3244 }, unitsBacking: 185, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Danja': { lgas: ['Danja'], centroid: { lat: 11.38341, lng: 7.5545 }, unitsBacking: 192, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Batagarawa': { lgas: ['Batagarawa'], centroid: { lat: 12.90988, lng: 7.60855 }, unitsBacking: 186, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Sabuwa': { lgas: ['Sabuwa'], centroid: { lat: 11.32, lng: 7.09602 }, unitsBacking: 125, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Kusada': { lgas: ['Kusada'], centroid: { lat: 12.46398, lng: 7.967 }, unitsBacking: 114, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Zango': { lgas: ['Zango'], centroid: { lat: 12.99662, lng: 8.50665 }, unitsBacking: 135, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Kankia': { lgas: ['Kankia'], centroid: { lat: 12.50399, lng: 7.81153 }, unitsBacking: 157, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Danmusa': { lgas: ['Dan Musa'], centroid: { lat: 12.216, lng: 7.32937 }, unitsBacking: 165, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Kafur': { lgas: ['Kafur'], centroid: { lat: 11.6729, lng: 7.686 }, unitsBacking: 251, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Kankara': { lgas: ['Kankara'], centroid: { lat: 11.92477, lng: 7.441 }, unitsBacking: 222, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Ingawa': { lgas: ['Ingawa'], centroid: { lat: 12.65061, lng: 8.07928 }, unitsBacking: 170, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Mani': { lgas: ['Mani'], centroid: { lat: 12.8624, lng: 7.88082 }, unitsBacking: 207, coordTier: 'crowd', provenance: 'auto-matched' },
  'Katsina|Jibia': { lgas: ['Jibia'], centroid: { lat: 13.08547, lng: 7.27149 }, unitsBacking: 192, coordTier: 'crowd', provenance: 'auto-matched' },
  'Katsina|Kaita': { lgas: ['Kaita'], centroid: { lat: 13.15214, lng: 7.756 }, unitsBacking: 149, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Dandume': { lgas: ['Dandume'], centroid: { lat: 11.4348, lng: 7.18957 }, unitsBacking: 161, coordTier: 'approx', provenance: 'auto-matched' },
  'Katsina|Matazu': { lgas: ['Matazu'], centroid: { lat: 12.23599, lng: 7.6616 }, unitsBacking: 132, coordTier: 'crowd', provenance: 'auto-matched' },
  // Kebbi ---------------------------------------------------
  'Kebbi|Yauri': { lgas: ['Yauri'], centroid: { lat: 10.83254, lng: 4.741 }, unitsBacking: 138, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Shanga': { lgas: ['Shanga'], centroid: { lat: 11.13783, lng: 4.592 }, unitsBacking: 144, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Fakai': { lgas: ['Fakai'], centroid: { lat: 11.527, lng: 4.97268 }, unitsBacking: 101, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Birnin Kebbi South': { lgas: ['Birnin Kebbi'], centroid: { lat: 12.45942, lng: 4.19627 }, unitsBacking: 385, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Birnin Kebbi North': { lgas: ['Birnin Kebbi'], centroid: { lat: 12.45942, lng: 4.19627 }, unitsBacking: 385, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Bagudo East': { lgas: ['Bagudo'], centroid: { lat: 11.44461, lng: 4.11957 }, unitsBacking: 226, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Wasagu/Danko East': { lgas: ['Wasagu/Danko'], centroid: { lat: 11.40649, lng: 5.616 }, unitsBacking: 229, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Zuru': { lgas: ['Zuru'], centroid: { lat: 11.44, lng: 5.233 }, unitsBacking: 200, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Jega': { lgas: ['Jega'], centroid: { lat: 12.22021, lng: 4.38111 }, unitsBacking: 232, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kebbi|Sakaba': { lgas: ['Sakaba'], centroid: { lat: 11.156, lng: 5.49224 }, unitsBacking: 98, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Ngaski': { lgas: ['Ngaski'], centroid: { lat: 10.37278, lng: 4.67 }, unitsBacking: 128, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Gwandu': { lgas: ['Gwandu'], centroid: { lat: 12.498, lng: 4.645 }, unitsBacking: 156, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Koko/Besse': { lgas: ['Koko/Besse'], centroid: { lat: 11.41136, lng: 4.446 }, unitsBacking: 191, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Wasagu/Danko West': { lgas: ['Wasagu/Danko'], centroid: { lat: 11.40649, lng: 5.616 }, unitsBacking: 229, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Arewa': { lgas: ['Arewa'], centroid: { lat: 12.7261, lng: 4.06705 }, unitsBacking: 214, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kebbi|Bunza': { lgas: ['Bunza'], centroid: { lat: 12.16073, lng: 4.006 }, unitsBacking: 141, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Dandi': { lgas: ['Dandi'], centroid: { lat: 11.83504, lng: 3.735 }, unitsBacking: 190, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Kalgo': { lgas: ['Kalgo'], centroid: { lat: 12.35295, lng: 4.03747 }, unitsBacking: 104, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Argungu': { lgas: ['Argungu'], centroid: { lat: 12.734, lng: 4.50191 }, unitsBacking: 246, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Aleiro': { lgas: ['Aliero'], centroid: { lat: 12.294, lng: 4.447 }, unitsBacking: 92, coordTier: 'approx', provenance: 'researched' },
  'Kebbi|Maiyama': { lgas: ['Maiyama'], centroid: { lat: 12.0835, lng: 4.31465 }, unitsBacking: 172, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Suru': { lgas: ['Suru'], centroid: { lat: 11.78087, lng: 4.08176 }, unitsBacking: 207, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Augie': { lgas: ['Augie'], centroid: { lat: 12.875, lng: 4.605 }, unitsBacking: 141, coordTier: 'approx', provenance: 'auto-matched' },
  'Kebbi|Bagudo West': { lgas: ['Bagudo'], centroid: { lat: 11.44461, lng: 4.11957 }, unitsBacking: 226, coordTier: 'approx', provenance: 'auto-matched' },
  // Kogi ----------------------------------------------------
  'Kogi|Kabba/Bunu': { lgas: ['Kabba/Bunu'], centroid: { lat: 7.84427, lng: 6.09333 }, unitsBacking: 147, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Ofu': { lgas: ['Ofu'], centroid: { lat: 7.32826, lng: 7.04433 }, unitsBacking: 184, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Ankpa II': { lgas: ['Ankpa'], centroid: { lat: 7.42788, lng: 7.58595 }, unitsBacking: 292, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Bassa': { lgas: ['Bassa'], centroid: { lat: 7.836, lng: 7.06066 }, unitsBacking: 130, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Igalamela-Odolu': { lgas: ['Igalamela/Odolu'], centroid: { lat: 7.11921, lng: 7.01821 }, unitsBacking: 140, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Idah': { lgas: ['Idah'], centroid: { lat: 7.10559, lng: 6.74048 }, unitsBacking: 120, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Adavi': { lgas: ['Adavi'], centroid: { lat: 7.57251, lng: 6.2424 }, unitsBacking: 217, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Ibaji': { lgas: ['Ibaji'], centroid: { lat: 6.78958, lng: 6.72896 }, unitsBacking: 174, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Okene II (South)': { lgas: ['Okene'], centroid: { lat: 7.5464, lng: 6.23376 }, unitsBacking: 284, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kogi|Yagba West': { lgas: ['Yagba West'], centroid: { lat: 8.22664, lng: 5.51327 }, unitsBacking: 96, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Kogi (K.K)': { lgas: ['Kogi . K. K.'], centroid: { lat: 8.13231, lng: 6.83458 }, unitsBacking: 90, coordTier: 'approx', provenance: 'researched' },
  'Kogi|Omala': { lgas: ['Omala'], centroid: { lat: 7.78584, lng: 7.51219 }, unitsBacking: 148, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Ijumu': { lgas: ['Ijumu'], centroid: { lat: 7.84381, lng: 5.9615 }, unitsBacking: 118, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Lokoja I': { lgas: ['Lokoja'], centroid: { lat: 7.817, lng: 6.73474 }, unitsBacking: 273, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kogi|Okura': { lgas: ['Dekina'], centroid: { lat: 7.53727, lng: 7.15686 }, unitsBacking: 352, coordTier: 'approx', provenance: 'researched' },
  'Kogi|Yagba East': { lgas: ['Yagba East'], centroid: { lat: 8.06222, lng: 5.78477 }, unitsBacking: 65, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Mopamuro': { lgas: ['Mopa Moro'], centroid: { lat: 8.14526, lng: 5.89934 }, unitsBacking: 53, coordTier: 'approx', provenance: 'researched' },
  'Kogi|Lokoja II': { lgas: ['Lokoja'], centroid: { lat: 7.817, lng: 6.73474 }, unitsBacking: 273, coordTier: 'crowd', provenance: 'auto-matched' },
  'Kogi|Olamaboro I': { lgas: ['Olamaboro'], centroid: { lat: 7.1984, lng: 7.57048 }, unitsBacking: 136, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Dekina/Biraidu': { lgas: ['Dekina'], centroid: { lat: 7.53727, lng: 7.15686 }, unitsBacking: 352, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Ajaokuta': { lgas: ['Ajaokuta'], centroid: { lat: 7.50167, lng: 6.47133 }, unitsBacking: 146, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Okene Town': { lgas: ['Okene'], centroid: { lat: 7.5464, lng: 6.23376 }, unitsBacking: 284, coordTier: 'crowd', provenance: 'researched' },
  'Kogi|Ankpa I': { lgas: ['Ankpa'], centroid: { lat: 7.42788, lng: 7.58595 }, unitsBacking: 292, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Okehi': { lgas: ['Okehi'], centroid: { lat: 7.59103, lng: 6.17228 }, unitsBacking: 188, coordTier: 'approx', provenance: 'auto-matched' },
  'Kogi|Ogori/Magongo': { lgas: ['Ogori Mangogo'], centroid: { lat: 7.47198, lng: 6.16691 }, unitsBacking: 67, coordTier: 'approx', provenance: 'researched' },
  // Kwara ---------------------------------------------------
  'Kwara|Oke-Ogun/Oyun II': { lgas: ['Oyun'], centroid: { lat: 8.11525, lng: 4.68314 }, unitsBacking: 108, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Balogun/Ojumu/Offa I': { lgas: ['Offa'], centroid: { lat: 8.14723, lng: 4.71876 }, unitsBacking: 173, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Isin': { lgas: ['Isin'], centroid: { lat: 8.25396, lng: 5.02057 }, unitsBacking: 80, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Share/Oke-Ode Ifelodun II': { lgas: ['Ifelodun'], centroid: { lat: 8.46432, lng: 4.94496 }, unitsBacking: 236, coordTier: 'approx', provenance: 'researched' },
  'Kwara|Irepodun': { lgas: ['Irepodun'], centroid: { lat: 8.15651, lng: 4.944 }, unitsBacking: 158, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Ekiti': { lgas: ['Ekiti'], centroid: { lat: 8.074, lng: 5.263 }, unitsBacking: 76, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Shawo/Essa/Offa II': { lgas: ['Offa'], centroid: { lat: 8.14723, lng: 4.71876 }, unitsBacking: 173, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Oke-Ero': { lgas: ['Okeero'], centroid: { lat: 8.084, lng: 5.1405 }, unitsBacking: 76, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Odo-Ogun/Oyun I': { lgas: ['Oyun'], centroid: { lat: 8.11525, lng: 4.68314 }, unitsBacking: 108, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Omupo/Igbaja Ifelodun I': { lgas: ['Ifelodun'], centroid: { lat: 8.46432, lng: 4.94496 }, unitsBacking: 236, coordTier: 'approx', provenance: 'researched' },
  'Kwara|Patigi': { lgas: ['Patigi'], centroid: { lat: 8.62438, lng: 5.76079 }, unitsBacking: 105, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Okuta/Ayashkira Barutin II': { lgas: ['Baruten'], centroid: { lat: 9.05662, lng: 3.25845 }, unitsBacking: 196, coordTier: 'approx', provenance: 'researched' },
  'Kwara|Oloru/Malete/Ipaiye/Moro II': { lgas: ['Moro'], centroid: { lat: 8.78538, lng: 4.61721 }, unitsBacking: 142, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Lanwa/Ejidongari/Moro I': { lgas: ['Moro'], centroid: { lat: 8.78538, lng: 4.61721 }, unitsBacking: 142, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Lafiagi/Edu': { lgas: ['Edu'], centroid: { lat: 8.92309, lng: 5.1251 }, unitsBacking: 175, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Kaiama/Wajibe/Kemanji/Kaiama II': { lgas: ['Kaiama'], centroid: { lat: 9.4992, lng: 3.97401 }, unitsBacking: 124, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Ilorin South': { lgas: ['Ilorin-South'], centroid: { lat: 8.49101, lng: 4.55836 }, unitsBacking: 275, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Ilorin East': { lgas: ['Ilorin East'], centroid: { lat: 8.50194, lng: 4.55173 }, unitsBacking: 320, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Ilorin West/Ilorin West II': { lgas: ['Ilorin-West'], centroid: { lat: 8.49459, lng: 4.53136 }, unitsBacking: 464, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Ilorin Central/Ilorin West I': { lgas: ['Ilorin-West'], centroid: { lat: 8.49459, lng: 4.53136 }, unitsBacking: 464, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Gwanabe/Adena/Banni/Kaiama I': { lgas: ['Kaiama'], centroid: { lat: 9.4992, lng: 3.97401 }, unitsBacking: 124, coordTier: 'approx', provenance: 'auto-matched' },
  'Kwara|Onire/Owode': { lgas: ['Asa'], centroid: { lat: 8.37133, lng: 4.41885 }, unitsBacking: 145, coordTier: 'approx', provenance: 'researched' },
  'Kwara|Afon': { lgas: ['Asa'], centroid: { lat: 8.37133, lng: 4.41885 }, unitsBacking: 145, coordTier: 'approx', provenance: 'researched' },
  'Kwara|Ilesha/Gwanara Barutin I': { lgas: ['Baruten'], centroid: { lat: 9.05662, lng: 3.25845 }, unitsBacking: 196, coordTier: 'approx', provenance: 'researched' },
  // Lagos ---------------------------------------------------
  'Lagos|Shomolu II': { lgas: ['Somolu'], centroid: { lat: 6.53495, lng: 3.38526 }, unitsBacking: 616, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Agege I': { lgas: ['Agege'], centroid: { lat: 6.6237, lng: 3.31608 }, unitsBacking: 609, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Agege II': { lgas: ['Agege'], centroid: { lat: 6.6237, lng: 3.31608 }, unitsBacking: 609, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ojo II': { lgas: ['Ojo'], centroid: { lat: 6.46872, lng: 3.17408 }, unitsBacking: 578, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Amuwo Odofin I': { lgas: ['Amuwo-Odofin'], centroid: { lat: 6.443, lng: 3.27903 }, unitsBacking: 216, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Lagos Island II': { lgas: ['Lagos Island'], centroid: { lat: 6.45645, lng: 3.39008 }, unitsBacking: 284, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ifako/Ijaiye I': { lgas: ['Ifako-Ijaye'], centroid: { lat: 6.65965, lng: 3.32003 }, unitsBacking: 732, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ajeromi/Ifelodun II': { lgas: ['Ajeromi/Ifelodun'], centroid: { lat: 6.45397, lng: 3.3406 }, unitsBacking: 454, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Badagry II': { lgas: ['Badagry'], centroid: { lat: 6.43609, lng: 2.935 }, unitsBacking: 373, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Lagos Mainland II': { lgas: ['Lagos Mainland'], centroid: { lat: 6.49787, lng: 3.38782 }, unitsBacking: 384, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ikorodu I': { lgas: ['Ikorodu'], centroid: { lat: 6.61582, lng: 3.51001 }, unitsBacking: 549, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Oshodi/Isolo I': { lgas: ['Oshodi/Isolo'], centroid: { lat: 6.52032, lng: 3.324 }, unitsBacking: 572, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Lagos Mainland I': { lgas: ['Lagos Mainland'], centroid: { lat: 6.49787, lng: 3.38782 }, unitsBacking: 384, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ifako/Ijaiye II': { lgas: ['Ifako-Ijaye'], centroid: { lat: 6.65965, lng: 3.32003 }, unitsBacking: 732, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ojo I': { lgas: ['Ojo'], centroid: { lat: 6.46872, lng: 3.17408 }, unitsBacking: 578, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Oshodi/Isolo II': { lgas: ['Oshodi/Isolo'], centroid: { lat: 6.52032, lng: 3.324 }, unitsBacking: 572, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Apapa II': { lgas: ['Apapa'], centroid: { lat: 6.44916, lng: 3.36153 }, unitsBacking: 191, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Eti-Osa II': { lgas: ['Eti-Osa'], centroid: { lat: 6.44598, lng: 3.42355 }, unitsBacking: 659, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ikeja II': { lgas: ['Ikeja'], centroid: { lat: 6.61287, lng: 3.354 }, unitsBacking: 620, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Alimosho II': { lgas: ['Alimosho'], centroid: { lat: 6.595, lng: 3.27039 }, unitsBacking: 1545, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Mushin II': { lgas: ['Mushin'], centroid: { lat: 6.52742, lng: 3.35628 }, unitsBacking: 774, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Badagry I': { lgas: ['Badagry'], centroid: { lat: 6.43609, lng: 2.935 }, unitsBacking: 373, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ikeja I': { lgas: ['Ikeja'], centroid: { lat: 6.61287, lng: 3.354 }, unitsBacking: 620, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Alimosho I': { lgas: ['Alimosho'], centroid: { lat: 6.595, lng: 3.27039 }, unitsBacking: 1545, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Surulere II': { lgas: ['Surulere'], centroid: { lat: 6.49447, lng: 3.35474 }, unitsBacking: 396, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Mushin I': { lgas: ['Mushin'], centroid: { lat: 6.52742, lng: 3.35628 }, unitsBacking: 774, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Eti-Osa I': { lgas: ['Eti-Osa'], centroid: { lat: 6.44598, lng: 3.42355 }, unitsBacking: 659, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Epe II': { lgas: ['Epe'], centroid: { lat: 6.59107, lng: 3.98125 }, unitsBacking: 322, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ikorodu II': { lgas: ['Ikorodu'], centroid: { lat: 6.61582, lng: 3.51001 }, unitsBacking: 549, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ajeromi/Ifelodun I': { lgas: ['Ajeromi/Ifelodun'], centroid: { lat: 6.45397, lng: 3.3406 }, unitsBacking: 454, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Amuwo Odofin II': { lgas: ['Amuwo-Odofin'], centroid: { lat: 6.443, lng: 3.27903 }, unitsBacking: 216, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Epe I': { lgas: ['Epe'], centroid: { lat: 6.59107, lng: 3.98125 }, unitsBacking: 322, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Kosofe I': { lgas: ['Kosofe'], centroid: { lat: 6.6021, lng: 3.38824 }, unitsBacking: 899, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Apapa I': { lgas: ['Apapa'], centroid: { lat: 6.44916, lng: 3.36153 }, unitsBacking: 191, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Kosofe II': { lgas: ['Kosofe'], centroid: { lat: 6.6021, lng: 3.38824 }, unitsBacking: 899, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Shomolu I': { lgas: ['Somolu'], centroid: { lat: 6.53495, lng: 3.38526 }, unitsBacking: 616, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ibeju-Lekki I': { lgas: ['Ibeju/Lekki'], centroid: { lat: 6.46985, lng: 3.81115 }, unitsBacking: 96, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Lagos Island I': { lgas: ['Lagos Island'], centroid: { lat: 6.45645, lng: 3.39008 }, unitsBacking: 284, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Surulere I': { lgas: ['Surulere'], centroid: { lat: 6.49447, lng: 3.35474 }, unitsBacking: 396, coordTier: 'approx', provenance: 'auto-matched' },
  'Lagos|Ibeju-Lekki II': { lgas: ['Ibeju/Lekki'], centroid: { lat: 6.46985, lng: 3.81115 }, unitsBacking: 96, coordTier: 'approx', provenance: 'auto-matched' },
  // Nasarawa ------------------------------------------------
  'Nasarawa|Karshi/Uke': { lgas: ['Karu'], centroid: { lat: 8.986, lng: 7.63714 }, unitsBacking: 516, coordTier: 'approx', provenance: 'researched' },
  'Nasarawa|Akwanga South': { lgas: ['Akwanga'], centroid: { lat: 8.93336, lng: 8.39456 }, unitsBacking: 191, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Nasarawa-Eggon West': { lgas: ['Nasarawa Eggon'], centroid: { lat: 8.75516, lng: 8.41056 }, unitsBacking: 255, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Keffi West': { lgas: ['Keffi'], centroid: { lat: 8.85023, lng: 7.88008 }, unitsBacking: 215, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Keffi East': { lgas: ['Keffi'], centroid: { lat: 8.85023, lng: 7.88008 }, unitsBacking: 215, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Wamba': { lgas: ['Wamba'], centroid: { lat: 8.95343, lng: 8.6195 }, unitsBacking: 122, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Nasarawa-Eggon East': { lgas: ['Nasarawa Eggon'], centroid: { lat: 8.75516, lng: 8.41056 }, unitsBacking: 255, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Karu/Gitata': { lgas: ['Karu'], centroid: { lat: 8.986, lng: 7.63714 }, unitsBacking: 516, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Lafia North': { lgas: ['Lafia'], centroid: { lat: 8.51264, lng: 8.53927 }, unitsBacking: 497, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Lafia Central': { lgas: ['Lafia'], centroid: { lat: 8.51264, lng: 8.53927 }, unitsBacking: 497, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Akwanga North': { lgas: ['Akwanga'], centroid: { lat: 8.93336, lng: 8.39456 }, unitsBacking: 191, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Keana': { lgas: ['Keana'], centroid: { lat: 8.19177, lng: 8.73738 }, unitsBacking: 114, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Kokona East': { lgas: ['Kokona'], centroid: { lat: 8.78218, lng: 8.0775 }, unitsBacking: 194, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Doma South': { lgas: ['Doma'], centroid: { lat: 8.27847, lng: 8.33358 }, unitsBacking: 214, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Kokona West': { lgas: ['Kokona'], centroid: { lat: 8.78218, lng: 8.0775 }, unitsBacking: 194, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Obi I': { lgas: ['Obi'], centroid: { lat: 8.38094, lng: 8.70438 }, unitsBacking: 251, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Awe North': { lgas: ['Awe'], centroid: { lat: 8.24343, lng: 9.217 }, unitsBacking: 165, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Awe South': { lgas: ['Awe'], centroid: { lat: 8.24343, lng: 9.217 }, unitsBacking: 165, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Nasarawa West (Loki/udege)': { lgas: ['Nasarawa'], centroid: { lat: 8.44851, lng: 7.737 }, unitsBacking: 303, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Gadabuke/Toto (Toto I)': { lgas: ['Toto'], centroid: { lat: 8.32322, lng: 7.17767 }, unitsBacking: 204, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Nasarawa Central': { lgas: ['Nasarawa'], centroid: { lat: 8.44851, lng: 7.737 }, unitsBacking: 303, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Doma North': { lgas: ['Doma'], centroid: { lat: 8.27847, lng: 8.33358 }, unitsBacking: 214, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Obi II': { lgas: ['Obi'], centroid: { lat: 8.38094, lng: 8.70438 }, unitsBacking: 251, coordTier: 'approx', provenance: 'auto-matched' },
  'Nasarawa|Umaisha/Dausu (Toto II)': { lgas: ['Toto'], centroid: { lat: 8.32322, lng: 7.17767 }, unitsBacking: 204, coordTier: 'approx', provenance: 'auto-matched' },
  // Niger ---------------------------------------------------
  'Niger|Bosso': { lgas: ['Bosso'], centroid: { lat: 9.63653, lng: 6.56247 }, unitsBacking: 249, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Gbako': { lgas: ['Gbako'], centroid: { lat: 9.23075, lng: 6.0045 }, unitsBacking: 156, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Chanchanga': { lgas: ['Chanchaga'], centroid: { lat: 9.617, lng: 6.54915 }, unitsBacking: 379, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Bida I (North)': { lgas: ['Bida'], centroid: { lat: 9.08345, lng: 6.00582 }, unitsBacking: 270, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Kontagora I': { lgas: ['Kontagora'], centroid: { lat: 10.39077, lng: 5.46761 }, unitsBacking: 248, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Mashegu': { lgas: ['Mashegu'], centroid: { lat: 9.93721, lng: 5.28758 }, unitsBacking: 205, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Mariga': { lgas: ['Mariga'], centroid: { lat: 10.6905, lng: 5.84145 }, unitsBacking: 214, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Magama': { lgas: ['Magama'], centroid: { lat: 10.33355, lng: 5.00023 }, unitsBacking: 189, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Lavun': { lgas: ['Lavun'], centroid: { lat: 9.0796, lng: 5.88 }, unitsBacking: 223, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Kotangora II': { lgas: ['Kontagora'], centroid: { lat: 10.39077, lng: 5.46761 }, unitsBacking: 248, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Bida II (South)': { lgas: ['Bida'], centroid: { lat: 9.08345, lng: 6.00582 }, unitsBacking: 270, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Lapai': { lgas: ['Lapai'], centroid: { lat: 8.663, lng: 6.611 }, unitsBacking: 188, coordTier: 'crowd', provenance: 'auto-matched' },
  'Niger|Borgu': { lgas: ['Borgu'], centroid: { lat: 10.195, lng: 4.34313 }, unitsBacking: 155, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Suleja': { lgas: ['Suleja'], centroid: { lat: 9.1906, lng: 7.18025 }, unitsBacking: 232, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Gurara': { lgas: ['Gurara'], centroid: { lat: 9.28324, lng: 7.001 }, unitsBacking: 150, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Katcha': { lgas: ['Katcha'], centroid: { lat: 8.99917, lng: 6.235 }, unitsBacking: 149, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Edatti': { lgas: ['Edatti'], centroid: { lat: 9.07664, lng: 5.63149 }, unitsBacking: 119, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Agaie': { lgas: ['Agaie'], centroid: { lat: 9.00241, lng: 6.3467 }, unitsBacking: 153, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Wushishi': { lgas: ['Wushishi'], centroid: { lat: 9.68462, lng: 6.07021 }, unitsBacking: 124, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Paikoro': { lgas: ['Paikoro'], centroid: { lat: 9.441, lng: 6.726 }, unitsBacking: 223, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Shiroro': { lgas: ['Shiroro'], centroid: { lat: 9.88163, lng: 6.72112 }, unitsBacking: 257, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Mokwa': { lgas: ['Mokwa'], centroid: { lat: 9.269, lng: 5.22516 }, unitsBacking: 187, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Rijau': { lgas: ['Rijau'], centroid: { lat: 11.12521, lng: 5.27368 }, unitsBacking: 161, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Agwara': { lgas: ['Agwara'], centroid: { lat: 10.70452, lng: 4.5205 }, unitsBacking: 70, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Rafi': { lgas: ['Rafi'], centroid: { lat: 10.22225, lng: 6.316 }, unitsBacking: 195, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Munya': { lgas: ['Munya'], centroid: { lat: 9.83244, lng: 6.99887 }, unitsBacking: 119, coordTier: 'approx', provenance: 'auto-matched' },
  'Niger|Tafa': { lgas: ['Tafa'], centroid: { lat: 9.26108, lng: 7.24539 }, unitsBacking: 171, coordTier: 'approx', provenance: 'auto-matched' },
  // Ogun ----------------------------------------------------
  'Ogun|Sagamu II Makun': { lgas: ['Sagamu'], centroid: { lat: 6.83989, lng: 3.61622 }, unitsBacking: 289, coordTier: 'approx', provenance: 'researched' },
  'Ogun|Abeokuta North': { lgas: ['Abeokuta North'], centroid: { lat: 7.17, lng: 3.32349 }, unitsBacking: 213, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ogun Waterside': { lgas: ['Ogun Water Side'], centroid: { lat: 6.51982, lng: 4.405 }, unitsBacking: 116, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ikenne': { lgas: ['Ikenne'], centroid: { lat: 6.89852, lng: 3.6996 }, unitsBacking: 126, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ado/Odo/Ota I': { lgas: ['Ado Odo-Ota'], centroid: { lat: 6.66341, lng: 3.1696 }, unitsBacking: 655, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ifo II': { lgas: ['Ifo'], centroid: { lat: 6.72724, lng: 3.29758 }, unitsBacking: 448, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ijebu North I': { lgas: ['Ijebu North'], centroid: { lat: 6.977, lng: 3.992 }, unitsBacking: 268, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ijebu North II': { lgas: ['Ijebu North'], centroid: { lat: 6.977, lng: 3.992 }, unitsBacking: 268, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Obafemi/Owode': { lgas: ['Obafemi/Owode'], centroid: { lat: 6.91213, lng: 3.42167 }, unitsBacking: 329, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Egbado South': { lgas: ['Egbado South'], centroid: { lat: 6.7976, lng: 2.9614 }, unitsBacking: 0, coordTier: 'operator', provenance: 'researched', note: 'Coordinate supplied by the operator, not derived from the register: all 257 units in this LGA lack a coordinate in every tier, so this is the one centroid with no polling unit behind it (hence unitsBacking 0).' },
  'Ogun|Odeda Area': { lgas: ['Odeda'], centroid: { lat: 7.2285, lng: 3.484 }, unitsBacking: 182, coordTier: 'approx', provenance: 'researched' },
  'Ogun|Ijebu-Ode': { lgas: ['Ijebu Ode'], centroid: { lat: 6.81718, lng: 3.91463 }, unitsBacking: 161, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Remo North': { lgas: ['Remo North'], centroid: { lat: 6.97006, lng: 3.7055 }, unitsBacking: 94, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Abeokuta South II': { lgas: ['Abeokuta South'], centroid: { lat: 7.15262, lng: 3.35487 }, unitsBacking: 445, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ijebu East Area': { lgas: ['Ijebu East'], centroid: { lat: 6.79549, lng: 4.127 }, unitsBacking: 154, coordTier: 'approx', provenance: 'researched' },
  'Ogun|Ifo I': { lgas: ['Ifo'], centroid: { lat: 6.72724, lng: 3.29758 }, unitsBacking: 448, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Sagamu I Offin': { lgas: ['Sagamu'], centroid: { lat: 6.83989, lng: 3.61622 }, unitsBacking: 289, coordTier: 'approx', provenance: 'researched' },
  'Ogun|Abeokuta South I': { lgas: ['Abeokuta South'], centroid: { lat: 7.15262, lng: 3.35487 }, unitsBacking: 445, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Idiroko Ipokia': { lgas: ['Ipokia'], centroid: { lat: 6.59579, lng: 2.7815 }, unitsBacking: 262, coordTier: 'approx', provenance: 'researched' },
  'Ogun|Egbado North I': { lgas: ['Egbado North'], centroid: { lat: 6.97721, lng: 3.68 }, unitsBacking: 48, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ado-Odo/Ota II': { lgas: ['Ado Odo-Ota'], centroid: { lat: 6.66341, lng: 3.1696 }, unitsBacking: 655, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ijebu North East': { lgas: ['Ijebu North East'], centroid: { lat: 6.88351, lng: 4.0 }, unitsBacking: 111, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Imeko-Afon': { lgas: ['Imeko/Afon'], centroid: { lat: 7.46676, lng: 2.85555 }, unitsBacking: 126, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Ewekoro': { lgas: ['Ewekoro'], centroid: { lat: 6.92861, lng: 3.21056 }, unitsBacking: 188, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Odogbolu': { lgas: ['Odogbolu'], centroid: { lat: 6.78335, lng: 3.86018 }, unitsBacking: 178, coordTier: 'approx', provenance: 'auto-matched' },
  'Ogun|Egbado North II': { lgas: ['Egbado North'], centroid: { lat: 6.97721, lng: 3.68 }, unitsBacking: 48, coordTier: 'approx', provenance: 'auto-matched' },
  // Ondo ----------------------------------------------------
  'Ondo|Ilaje I': { lgas: ['Ilaje'], centroid: { lat: 6.20939, lng: 4.79353 }, unitsBacking: 292, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akoko North West II': { lgas: ['Akoko North West'], centroid: { lat: 7.57601, lng: 5.758 }, unitsBacking: 170, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akoko South East': { lgas: ['Akoko South East'], centroid: { lat: 7.46164, lng: 5.91232 }, unitsBacking: 80, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akoko South West I': { lgas: ['Akoko South West'], centroid: { lat: 7.45312, lng: 5.75188 }, unitsBacking: 199, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akoko South West II': { lgas: ['Akoko South West'], centroid: { lat: 7.45312, lng: 5.75188 }, unitsBacking: 199, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akure North': { lgas: ['Akure North'], centroid: { lat: 7.30606, lng: 5.2649 }, unitsBacking: 157, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akure South I': { lgas: ['Akure South'], centroid: { lat: 7.24872, lng: 5.18124 }, unitsBacking: 596, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akure South II': { lgas: ['Akure South'], centroid: { lat: 7.24872, lng: 5.18124 }, unitsBacking: 596, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Ese Odo': { lgas: ['Ese-Odo'], centroid: { lat: 6.19641, lng: 4.92848 }, unitsBacking: 143, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Ifedore': { lgas: ['Ifedore'], centroid: { lat: 7.40445, lng: 5.08619 }, unitsBacking: 169, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Okitipupa II': { lgas: ['Okitipupa'], centroid: { lat: 6.52882, lng: 4.669 }, unitsBacking: 269, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Owo I': { lgas: ['Owo'], centroid: { lat: 7.20159, lng: 5.59 }, unitsBacking: 275, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Ilaje II': { lgas: ['Ilaje'], centroid: { lat: 6.20939, lng: 4.79353 }, unitsBacking: 292, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Odigbo II': { lgas: ['Odigbo'], centroid: { lat: 6.74608, lng: 4.85262 }, unitsBacking: 304, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Okitipupa I': { lgas: ['Okitipupa'], centroid: { lat: 6.52882, lng: 4.669 }, unitsBacking: 269, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Owo II': { lgas: ['Owo'], centroid: { lat: 7.20159, lng: 5.59 }, unitsBacking: 275, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Idanre': { lgas: ['Idanre'], centroid: { lat: 7.01211, lng: 5.11536 }, unitsBacking: 166, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akoko North West I': { lgas: ['Akoko North West'], centroid: { lat: 7.57601, lng: 5.758 }, unitsBacking: 170, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Akoko North East': { lgas: ['Akoko North East'], centroid: { lat: 7.53747, lng: 5.76044 }, unitsBacking: 159, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Ile Oluji/Oke Igbo': { lgas: ['Ileoluji/Okeigbo'], centroid: { lat: 7.18059, lng: 4.82775 }, unitsBacking: 191, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Ondo West I': { lgas: ['Ondo West'], centroid: { lat: 7.06757, lng: 4.85142 }, unitsBacking: 270, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Irele': { lgas: ['Irele'], centroid: { lat: 6.56319, lng: 4.96617 }, unitsBacking: 155, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Ose': { lgas: ['Ose'], centroid: { lat: 6.939, lng: 5.76835 }, unitsBacking: 141, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Odigbo I': { lgas: ['Odigbo'], centroid: { lat: 6.74608, lng: 4.85262 }, unitsBacking: 304, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Ondo West II': { lgas: ['Ondo West'], centroid: { lat: 7.06757, lng: 4.85142 }, unitsBacking: 270, coordTier: 'approx', provenance: 'auto-matched' },
  'Ondo|Ondo East': { lgas: ['Ondo East'], centroid: { lat: 7.12608, lng: 4.95448 }, unitsBacking: 99, coordTier: 'approx', provenance: 'auto-matched' },
  // Osun ----------------------------------------------------
  'Osun|Ayedire': { lgas: ['Ayedire'], centroid: { lat: 7.59845, lng: 4.26068 }, unitsBacking: 49, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ifelodun': { lgas: ['Ifelodun'], centroid: { lat: 7.93647, lng: 4.65437 }, unitsBacking: 145, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Iwo': { lgas: ['Iwo'], centroid: { lat: 7.63451, lng: 4.18 }, unitsBacking: 170, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Odo-Otin': { lgas: ['Odo-Otin'], centroid: { lat: 8.018, lng: 4.65469 }, unitsBacking: 121, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ayedade': { lgas: ['Ayedaade'], centroid: { lat: 7.471, lng: 4.34325 }, unitsBacking: 150, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ifedayo': { lgas: ['Ifedayo'], centroid: { lat: 8.01877, lng: 5.002 }, unitsBacking: 59, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Irepodun/Orulu': { lgas: ['Irepodun', 'Orolu'], centroid: { lat: 7.87144, lng: 4.48369 }, unitsBacking: 218, coordTier: 'approx', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher\'s compound split dropped \'Orolu\', which INEC spells \'Orulu\' — leaving that LGA with no constituency at all. One of Osun\'s four required two-LGA seats (30 LGAs / 26 constituencies).' },
  'Osun|Boripe/Boluwa-Duro': { lgas: ['Boluwaduro', 'Boripe'], centroid: { lat: 7.91673, lng: 4.726 }, unitsBacking: 179, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ife East': { lgas: ['Ife East'], centroid: { lat: 7.469, lng: 4.55983 }, unitsBacking: 200, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Egbedore': { lgas: ['Egbedore'], centroid: { lat: 7.81769, lng: 4.48095 }, unitsBacking: 90, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ede South': { lgas: ['Ede South'], centroid: { lat: 7.70164, lng: 4.44132 }, unitsBacking: 101, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ejigbo': { lgas: ['Ejigbo'], centroid: { lat: 7.89937, lng: 4.29044 }, unitsBacking: 133, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ife North': { lgas: ['Ife North'], centroid: { lat: 7.51046, lng: 4.44897 }, unitsBacking: 111, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Oriade': { lgas: ['Oriade'], centroid: { lat: 7.56, lng: 4.87391 }, unitsBacking: 123, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ife Central': { lgas: ['Ife Central'], centroid: { lat: 7.49722, lng: 4.55273 }, unitsBacking: 215, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Osogbo': { lgas: ['Osogbo'], centroid: { lat: 7.74904, lng: 4.55353 }, unitsBacking: 236, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ilesa West': { lgas: ['Ilesa West'], centroid: { lat: 7.635, lng: 4.74 }, unitsBacking: 103, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ede North': { lgas: ['Ede North'], centroid: { lat: 7.73779, lng: 4.43543 }, unitsBacking: 139, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Olorunda': { lgas: ['Olorunda'], centroid: { lat: 7.85425, lng: 4.56007 }, unitsBacking: 160, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ila': { lgas: ['Ila'], centroid: { lat: 8.01711, lng: 4.90356 }, unitsBacking: 124, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ola-Oluwa': { lgas: ['Ola-Oluwa'], centroid: { lat: 7.746, lng: 4.23084 }, unitsBacking: 62, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Irewole/Isokan': { lgas: ['Irewole', 'Isokan'], centroid: { lat: 7.3358, lng: 4.26685 }, unitsBacking: 210, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Obokun': { lgas: ['Obokun'], centroid: { lat: 7.77964, lng: 4.7745 }, unitsBacking: 100, coordTier: 'crowd', provenance: 'auto-matched' },
  'Osun|Atakunmosa East and West': { lgas: ['Atakumosa East', 'Atakumosa West'], centroid: { lat: 7.52134, lng: 4.69229 }, unitsBacking: 153, coordTier: 'approx', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher split this on \' and \' into [\'Atakunmosa East\', \'West\'] and the bare fragment \'West\' matched nothing, so \'Atakumosa West\' was dropped. The seat covers both Atakumosa East and Atakumosa West LGAs — the fourth of Osun\'s four two-LGA seats.' },
  'Osun|Ilesa East': { lgas: ['Ilesa East'], centroid: { lat: 7.6, lng: 4.745 }, unitsBacking: 119, coordTier: 'approx', provenance: 'auto-matched' },
  'Osun|Ife South': { lgas: ['Ife South'], centroid: { lat: 7.2205, lng: 4.63539 }, unitsBacking: 131, coordTier: 'approx', provenance: 'auto-matched' },
  // Oyo -----------------------------------------------------
  'Oyo|Ibadan South West II': { lgas: ['Ibadan South West'], centroid: { lat: 7.36851, lng: 3.853 }, unitsBacking: 239, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Iwajowa': { lgas: ['Iwajowa'], centroid: { lat: 7.97432, lng: 3.097 }, unitsBacking: 100, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Oorelope': { lgas: ['Oorelope'], centroid: { lat: 8.85019, lng: 3.76937 }, unitsBacking: 79, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Saki West': { lgas: ['Saki West'], centroid: { lat: 8.663, lng: 3.38779 }, unitsBacking: 211, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ibarapa North & Ibarapa Central': { lgas: ['Ibarapa Central', 'Ibarapa North'], centroid: { lat: 7.53559, lng: 3.22982 }, unitsBacking: 278, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ibadan North-East II': { lgas: ['Ibadan North East'], centroid: { lat: 7.385, lng: 3.925 }, unitsBacking: 76, coordTier: 'crowd', provenance: 'auto-matched' },
  'Oyo|Oluyole': { lgas: ['Oluyole'], centroid: { lat: 7.30489, lng: 3.91544 }, unitsBacking: 204, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Kajola': { lgas: ['Kajola'], centroid: { lat: 8.04827, lng: 3.35522 }, unitsBacking: 132, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Akinyele II': { lgas: ['Akinyele'], centroid: { lat: 7.52186, lng: 3.91143 }, unitsBacking: 278, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Oyo West/Oyo East': { lgas: ['Oyo East', 'Oyo West'], centroid: { lat: 7.84215, lng: 3.92952 }, unitsBacking: 288, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ibadan North I': { lgas: ['Ibadan North'], centroid: { lat: 7.411, lng: 3.9075 }, unitsBacking: 106, coordTier: 'crowd', provenance: 'auto-matched' },
  'Oyo|Egbeda': { lgas: ['Egbeda'], centroid: { lat: 7.422, lng: 4.01529 }, unitsBacking: 294, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Lagelu': { lgas: ['Lagelu'], centroid: { lat: 7.47577, lng: 4.07594 }, unitsBacking: 141, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Saki East and Atisbo': { lgas: ['Atisbo', 'Saki East'], centroid: { lat: 8.45962, lng: 3.42813 }, unitsBacking: 174, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ogbomoso South': { lgas: ['Ogbomoso South'], centroid: { lat: 8.12, lng: 4.23706 }, unitsBacking: 183, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Atiba': { lgas: ['Atiba'], centroid: { lat: 7.91385, lng: 3.93596 }, unitsBacking: 168, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ibadan South-West I': { lgas: ['Ibadan South West'], centroid: { lat: 7.36851, lng: 3.853 }, unitsBacking: 239, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ogbomoso North': { lgas: ['Ogbomoso North'], centroid: { lat: 8.13404, lng: 4.247 }, unitsBacking: 188, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ibarapa East': { lgas: ['Ibarapa East'], centroid: { lat: 7.58357, lng: 3.44519 }, unitsBacking: 148, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Oriire': { lgas: ['Ori Ire'], centroid: { lat: 8.46412, lng: 4.09274 }, unitsBacking: 168, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ibadan North West': { lgas: ['Ibadan North West'], centroid: { lat: 7.403, lng: 3.878 }, unitsBacking: 49, coordTier: 'crowd', provenance: 'auto-matched' },
  'Oyo|Ido': { lgas: ['Ido'], centroid: { lat: 7.45796, lng: 3.79379 }, unitsBacking: 178, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Irepo & Olorunsogo': { lgas: ['Irepo', 'Olorunsogo'], centroid: { lat: 9.00314, lng: 3.92757 }, unitsBacking: 169, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Akinyele I': { lgas: ['Akinyele'], centroid: { lat: 7.52186, lng: 3.91143 }, unitsBacking: 278, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Afijio': { lgas: ['Afijio'], centroid: { lat: 7.78814, lng: 3.90206 }, unitsBacking: 95, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ibadan North II': { lgas: ['Ibadan North'], centroid: { lat: 7.411, lng: 3.9075 }, unitsBacking: 106, coordTier: 'crowd', provenance: 'auto-matched' },
  'Oyo|Ibadan South-East II': { lgas: ['Ibadan South-East'], centroid: { lat: 7.357, lng: 3.913 }, unitsBacking: 83, coordTier: 'crowd', provenance: 'auto-matched' },
  'Oyo|Iseyin and Itesiwaju': { lgas: ['Iseyin', 'Itesiwaju'], centroid: { lat: 8.00783, lng: 3.53199 }, unitsBacking: 326, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ona-Ara': { lgas: ['Ona-Ara'], centroid: { lat: 7.334, lng: 3.98254 }, unitsBacking: 118, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ogo-Oluwa/Surulere': { lgas: ['Ogo-Oluwa', 'Surulere'], centroid: { lat: 8.01692, lng: 4.31072 }, unitsBacking: 254, coordTier: 'approx', provenance: 'auto-matched' },
  'Oyo|Ibadan North East I': { lgas: ['Ibadan North East'], centroid: { lat: 7.385, lng: 3.925 }, unitsBacking: 76, coordTier: 'crowd', provenance: 'auto-matched' },
  'Oyo|Ibadan South-East I': { lgas: ['Ibadan South-East'], centroid: { lat: 7.357, lng: 3.913 }, unitsBacking: 83, coordTier: 'crowd', provenance: 'auto-matched' },
  // Plateau -------------------------------------------------
  'Plateau|Jos South': { lgas: ['Jos South'], centroid: { lat: 9.80731, lng: 8.86401 }, unitsBacking: 542, coordTier: 'crowd', provenance: 'auto-matched' },
  'Plateau|Riyom': { lgas: ['Riyom'], centroid: { lat: 9.60775, lng: 8.71062 }, unitsBacking: 146, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Jos North': { lgas: ['Jos North'], centroid: { lat: 9.92915, lng: 8.88853 }, unitsBacking: 913, coordTier: 'crowd', provenance: 'auto-matched' },
  'Plateau|Mangu South': { lgas: ['Mangu'], centroid: { lat: 9.459, lng: 9.175 }, unitsBacking: 409, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Langtang Central': { lgas: ['Langtang North'], centroid: { lat: 9.15673, lng: 9.81 }, unitsBacking: 225, coordTier: 'approx', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher indexed LGA names with their compass word stripped, so \'Langtang North\' and \'Langtang South\' collapsed to one key and this seat was attached to the wrong sibling. Reported in Plateau Assembly coverage as \'Langtang North Central\'; Langtang South already has its own seat, and Plateau\'s arithmetic needs Langtang North to hold two.' },
  'Plateau|Langtang North': { lgas: ['Langtang North'], centroid: { lat: 9.15673, lng: 9.81 }, unitsBacking: 225, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Mikang': { lgas: ['Mikang'], centroid: { lat: 9.0287, lng: 9.59021 }, unitsBacking: 90, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Kantana': { lgas: ['Kanam'], centroid: { lat: 9.42731, lng: 9.96951 }, unitsBacking: 285, coordTier: 'crowd', provenance: 'researched' },
  'Plateau|Qua\'an Pan South': { lgas: ['Qua\'An Pan'], centroid: { lat: 8.78215, lng: 9.249 }, unitsBacking: 279, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Pankshin North': { lgas: ['Pankshin'], centroid: { lat: 9.32038, lng: 9.39553 }, unitsBacking: 260, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Langtang South': { lgas: ['Langtang South'], centroid: { lat: 8.71038, lng: 9.80172 }, unitsBacking: 127, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Shendam': { lgas: ['Shendam'], centroid: { lat: 8.81576, lng: 9.54234 }, unitsBacking: 274, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Kanke': { lgas: ['Kanke'], centroid: { lat: 9.36486, lng: 9.58759 }, unitsBacking: 185, coordTier: 'crowd', provenance: 'auto-matched' },
  'Plateau|Pankshin South': { lgas: ['Pankshin'], centroid: { lat: 9.32038, lng: 9.39553 }, unitsBacking: 260, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Dengi': { lgas: ['Kanam'], centroid: { lat: 9.42731, lng: 9.96951 }, unitsBacking: 285, coordTier: 'crowd', provenance: 'researched' },
  'Plateau|Jos East': { lgas: ['Jos East'], centroid: { lat: 9.88722, lng: 9.08457 }, unitsBacking: 133, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Mangu North': { lgas: ['Mangu'], centroid: { lat: 9.459, lng: 9.175 }, unitsBacking: 409, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Jos North West': { lgas: ['Jos North'], centroid: { lat: 9.92915, lng: 8.88853 }, unitsBacking: 913, coordTier: 'crowd', provenance: 'corrected', note: 'corrected by the match audit: the auto-matcher indexed LGA names with their compass word stripped, so \'Jos East\', \'Jos North\' and \'Jos South\' collapsed to one key and this seat was attached to the wrong sibling. A split of Jos North LGA; as mis-mapped, Jos South carried two seats and Jos North one. Plateau\'s 24 seats reconcile only with Jos North holding two.' },
  'Plateau|Bokkos': { lgas: ['Bokkos'], centroid: { lat: 9.26395, lng: 8.94943 }, unitsBacking: 236, coordTier: 'crowd', provenance: 'auto-matched' },
  'Plateau|Barkin Ladi': { lgas: ['Barikin Ladi'], centroid: { lat: 9.58629, lng: 8.97466 }, unitsBacking: 205, coordTier: 'approx', provenance: 'auto-matched' },
  'Plateau|Wase': { lgas: ['Wase'], centroid: { lat: 9.099, lng: 10.005 }, unitsBacking: 277, coordTier: 'crowd', provenance: 'auto-matched' },
  'Plateau|Pengana': { lgas: ['Bassa'], centroid: { lat: 10.01254, lng: 8.76407 }, unitsBacking: 296, coordTier: 'approx', provenance: 'researched' },
  'Plateau|Rukuba/Irigwe': { lgas: ['Bassa'], centroid: { lat: 10.01254, lng: 8.76407 }, unitsBacking: 296, coordTier: 'approx', provenance: 'researched' },
  'Plateau|Qua\'an Pan North': { lgas: ['Qua\'An Pan'], centroid: { lat: 8.78215, lng: 9.249 }, unitsBacking: 279, coordTier: 'approx', provenance: 'auto-matched' },
  // Rivers --------------------------------------------------
  'Rivers|Khana I': { lgas: ['Khana'], centroid: { lat: 4.643, lng: 7.423 }, unitsBacking: 359, coordTier: 'approx', provenance: 'auto-matched' },
  'Rivers|Port-Harcourt III': { lgas: ['Port Harcourt'], centroid: { lat: 4.79258, lng: 7.01637 }, unitsBacking: 805, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Emohua': { lgas: ['Emohua'], centroid: { lat: 4.9396, lng: 6.7791 }, unitsBacking: 121, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Obio/Akpor II': { lgas: ['Obio/Akpor'], centroid: { lat: 4.8471, lng: 6.99222 }, unitsBacking: 1072, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Asari-Toru II': { lgas: ['Asari-Toru'], centroid: { lat: 4.75415, lng: 6.83133 }, unitsBacking: 50, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Ogba/Egbema/Ndoni': { lgas: ['Ogba/Egbema/Ndoni'], centroid: { lat: 5.33997, lng: 6.63961 }, unitsBacking: 298, coordTier: 'approx', provenance: 'auto-matched' },
  'Rivers|Ahoada West': { lgas: ['Ahoada West'], centroid: { lat: 5.05886, lng: 6.473 }, unitsBacking: 171, coordTier: 'approx', provenance: 'auto-matched' },
  'Rivers|Degema': { lgas: ['Degema'], centroid: { lat: 4.7582, lng: 6.88517 }, unitsBacking: 88, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Akuku-Toru II': { lgas: ['Akuku Toru'], centroid: { lat: 4.62500, lng: 6.77300 }, unitsBacking: 16, coordTier: 'approx', provenance: 'auto-matched', note: 'Centroid is the median over DISTINCT ward envelopes, not over units: 10 of this LGA\'s 16 coordinate-bearing units sit in one southern ward (Kula I), so unit-weighting pulled the pin 27km off, nearer a Bayelsa unit than its own LGA. Thin evidence either way — 16 of 244 units.' },
  'Rivers|Okrika': { lgas: ['Okrika'], centroid: { lat: 4.7339, lng: 7.0878 }, unitsBacking: 31, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Khana II': { lgas: ['Khana'], centroid: { lat: 4.643, lng: 7.423 }, unitsBacking: 359, coordTier: 'approx', provenance: 'auto-matched' },
  'Rivers|Akuku-Toru I': { lgas: ['Akuku Toru'], centroid: { lat: 4.62500, lng: 6.77300 }, unitsBacking: 16, coordTier: 'approx', provenance: 'auto-matched', note: 'Centroid is the median over DISTINCT ward envelopes, not over units: 10 of this LGA\'s 16 coordinate-bearing units sit in one southern ward (Kula I), so unit-weighting pulled the pin 27km off, nearer a Bayelsa unit than its own LGA. Thin evidence either way — 16 of 244 units.' },
  'Rivers|Onelga II': { lgas: ['Ogba/Egbema/Ndoni'], centroid: { lat: 5.33997, lng: 6.63961 }, unitsBacking: 298, coordTier: 'approx', provenance: 'researched' },
  'Rivers|Etche I': { lgas: ['Etche'], centroid: { lat: 5.07672, lng: 7.09928 }, unitsBacking: 271, coordTier: 'approx', provenance: 'auto-matched' },
  'Rivers|Bonny': { lgas: ['Bonny'], centroid: { lat: 4.40886, lng: 7.165 }, unitsBacking: 13, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Tai': { lgas: ['Tai'], centroid: { lat: 4.7478, lng: 7.28009 }, unitsBacking: 45, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Ikwere I': { lgas: ['Ikwerre'], centroid: { lat: 4.95969, lng: 6.92791 }, unitsBacking: 126, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Asari-Toru I': { lgas: ['Asari-Toru'], centroid: { lat: 4.75415, lng: 6.83133 }, unitsBacking: 50, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Andoni I': { lgas: ['Andoni'], centroid: { lat: 4.50344, lng: 7.41909 }, unitsBacking: 265, coordTier: 'approx', provenance: 'auto-matched' },
  'Rivers|Obio/Akpor I': { lgas: ['Obio/Akpor'], centroid: { lat: 4.8471, lng: 6.99222 }, unitsBacking: 1072, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Ahoada East I': { lgas: ['Ahoada East'], centroid: { lat: 5.05, lng: 6.636 }, unitsBacking: 35, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Abua/Odual': { lgas: ['Abua-Odual'], centroid: { lat: 4.8486, lng: 6.513 }, unitsBacking: 85, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Etche II': { lgas: ['Etche'], centroid: { lat: 5.07672, lng: 7.09928 }, unitsBacking: 271, coordTier: 'approx', provenance: 'auto-matched' },
  'Rivers|Port-Harcourt II': { lgas: ['Port Harcourt'], centroid: { lat: 4.79258, lng: 7.01637 }, unitsBacking: 805, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Eleme': { lgas: ['Eleme'], centroid: { lat: 4.73462, lng: 7.13642 }, unitsBacking: 71, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Oyigbo': { lgas: ['Oyigbo'], centroid: { lat: 4.87418, lng: 7.14459 }, unitsBacking: 76, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Ogu/Bolo': { lgas: ['Ogu/Bolo'], centroid: { lat: 4.70968, lng: 7.20135 }, unitsBacking: 131, coordTier: 'approx', provenance: 'auto-matched' },
  'Rivers|Opobo/Nkoro': { lgas: ['Opobo/Nekoro'], centroid: { lat: 4.51503, lng: 7.5379 }, unitsBacking: 74, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Gokana': { lgas: ['Gokana'], centroid: { lat: 4.6659, lng: 7.3012 }, unitsBacking: 175, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Port-Harcourt I': { lgas: ['Port Harcourt'], centroid: { lat: 4.79258, lng: 7.01637 }, unitsBacking: 805, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Omuma': { lgas: ['Omuma'], centroid: { lat: 5.06393, lng: 7.2321 }, unitsBacking: 85, coordTier: 'crowd', provenance: 'auto-matched' },
  'Rivers|Ahoada East II': { lgas: ['Ahoada East'], centroid: { lat: 5.05, lng: 6.636 }, unitsBacking: 35, coordTier: 'crowd', provenance: 'auto-matched' },
  // Sokoto --------------------------------------------------
  'Sokoto|Tureta': { lgas: ['Tureta'], centroid: { lat: 12.58438, lng: 5.51739 }, unitsBacking: 77, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Tambuwal East': { lgas: ['Tambuwal'], centroid: { lat: 12.389, lng: 4.753 }, unitsBacking: 259, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Kware': { lgas: ['Kware'], centroid: { lat: 13.1235, lng: 5.287 }, unitsBacking: 142, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Sokoto North I': { lgas: ['Sokoto North'], centroid: { lat: 13.069, lng: 5.244 }, unitsBacking: 289, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Sokoto South I': { lgas: ['Sokoto South'], centroid: { lat: 13.05, lng: 5.24947 }, unitsBacking: 298, coordTier: 'crowd', provenance: 'auto-matched' },
  'Sokoto|Shagari': { lgas: ['Shagari'], centroid: { lat: 12.59981, lng: 5.0705 }, unitsBacking: 148, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Tambuwal West': { lgas: ['Tambuwal'], centroid: { lat: 12.389, lng: 4.753 }, unitsBacking: 259, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Gada West': { lgas: ['Gada'], centroid: { lat: 13.69857, lng: 5.65665 }, unitsBacking: 239, coordTier: 'crowd', provenance: 'auto-matched' },
  'Sokoto|Dange Shuni': { lgas: ['Dange/Shuni'], centroid: { lat: 12.9175, lng: 5.32844 }, unitsBacking: 194, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Goronyo': { lgas: ['Goronyo'], centroid: { lat: 13.4435, lng: 5.71065 }, unitsBacking: 172, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Sokoto South II': { lgas: ['Sokoto South'], centroid: { lat: 13.05, lng: 5.24947 }, unitsBacking: 298, coordTier: 'crowd', provenance: 'auto-matched' },
  'Sokoto|Gada East': { lgas: ['Gada'], centroid: { lat: 13.69857, lng: 5.65665 }, unitsBacking: 239, coordTier: 'crowd', provenance: 'auto-matched' },
  'Sokoto|Wamakko': { lgas: ['Wamakko'], centroid: { lat: 13.032, lng: 5.19596 }, unitsBacking: 259, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Tangaza': { lgas: ['Tangaza'], centroid: { lat: 13.404, lng: 4.987 }, unitsBacking: 139, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Yabo': { lgas: ['Yabo'], centroid: { lat: 12.72018, lng: 4.98988 }, unitsBacking: 102, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Kebbe': { lgas: ['Kebbe'], centroid: { lat: 12.04083, lng: 4.703 }, unitsBacking: 113, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Isa': { lgas: ['Isa'], centroid: { lat: 13.20207, lng: 6.406 }, unitsBacking: 146, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Gwadabawa South': { lgas: ['Gwadabawa'], centroid: { lat: 13.37833, lng: 5.292 }, unitsBacking: 186, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Gwadabawa North': { lgas: ['Gwadabawa'], centroid: { lat: 13.37833, lng: 5.292 }, unitsBacking: 186, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Gudu': { lgas: ['Gudu'], centroid: { lat: 13.461, lng: 4.39521 }, unitsBacking: 90, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Illela': { lgas: ['Illela'], centroid: { lat: 13.6823, lng: 5.346 }, unitsBacking: 210, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Rabah': { lgas: ['Rabah'], centroid: { lat: 12.99448, lng: 5.691 }, unitsBacking: 115, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Sabon Birni North': { lgas: ['S/Birni'], centroid: { lat: 13.5425, lng: 6.31163 }, unitsBacking: 232, coordTier: 'approx', provenance: 'researched' },
  'Sokoto|Sabon Birni South': { lgas: ['S/Birni'], centroid: { lat: 13.5425, lng: 6.31163 }, unitsBacking: 232, coordTier: 'approx', provenance: 'researched' },
  'Sokoto|Silame': { lgas: ['Silame'], centroid: { lat: 13.026, lng: 4.83937 }, unitsBacking: 101, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Sokoto North II': { lgas: ['Sokoto North'], centroid: { lat: 13.069, lng: 5.244 }, unitsBacking: 289, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Wurno': { lgas: ['Wurno'], centroid: { lat: 13.24448, lng: 5.4225 }, unitsBacking: 124, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Bodinga South': { lgas: ['Bodinga'], centroid: { lat: 12.83559, lng: 5.16153 }, unitsBacking: 181, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Bodinga North': { lgas: ['Bodinga'], centroid: { lat: 12.83559, lng: 5.16153 }, unitsBacking: 181, coordTier: 'approx', provenance: 'auto-matched' },
  'Sokoto|Binji': { lgas: ['Binji'], centroid: { lat: 13.168, lng: 4.912 }, unitsBacking: 85, coordTier: 'approx', provenance: 'auto-matched' },
  // Taraba --------------------------------------------------
  'Taraba|Jalingo I': { lgas: ['Jalingo'], centroid: { lat: 8.899, lng: 11.34539 }, unitsBacking: 342, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Wukari II': { lgas: ['Wukari'], centroid: { lat: 7.90099, lng: 9.82419 }, unitsBacking: 377, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Gashaka': { lgas: ['Gashaka'], centroid: { lat: 7.514, lng: 11.347 }, unitsBacking: 137, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Karim Lamido II': { lgas: ['Karim-Lamido'], centroid: { lat: 9.34459, lng: 11.18932 }, unitsBacking: 215, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Gassol I': { lgas: ['Gassol'], centroid: { lat: 8.56549, lng: 10.65104 }, unitsBacking: 342, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Mbamnga': { lgas: ['Sardauna'], centroid: { lat: 6.75594, lng: 11.2295 }, unitsBacking: 358, coordTier: 'approx', provenance: 'researched' },
  'Taraba|Yorro': { lgas: ['Yorro'], centroid: { lat: 8.947, lng: 11.603 }, unitsBacking: 107, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Jalingo II': { lgas: ['Jalingo'], centroid: { lat: 8.899, lng: 11.34539 }, unitsBacking: 342, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Ibi': { lgas: ['Ibi'], centroid: { lat: 8.19081, lng: 9.75217 }, unitsBacking: 142, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Lau': { lgas: ['Lau'], centroid: { lat: 9.192, lng: 11.451 }, unitsBacking: 137, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Nguroje': { lgas: ['Sardauna'], centroid: { lat: 6.75594, lng: 11.2295 }, unitsBacking: 358, coordTier: 'approx', provenance: 'researched' },
  'Taraba|Zing': { lgas: ['Zing'], centroid: { lat: 8.95992, lng: 11.75981 }, unitsBacking: 154, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Kurmi': { lgas: ['Kurmi'], centroid: { lat: 7.19364, lng: 10.61535 }, unitsBacking: 135, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Ardo-Kola': { lgas: ['Ardokola'], centroid: { lat: 8.83894, lng: 11.24013 }, unitsBacking: 164, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Bali II': { lgas: ['Bali'], centroid: { lat: 8.07151, lng: 10.97877 }, unitsBacking: 254, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Takum I': { lgas: ['Takum'], centroid: { lat: 7.256, lng: 9.99025 }, unitsBacking: 245, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Wukari I': { lgas: ['Wukari'], centroid: { lat: 7.90099, lng: 9.82419 }, unitsBacking: 377, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Bali I': { lgas: ['Bali'], centroid: { lat: 8.07151, lng: 10.97877 }, unitsBacking: 254, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Gembu (Sardauna I)': { lgas: ['Sardauna'], centroid: { lat: 6.75594, lng: 11.2295 }, unitsBacking: 358, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Karim Lamido I': { lgas: ['Karim-Lamido'], centroid: { lat: 9.34459, lng: 11.18932 }, unitsBacking: 215, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Gassol II': { lgas: ['Gassol'], centroid: { lat: 8.56549, lng: 10.65104 }, unitsBacking: 342, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Donda': { lgas: ['Donga'], centroid: { lat: 7.67205, lng: 10.21 }, unitsBacking: 185, coordTier: 'approx', provenance: 'researched', note: 'researched, MEDIUM confidence: \'Donda\' is attested nowhere with a stated LGA. It resolves to Donga by elimination — Donga is the only Taraba LGA left unaccounted for once the other 23 seats match, and the names differ by one letter. Almost certainly an INEC transcription of Donga, but not asserted.' },
  'Taraba|Kashimbila (Takum II)': { lgas: ['Takum'], centroid: { lat: 7.256, lng: 9.99025 }, unitsBacking: 245, coordTier: 'approx', provenance: 'auto-matched' },
  'Taraba|Ussa/Likam': { lgas: ['Ussa'], centroid: { lat: 7.1755, lng: 10.031 }, unitsBacking: 150, coordTier: 'approx', provenance: 'auto-matched' },
  // Yobe ----------------------------------------------------
  'Yobe|Gulani': { lgas: ['Gulani'], centroid: { lat: 10.94435, lng: 11.672 }, unitsBacking: 131, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Tarmuwa': { lgas: ['Tarmuwa'], centroid: { lat: 12.263, lng: 11.78201 }, unitsBacking: 84, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Nangere': { lgas: ['Nangere'], centroid: { lat: 11.82729, lng: 10.99 }, unitsBacking: 169, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Mamudo': { lgas: ['Potiskum'], centroid: { lat: 11.70679, lng: 11.08852 }, unitsBacking: 328, coordTier: 'approx', provenance: 'researched' },
  'Yobe|Potiskum Town': { lgas: ['Potiskum'], centroid: { lat: 11.70679, lng: 11.08852 }, unitsBacking: 328, coordTier: 'approx', provenance: 'researched' },
  'Yobe|Goya/Ngeji': { lgas: ['Fika'], centroid: { lat: 11.33313, lng: 11.28005 }, unitsBacking: 187, coordTier: 'approx', provenance: 'suspect', note: 'UNATTESTED: neither Goya nor Ngeji appears in any Fika register ward, and Ngeji appears nowhere in the register at all. Fika is inference by elimination — re-verify before relying on it for LGA-to-seat inference.' },
  'Yobe|Geidam North': { lgas: ['Geidam'], centroid: { lat: 12.87646, lng: 11.929 }, unitsBacking: 144, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Fika/Ngalda': { lgas: ['Fika'], centroid: { lat: 11.33313, lng: 11.28005 }, unitsBacking: 187, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Damaturu I': { lgas: ['Damaturu'], centroid: { lat: 11.745, lng: 11.95201 }, unitsBacking: 221, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Nguru I': { lgas: ['Nguru'], centroid: { lat: 12.8846, lng: 10.452 }, unitsBacking: 169, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Nguru II': { lgas: ['Nguru'], centroid: { lat: 12.8846, lng: 10.452 }, unitsBacking: 169, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Yunusari I': { lgas: ['Yunusari'], centroid: { lat: 13.05082, lng: 11.843 }, unitsBacking: 112, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Machina': { lgas: ['Machina'], centroid: { lat: 13.00701, lng: 9.975 }, unitsBacking: 91, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Karasuwa': { lgas: ['Karasawa'], centroid: { lat: 12.94379, lng: 10.80782 }, unitsBacking: 111, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Jakusko': { lgas: ['Jakusko'], centroid: { lat: 12.4772, lng: 10.86426 }, unitsBacking: 161, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Yusufari II': { lgas: ['Yusufari'], centroid: { lat: 13.2015, lng: 10.96466 }, unitsBacking: 114, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Bade West': { lgas: ['Bade'], centroid: { lat: 12.874, lng: 11.04025 }, unitsBacking: 210, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Damaturu II': { lgas: ['Damaturu'], centroid: { lat: 11.745, lng: 11.95201 }, unitsBacking: 221, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Damagum': { lgas: ['Fune'], centroid: { lat: 11.80989, lng: 11.42295 }, unitsBacking: 219, coordTier: 'approx', provenance: 'researched' },
  'Yobe|Jajere': { lgas: ['Fune'], centroid: { lat: 11.80989, lng: 11.42295 }, unitsBacking: 219, coordTier: 'approx', provenance: 'researched' },
  'Yobe|Geidam South': { lgas: ['Geidam'], centroid: { lat: 12.87646, lng: 11.929 }, unitsBacking: 144, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Gujba': { lgas: ['Gujba'], centroid: { lat: 11.3815, lng: 12.03437 }, unitsBacking: 140, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Bade East': { lgas: ['Bade'], centroid: { lat: 12.874, lng: 11.04025 }, unitsBacking: 210, coordTier: 'approx', provenance: 'auto-matched' },
  'Yobe|Bursari': { lgas: ['Bursari'], centroid: { lat: 12.767, lng: 11.49357 }, unitsBacking: 128, coordTier: 'approx', provenance: 'auto-matched' },
  // Zamfara -------------------------------------------------
  'Zamfara|Kaura Namoda North': { lgas: ['Kaura Namoda'], centroid: { lat: 12.55421, lng: 6.61292 }, unitsBacking: 261, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Bukkuyum South': { lgas: ['Bukkuyum'], centroid: { lat: 12.01516, lng: 5.601 }, unitsBacking: 193, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Anka': { lgas: ['Anka'], centroid: { lat: 12.0735, lng: 5.924 }, unitsBacking: 164, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Bukkuyum North': { lgas: ['Bukkuyum'], centroid: { lat: 12.01516, lng: 5.601 }, unitsBacking: 193, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Tsafe West': { lgas: ['Tsafe'], centroid: { lat: 11.95141, lng: 6.87309 }, unitsBacking: 301, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Gummi II': { lgas: ['Gummi'], centroid: { lat: 12.11675, lng: 5.1155 }, unitsBacking: 202, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Talata Mafara North': { lgas: ['Talata Mafara'], centroid: { lat: 12.49264, lng: 6.06764 }, unitsBacking: 259, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Maru South': { lgas: ['Maru'], centroid: { lat: 11.68241, lng: 6.35417 }, unitsBacking: 247, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Gusau East': { lgas: ['Gusau'], centroid: { lat: 12.14, lng: 6.67326 }, unitsBacking: 564, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Bungudu East': { lgas: ['Bungudu'], centroid: { lat: 12.23985, lng: 6.5836 }, unitsBacking: 325, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Gusau West': { lgas: ['Gusau'], centroid: { lat: 12.14, lng: 6.67326 }, unitsBacking: 564, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Zurmi East': { lgas: ['Zurmi'], centroid: { lat: 12.79552, lng: 6.73333 }, unitsBacking: 233, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Zurmi West': { lgas: ['Zurmi'], centroid: { lat: 12.79552, lng: 6.73333 }, unitsBacking: 233, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Bakura': { lgas: ['Bakura'], centroid: { lat: 12.6916, lng: 5.875 }, unitsBacking: 189, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Maradun I': { lgas: ['Maradun'], centroid: { lat: 12.69639, lng: 6.267 }, unitsBacking: 177, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Bungudu West': { lgas: ['Bungudu'], centroid: { lat: 12.23985, lng: 6.5836 }, unitsBacking: 325, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Talata Mafara South': { lgas: ['Talata Mafara'], centroid: { lat: 12.49264, lng: 6.06764 }, unitsBacking: 259, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Maradun II': { lgas: ['Maradun'], centroid: { lat: 12.69639, lng: 6.267 }, unitsBacking: 177, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Maru North': { lgas: ['Maru'], centroid: { lat: 11.68241, lng: 6.35417 }, unitsBacking: 247, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Tsafe East': { lgas: ['Tsafe'], centroid: { lat: 11.95141, lng: 6.87309 }, unitsBacking: 301, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Gummi I': { lgas: ['Gummi'], centroid: { lat: 12.11675, lng: 5.1155 }, unitsBacking: 202, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Shinkafi': { lgas: ['Shinkafi'], centroid: { lat: 13.05891, lng: 6.503 }, unitsBacking: 172, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Kaura Namoda South': { lgas: ['Kaura Namoda'], centroid: { lat: 12.55421, lng: 6.61292 }, unitsBacking: 261, coordTier: 'approx', provenance: 'auto-matched' },
  'Zamfara|Birnin Magaji': { lgas: ['Birnin Magaji'], centroid: { lat: 12.52708, lng: 6.8195 }, unitsBacking: 170, coordTier: 'approx', provenance: 'auto-matched' },
};

/** Key into ASSEMBLY_LOCATIONS. Mirrors the upstream `state|constituency`. */
export function assemblyLocationKey(state: StateName, seat: string): string {
  return `${state}|${seat}`;
}

/** Location detail for one state constituency, or undefined if unknown. */
export function assemblyLocation(state: StateName, seat: string): AssemblyLocation | undefined {
  return ASSEMBLY_LOCATIONS[assemblyLocationKey(state, seat)];
}

/**
 * Reverse index, built once on first use: register LGA -> the state
 * constituencies inside it.
 */
let lgaIndex: Map<string, string[]> | null = null;

function buildLgaIndex(): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const [key, loc] of Object.entries(ASSEMBLY_LOCATIONS)) {
    const sep = key.indexOf('|');
    const state = key.slice(0, sep);
    const seat = key.slice(sep + 1);
    for (const lga of loc.lgas) {
      const k = `${state}|${lga}`;
      const list = idx.get(k);
      if (list) list.push(seat);
      else idx.set(k, [seat]);
    }
  }
  return idx;
}

/**
 * The state constituencies that sit in a given register LGA — the lookup the
 * 2027 reporting picker needs, since a report starts from a polling unit and a
 * polling unit knows its state and LGA.
 *
 * THIS RELATION IS MANY-TO-MANY, and callers must handle a list, not a single
 * answer, in BOTH directions:
 *   - one LGA can hold several constituencies — most hold 1, plenty hold 2, and
 *     Bayelsa "Southern Ijaw" holds 4 — so this returns [] , [one] or [several];
 *   - one constituency can span several LGAs — 19 of the 993 do, e.g.
 *     Kano "Kura/Gurun Mallam" covers both Kura and Garun Malam — so the same
 *     seat name legitimately appears under more than one LGA key.
 * An LGA therefore narrows the choice; it does not decide it. The register
 * carries no ward -> state-constituency delineation, so where this returns more
 * than one the final pick has to come from the observer (or from ward-level
 * delineation data, if that is ever sourced).
 *
 * `state` and `lga` must be the register's own spellings
 * (`polling_units.state` / `.lga`). Returns [] for an unknown pair and for all
 * six FCT area councils, which elect no state assembly.
 */
export function shaConstituenciesInLga(state: StateName, lga: string): string[] {
  if (!lgaIndex) lgaIndex = buildLgaIndex();
  return lgaIndex.get(`${state}|${lga}`) ?? [];
}

/** A single selectable race, fully resolved. */
export interface Race {
  type: ElectionTypeCode;
  /** Code to match against GET /api/contests. Equal to `type`. */
  contestCode: ElectionTypeCode;
  /** Undefined only for the presidential race. */
  state?: StateName;
  /** SEN only. */
  district?: string;
  /** REP only. */
  constituency?: string;
  /** SHA only — the state-constituency name (INEC 2023 ballot name). */
  seat?: string;
  /**
   * SHA only — the register LGA(s) this seat covers, copied from
   * ASSEMBLY_LOCATIONS. Empty only if the seat's LGAs are unresolved.
   * Additive: it does not participate in `key`, so race identity is unchanged.
   */
  lgas?: string[];
  /** SHA only — representative point; undefined when the seat has no centroid. */
  centroid?: { lat: number; lng: number };
  /** Human label for the picker. */
  label: string;
  /** Stable unique key — use as the report's race identity. */
  key: string;
}

const slug = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The single presidential race. */
export const PRESIDENTIAL_RACE: Race = {
  type: 'PRES',
  contestCode: 'PRES',
  label: 'Presidency',
  key: 'PRES',
};

/**
 * The catalogue's own cycle: every race enumerated in this file belongs to the
 * January 2027 general election. raceLabel() uses it as the year of last resort
 * so that no race carries a hand-written year of its own.
 */
export const GENERAL_ELECTION_YEAR = 2027;

/**
 * How a race is named wherever it is shown: `<race> (<year>)`.
 *
 * The year is DERIVED, never written down per race. A race the backend has
 * configured carries its own polling date (Osun's GOV row is 2026-08-15, so
 * "Osun Governorship (2026)"); anything with no contest row yet — today the
 * presidency — falls back to the catalogue's general-election cycle, giving
 * "Presidency (2027)".
 *
 * Deriving it is the whole point: governorship elections are STAGGERED across
 * years, and this file generates a `${state} Governorship` race for all 36
 * states. A hardcoded 2026 would mislabel every off-cycle state the moment a
 * second GOV contest is configured; reading the contest's own date cannot.
 *
 * `contests` is structurally typed rather than importing Contest from lib/api,
 * which would make this module and the API client circular.
 */
export function raceLabel(
  race: Pick<Race, 'label' | 'contestCode'>,
  contests?: { code: string; date?: string }[],
): string {
  const date = contests?.find((c) => c.code === race.contestCode)?.date;
  const year = Number(date?.slice(0, 4)) || GENERAL_ELECTION_YEAR;
  return `${race.label} (${year})`;
}

/**
 * Enumerate every concrete race for a given election type. For SHA this returns
 * [] for any state whose constituency names are unavailable (the seat count is
 * still exposed via STATE_ASSEMBLY) — anonymous numbered seats are deliberately
 * not fabricated.
 *
 * SHA races also carry `lgas` and `centroid` from ASSEMBLY_LOCATIONS. `label`
 * and `key` are unchanged: the key is the report's race identity and other code
 * matches on it, and a caller wanting the LGA in a label should read `lgas` and
 * format it itself rather than depend on this string.
 */
export function listRaces(type: ElectionTypeCode, state?: StateName): Race[] {
  switch (type) {
    case 'PRES':
      return [PRESIDENTIAL_RACE];
    case 'GOV':
      return (state ? [state] : GOVERNORSHIP_STATES)
        .filter((s) => s !== 'FCT')
        .map((s) => ({
          type: 'GOV', contestCode: 'GOV', state: s,
          label: `${s} Governorship`, key: `GOV:${s}`,
        }));
    case 'SEN':
      return (state ? [state] : STATES).flatMap((s) =>
        SENATORIAL_DISTRICTS[s].map((d) => ({
          type: 'SEN' as const, contestCode: 'SEN' as const, state: s, district: d,
          label: `${slug(d)} Senatorial District`, key: `SEN:${s}:${slug(d)}`,
        })),
      );
    case 'REP':
      return (state ? [state] : STATES).flatMap((s) =>
        FEDERAL_CONSTITUENCIES[s].map((c) => ({
          type: 'REP' as const, contestCode: 'REP' as const, state: s, constituency: c,
          label: `${slug(c)} Federal Constituency (${s})`, key: `REP:${s}:${slug(c)}`,
        })),
      );
    case 'SHA':
      return (state ? [state] : STATES).flatMap((s) => {
        const names = STATE_ASSEMBLY[s].constituencies;
        if (!names) return [];
        return names.map((n) => {
          // Location detail rides along; `key` is deliberately untouched.
          const loc = ASSEMBLY_LOCATIONS[`${s}|${n}`];
          return {
            type: 'SHA' as const, contestCode: 'SHA' as const, state: s, seat: n,
            lgas: loc?.lgas ?? [],
            centroid: loc?.centroid,
            label: `${slug(n)} State Constituency (${s})`, key: `SHA:${s}:${slug(n)}`,
          };
        });
      });
  }
}

/** The contest shape returned by GET /api/contests (subset we rely on). */
export interface Contest {
  code: string;
  states?: string[];
  open?: boolean;
  [k: string]: unknown;
}

/** The contest (if any) that governs this race's OPEN/closed state. */
export function matchContest(race: Race, contests: Contest[]): Contest | undefined {
  return contests.find((c) =>
    c.code === race.contestCode &&
    // A contest with no `states` (or an empty list) is national in scope.
    (!c.states || c.states.length === 0 || (race.state != null && c.states.includes(race.state))),
  );
}

/** True when a live contest exists for this race and reporting is open. */
export function isRaceOpen(race: Race, contests: Contest[]): boolean {
  return matchContest(race, contests)?.open === true;
}

/**
 * Reconciliation totals. Runtime self-check so a bad edit fails loudly; also
 * used by tools/validate. Returns the reached totals and whether each matches
 * its constitutional target.
 */
export function catalogueTotals() {
  const senatorial = Object.values(SENATORIAL_DISTRICTS).reduce((n, a) => n + a.length, 0);
  const federal = Object.values(FEDERAL_CONSTITUENCIES).reduce((n, a) => n + a.length, 0);
  const assembly = Object.values(STATE_ASSEMBLY).reduce((n, a) => n + a.seats, 0);
  const governorships = GOVERNORSHIP_STATES.length;
  // Location coverage, reported but deliberately NOT part of `ok`: a missing
  // centroid is a known register gap, not a catalogue error.
  const locs = Object.values(ASSEMBLY_LOCATIONS);
  const assemblyLocated = locs.length;
  const assemblyWithCentroid = locs.filter((l) => l.centroid).length;
  const assemblyUnresolved = locs.filter((l) => l.lgas.length === 0).length;
  /**
   * Seats with NO location entry at all — distinct from `assemblyUnresolved`,
   * which counts entries that exist but carry an empty `lgas`. The 2026
   * restorations produced the first seats in the second category: 14 whose
   * names reduce to nothing the register knows, deliberately given no entry
   * rather than a guessed one. Without this they were invisible here, since
   * every other total counts what IS present.
   */
  const assemblyWithoutLocation = assembly - assemblyLocated;
  return {
    presidential: 1,
    governorships,
    senatorial,
    federal,
    assembly,
    assemblyLocated,
    assemblyWithCentroid,
    assemblyUnresolved,
    assemblyWithoutLocation,
    ok:
      senatorial === 109 &&
      federal === 360 &&
      assembly === 1019 &&
      governorships === 36 &&
      !GOVERNORSHIP_STATES.includes('FCT'),
  };
}
