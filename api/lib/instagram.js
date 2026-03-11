/**
 * Guest.Manager — Instagram DM Handler
 * Uses Meta's Messaging API (same infrastructure as WhatsApp)
 */

const { processMessage } = require('./whatsapp');

/**
 * Handle incoming Instagram webhook
 */
async function handleWebhook(req, res, { business, sendEscalationAlert }) {
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

        // Fetch guest name from Instagram profile
        let guestName = null;
        try {
          guestName = await getInstagramName(contactId);
        } catch { /* non-critical */ }

        await processMessage({
          businessId: business.id,
          channel: 'instagram',
          contactId,
          guestName,
          text,
          business,
          sendEscalationAlert,
        });
      }
    }
  } catch (err) {
    console.error('[Instagram] Handler error:', err);
  }
}

/**
 * Send Instagram DM
 */
async function sendInstagramMessage(recipientId, text, business) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const igPageId    = process.env.INSTAGRAM_PAGE_ID;

  const res = await fetch(
    `https://graph.facebook.com/v18.0/${igPageId}/messages`,
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
    console.error('[Instagram] Send failed:', err);
    throw new Error(`Instagram send error: ${err.error?.message}`);
  }

  return res.json();
}

/**
 * Fetch Instagram user's display name
 */
async function getInstagramName(userId) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const res = await fetch(
    `https://graph.facebook.com/v18.0/${userId}?fields=name&access_token=${accessToken}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.name || null;
}

module.exports = { handleWebhook, sendInstagramMessage };
