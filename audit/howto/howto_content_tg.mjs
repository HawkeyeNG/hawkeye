// Inline-Telegram-command how-to clips. Same spec shape as howto_content.mjs
// CLIPS (slug/title/kicker/steps[{cap,vo?,screen}]) so build_howto_hf.mjs renders
// them unchanged; the only wiring is CLIPS_TG + TG_CSS merged in there.
//
// Screens mix REAL app screens (reused builders from howto_content.mjs, for the
// in-app bookends) and Telegram-chat screens (tg_components.mjs). Copy is taken
// verbatim from the live bot (backend/src/services/bot.js + routes/telegram.js);
// parties stay placeholder per the nonpartisan rule where they ever appear.
import { scr, h1, lede, card, label, input, btn, otp, ok, cam } from './howto_content.mjs';
import { tgScreen, botMsg, userMsg, cmd, botMsgKb, TG_CSS } from './tg_components.mjs';

export { TG_CSS };

// Delivery-channel picker as the app now shows it: Telegram (free) selected,
// WhatsApp the alternative. Inline-styled so it needs no new PHONE_CSS.
const channelPick = () => `<div style="display:flex;gap:14px">
    <div style="flex:1;border:3px solid #008751;background:#e8f5ee;border-radius:14px;padding:20px 8px;text-align:center;font-size:25px;font-weight:800;color:#0a6b40">Telegram<div style="font-size:19px;font-weight:600;color:#5b6b62;margin-top:2px">free</div></div>
    <div style="flex:1;border:2px solid #b9c4bd;border-radius:14px;padding:20px 8px;text-align:center;font-size:25px;font-weight:700;color:#8a978f">WhatsApp</div>
  </div>`;

// The bot's real welcome line (routes/telegram.js step 2).
const WELCOME = 'Welcome to Hawkeye. Tap the button below to share your phone number — this confirms the number you entered in the app is really yours.';

