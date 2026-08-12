// "Add Hawkeye to your iPhone Home Screen" how-to. Same spec shape as
// howto_content.mjs CLIPS (slug/title/kicker/steps[{cap,vo?,screen}]) so
// build_howto_hf.mjs renders it unchanged; the only wiring is CLIPS_IOS +
// IOS_CSS merged in there.
//
// Safari-only is stated out loud in step one on purpose. Since iOS 16.4 other
// browsers can technically add to the Home Screen, but the reliable, universal
// route on every iPhone and iPad is Safari's own share sheet, and a viewer who
// tries it in Chrome and fails will not try twice.
import { iosScreen, hawkeyePage, shareSheet, addSheet, homeScreen, IOS_CSS } from './ios_components.mjs';

export { IOS_CSS };

export const CLIPS_IOS = [
  {
    slug: 'install-ios',
    // "Install" is the outcome people understand; "web app" is jargon and "add
    // to Home Screen" is the mechanic, which belongs in the steps (where it has
    // to match Apple's own wording exactly, because that is the phrase the
    // viewer is hunting for in the share sheet). "Without the App Store" also
    // pre-empts the first thing an iPhone user asks, and stays accurate once
    // the real App Store listing goes live.
    //
    // Leading with "How to" matters mechanically too: the intro voiceover is
    // literally `${title}.`, and an earlier title beginning with "Add" made that
    // the first word Abeo spoke, where it came out flat and un-Nigerian.
    title: 'How to install Hawkeye without the App Store',
    kicker: 'IPHONE & IPAD · SAFARI',
    steps: [
      {
        cap: 'Open hawkeye.com.ng in Safari. It has to be Safari — on iPhone and iPad.',
        // "Safari" alone, twice, sat oddly in the read. Naming it as "the Safari
        // browser" gives the voice a noun phrase to carry the stress, and the
        // second mention is rephrased rather than repeated.
        vo: 'Open hawkeye dot com dot N G in the Safari browser. No other browser will work.',
        screen: iosScreen(hawkeyePage()),
      },
      {
        // The single hardest instruction to give in words, which is why the clip
        // exists at all: the control has no label, and it sits in a different
        // place on iPad. Both facts are said once, plainly.
        cap: 'Tap Share — the box with an arrow. Bottom bar on iPhone, top right on iPad.',
        vo: 'Tap the share button. The box with an arrow coming out of it.',
        screen: iosScreen(hawkeyePage(), { hi: 'share' }),
      },
      {
        cap: 'Scroll down the share sheet and tap Add to Home Screen.',
        vo: 'Scroll down, then tap Add to Home Screen.',
        screen: iosScreen(hawkeyePage()) + shareSheet(),
      },
      {
        cap: 'Rename it if you like, then tap Add.',
        // "…tap Add." puts a bare capitalised word at the end of the sentence,
        // and en-NG-AbeoNeural clips it into something that does not sound like
        // the rest of the read. Giving it a noun to lean on fixes the delivery
        // without changing the instruction.
        vo: 'Rename it if you like, then tap the Add button.',
        screen: iosScreen(hawkeyePage()) + addSheet(),
      },
      {
        // The payoff has to be a reason, not just a confirmation: an installed
        // PWA is also the only way iOS delivers web push, and the offline
        // register is the thing that matters on a bad election-day network.
        cap: 'Done. It opens full screen, works offline, and can alert you.',
        vo: 'Done. It opens full screen, works offline, and can send you alerts.',
        screen: homeScreen(),
      },
    ],
  },
];
