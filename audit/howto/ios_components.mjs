// Reusable iOS-Safari UI for the "add to Home Screen" how-to. Renders INSIDE
// the same 560x1064 .phone frame the app how-tos use (howto_content.mjs
// PHONE_CSS provides .phone / .phone-notch), so an iosScreen() drops in wherever
// an app scr() or a tgScreen() would and build_howto_hf.mjs needs no new wiring
// beyond merging IOS_CSS.
//
// The look is deliberately real-iOS — status bar, the URL pill, the bottom
// toolbar, the share sheet, the springboard grid — because the whole teaching
// point is "find THIS button on YOUR screen". A stylised approximation would
// defeat it.
//
// Every string is CONTENT: copy is authored per-clip in howto_content_ios.mjs
// and passed in. All dynamic text must go through esc().
import { esc } from './howto_content.mjs';

// ── status bar ───────────────────────────────────────────────────────────────
export const iosStatus = (time = '09:41', dark = false) =>
  `<div class="ios-status${dark ? ' dk' : ''}"><span>${esc(time)}</span>
     <span class="ios-stat-r">▮▮▮ <span class="ios-wifi">WiFi</span> <span class="ios-batt"></span></span>
   </div>`;

// ── Safari chrome ────────────────────────────────────────────────────────────
// The URL pill. `site` is shown the way Safari shows it: host only, no scheme.
export const urlBar = (site = 'hawkeye.com.ng') =>
  `<div class="ios-urlbar"><span class="ios-aa">AA</span>
     <span class="ios-url">🔒 ${esc(site)}</span>
     <span class="ios-reload">⟳</span></div>`;

// Bottom toolbar. `hi` highlights one control — 'share' is the one this clip
// needs the viewer to actually find.
export const safariBar = (hi = '') =>
  `<div class="ios-bar">
     <span class="ios-bi dim">‹</span>
     <span class="ios-bi dim">›</span>
     <span class="ios-bi${hi === 'share' ? ' hi' : ''}">⬆<span class="ios-share-box"></span></span>
     <span class="ios-bi">📖</span>
     <span class="ios-bi">⧉</span>
   </div>`;

// A minimal, recognisable Hawkeye page to sit behind the chrome. Not the real
// site — just enough that the viewer knows which page they should be on.
export const hawkeyePage = () =>
  `<div class="ios-page">
     <div class="ios-pg-hd"><img src="assets/logo.svg" alt=""><b>HAWKEYE</b></div>
     <div class="ios-pg-h1">Report what you see at your polling unit</div>
     <div class="ios-pg-p">Independent election monitoring. Every report published
       to a public record anyone can check.</div>
     <div class="ios-pg-btn">Get started</div>
     <div class="ios-pg-card"></div>
     <div class="ios-pg-card short"></div>
   </div>`;

// Safari screen assembler: status bar + page + URL bar + toolbar.
export const iosScreen = (body, o = {}) =>
  `<div class="ios-screen">
     ${iosStatus(o.time)}
     <div class="ios-content">${body}</div>
     ${urlBar(o.site)}
     ${safariBar(o.hi)}
   </div>`;

// ── share sheet ──────────────────────────────────────────────────────────────
// Rows are [icon, label]. `hi` marks the row to highlight by label match.
const SHEET_ROWS = [
  ['⧉', 'Copy'],
  ['👓', 'Add to Reading List'],
  ['📖', 'Add Bookmark'],
  ['⊞', 'Add to Home Screen'],
  ['🖊', 'Markup'],
  ['🖨', 'Print'],
];
export const shareSheet = (hi = 'Add to Home Screen', site = 'hawkeye.com.ng') =>
  `<div class="ios-sheet-scrim"><div class="ios-sheet">
     <div class="ios-grab"></div>
     <div class="ios-sheet-hd">
       <img src="assets/logo.svg" alt="">
       <div><b>Hawkeye</b><span>${esc(site)}</span></div>
       <span class="ios-opts">Options ›</span>
     </div>
     <div class="ios-appsrow">
       <span class="ios-app">AirDrop</span><span class="ios-app">Messages</span>
       <span class="ios-app">Mail</span><span class="ios-app">WhatsApp</span>
     </div>
     <div class="ios-rows">${SHEET_ROWS.map(([ic, label]) =>
       `<div class="ios-row${label === hi ? ' hi' : ''}">
          <span class="ios-rl">${esc(label)}</span><span class="ios-ri">${ic}</span>
        </div>`).join('')}
     </div>
   </div></div>`;

