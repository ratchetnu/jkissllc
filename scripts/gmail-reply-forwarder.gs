/**
 * J KISS LLC — forward customer EMAIL replies to the site webhook.
 *
 * Customers reply to info@jkissllc.com. Google Workspace can't POST to a webhook
 * directly, so this Apps Script (running in the info@ account) pushes new replies
 * to /api/webhooks/email, where they're matched to a booking and shown in /admin/inbox.
 *
 * ── ONE-TIME SETUP ───────────────────────────────────────────────────────────
 * 1. Sign in to Google as info@jkissllc.com → go to https://script.google.com → New project.
 * 2. Paste this whole file in. Set SECRET below to the same value as the Vercel
 *    env var EMAIL_WEBHOOK_SECRET.
 * 3. Run `forwardReplies` once → approve the Gmail permission prompt.
 * 4. Left sidebar → Triggers (clock icon) → Add Trigger:
 *      function: forwardReplies · event source: Time-driven · type: Minutes timer · every 5 minutes.
 * Done. New customer email replies now appear in the admin inbox within ~5 minutes.
 */

var WEBHOOK_URL = 'https://www.jkissllc.com/api/webhooks/email';
var SECRET = '814a1fa8458932d0690ed52d8a592269ca88740cf42ef177';

// Our own addresses — never forward our own outbound, but DO use these to decide
// "did we start/participate in this thread?" (i.e. is the inbound a reply to us).
var OURS = /jkissllc\.com|jkissbiz@gmail\.com/i;

// A booking number anywhere in the subject (JK-B-1003, JK-Q-204, "JK B 1003"…).
var JK_NUM = /JK[-\s]?[A-Z][-\s]?\d+/i;

// Automated / bulk senders that are never a customer reply. Belt-and-suspenders;
// the thread-participation check below already excludes most of these.
var AUTOMATED = /(^|[._-])(no[-_.]?reply|donotreply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounce|notifications?|mailer|newsletter|dmarc|abuse|support@.*twilio|@.*netlify|@.*\badr\.org)\b/i;

function forwardReplies() {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('lastRun') || 0);
  var floor = last || (Date.now() - 24 * 3600 * 1000); // first run: look back 24h
  var sinceSec = Math.floor(floor / 1000);
  var startedAt = Date.now();
  var sent = 0, skipped = 0;

  var threads = GmailApp.search('in:inbox after:' + sinceSec, 0, 50);
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();

    // Did WE participate earlier in this thread? If so, an inbound message here is
    // a reply to one of our emails — exactly what we want to capture.
    var weParticipated = false;
    for (var k = 0; k < msgs.length; k++) {
      if (OURS.test(msgs[k].getFrom())) { weParticipated = true; break; }
    }

    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      if (m.getDate().getTime() < floor) continue;     // only messages newer than last run
      if (OURS.test(m.getFrom())) continue;            // skip our own outbound

      var subject = m.getSubject() || '';
      var from = m.getFrom() || '';

      // Forward ONLY genuine customer replies: a reply in a thread we started, OR
      // anything that references a booking number. Everything else (DMARC reports,
      // newsletters, Twilio/Netlify notices, cold automated mail) is skipped.
      var isReply = weParticipated || JK_NUM.test(subject);
      if (!isReply || AUTOMATED.test(from)) { skipped++; continue; }

      var payload = {
        from: from,
        to: m.getTo(),
        subject: subject,
        text: m.getPlainBody().slice(0, 5000),
        messageId: m.getId(),                          // server dedups on this
      };
      try {
        UrlFetchApp.fetch(WEBHOOK_URL + '?key=' + encodeURIComponent(SECRET), {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        sent++;
      } catch (e) {
        Logger.log('forward failed for ' + m.getId() + ': ' + e);
      }
    }
  }
  props.setProperty('lastRun', String(startedAt));
  Logger.log('forwardReplies: sent ' + sent + ', skipped ' + skipped);
}
