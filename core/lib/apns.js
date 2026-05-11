// apns.js — Apple Push Notification Service (Token-Based Auth, HTTP/2)
//
// Keine externen Dependencies — nutzt node:crypto + node:http2.
// JWT wird 45min gecached (APNs-Token valid 1h).
//
// Env-Vars:
//   APNS_KEY_PATH   — Pfad zur .p8-Datei (PKCS8 EC private key)
//   APNS_KEY_ID     — 10-stellige Key-ID aus Apple Developer Portal
//   APNS_TEAM_ID    — 10-stellige Team-ID aus Apple Developer Portal
//   APNS_BUNDLE_ID  — Bundle-ID der App (default: de.dedecke.jarvis)
//   APNS_ENV        — "production" | "development" (default: development)

import { createSign }   from "node:crypto";
import { readFileSync }  from "node:fs";
import http2             from "node:http2";

const KEY_PATH  = process.env.APNS_KEY_PATH;
const KEY_ID    = process.env.APNS_KEY_ID;
const TEAM_ID   = process.env.APNS_TEAM_ID;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "de.dedecke.jarvis";
const APNS_ENV  = process.env.APNS_ENV       || "development";

const APNS_HOST = APNS_ENV === "production"
  ? "api.push.apple.com"
  : "api.sandbox.push.apple.com";

let _keyPem = null;
function getKey() {
  if (!_keyPem) _keyPem = readFileSync(KEY_PATH, "utf8");
  return _keyPem;
}

// JWT caching — refresh nach 45min (APNs-Tokens sind 60min gültig)
let _jwt   = null;
let _jwtAt = 0;

function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (_jwt && (now - _jwtAt) < 45 * 60) return _jwt;

  const hdr = Buffer.from(JSON.stringify({ alg: "ES256", kid: KEY_ID })).toString("base64url");
  const pay = Buffer.from(JSON.stringify({ iss: TEAM_ID, iat: now })).toString("base64url");
  const msg = `${hdr}.${pay}`;

  const sign = createSign("SHA256");
  sign.update(msg);
  // APNs erwartet IEEE P-1363 Format (raw r||s), nicht DER
  const sig = sign.sign({ key: getKey(), dsaEncoding: "ieee-p1363" }).toString("base64url");

  _jwt   = `${msg}.${sig}`;
  _jwtAt = now;
  return _jwt;
}

export function isConfigured() {
  return !!(KEY_PATH && KEY_ID && TEAM_ID);
}

/**
 * Sendet eine Alert-Push-Notification an einen APNs Device-Token.
 * @param {string} deviceToken  Hex-kodierter APNs Device-Token
 * @param {string} title        Notification-Titel
 * @param {string} body         Notification-Text
 * @param {object} [extra]      Optionale zusätzliche aps-Keys oder Custom-Data
 */
export function send(deviceToken, title, body, extra = {}) {
  if (!isConfigured()) {
    return Promise.reject(new Error("APNs nicht konfiguriert (APNS_KEY_PATH/KEY_ID/TEAM_ID fehlen)"));
  }

  const jwt     = makeJwt();
  const payload = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: "default",
      ...extra,
    },
  });

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${APNS_HOST}`);
    client.on("error", (err) => { client.destroy(); reject(err); });

    const req = client.request({
      ":method":     "POST",
      ":path":       `/3/device/${deviceToken}`,
      ":scheme":     "https",
      ":authority":  APNS_HOST,
      "authorization":  `bearer ${jwt}`,
      "apns-topic":     BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority":  "10",
      "content-type":   "application/json",
    });

    req.write(payload);
    req.end();

    let status = 0;
    let resBody = "";

    req.on("response", (headers) => { status = Number(headers[":status"]); });
    req.on("data",     (chunk)   => { resBody += chunk; });
    req.on("end", () => {
      client.close();
      if (status === 200) {
        resolve({ ok: true });
      } else {
        const msg = resBody ? JSON.parse(resBody).reason || resBody : `HTTP ${status}`;
        reject(new Error(`APNs ${status}: ${msg}`));
      }
    });
    req.on("error", (err) => { client.destroy(); reject(err); });
  });
}
