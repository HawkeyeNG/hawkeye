// Reusable Telegram-chat UI for the inline-command how-to clips. These render
// INSIDE the same 560x1064 .phone frame the app how-tos use (howto_content.mjs
// PHONE_CSS provides .phone / .phone-notch); a tgScreen() drops in wherever an
// app scr() used to, so build_howto_hf.mjs needs no changes.
//
// The look is deliberately real-Telegram (blue header, wallpaper, incoming/
// outgoing bubbles, inline keyboards attached under a message, a bottom reply
// keyboard for request_contact) so a first-time observer recognises "this is
// happening inside Telegram", which is the whole teaching point.
//
// Every string is CONTENT — copy is authored per-clip in howto_content_tg.mjs
// and passed in. All dynamic text must be run through esc().
import { esc } from './howto_content.mjs';

// ── header: back arrow · avatar · name/sub · call+menu, Telegram accent bar ──
export const tgHeader = (name = 'Hawkeye', sub = 'bot') =>
  `<div class="tg-hd">
     <span class="tg-back">‹</span>
     <span class="tg-av"><img src="assets/logo.svg" alt=""></span>
     <div class="tg-hdt"><b>${esc(name)}</b><span>${esc(sub)}</span></div>
     <span class="tg-hdic">📞</span><span class="tg-hdic">⋮</span>
   </div>`;

// ── bubbles ──────────────────────────────────────────────────────────────────
// Bot (incoming, left, white). `html` may contain <b>/<code> like the real bot
// messages. time is the little timestamp in the corner.
export const botMsg = (html, time = '') =>
  `<div class="tg-row in"><div class="tg-b in">${html}${time ? `<span class="tg-t">${esc(time)}</span>` : ''}</div></div>`;
// User (outgoing, right, Telegram green-blue). Used for typed commands + shares.
export const userMsg = (html, time = '') =>
  `<div class="tg-row out"><div class="tg-b out">${html}${time ? `<span class="tg-t">${esc(time)} ✓✓</span>` : ''}</div></div>`;
// A typed slash command reads as an outgoing message.
export const cmd = (c, time = '') => userMsg(`<span class="tg-cmd">${esc(c)}</span>`, time);

// ── inline keyboard: buttons attached UNDER a bot message. Each row is an array
// of {text, kind?}. kind:'app' marks a Mini-App (web_app) button — same shape,
// a small ↗ so the handoff to the live camera/mapper reads as leaving the chat.
export const inlineKb = (rows) =>
  `<div class="tg-kb">${rows.map((row) =>
    `<div class="tg-kbrow">${row.map((b) =>
      `<button class="tg-kbbtn${b.kind === 'app' ? ' app' : ''}">${esc(b.text)}${b.kind === 'app' ? ' <span class="tg-ext">↗</span>' : ''}</button>`,
    ).join('')}</div>`).join('')}</div>`;

// A bot message that carries an inline keyboard directly beneath it (the common
// case: /collation, /mapunit, /ledger, /incident, the report handoff).
export const botMsgKb = (html, rows, time = '') => botMsg(html, time) + inlineKb(rows);

// ── bottom reply keyboard — request_contact lives here, NOT inline (Telegram
// only allows request_contact on the reply keyboard). Sits above the input bar.
export const replyKb = (label) =>
  `<div class="tg-rkb"><button class="tg-rkbbtn">${esc(label)}</button></div>`;

// ── message input bar (bottom chrome). Give it a hint like '/report' to show a
// half-typed command, or leave blank for the resting "Message" placeholder.
export const inputBar = (typed = '') =>
  `<div class="tg-input"><span class="tg-clip">📎</span>
     <div class="tg-field${typed ? ' typed' : ''}">${typed ? esc(typed) : 'Message'}</div>
     <span class="tg-mic">${typed ? '➤' : '🎤'}</span></div>`;

// "Hawkeye is typing…" — used before a chat-native answer (/ask, /results).
export const typing = () => `<div class="tg-typing">Hawkeye is typing…</div>`;

// The native "share your phone number" confirm sheet that pops when the reply
// keyboard's request_contact button is tapped — the exact moment the OTP clip
// must dwell on ("tap Share Contact to get the code").
export const shareContactSheet = (bot = 'Hawkeye') =>
  `<div class="tg-sheet-scrim"><div class="tg-sheet">
     <div class="tg-sheet-t">Share your phone number with <b>${esc(bot)}</b>?</div>
     <div class="tg-sheet-b">Your phone number will be sent to the bot.</div>
     <button class="tg-sheet-ok">Share my phone number</button>
     <button class="tg-sheet-no">Cancel</button>
   </div></div>`;

