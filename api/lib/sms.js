const { getAIResponse, buildEscalationAlert } = require('./ai-brain');
const { getSession, addToHistory, markEscalated } = require('./conversation-store');

async function handleWebhook(req, res, { business, sendEscalationAlert }) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');

  try {
    const { From: contactId, Body: text, ProfileName: guestName } = req.body;
    if (!contactId || !text) return;

    const session = getSession(business.id, 'sms', contactId, guestName || null);
    if (session.escalated) return;

    addToHistory(session, 'user', text);

    const aiResult = await getAIResponse({
      message: text,
      business,
      conversationHistory: session.history.slice(0, -1),
      guestName,
    });

    if (aiResult.escalate) {
      markEscalated(session, aiResult.escalateReason);
      const holdingMsg = `Thank you for your message. Our team will be in touch shortly.`;
      await sendSMS(contactId, holdingMsg, business);
      addToHistory(session, 'assistant', holdingMsg);
      return;
    }

    if (aiResult.reply) {
      await sendSMS(contactId, aiResult.reply, business);
      addToHistory(session, 'assistant', aiResult.reply);
    }
  } catch (err) {
    console.error('[SMS] Handler error:', err);
  }
}

async function sendSMS(to, text, business) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  console.log('Sending SMS:', { to, from: fromNumber, accountSid: accountSid?.slice(0,10) });

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const body = new URLSearchParams({ From: fromNumber, To: to, Body: text });

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
    console.error('[SMS] Send failed:', JSON.stringify(err));
    throw new Error(`Twilio error: ${err.message}`);
  }

  const result = await res.json();
  console.log('[SMS] Sent successfully:', result.sid);
  return result;
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