// ── the "Add to Home Screen" confirm dialog ─────────────────────────────────
export const addSheet = (name = 'Hawkeye', site = 'hawkeye.com.ng') =>
  `<div class="ios-sheet-scrim"><div class="ios-add">
     <div class="ios-add-hd"><span class="ios-cancel">Cancel</span>
       <b>Add to Home Screen</b><span class="ios-addbtn">Add</span></div>
     <div class="ios-add-body">
       <div class="ios-add-icon"><img src="assets/logo.svg" alt=""></div>
       <div class="ios-add-fields">
         <div class="ios-add-name">${esc(name)}<span class="ios-caret"></span></div>
         <div class="ios-add-url">${esc(site)}</div>
       </div>
     </div>
     <div class="ios-add-note">An icon will be added to your Home Screen so you can
       open this site like an app.</div>
   </div></div>`;

// ── springboard ──────────────────────────────────────────────────────────────
// `hi` highlights the Hawkeye icon — the payoff frame.
export const homeScreen = (hi = true) =>
  `<div class="ios-home">
     ${iosStatus('09:41', true)}
     <div class="ios-grid">
       ${/* Glyphs, not blank tiles. Empty rounded squares read as a broken
            render rather than as a neutral stand-in home screen. */
         [['Phone', '📞'], ['Safari', '🧭'], ['Messages', '💬'], ['Camera', '📷'],
          ['Photos', '🌇'], ['Maps', '🗺'], ['Clock', '⏰'], ['Notes', '📝']]
         .map(([n, g]) => `<div class="ios-ic"><div class="ios-ic-t"><i>${g}</i></div><span>${esc(n)}</span></div>`).join('')}
       <div class="ios-ic${hi ? ' hi' : ''}">
         <div class="ios-ic-t hawk"><img src="assets/logo.svg" alt=""></div><span>Hawkeye</span>
       </div>
     </div>
     <div class="ios-dock"></div>
   </div>`;

