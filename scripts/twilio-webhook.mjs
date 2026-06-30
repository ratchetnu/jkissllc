// Inspect / set the inbound-SMS webhook on the J KISS Twilio number.
// Reads creds from .env.production.local (never prints secrets).
//
//   node scripts/twilio-webhook.mjs                 # read-only: show current config
//   node scripts/twilio-webhook.mjs --set <url>     # set SmsUrl (run AFTER deploy)
//
// Production URL: https://www.jkissllc.com/api/webhooks/twilio/sms
import fs from 'node:fs'

function loadEnv(path) {
  const env = {}
  try {
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch (e) { console.error('Could not read', path, e.message) }
  return env
}

const env = loadEnv('.env.production.local')
const { TWILIO_ACCOUNT_SID: sid, TWILIO_API_KEY_SID: ks, TWILIO_API_KEY_SECRET: ksec, TWILIO_FROM: from } = env
if (!sid || !ks || !ksec || !from) { console.error('Missing Twilio env (ACCOUNT_SID / API_KEY_SID / API_KEY_SECRET / FROM)'); process.exit(1) }

const auth = 'Basic ' + Buffer.from(`${ks}:${ksec}`).toString('base64')
const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`

const res = await fetch(`${base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`, { headers: { Authorization: auth } })
if (!res.ok) { console.error('Twilio list failed', res.status, await res.text()); process.exit(1) }
const n = (await res.json()).incoming_phone_numbers?.[0]
if (!n) { console.error('No Twilio number matching', from); process.exit(1) }

console.log(`Number:  ${n.phone_number}  (SID ${n.sid})`)
console.log(`Current inbound SmsUrl:  ${n.sms_url || '(none)'}  [${n.sms_method || '-'}]`)

const i = process.argv.indexOf('--set')
if (i !== -1 && process.argv[i + 1]) {
  const url = process.argv[i + 1]
  const body = new URLSearchParams({ SmsUrl: url, SmsMethod: 'POST' })
  const up = await fetch(`${base}/IncomingPhoneNumbers/${n.sid}.json`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  if (!up.ok) { console.error('Set failed', up.status, await up.text()); process.exit(1) }
  console.log(`\n✅ Set inbound SmsUrl -> ${(await up.json()).sms_url}  [POST]`)
} else {
  console.log('\n(read-only — re-run with:  --set https://www.jkissllc.com/api/webhooks/twilio/sms  AFTER deploy)')
}
