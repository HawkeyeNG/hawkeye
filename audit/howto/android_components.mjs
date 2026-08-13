// Reusable Chrome-on-Android UI for the "install without the Play Store" how-to.
// Same contract as ios_components.mjs: renders INSIDE the 560x1064 .phone frame
// from howto_content.mjs PHONE_CSS, so an androidScreen() drops in wherever an
// app scr() or an iosScreen() would.
//
// Android's chrome differs from iOS in the ways that matter for the teaching:
// the omnibox is at the TOP, the menu is a ⋮ popup anchored top-right rather
// than a bottom sheet, and the confirm is a centred Material dialog, not a
// slide-up. Getting those wrong would send viewers hunting in the wrong corner.
import { esc } from './howto_content.mjs';

export const andStatus = (time = '09:41', dark = false) =>
  `<div class="and-status${dark ? ' dk' : ''}"><span>${esc(time)}</span>
     <span class="and-stat-r">▮▮ <span class="and-wifi">WiFi</span> <span class="and-batt"></span></span>
   </div>`;

// Top toolbar: tab count, omnibox pill, ⋮ overflow. `hi` highlights the ⋮.
export const chromeBar = (site = 'hawkeye.com.ng', hi = '') =>
  `<div class="and-bar">
     <span class="and-tabs">3</span>
     <div class="and-omni">🔒 ${esc(site)}</div>
     <span class="and-dots${hi === 'menu' ? ' hi' : ''}">⋮</span>
   </div>`;

// The page behind the chrome — recognisable, not a pixel copy of the site.
export const hawkeyePageA = () =>
  `<div class="and-page">
     <div class="and-pg-hd"><img src="assets/logo.svg" alt=""><b>HAWKEYE</b></div>
     <div class="and-pg-h1">Report what you see at your polling unit</div>
     <div class="and-pg-p">Independent election monitoring. Every report published
       to a public record anyone can check.</div>
     <div class="and-pg-btn">Get started</div>
     <div class="and-pg-card"></div>
     <div class="and-pg-card short"></div>
   </div>`;

export const androidScreen = (body, o = {}) =>
  `<div class="and-screen">
     ${andStatus(o.time)}
     ${chromeBar(o.site, o.hi)}
     <div class="and-content">${body}</div>
     <div class="and-nav"><span>◁</span><span>○</span><span>□</span></div>
   </div>`;

// ⋮ overflow popup, anchored under the button. `hi` marks a row by label.
const MENU_ROWS = [
  ['New tab', ''],
  ['History', ''],
  ['Downloads', ''],
  ['Bookmarks', ''],
  ['Add to Home screen', '⊞'],
  ['Desktop site', ''],
  ['Settings', ''],
];
export const chromeMenu = (hi = 'Add to Home screen') =>
  `<div class="and-menu-scrim"><div class="and-menu">
     ${MENU_ROWS.map(([label, ic]) =>
       `<div class="and-mrow${label === hi ? ' hi' : ''}">${esc(label)}${ic ? `<span class="and-mic">${ic}</span>` : ''}</div>`).join('')}
   </div></div>`;

// Material confirm dialog. Chrome labels this "Install" when the site meets the
// PWA criteria and "Add" when it does not, so the copy says both once.
export const installDialog = (name = 'Hawkeye', site = 'hawkeye.com.ng') =>
  `<div class="and-dlg-scrim"><div class="and-dlg">
     <div class="and-dlg-hd"><img src="assets/logo.svg" alt="">
       <div><b>${esc(name)}</b><span>${esc(site)}</span></div></div>
     <div class="and-dlg-b">This site can be installed. It will open in its own
       window and work offline.</div>
     <div class="and-dlg-acts"><span class="and-cancel">Cancel</span>
       <span class="and-install">Install</span></div>
   </div></div>`;

export const androidHome = (hi = true) =>
  `<div class="and-home">
     ${andStatus('09:41', true)}
     <div class="and-grid">
       ${[['Phone', '📞'], ['Chrome', '🌐'], ['Messages', '💬'], ['Camera', '📷'],
          ['Photos', '🌇'], ['Maps', '🗺'], ['Clock', '⏰'], ['Play Store', '▶']]
         .map(([n, g]) => `<div class="and-ic"><div class="and-ic-t"><i>${g}</i></div><span>${esc(n)}</span></div>`).join('')}
       <div class="and-ic${hi ? ' hi' : ''}">
         <div class="and-ic-t hawk"><img src="assets/logo.svg" alt=""></div><span>Hawkeye</span>
       </div>
     </div>
     <div class="and-dock"></div>
     <div class="and-nav dark"><span>◁</span><span>○</span><span>□</span></div>
   </div>`;

