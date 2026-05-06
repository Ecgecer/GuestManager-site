/**
 * Guest.Manager — WhatsApp Business API Handler
 * Receives and sends messages via Meta's Cloud API
 */

const { getAIResponse, buildEscalationAlert } = require('../lib/ai-brain');
const { getSession, addToHistory, markEscalated } = require('../lib/conversation-store');

/**
 * Verify WhatsApp webhook (Meta requires this on setup)
 */
function verifyWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WhatsApp] Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Forbidden' });
}

/**
 * Process incoming WhatsApp webhook event
 */
async function handleWebhook(req, res, { business, creds, sendEscalationAlert }) {
  // Acknowledge immediately — Meta requires 200 within 5 seconds
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;
    if (!body?.entry?.[0]?.changes?.[0]?.value) return;

    const value    = body.entry[0].changes[0].value;
    const messages = value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      // Only handle text messages for now
      if (msg.type !== 'text') {
        await sendWhatsAppMessage(msg.from, "Thanks for your message! For media or files, please contact us directly.", business, creds?.whatsapp);
        continue;
      }

      const contactId  = msg.from; // WhatsApp phone number
      const text       = msg.text.body;
      const guestName  = value?.contacts?.[0]?.profile?.name || null;

      await processMessage({
        businessId:  business.id,
        channel:     'whatsapp',
        contactId,
        guestName,
        text,
        business,
        creds,
        sendEscalationAlert,
      });
    }
  } catch (err) {
    console.error('[WhatsApp] Handler error:', err);
  }
}

/**
 * Send a WhatsApp message
 */
async function sendWhatsAppMessage(to, text, business, creds) {
  const phoneNumberId = creds?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = creds?.accessToken   || process.env.META_ACCESS_TOKEN;

  const res = await fetch(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    console.error('[WhatsApp] Send failed:', err);
    throw new Error(`WhatsApp send error: ${err.error?.message}`);
  }

  return res.json();
}

/**
 * Shared message processor — used by all channels
 */
async function processMessage({ businessId, channel, contactId, guestName, text, business, creds, sendEscalationAlert }) {
  const session = await getSession(businessId, channel, contactId, guestName);

  // If already escalated, don't auto-reply — owner is handling it
  if (session.escalated) {
    console.log(`[${channel}] Session ${session.key} is escalated — skipping AI`);
    return;
  }

  // Add incoming message to history
  await addToHistory(session, 'user', text);

  // Get AI response
  const aiResult = await getAIResponse({
    message: text,
    business,
    conversationHistory: session.history.slice(0, -1), // exclude current message
    guestName,
  });

  if (aiResult.escalate) {
    // Mark escalated and notify owner
    await markEscalated(session, aiResult.escalateReason);

    const alertText = buildEscalationAlert({
      guestName:    guestName || contactId,
      guestContact: contactId,
      reason:       aiResult.escalateReason,
      lastMessage:  text,
      channel,
      businessName: business.name,
    });

    if (sendEscalationAlert) {
      await sendEscalationAlert(business, alertText);
    }

    // Send holding message to guest
    const holdingMsg = `Thank you for your message. I've flagged this for our team and someone will be in touch with you shortly.`;
    await sendByChannel(channel, contactId, holdingMsg, business, creds);
    await addToHistory(session, 'assistant', holdingMsg);

    console.log(`[${channel}] Escalated: ${aiResult.escalateReason}`);
    return;
  }

  // Send AI reply
  if (aiResult.reply) {
    await sendByChannel(channel, contactId, aiResult.reply, business, creds);
    await addToHistory(session, 'assistant', aiResult.reply);

    console.log(`[${channel}] Replied (confidence: ${(aiResult.confidence * 100).toFixed(0)}%)`);
  }
}

/**
 * Route reply to correct channel sender
 */
async function sendByChannel(channel, contactId, text, business, creds) {
  switch (channel) {
    case 'whatsapp':
      return sendWhatsAppMessage(contactId, text, business, creds?.whatsapp);
    case 'sms':
      return require('./sms').sendSMS(contactId, text, creds?.twilio);
    case 'instagram':
      return require('./instagram').sendInstagramMessage(contactId, text, creds?.instagram);
    case 'facebook':
      return require('./facebook').sendFacebookMessage(contactId, text, creds?.facebook);
    default:
      throw new Error(`Unknown channel: ${channel}`);
  }
}

module.exports = { verifyWebhook, handleWebhook, processMessage, sendWhatsAppMessage, sendByChannel };
