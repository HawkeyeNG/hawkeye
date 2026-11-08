/**
 * SEVERAL PHOTOS OF ONE SHEET, JOINED ON THE PHONE. Native twin of
 * app/sheet-parts.js — same box, same band, same order.
 *
 * The public photographs Form EC60(E), the result poster INEC pastes up at the
 * unit, and a poster can be too big for one readable photo or printed across
 * sheets (docs/private/EC60E-RESULT-POSTER.md). The observer shoots it in
 * parts, top first, and the parts are joined TOP TO BOTTOM into one JPEG before
 * anything is hashed or signed: the ledger still holds exactly one sheet photo,
 * and the report says how many parts it was (`sheetParts`, unsigned — it only
 * changes how the server reads the photo).
 *
 * THE BOX IS THE GPU READER'S BUDGET: 1500 px wide, an 8,192-token context, so
 * a join is shrunk (never cropped) to fit 1500 x 2250. THE BAND between parts
 * is on purpose: it says "joined here" to a reviewer and to the vision check,
 * which is told about it, so a join is never mistaken for a hidden edit.
 *
 * HOW, WITHOUT A NEW NATIVE MODULE. Nothing installed composites two images
 * (expo-image-manipulator crops, resizes and rotates; Skia and view-shot would
 * need a new store build). react-native-webview IS in every store build (the
 * support chat), and a canvas inside it is the very engine the Lite app joins
 * in. So components/sheet-joiner.tsx mounts a hidden WebView that runs
 * JOIN_HTML. On the web export (screenshots, tests) the page's own canvas does
 * it directly — joinInDocument below, the same steps.
 */
export const MAX_SHEET_PARTS = 3;      // backend MAX_SHEET_PARTS
export const JOIN_MAX_W = 1500;
export const JOIN_MAX_H = 2250;
export const JOIN_BAND = 16;
export const JOIN_BAND_COLOUR = '#111111';
export const JOIN_QUALITY = 0.76;      // the sheet's tuned upload quality

export type JoinLayout = { width: number; height: number; rows: { y: number; h: number }[] };

/** The joined layout for parts of these natural sizes, top first. */
export function joinLayout(sizes: { w: number; h: number }[]): JoinLayout {
  if (!sizes.length) throw new Error('no parts');
  const w = Math.min(JOIN_MAX_W, Math.max(...sizes.map((s) => s.w)));
  const hs = sizes.map((s) => (s.h * w) / s.w);
  const room = JOIN_MAX_H - JOIN_BAND * (sizes.length - 1);
  const k = Math.min(1, room / hs.reduce((a, b) => a + b, 0));
  const width = Math.max(1, Math.round(w * k));
  let y = 0;
  // DOWN, not to nearest: rounding each part up by half a pixel added up to a
  // join 1-2 px taller than the box (17 of 400 random part sets).
  const rows = hs.map((h) => {
    const r = { y, h: Math.max(1, Math.floor(h * k)) };
    y += r.h + JOIN_BAND;
    return r;
  });
  return { width, height: y - JOIN_BAND, rows };
}

/**
 * The page the hidden WebView runs. The layout is written out again in plain
 * ES5 because a Hermes build cannot stringify a compiled function;
 * tests/sheet_parts_native_test.mjs runs this copy against joinLayout() above
 * on many sizes, so the two cannot drift apart unnoticed.
 *
 * Protocol: RN posts {type:'join', id, parts:[dataUri...]}; the page answers
 * {id, ok:true, b64, width, height} or {id, ok:false, error}, and says
 * {type:'ready'} once it is listening.
 */
export const JOIN_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
var MAX_W=${JOIN_MAX_W},MAX_H=${JOIN_MAX_H},BAND=${JOIN_BAND},COLOUR='${JOIN_BAND_COLOUR}',Q=${JOIN_QUALITY};
function layout(sizes){
  var w=Math.min(MAX_W,Math.max.apply(null,sizes.map(function(s){return s.w;})));
  var hs=sizes.map(function(s){return s.h*w/s.w;});
  var room=MAX_H-BAND*(sizes.length-1);
  var k=Math.min(1,room/hs.reduce(function(a,b){return a+b;},0));
  var width=Math.max(1,Math.round(w*k));
  var y=0;
  var rows=hs.map(function(h){var r={y:y,h:Math.max(1,Math.floor(h*k))};y+=r.h+BAND;return r;});
  return {width:width,height:y-BAND,rows:rows};
}
function post(m){window.ReactNativeWebView.postMessage(JSON.stringify(m));}
function load(src){return new Promise(function(res,rej){var i=new Image();i.onload=function(){res(i);};i.onerror=function(){rej(new Error('part did not load'));};i.src=src;});}
function join(id,parts){
  Promise.all(parts.map(load)).then(function(imgs){
    var L=layout(imgs.map(function(i){return {w:i.naturalWidth,h:i.naturalHeight};}));
    var c=document.createElement('canvas');c.width=L.width;c.height=L.height;
    var g=c.getContext('2d');g.fillStyle=COLOUR;g.fillRect(0,0,L.width,L.height);
    imgs.forEach(function(im,n){g.drawImage(im,0,L.rows[n].y,L.width,L.rows[n].h);});
    var url=c.toDataURL('image/jpeg',Q);
    post({id:id,ok:true,b64:url.slice(url.indexOf(',')+1),width:L.width,height:L.height});
  }).catch(function(e){post({id:id,ok:false,error:String((e&&e.message)||e)});});
}
function onMsg(e){var m;try{m=JSON.parse(e.data);}catch(x){return;}if(m&&m.type==='join')join(m.id,m.parts);}
window.addEventListener('message',onMsg);document.addEventListener('message',onMsg);
post({type:'ready'});
</script></body></html>`;

/** The same join, on a page that has a DOM (the web export). Resolves to base64 JPEG. */
export async function joinInDocument(parts: string[]): Promise<{ b64: string; width: number; height: number }> {
  const doc = (globalThis as unknown as { document?: Document }).document;
  if (!doc) throw new Error('no document to join in');
  const imgs = await Promise.all(parts.map((src) => new Promise<HTMLImageElement>((res, rej) => {
    const i = new (globalThis as unknown as { Image: typeof Image }).Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('part did not load'));
    i.src = src;
  })));
  const L = joinLayout(imgs.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight })));
  const c = doc.createElement('canvas');
  c.width = L.width;
  c.height = L.height;
  const g = c.getContext('2d');
  if (!g) throw new Error('no canvas');
  g.fillStyle = JOIN_BAND_COLOUR;
  g.fillRect(0, 0, L.width, L.height);
  imgs.forEach((im, n) => g.drawImage(im, 0, L.rows[n].y, L.width, L.rows[n].h));
  const url = c.toDataURL('image/jpeg', JOIN_QUALITY);
  return { b64: url.slice(url.indexOf(',') + 1), width: L.width, height: L.height };
}

/** What a recognised part read becomes when several are joined: the FIRST part
 *  names the unit (its text and serial); counts are pooled, earlier parts first. */
export function mergeReads<R extends { text: string; numericLines: number; counts: Record<string, number>; serial?: string | null }>(
  reads: (R | null | undefined)[],
): R | null {
  const got = reads.filter((r): r is R => !!r);
  if (!got.length) return null;
  const counts: Record<string, number> = {};
  for (const r of got) for (const [code, n] of Object.entries(r.counts || {})) if (!(code in counts)) counts[code] = n;
  return {
    ...got[0],
    numericLines: got.reduce((a, r) => a + (r.numericLines || 0), 0),
    counts,
    serial: got.find((r) => r.serial)?.serial ?? got[0].serial ?? null,
  };
}