export const CLIPS_TG = [
  {
    slug: 'report-telegram',
    // Says the command out loud. Someone scrolling needs to know this is the
    // thing they will actually do on election day, not a features tour.
    title: 'How to report a result from Telegram',
    kicker: 'ONE COMMAND · /REPORT',
    steps: [
      {
        cap: 'Send /report in the Hawkeye chat. Pick your saved unit, or browse.',
        vo: 'Send slash report, then pick your saved unit.',
        screen: tgScreen(
          cmd('/report', '09:14')
          + botMsgKb(
            '📋 Report a polling-unit result.<br><br>Which unit? Tap <b>Browse</b> to pick it '
            + 'from a list, or send its <b>PU code</b> (e.g. <code>25-01-05-012</code>) — '
            + '/mapunit shows yours if unsure.<br><br>Your saved unit:',
            [[{ text: '⭐ Ward 5 Primary School' }], [{ text: '🔎 Browse by state → unit' }]],
            '09:14'),
        ),
      },
      {
        // The standalone "Which election?" keyboard screen used to live here as
        // its own step. It was cut to shorten the clip (the renderer dies on this
        // box past ~1150 frames, and length is driven straight off the voiceover),
        // so the unit confirmation and the election both fold into this bot
        // message instead — same information, one screen fewer.
        cap: 'Confirm the unit and election, then type the votes — one party per line.',
        vo: 'Confirm the unit and election, then type the votes. One party per line.',
        screen: tgScreen(
          botMsg('Unit: <b>Ward 5 Primary School</b> · Governorship.<br>'
            + 'Now send the votes — one party per line or comma-separated, e.g.<br>'
            + '<code>APC 341<br>PDP 220<br>LP 190</code>', '09:15')
          + userMsg('<code>APC 341<br>PDP 220<br>LP 190</code>', '09:16'),
          { typed: 'APC 341' },
        ),
      },
      {
        cap: 'Check the read-back. If a figure is wrong, this is where you catch it.',
        vo: 'Check the read-back. Catch a wrong figure here.',
        screen: tgScreen(
          botMsgKb(
            '✅ <b>Ward 5 Primary School (25-01-05-012)</b><br>Governorship<br>'
            + 'APC — 341<br>PDP — 220<br>LP — 190<br><br>'
            + 'Last step — open the camera to photograph the result sheet. Photos are captured '
            + '<b>live</b> and signed on your phone; that is what makes the report trustworthy.',
            [[{ text: '📸 Open camera', kind: 'app' }]],
            '09:16'),
        ),
      },
      {
        cap: 'The camera opens. Photograph the sheet — it is signed on your phone as you shoot.',
        vo: 'Photograph the sheet. It is signed on your phone as you shoot.',
        screen: scr('Report a result',
          h1('Photograph the sheet')
          + lede('Live capture only — gallery uploads are rejected.')
          + card(
            cam('EC8A') + btn('Capture'),
          )),
      },
      {
        cap: 'Submitted. Your report is on the public ledger within seconds.',
        vo: 'Submitted. It is on the public ledger within seconds.',
        screen: scr('Submitted',
          ok('Result recorded', 'Ward 5 Primary School · Governorship')
          + card('<div class="ph-fine">Signed with your key and chained to the entry before it. '
            + 'Nobody — including us — can alter it without breaking the chain.</div>'),
        ),
      },
    ],
  },
  {
    slug: 'otp-telegram',
    // Says OTP and Telegram outright. "Get Your Code" told a scrolling viewer
    // neither what the thing is called in the app nor where it turns up, and
    // this title is BOTH the on-screen card and the intro voiceover line
    // (build_howto_hf.mjs derives the VO intro from it), so it has one job.
    title: 'How to get your OTP from Telegram',
    kicker: 'YOUR CODE ARRIVES ON TELEGRAM',
    steps: [
      {
        cap: 'In Hawkeye, enter your number and pick Telegram — codes are free.',
        vo: 'In Hawkeye, enter your number and pick Telegram. Codes are free.',
        screen: scr('Register your device',
          h1('Get your code')
          + lede('One verified number is one observer identity.')
          + card(
            label('Nigerian mobile number')
            + input('e.g. 0803 123 4567', '0803 123 4567')
            + label('Where should we send it?')
            + channelPick()
            + btn('Request OTP'),
          )),
      },
      {
        cap: 'Telegram opens. Hawkeye asks you to confirm the number is yours.',
        screen: tgScreen(botMsg(WELCOME, '9:41'), { reply: '✅ Share my phone number' }),
      },
      {
        cap: 'Tap “Share my phone number” — this is what unlocks your code.',
        vo: 'Tap Share my phone number. This is the step that unlocks your code.',
        screen: tgScreen(botMsg(WELCOME, '9:41'), { reply: '✅ Share my phone number', sheet: true }),
      },
      {
        cap: 'Your one-time code arrives right here in Telegram.',
        screen: tgScreen(
          botMsg('Tap the button below to share your phone number — this confirms the number is really yours.', '9:41')
          + userMsg('👤 My contact · +234 803 123 4567', '9:41')
          + botMsg('Hawkeye code: <b>492715</b>. Never share it. You can return to the app now — future codes will arrive here automatically.', '9:41'),
          {}),
      },
      {
        cap: 'Type that code back into Hawkeye.',
        screen: scr('Verify',
          h1('Enter your code')
          + lede('We sent a 6-digit code to your Telegram.')
          + card(otp('4 9 2 7 1 5') + btn('Verify & continue'))),
      },
      {
        cap: 'Verified. From now on, codes arrive on Telegram automatically.',
        vo: 'Verified. From now on, your codes arrive on Telegram automatically.',
        screen: scr('Verified',
          ok('Device verified', 'You can now report from this phone.')
          + card('<div class="ph-fine">Future codes arrive on your Telegram automatically — no need to share your contact again.</div>')),
      },
    ],
  },
];
