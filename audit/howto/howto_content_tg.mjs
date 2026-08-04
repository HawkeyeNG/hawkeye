// Inline-Telegram-command how-to clips. Same spec shape as howto_content.mjs
// CLIPS (slug/title/kicker/steps[{cap,vo?,screen}]) so build_howto_hf.mjs renders
// them unchanged; the only wiring is CLIPS_TG + TG_CSS merged in there.
//
// Screens mix REAL app screens (reused builders from howto_content.mjs, for the
// in-app bookends) and Telegram-chat screens (tg_components.mjs). Copy is taken
// verbatim from the live bot (backend/src/services/bot.js + routes/telegram.js);
// parties stay placeholder per the nonpartisan rule where they ever appear.
import { scr, h1, lede, card, label, input, btn, otp, ok } from './howto_content.mjs';
import { tgScreen, botMsg, userMsg, TG_CSS } from './tg_components.mjs';

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
    slug: 'otp-telegram',
    title: 'How to Get Your Code',
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