// Matched to PHONE_CSS's scale (560px phone, large type for the 0.78 downscale
// into the 1080-wide canvas).
export const IOS_CSS = `
  .ios-screen{position:absolute;inset:0;display:flex;flex-direction:column;background:#fff;color:#0b0b0c}
  .ios-status{flex:none;display:flex;align-items:center;justify-content:space-between;
    padding:44px 34px 8px;font-size:23px;font-weight:700;color:#0b0b0c}
  .ios-status.dk{color:#fff}
  .ios-stat-r{font-size:19px;letter-spacing:1px;display:flex;align-items:center;gap:8px}
  .ios-wifi{font-size:17px}
  .ios-batt{display:inline-block;width:34px;height:17px;border:2px solid currentColor;border-radius:5px;position:relative;opacity:.9}
  .ios-batt:after{content:'';position:absolute;inset:2px;background:currentColor;border-radius:2px}
  .ios-content{flex:1;overflow:hidden;background:#fff}
  .ios-page{padding:22px 26px;display:flex;flex-direction:column;gap:16px}
  .ios-pg-hd{display:flex;align-items:center;gap:12px;background:#00331e;margin:-22px -26px 8px;padding:20px 26px}
  .ios-pg-hd img{width:44px;height:44px}
  .ios-pg-hd b{color:#fff;font-size:30px;letter-spacing:2px}
  .ios-pg-h1{font-size:40px;font-weight:800;line-height:1.15;letter-spacing:-.5px}
  .ios-pg-p{font-size:24px;line-height:1.45;color:#4a5651}
  .ios-pg-btn{align-self:flex-start;background:#0a5c39;color:#fff;font-size:25px;font-weight:700;
    padding:18px 34px;border-radius:14px}
  .ios-pg-card{height:120px;background:#eef3f0;border-radius:16px}
  .ios-pg-card.short{height:72px}
  .ios-urlbar{flex:none;display:flex;align-items:center;gap:14px;padding:14px 22px;
    background:#f6f6f6;border-top:1px solid #dcdcdc}
  .ios-aa{font-size:22px;font-weight:700;color:#5b5b60}
  .ios-url{flex:1;text-align:center;font-size:25px;color:#0b0b0c}
  .ios-reload{font-size:26px;color:#5b5b60}
  .ios-bar{flex:none;display:flex;align-items:center;justify-content:space-around;
    background:#f6f6f6;padding:16px 20px calc(22px + env(safe-area-inset-bottom));border-top:1px solid #e2e2e2}
  .ios-bi{font-size:34px;color:#0a84ff;position:relative;padding:6px 14px;border-radius:12px}
  .ios-bi.dim{color:#b9bcc0}
  /* the share glyph: arrow already in the text, this is the open-topped box */
  .ios-share-box{position:absolute;left:50%;top:52%;transform:translateX(-50%);width:26px;height:20px;
    border:3px solid currentColor;border-top:none;border-radius:0 0 5px 5px}
  .ios-bi.hi{background:#0a84ff;color:#fff;box-shadow:0 0 0 8px rgba(10,132,255,.25)}
  /* sheets */
  /* The sheets are SIBLINGS of .ios-screen, not children — they overlay the
     whole phone. So they inherit the frame's light-on-dark colour, not the
     screen's, and every unhighlighted row rendered white on white. Set the
     colour explicitly here rather than relying on inheritance. */
  .ios-sheet-scrim{position:absolute;inset:0;background:rgba(0,0,0,.32);display:flex;align-items:flex-end;color:#0b0b0c}
  .ios-sheet{width:100%;background:#f2f2f5;border-radius:26px 26px 0 0;padding:12px 0 calc(18px + env(safe-area-inset-bottom))}
  .ios-grab{width:74px;height:7px;border-radius:4px;background:#c9ccd1;margin:2px auto 16px}
  .ios-sheet-hd{display:flex;align-items:center;gap:16px;padding:0 26px 18px}
  .ios-sheet-hd img{width:56px;height:56px;border-radius:12px;background:#00331e;padding:6px}
  .ios-sheet-hd b{display:block;font-size:27px}
  .ios-sheet-hd span{font-size:21px;color:#8a8f96}
  .ios-opts{margin-left:auto;color:#0a84ff;font-size:22px}
  .ios-appsrow{display:flex;gap:22px;padding:0 26px 20px;border-bottom:1px solid #e2e3e7}
  .ios-app{flex:1;text-align:center;font-size:18px;color:#3c3c43}
  .ios-app:before{content:'';display:block;height:66px;border-radius:50%;background:#dfe1e6;margin-bottom:8px}
  .ios-rows{background:#fff;margin:18px 16px 0;border-radius:16px;overflow:hidden}
  .ios-row{display:flex;align-items:center;justify-content:space-between;padding:24px 22px;
    font-size:26px;border-bottom:1px solid #ececf0}
  .ios-row:last-child{border-bottom:none}
  .ios-ri{font-size:27px;color:#3c3c43}
  .ios-row.hi{background:#0a84ff;color:#fff;box-shadow:0 0 0 5px rgba(10,132,255,.3)}
  .ios-row.hi .ios-ri{color:#fff}
  .ios-rl{font-weight:500}
  /* add-to-home dialog */
  .ios-add{width:100%;background:#f2f2f5;border-radius:26px 26px 0 0;padding-bottom:calc(24px + env(safe-area-inset-bottom))}
  .ios-add-hd{display:flex;align-items:center;justify-content:space-between;padding:26px 26px 20px;font-size:25px}
  .ios-add-hd b{font-size:27px}
  .ios-cancel{color:#0a84ff}
  .ios-addbtn{color:#0a84ff;font-weight:800;background:rgba(10,132,255,.14);padding:8px 20px;border-radius:11px;
    box-shadow:0 0 0 5px rgba(10,132,255,.22)}
  .ios-add-body{display:flex;align-items:center;gap:20px;background:#fff;margin:0 16px;padding:22px;border-radius:16px}
  .ios-add-icon img{width:76px;height:76px;border-radius:17px;background:#00331e;padding:8px}
  .ios-add-fields{flex:1;min-width:0}
  .ios-add-name{font-size:27px;font-weight:600;border-bottom:1px solid #e6e6ea;padding-bottom:10px}
  .ios-caret{display:inline-block;width:3px;height:26px;background:#0a84ff;margin-left:3px;vertical-align:-5px}
  .ios-add-url{font-size:22px;color:#8a8f96;padding-top:10px}
  .ios-add-note{font-size:21px;color:#6b7178;padding:18px 30px 0;line-height:1.4}
  /* springboard */
  .ios-home{position:absolute;inset:0;display:flex;flex-direction:column;
    background:linear-gradient(160deg,#0f3d2b 0%,#08251a 45%,#123a52 100%)}
  .ios-grid{flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:30px 18px;padding:34px 26px;align-content:start}
  .ios-ic{text-align:center}
  .ios-ic-t{height:98px;border-radius:22px;background:rgba(255,255,255,.16);margin-bottom:9px;
    display:flex;align-items:center;justify-content:center}
  .ios-ic-t i{font-style:normal;font-size:46px;line-height:1}
  .ios-ic-t.hawk{background:#00331e;display:flex;align-items:center;justify-content:center}
  .ios-ic-t.hawk img{width:66px;height:66px}
  .ios-ic span{font-size:18px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
  .ios-ic.hi .ios-ic-t{box-shadow:0 0 0 6px rgba(255,255,255,.9),0 0 34px rgba(255,255,255,.55)}
  .ios-dock{flex:none;height:130px;margin:0 20px calc(22px + env(safe-area-inset-bottom));
    border-radius:32px;background:rgba(255,255,255,.18)}
`;
