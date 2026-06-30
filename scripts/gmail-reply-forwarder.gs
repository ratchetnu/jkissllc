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
var SECRET = 'PASTE_SAME_VALUE_AS_EMAIL_WEBHOOK_SECRET';

// Addresses that are US (don't forward our own outbound).
var OURS = /jkissllc\.com|jkissbiz@gmail\.com/i;

function forwardReplies() {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('lastRun') || 0);
  var floor = last || (Date.now() - 24 * 3600 * 1000); // first run: look back 24h
  var sinceSec = Math.floor(floor / 1000);
  var startedAt = Date.now();

  var threads = GmailApp.search('in:inbox after:' + sinceSec, 0, 50);
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      if (m.getDate().getTime() < floor) continue;     // only messages newer than last run
      if (OURS.test(m.getFrom())) continue;            // skip our own outbound
      var payload = {
        from: m.getFrom(),
        to: m.getTo(),
        subject: m.getSubject(),
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
      } catch (e) {
        Logger.log('forward failed for ' + m.getId() + ': ' + e);
      }
    }
  }
  props.setProperty('lastRun', String(startedAt));
}
