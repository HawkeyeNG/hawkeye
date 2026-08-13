// "Install Hawkeye without the Play Store" — Android/Chrome sibling of
// howto_content_ios.mjs. Same CLIPS spec shape, so build_howto_hf.mjs renders it
// unchanged; the only wiring is CLIPS_ANDROID + ANDROID_CSS merged in there.
//
// Deliberately titled the same way as the iOS clip so the two read as a set, and
// it stays true once the Play listing is approved — the PWA is a second route,
// not a replacement.
import { androidScreen, hawkeyePageA, chromeMenu, installDialog, androidHome, ANDROID_CSS }
  from './android_components.mjs';

export { ANDROID_CSS };

export const CLIPS_ANDROID = [
  {
    slug: 'install-android',
    title: 'How to install Hawkeye without the Play Store',
    kicker: 'ANDROID · CHROME',
    steps: [
      {
        cap: 'Open hawkeye.com.ng in the Chrome browser.',
        vo: 'Open hawkeye dot com dot N G in the Chrome browser.',
        screen: androidScreen(hawkeyePageA()),
      },
      {
        // On Android the control is top-RIGHT, the opposite corner from the iOS
        // share button. Saying which corner is the whole value of this step.
        cap: 'Tap the three-dot menu, top right.',
        vo: 'Tap the three dot menu at the top right.',
        screen: androidScreen(hawkeyePageA(), { hi: 'menu' }),
      },
      {
        // Chrome labels this "Install app" when the site meets the install
        // criteria and "Add to Home screen" when it does not. Naming both means
        // nobody stalls looking for wording their phone is not showing.
        cap: 'Tap Add to Home screen — some phones say Install app.',
        vo: 'Tap Add to Home screen. Some phones say Install app instead.',
        screen: androidScreen(hawkeyePageA()) + chromeMenu(),
      },
      {
        cap: 'Tap Install to confirm.',
        vo: 'Tap Install to confirm.',
        screen: androidScreen(hawkeyePageA()) + installDialog(),
      },
      {
        cap: 'Done. It opens full screen, works offline, and can alert you.',
        vo: 'Done. It opens full screen, works offline, and can send you alerts.',
        screen: androidHome(),
      },
    ],
  },
];