// ── screen assembler ────────────────────────────────────────────────────────
// Fills the .phone. Pass the chat body (bubbles/keyboards) + choose the bottom
// chrome: {reply:'…'} for a reply keyboard, {typed:'/x'} for a half-typed input,
// or nothing for the resting input. {sheet:true} overlays the share-contact
// confirm. Chat scrolls from the bottom (newest pinned low, like real Telegram).
export const tgScreen = (body, o = {}) =>
  `<div class="tg-screen">
     ${tgHeader(o.name, o.sub)}
     <div class="tg-chat"><div class="tg-chat-inner">${body}</div></div>
     ${o.reply ? replyKb(o.reply) : ''}
     ${inputBar(o.typed || '')}
     ${o.sheet ? shareContactSheet(o.name) : ''}
   </div>`;

// Matched to PHONE_CSS's scale (560px phone, large type for the 0.78 downscale
// into 1080-wide canvas). Telegram light theme + classic blue header.
export const TG_CSS = `
  .tg-screen{position:absolute;inset:0;display:flex;flex-direction:column;background:#cfdbe6;
    background-image:radial-gradient(circle at 20% 15%,rgba(255,255,255,.5) 0,transparent 40%),
      radial-gradient(circle at 80% 70%,rgba(255,255,255,.35) 0,transparent 45%);color:#0f1720}
  .tg-hd{background:#527da3;color:#fff;padding:52px 22px 18px;display:flex;align-items:center;gap:14px;flex:none}
  .tg-back{font-size:44px;line-height:.7;font-weight:400;margin-right:2px}
  .tg-av{width:56px;height:56px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;flex:none}
  .tg-av img{width:44px;height:44px;object-fit:contain}
  .tg-hdt{display:flex;flex-direction:column;min-width:0}
  .tg-hdt b{font-size:28px;font-weight:700;line-height:1.05}
  .tg-hdt span{font-size:19px;color:#cfe0f0;margin-top:2px}
  .tg-hdic{margin-left:auto;font-size:28px;opacity:.9}
  .tg-hdic+.tg-hdic{margin-left:20px}
  .tg-chat{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;padding:22px 22px 12px}
  .tg-chat-inner{display:flex;flex-direction:column;gap:16px}
  .tg-row{display:flex}
  .tg-row.in{justify-content:flex-start}
  .tg-row.out{justify-content:flex-end}
  .tg-b{max-width:82%;padding:18px 22px;font-size:25px;line-height:1.4;border-radius:22px;position:relative;box-shadow:0 1px 1px rgba(0,0,0,.12)}
  .tg-b.in{background:#fff;color:#0f1720;border-bottom-left-radius:7px}
  .tg-b.out{background:#e4f6d1;color:#0f1720;border-bottom-right-radius:7px}
  .tg-b b{font-weight:800}
  .tg-b code{font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:23px;background:#eef3ee;padding:2px 8px;border-radius:6px}
  .tg-t{display:block;text-align:right;font-size:17px;color:#8aa0af;margin-top:6px}
  .tg-b.out .tg-t{color:#67a86b}
  .tg-cmd{color:#2f7bd0;font-weight:700}
  .tg-kb{display:flex;flex-direction:column;gap:10px;margin-top:-4px}
  .tg-kbrow{display:flex;gap:10px}
  .tg-kbbtn{flex:1;background:rgba(255,255,255,.94);color:#2f7bd0;border:none;border-radius:16px;
    padding:22px 18px;font-size:24px;font-weight:600;text-align:center;box-shadow:0 1px 1px rgba(0,0,0,.1)}
  .tg-kbbtn.app{color:#1f8a4c;font-weight:800}
  .tg-ext{font-size:20px;opacity:.8}
  .tg-typing{font-size:22px;color:#5b7488;font-style:italic;padding:2px 6px}
  .tg-rkb{padding:12px 16px 6px;flex:none}
  .tg-rkbbtn{width:100%;background:#fff;color:#2f7bd0;border:none;border-radius:16px;padding:26px;font-size:27px;font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.14)}
  .tg-input{background:#fff;padding:18px 22px calc(18px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:16px;flex:none;border-top:1px solid #d5dde4}
  .tg-clip,.tg-mic{font-size:30px;color:#8aa0af;flex:none}
  .tg-field{flex:1;font-size:26px;color:#9aa7b0}
  .tg-field.typed{color:#0f1720}
  .tg-mic{color:#2f7bd0}
  /* native share-contact confirm sheet */
  .tg-sheet-scrim{position:absolute;inset:0;background:rgba(10,20,28,.45);display:flex;align-items:flex-end}
  .tg-sheet{width:100%;background:#fff;border-radius:26px 26px 0 0;padding:34px 28px calc(30px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:16px}
  .tg-sheet-t{font-size:28px;font-weight:700;text-align:center}
  .tg-sheet-b{font-size:22px;color:#5b7488;text-align:center;margin-bottom:6px}
  .tg-sheet-ok{background:#3390ec;color:#fff;border:none;border-radius:16px;padding:24px;font-size:27px;font-weight:800}
  .tg-sheet-no{background:#eef1f4;color:#2f7bd0;border:none;border-radius:16px;padding:24px;font-size:26px;font-weight:700}
`;