export const ANDROID_CSS = `
  .and-screen{position:absolute;inset:0;display:flex;flex-direction:column;background:#fff;color:#202124}
  .and-status{flex:none;display:flex;align-items:center;justify-content:space-between;
    padding:26px 26px 8px;font-size:21px;font-weight:600;color:#202124}
  .and-status.dk{color:#fff}
  .and-stat-r{font-size:18px;display:flex;align-items:center;gap:8px}
  .and-batt{display:inline-block;width:30px;height:16px;border:2px solid currentColor;border-radius:3px;position:relative;opacity:.9}
  .and-batt:after{content:'';position:absolute;inset:2px;background:currentColor;border-radius:1px}
  .and-bar{flex:none;display:flex;align-items:center;gap:14px;padding:10px 20px 14px;background:#f1f3f4}
  .and-tabs{border:2px solid #5f6368;border-radius:5px;font-size:19px;font-weight:700;
    color:#5f6368;width:32px;height:32px;display:flex;align-items:center;justify-content:center;flex:none}
  .and-omni{flex:1;background:#fff;border-radius:999px;padding:14px 22px;font-size:24px;color:#202124;
    box-shadow:0 1px 3px rgba(0,0,0,.16);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .and-dots{font-size:34px;color:#5f6368;padding:2px 10px;border-radius:999px;flex:none;line-height:1}
  .and-dots.hi{background:#1a73e8;color:#fff;box-shadow:0 0 0 8px rgba(26,115,232,.25)}
  .and-content{flex:1;overflow:hidden;background:#fff}
  .and-page{padding:22px 26px;display:flex;flex-direction:column;gap:16px}
  .and-pg-hd{display:flex;align-items:center;gap:12px;background:#00331e;margin:-22px -26px 8px;padding:20px 26px}
  .and-pg-hd img{width:44px;height:44px}
  .and-pg-hd b{color:#fff;font-size:30px;letter-spacing:2px}
  .and-pg-h1{font-size:40px;font-weight:800;line-height:1.15;letter-spacing:-.5px}
  .and-pg-p{font-size:24px;line-height:1.45;color:#4a5651}
  .and-pg-btn{align-self:flex-start;background:#0a5c39;color:#fff;font-size:25px;font-weight:700;
    padding:18px 34px;border-radius:14px}
  .and-pg-card{height:120px;background:#eef3f0;border-radius:16px}
  .and-pg-card.short{height:72px}
  .and-nav{flex:none;display:flex;align-items:center;justify-content:space-around;
    background:#f1f3f4;padding:16px 60px 20px;font-size:26px;color:#5f6368}
  .and-nav.dark{background:transparent;color:rgba(255,255,255,.85)}
  /* ⋮ popup: anchored top-right, the way Chrome actually drops it */
  .and-menu-scrim{position:absolute;inset:0;background:rgba(0,0,0,.28);color:#202124}
  .and-menu{position:absolute;top:96px;right:18px;width:74%;background:#fff;border-radius:12px;
    padding:10px 0;box-shadow:0 6px 26px rgba(0,0,0,.3)}
  .and-mrow{display:flex;align-items:center;justify-content:space-between;padding:22px 26px;font-size:26px}
  .and-mrow.hi{background:#1a73e8;color:#fff;box-shadow:0 0 0 5px rgba(26,115,232,.3)}
  .and-mic{font-size:26px}
  /* centred Material confirm */
  .and-dlg-scrim{position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;
    align-items:center;justify-content:center;padding:0 34px;color:#202124}
  .and-dlg{width:100%;background:#fff;border-radius:26px;padding:32px 30px 22px}
  .and-dlg-hd{display:flex;align-items:center;gap:18px;margin-bottom:18px}
  .and-dlg-hd img{width:70px;height:70px;border-radius:16px;background:#00331e;padding:7px}
  .and-dlg-hd b{display:block;font-size:29px}
  .and-dlg-hd span{font-size:21px;color:#5f6368}
  .and-dlg-b{font-size:24px;line-height:1.45;color:#3c4043}
  .and-dlg-acts{display:flex;justify-content:flex-end;gap:26px;margin-top:26px;
    font-size:26px;font-weight:700;color:#1a73e8}
  .and-install{background:rgba(26,115,232,.14);padding:10px 26px;border-radius:11px;
    box-shadow:0 0 0 5px rgba(26,115,232,.22)}
  /* launcher */
  .and-home{position:absolute;inset:0;display:flex;flex-direction:column;
    background:linear-gradient(160deg,#10352a 0%,#0a2018 45%,#14384f 100%)}
  .and-grid{flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:30px 18px;padding:34px 26px;align-content:start}
  .and-ic{text-align:center}
  .and-ic-t{height:96px;border-radius:26px;background:rgba(255,255,255,.16);margin-bottom:9px;
    display:flex;align-items:center;justify-content:center}
  .and-ic-t i{font-style:normal;font-size:46px;line-height:1}
  .and-ic-t.hawk{background:#00331e}
  .and-ic-t.hawk img{width:64px;height:64px}
  .and-ic span{font-size:18px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
  .and-ic.hi .and-ic-t{box-shadow:0 0 0 6px rgba(255,255,255,.9),0 0 34px rgba(255,255,255,.55)}
  .and-dock{flex:none;height:120px;margin:0 20px 14px;border-radius:32px;background:rgba(255,255,255,.18)}
`;
