import fs from "node:fs";
import crypto from "node:crypto";
const KEY = fs.readFileSync(process.env.ASC_KEY_PATH, "utf8");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const h = b64({ alg: "ES256", kid: process.env.ASC_KEY_ID, typ: "JWT" });
const p = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1" });
const sig = crypto.createSign("SHA256").update(h + "." + p).sign({ key: KEY, dsaEncoding: "ieee-p1363" }).toString("base64url");
const jwt = h + "." + p + "." + sig;
const api = async (x) => { const r = await fetch("https://api.appstoreconnect.apple.com" + x, { headers: { authorization: "Bearer " + jwt } }); const t = await r.text(); if (!r.ok) return { error: r.status }; return JSON.parse(t); };
for (const [bundle, want] of [["ng.com.hawkeye.observer", "1.0.2"], ["ng.com.hawkeye.lite", "1.3"]]) {
  const app = (await api("/v1/apps?filter[bundleId]=" + bundle)).data[0];
  const ver = (await api("/v1/apps/" + app.id + "/appStoreVersions?limit=20")).data.find((v) => v.attributes.versionString === want);
  if (!ver) { console.log(bundle + " " + want + ": NO RECORD"); continue; }
  console.log("\n== " + app.attributes.name + " " + want + " [" + ver.attributes.appStoreState + "]");
  const locs = (await api("/v1/appStoreVersions/" + ver.id + "/appStoreVersionLocalizations")).data;
  for (const l of locs) {
    const sets = (await api("/v1/appStoreVersionLocalizations/" + l.id + "/appScreenshotSets")).data || [];
    let shots = 0;
    for (const s of sets) shots += ((await api("/v1/appScreenshotSets/" + s.id + "/appScreenshots")).data || []).length;
    const a = l.attributes;
    console.log("   " + a.locale + ": screenshot sets=" + sets.length + " images=" + shots
      + " | description=" + (a.description ? a.description.length + " chars" : "EMPTY")
      + " | keywords=" + (a.keywords ? "set" : "EMPTY")
      + " | whatsNew=" + (a.whatsNew ? a.whatsNew.length + " chars" : "EMPTY"));
  }
  const rd = await api("/v1/appStoreVersions/" + ver.id + "/appStoreReviewDetail");
  console.log("   review detail: " + (rd.data ? "present" : "MISSING (contact info for App Review)"));
  const enc = await api("/v1/appStoreVersions/" + ver.id + "?fields[appStoreVersions]=usesIdfa");
  console.log("   idfa: " + JSON.stringify(enc.data?.attributes ?? {}));
}
