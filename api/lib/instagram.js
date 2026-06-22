/**
 * Guest.Manager — Instagram DM Handler
 * Uses Meta's Messaging API (same infrastructure as WhatsApp)
 */

const { processMessage } = require('./whatsapp');

/**
 * Verify Instagram webhook (Meta requires this on setup).
 * Falls back to the shared WhatsApp verify token if a dedicated one isn't set,
 * since a single Meta app commonly reuses one verify token across products.
 */
function verifyWebhook(req, res) {
  const mode        = req.query['hub.mode'];
  const token       = req.query['hub.verify_token'];
  const challenge   = req.query['hub.challenge'];
  const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[Instagram] Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Forbidden' });
}

/**
 * Handle incoming Instagram webhook
 */
async function handleWebhook(req, res, { business, creds, sendEscalationAlert, sendOwnerNotification }) {
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
          guestName = await getInstagramName(contactId, creds?.instagram);
        } catch { /* non-critical */ }

        await processMessage({
          businessId: business.id,
          channel: 'instagram',
          contactId,
          guestName,
          text,
          business,
          creds,
          sendEscalationAlert,
          sendOwnerNotification,
        });
      }
    }
  } catch (err) {
    console.error('[Instagram] Handler error:', err);
  }
}

/**
 * Send Instagram DM
 * Uses the Instagram API with Instagram Login (graph.instagram.com).
 * The IG-Login access token is scoped to the connected IG user, so we POST
 * to /me/messages. Replies are only permitted within the 24h window that
 * opens after a user messages the business.
 */
async function sendInstagramMessage(recipientId, text, creds) {
  const accessToken = creds?.accessToken || process.env.META_ACCESS_TOKEN;

  const res = await fetch(
    `https://graph.instagram.com/v21.0/me/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
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
 * Looks up the Instagram-scoped sender ID via graph.instagram.com.
 */
async function getInstagramName(userId, creds) {
  const accessToken = creds?.accessToken || process.env.META_ACCESS_TOKEN;
  const res = await fetch(
    `https://graph.instagram.com/v21.0/${userId}?fields=name,username&access_token=${accessToken}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.name || data.username || null;
}

module.exports = { verifyWebhook, handleWebhook, sendInstagramMessage };
