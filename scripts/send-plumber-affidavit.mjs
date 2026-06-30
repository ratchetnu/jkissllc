// Sends the records-affidavit request to Classic Plumbing via Resend.
// Usage:  RESEND_API_KEY=re_xxx node scripts/send-plumber-affidavit.mjs
// (or put RESEND_API_KEY in the environment / a sourced .env first)
import { Resend } from 'resend';
import { readFileSync } from 'node:fs';

function keyFromEnvFile(p) {
  try {
    const line = readFileSync(p, 'utf8').split('\n').find(l => l.startsWith('RESEND_API_KEY='));
    return line ? line.slice('RESEND_API_KEY='.length).trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}
const KEY = process.env.RESEND_API_KEY
  || keyFromEnvFile('/Users/nunubabymuzik/jkissllc/.env.resend')   // jkissllc's own verified account (pull from Vercel)
  || keyFromEnvFile('/Users/nunubabymuzik/jkissllc/.env.local');
if (!KEY) { console.error('Missing RESEND_API_KEY for the jkissllc.com account. Aborting (nothing sent).'); process.exit(1); }

const DESK = '/Users/nunubabymuzik/Desktop/J Kiss Stuff';
const affidavit = readFileSync(`${DESK}/REBUILD/08_Affidavit_ClassicPlumbing.pdf`).toString('base64');
const invoice   = readFileSync(`${DESK}/source_originals/All files from Insurance company/invoice_plumber.pdf`).toString('base64');

const TO = ['ar@classicplb.com'];   // billing address printed on the invoice

const html = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.55">
<p>Hello,</p>
<p>My name is Timmothy Jones with J&nbsp;Kiss&nbsp;LLC. On <b>January 25, 2024</b>, Classic Plumbing
(<b>Invoice&nbsp;#67365</b>, technician Matthew Austin) performed a service at <b>4573 Waterford Drive,
Plano, TX</b> for customer Marianne Rhoades, and identified a loose packing nut on the gate valve behind
the washer as the source of a leak &mdash; which tightening resolved.</p>
<p>I&rsquo;m involved in a matter where that invoice is an exhibit, and I need to confirm it as a genuine
Classic Plumbing business record. I&rsquo;ve attached two short documents:</p>
<ol>
  <li><b>A one-paragraph records affidavit</b> &mdash; it simply states the attached invoice is a true record
  kept in your ordinary course of business. Any office/records representative can sign paragraphs&nbsp;1&ndash;4.
  If your master plumber (John&nbsp;Pritchett) or the technician (Matthew&nbsp;Austin) signs, paragraph&nbsp;5
  also confirms the finding.</li>
  <li><b>A copy of the invoice itself</b>, for your reference, in case it&rsquo;s easier than pulling it up.</li>
</ol>
<p>It can be notarized, or &mdash; to keep things simple &mdash; signed as an unsworn declaration under penalty
of perjury (the form includes both options). If you could sign and email a scanned copy back to this address,
I&rsquo;d be very grateful. I&rsquo;m glad to hop on a quick call to make it as easy as possible.</p>
<p>Thank you for your time,</p>
<p><b>Timmothy Jones</b><br/>J&nbsp;Kiss&nbsp;LLC<br/>817-909-4312<br/>timmothy@jkissllc.com</p>
</div>`;

const payload = {
  from: 'J Kiss LLC <info@jkissllc.com>',
  to: TO,
  cc: ['timmothy@jkissllc.com', 'jkissbiz@gmail.com'],
  replyTo: 'timmothy@jkissllc.com',
  subject: 'Records affidavit request — Classic Plumbing Invoice #67365 (Rhoades, 4573 Waterford Dr)',
  html,
  attachments: [
    { filename: 'Records_Affidavit_to_Sign.pdf', content: affidavit },
    { filename: 'Classic_Plumbing_Invoice_67365.pdf', content: invoice },
  ],
};
console.log('KEY: prefix=%s length=%d', KEY.slice(0, 3), KEY.length);
console.log('PAYLOAD (addresses):', JSON.stringify({
  from: payload.from, to: payload.to, cc: payload.cc, replyTo: payload.replyTo,
  subject: payload.subject, attachments: payload.attachments.map(a => a.filename),
}, null, 2));

const resend = new Resend(KEY);
let data, error;
try {
  ({ data, error } = await resend.emails.send(payload));
} catch (thrown) {
  console.error('=== THROWN EXCEPTION ===');
  console.error('message:', thrown?.message);
  console.error('name   :', thrown?.name);
  console.error('responseBody:', JSON.stringify(thrown?.response?.data ?? thrown?.response ?? null, null, 2));
  console.error('full   :', JSON.stringify(thrown, Object.getOwnPropertyNames(thrown || {}), 2));
  process.exit(1);
}
if (error) {
  console.error('=== RESEND validation_error — COMPLETE RESPONSE ===');
  console.error('statusCode :', error.statusCode);
  console.error('name       :', error.name);
  console.error('message    :', error.message);
  console.error('all keys   :', Object.keys(error));
  console.error('full JSON  :', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
  process.exit(1);
}
console.log('SENT. id =', data?.id, '| to', TO.join(', '), '| cc timmothy@jkissllc.com, jkissbiz@gmail.com');
