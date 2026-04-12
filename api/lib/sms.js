/**
 * Guest.Manager — SMS Handler (with Usage Tracking)
 */

const { getAIResponse }  = require('./ai-brain');
const { getSession, addToHistory, markEscalated } = require('./conversation-store');
const { routeMessage, loadSpaces, saveRouting }   = require('./routing-engine');
const { trackAIReply }   = require('./usage-tracker');
const { supabase }       = require('./conversation-store');

async function handleWebhook(req, res, { business }) {
  const { From: contactId, Body: text, ProfileName: guestName } = req.body;

  if (!contactId || !text) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  }

  console.log('[SMS] Incoming from:', contactId, 'text:', text);

  const session = await getSession(business.id, 'sms', contactId, guestName || null);

  if (session.escalated) {
    console.log('[SMS] Escalated — skipping AI');
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  }

  await addToHistory(session, 'guest', text);

  // ── SMART ROUTING (first message only) ──────────────────────
  if (session.messageCount <= 1) {
    try {
      const spaces = await loadSpaces(business.id, supabase);
      if (spaces.length > 0) {
        const routing = await routeMessage(text, spaces, business);
        if (routing && session.id && !session.id.startsWith('mem_')) {
          await saveRouting(session.id, routing, supabase);
        }
      }
    } catch (err) {
      console.error('[SMS] Routing error (non-fatal):', err.message);
    }
  }

  // ── AI RESPONSE ──────────────────────────────────────────────
  console.log('[SMS] Calling AI...');
  let aiResult;
  try {
    aiResult = await getAIResponse({
      message: text,
      business,
      conversationHistory: session.history,
      guestName: session.guestName,
    });
  } catch (err) {
    console.error('[SMS] AI call failed:', err.message, err);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  }

  console.log('[SMS] AI result:', JSON.stringify(aiResult));

  if (aiResult.escalate) {
    await markEscalated(session, aiResult.escalateReason);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  }

  if (!aiResult.reply) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  }

  await addToHistory(session, 'ai', aiResult.reply, aiResult.confidence);

  // ── USAGE TRACKING ───────────────────────────────────────────
  // Fire and forget — never blocks the reply
  trackAIReply(business.id, supabase, {
    channel:   'sms',
    contactId: contactId,
  }).catch(err => console.error('[SMS] Usage tracking failed:', err.message));

  // ── SEND REPLY ───────────────────────────────────────────────
  console.log('[SMS] Sending to:', contactId, 'from:', process.env.TWILIO_PHONE_NUMBER);

  try {
    await sendSMS(contactId, aiResult.reply);
    console.log('[SMS] Reply sent successfully');
  } catch (err) {
    console.error('[SMS] Send failed:', err.message);
  }

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<Response></Response>');
}

async function sendSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const auth   = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error('Twilio error: ' + err.message);
  }

  const result = await res.json();
  console.log('[SMS] Sent successfully:', result.sid);
  return result;
}

module.exports = { handleWebhook, sendSMS };
