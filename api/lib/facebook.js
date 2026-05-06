/**
 * Guest.Manager — Facebook Messenger Handler
 */

const { processMessage } = require('./whatsapp');

async function handleWebhook(req, res, { business, creds, sendEscalationAlert }) {
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;
    if (!body?.entry?.length) return;

    for (const entry of body.entry) {
      const messaging = entry?.messaging;
      if (!messaging?.length) continue;

      for (const event of messaging) {
        if (!event.message || event.message.is_echo) continue;

        const contactId = event.sender.id;
        const text      = event.message.text;
        if (!text) continue;

        let guestName = null;
        try {
          guestName = await getFacebookName(contactId);
        } catch { /* non-critical */ }

        await processMessage({
          businessId: business.id,
          channel: 'facebook',
          contactId,
          guestName,
          text,
          business,
          creds,
          sendEscalationAlert,
        });
      }
    }
  } catch (err) {
    console.error('[Facebook] Handler error:', err);
  }
}

async function sendFacebookMessage(recipientId, text, creds) {
  const accessToken = creds?.accessToken || process.env.META_ACCESS_TOKEN;
  const pageId      = creds?.pageId      || process.env.FACEBOOK_PAGE_ID;

  const res = await fetch(
    `https://graph.facebook.com/v18.0/${pageId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
        messaging_type: 'RESPONSE',
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    console.error('[Facebook] Send failed:', err);
    throw new Error(`Facebook send error: ${err.error?.message}`);
  }

  return res.json();
}

async function getFacebookName(userId) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const res = await fetch(
    `https://graph.facebook.com/v18.0/${userId}?fields=first_name,last_name&access_token=${accessToken}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.first_name ? `${data.first_name} ${data.last_name || ''}`.trim() : null;
}

module.exports = { handleWebhook, sendFacebookMessage };
