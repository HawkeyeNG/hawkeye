import { Platform, Share } from 'react-native';

/**
 * SHARE HAWKEYE — the app's half of app/share.js.
 *
 * An election tool spreads by one person handing it to another. React Native's
 * own Share opens the OS sheet, which is every messenger the phone knows about —
 * WhatsApp, Instagram, Telegram, X, Facebook, iMessage — with no list for us to
 * keep in step with what people actually use.
 *
 * No dependency: `Share` is in react-native itself. expo-sharing exists but is
 * for FILES (it wraps UIActivityViewController around a local path) and cannot
 * send text and a link, which is the whole payload here.
 */

/**
 * Where a shared link lands: a page with the store badges and the routes for a
 * phone with neither store (backend/src/server.js serves it at /download).
 *
 * An ADDRESS, not a filename — it is typed from memory and read aloud, and it
 * does not change when the page behind it does.
 */
export const SHARE_LINK = 'https://hawkeye.com.ng/download';

/**
 * WHAT GETS SENT. One sentence, no exclamation, no "download now".
 *
 * This arrives in someone's WhatsApp from a person they know, about an election.
 * It says what Hawkeye is and what it is for; anything that reads like an advert
 * is the fastest way to have it forwarded as spam — and on a subject where
 * Hawkeye's whole claim is that it is not campaigning for anyone, tone is not
 * decoration.
 *
 * WORD FOR WORD the same as app/share.js. Two clients sending different
 * descriptions of the same product into the same group chat is the kind of
 * inconsistency that reads as impersonation.
 */
export const SHARE_TEXT =
  'Hawkeye lets Nigerians watch an election from their own polling unit ' +
  "and check the results against INEC's own sheets. It is free and independent.";

/**
 * Open the OS share sheet.
 *
 * THE TWO PLATFORMS TAKE THE LINK DIFFERENTLY, and getting it wrong sends it
 * twice.
 *
 * iOS builds the share payload as a LIST of activity items — RN's
 * RCTActionSheetManager.mm does `[items addObject:message]` and then
 * `[items addObject:URL]`, with no de-duplication in React Native or in
 * UIActivityViewController. Every activity that renders text and URL together
 * (WhatsApp, Telegram, Messages, Mail) would therefore print the address once
 * from the sentence and again from the url. So on iOS the sentence stays clean
 * and the link travels as its own item.
 *
 * Android has no such list: its share intent carries ONE text extra and ignores
 * `url` outright, so the link has to be inside `message` or the recipient gets a
 * sentence about an app with no way to get the app.
 *
 * An earlier version of this comment claimed iOS de-duplicates. It does not —
 * checked against react-native 0.86's own source, not assumed. Do not "simplify"
 * this back into one object.
 *
 * `dialogTitle` is Android-only and inert on iOS; it is passed unconditionally
 * because that is the whole of its platform story.
 *
 * Never throws: a sheet the reader dismissed is not an error, and there is
 * nothing to tell them about it.
 */
export async function shareHawkeye(): Promise<void> {
  try {
    await Share.share(
      Platform.OS === 'ios'
        ? { message: SHARE_TEXT, url: SHARE_LINK, title: 'Hawkeye' }
        : { message: `${SHARE_TEXT} ${SHARE_LINK}`, title: 'Hawkeye' },
      { dialogTitle: 'Share Hawkeye' },
    );
  } catch {
    /* dismissed, or no sheet available */
  }
}
