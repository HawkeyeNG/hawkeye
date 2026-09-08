# Election terms — the vocabulary everything else is built on

These are the words machine translation gets wrong, and getting them wrong is
not cosmetic: an observer who misreads "accredited voters" as "registered
voters" files a wrong number, and the platform publishes it.

The columns were deliberately left blank for a human, because a draft in the
column anchors the reviewer to it, and these are exactly the terms where the
anchor is wrong — several have an established INEC usage that no general
translation engine has seen.

## Status, 2026-09-07

| Language | Terms | Reviewers | Standing |
|---|---|---|---|
| Hausa | filled | 1, anonymous, **plus the project owner**, a Hausa speaker, who attests it | provisional |
| Igbo | filled | 1, anonymous | provisional |
| Yorùbá | filled | 1, anonymous | provisional |
| Naija (Pidgin) | empty | — | not started |

**The reviewers asked not to be named**, so `_meta.glossary.anonymous` is `true`
in every bundle and `reviewedBy` stays null. That is a deliberate record of
anonymity, not a missing field — do not "fix" it by inventing an attribution.

**Two or three more reviewers per language are being recruited to corroborate.**
`_meta.target` is 3. Raise `_meta.glossary.reviewers` as each one signs off; when
it reaches the target, set `_meta.review` to `human` and the picker's draft badge
disappears on its own — the badge is read from the bundle, not hardcoded.

**These terms are provisional; the 588 UI strings that use them are not reviewed
at all.** They are a language-model draft written on top of this vocabulary,
and that is what `_meta.review: "machine-draft"` means.

The next review pass is those UI strings, and it does not have to start from
one end. **`_meta.priority` in each bundle lists fifteen to read first**: the
two evidential ledger notices, the account-deletion warning, the corroboration
explainer, and the strings that either carry the INEC notice as a trailing
clause or state a hard rule an observer must not misread — one report per
election per device, reports are permanent, a phone number is stored only as a
hash. Getting those fifteen right matters more than the other 573 combined.

**The privacy policy and the terms are not in the bundles at all** and render in
English on every language. That is deliberate (`_meta.englishOnlyPages`), not an
omission — see the last section.

### One question for the Yorùbá reviewers

Four entries below carry no tone marks while the rest do — **Iṣẹlẹ** (15),
**Rira ibo** (16), **Gbe jade** (13) and **Nomba siriali** (25). The UI strings
follow this file verbatim rather than "correcting" it, so if the omission was
accidental, fixing it here is what propagates.

|#|English (source)|Hausa|Igbo|Yorùbá|Naija (Pidgin)|
|-:|-|-|-|-|-|
|1|Polling unit|Rukunin zaɓe|Ngalaba ntuli aka|Ẹ̀ka ìdìbò||
|2|Registered voters|Masu zaɓe da aka yi wa rijista|Ndị ntuli aka edebanyere aha|Àwọn olùdìbò tí a forúkọ sílẹ̀||
|3|Accredited voters|Masu zaɓe da aka amince da su|Ndị ntuli aka enyere ikike|Àwọn olùdìbò tí a fọwọ́ sí||
|4|Presiding officer|Jami'in gudanarwa|Onyeisi oche|Alága àgbà||
|5|Result sheet (EC8A)|Takardar Sakamako|Mpempe akwụkwọ nsonaazụ|Ìwé Àbájáde||
|6|Collation|Tattarawa|Nchịkọta|Ṣíṣe àkójọpọ̀||
|7|Ward|Unguwa|Ward|Àgọ́||
|8|Local Government Area (LGA)|Karamar Hukumar|Mpaghara Ọchịchị Obodo|Agbègbè Ìjọba Àdúgbò||
|9|Constituency|Mazabar mazaba|Mpaghara ntuli aka|Ìgbìmọ̀ aṣòfin||
|10|Ballot|Takardar zaɓe|Ntuli aka|Ìdìbò||
|11|Spoiled ballot|Kuri'ar zaɓen da ta lalace|Akwụkwọ ntuli aka mebiri emebi|Ìwé ìdìbò tí ó ti bàjẹ́||
|12|Total valid votes|Jimillar ƙuri'u masu inganci|Mgbakọta votu ndị ziri ezi|Àpapọ̀ àwọn ìdìbò tó wúlò||
|13|Turnout|Hallara|Tụgharịpụta|Gbe jade||
|14|Observer|Mai Lura|Onye Na-ekiri Ihe|Olùwòran||
|15|Incident|Lamarin da ya faru|Ihe merenụ|Iṣẹlẹ||
|16|Vote buying|Siyan ƙuri'a|Ịzụta votu|Rira ibo||
|17|Over-voting|Yawan jefa ƙuri'a|Ịtụ vootu gabiga ókè|Ìdìbò tó pọ̀jù||
|18|Polling agent|Wakilin zaɓe|Onye nnọchite anya ntuli aka|Aṣojú ìdìbò||
|19|Declaration (of a result)|Sanarwa|Nkwupụta|Ìkéde||
|20|Tribunal / petition|Kotun / ƙara|Ụlọikpe / Akwụkwọ mkpesa |Ilé ẹjọ́ / ẹ̀bẹ̀||
|21|Unverified|Ba a Tabbatar ba|Enweghị nkwenye|A kò tíì fìdí rẹ̀ múlẹ̀||
|22|Evidence|Shaida|Ihe akaebe|Ẹ̀rí||
|23|Sign in / Sign up|Shiga / yi rijista|Banye / Debanye aha|Wọlé / forúkọ sílẹ̀||
|24|Polling day|Ranar zaɓe|Ụbọchị ntuli aka|Ọjọ́ ìdìbò||
|25|Serial number|Lambar Serial|Nọmba usoro n'usoro|Nomba siriali||

## Notes for reviewers

**"Accredited" vs "registered" (rows 2 and 3) is the most dangerous pair in the
document.** They are different numbers on the same sheet, and they are the two
fields that must agree across a polling unit's Presidential, Senate and Reps
sheets — the platform's strongest automated integrity check depends on them
being distinguishable. If one word ends up serving both, that check silently
stops meaning anything.

**Row 21, "unverified", carries legal weight.** It is the label separating a
phone-in claim from a photographed result sheet. It must be unmistakable, not
softened.

**Numbers stay in digits.** Do not translate numerals into words anywhere in the
interface, however natural it reads — the app parses what it displays back in
places, and the words column on the EC8A is already read by a separate parser
with its own grammar rules.

**Nigerian Pidgin has no standard orthography.** Follow BBC News Pidgin's
convention rather than inventing one; it is the largest published body of
written Naija and the one readers will have seen.

**Script requirements** (already covered by the rebuilt web fonts, 2026-09-07 —
re-check if fonts ever change): Yorùbá needs the subdotted letters ẹ ọ ṣ **and**
the combining tone marks (U+0300 grave, U+0301 acute). Igbo needs ị ọ ụ. Hausa
Boko needs the hooked letters ɓ ɗ ƙ. **Spline Sans, the display face used for
headings, lacks ẹ ṣ and all three Hausa hooks** — headings swap wholesale to
Inter for Yorùbá and Hausa, which is why `--display` exists in styles.css.

## What must never be machine-translated

Legal and evidential text: the privacy policy, terms, the INEC disclaimer in the
footer, consent wording, and any "unverified" label. These go to a human
translator or stay in English. A mistranslated disclaimer is a legal exposure,
and a mistranslated evidence label is an integrity one.

