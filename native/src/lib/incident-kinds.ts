/* How each incident kind reads, for the incidents screen and the home feed.
 *
 * Keys, not calls: resolved on read, so a language change reaches them. A map
 * built with t() at import freezes in whatever language loaded first -- see
 * lazyT in lib/i18n.
 */
import { lazyT } from '@/lib/i18n';

export const KIND_LABEL: Record<string, string> = lazyT({
  violence: 'n.app.incidents.violence',
  ballot_snatching: 'n.app.incidents.ballot-snatching',
  vote_buying: 'n.app.incidents.vote-buying',
  intimidation: 'n.app.incidents.intimidation',
  bvas_failure: 'n.app.incidents.bvas-failure',
  late_materials: 'n.app.incidents.late-materials',
  obstruction: 'n.app.incidents.obstruction',
  other: 'n.app.incidents.other',
});
