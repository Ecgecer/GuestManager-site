/**
 * Guest.Manager — SMS Handler via Twilio
 */

const { processMessage } = require('./whatsapp'); // shared processor

/**
 * Handle incoming Twilio SMS webhook
 */
async function handleWebhook(req, res, { business, sendEscalationAlert }) {
  // Twilio expects 200 + TwiML response (empty = no auto-reply, we send via API)
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  try {
    const { From: contactId, Body: text, ProfileName: guestName } = req.body;
    if (!contactId || !text) return;

    await processMessage({
      businessId: business.id,
      channel: 'sms',
      contactId,
      guestName: guestName || null,
      text,
      business,
      sendEscalationAlert,
    });
  } catch (err) {
    console.error('[SMS] Handler error:', err);
  }
}

/**
 * Send SMS via Twilio REST API
 */
async function sendSMS(to, text, business) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const body = new URLSearchParams({
    From: fromNumber,
    To: to,
    Body: text,
  });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    console.error('[SMS] Send failed:', err);
    throw new Error(`Twilio error: ${err.message}`);
  }

  return res.json();
}

module.exports = { handleWebhook, sendSMS };
