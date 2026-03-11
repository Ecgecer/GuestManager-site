/**
 * Guest.Manager — AI Brain
 * Claude-powered response engine with confidence layer
 * Hallucination protection built in
 */

const CONFIDENCE_THRESHOLD = 0.75;

/**
 * Build the system prompt from business context
 * This is what makes each bot unique to each business
 */
function buildSystemPrompt(business) {
  return `You are a friendly, professional customer service assistant for ${business.name}.

BUSINESS INFORMATION (verified, use only this):
- Name: ${business.name}
- Type: ${business.type || 'business'}
- Hours: ${business.hours || 'Contact us for hours'}
- Location: ${business.location || 'Contact us for location'}
- Phone: ${business.phone || 'Contact us directly'}
- Services: ${JSON.stringify(business.services || [])}
- Pricing: ${JSON.stringify(business.pricing || {})}
- FAQs: ${JSON.stringify(business.faqs || [])}
- Booking link: ${business.bookingUrl || null}
- Special notes: ${business.notes || 'none'}

REPLY MEMORY (how ${business.name} communicates):
${business.replyMemory || 'Be warm, professional, and concise. Match the business tone.'}

STRICT RULES — follow these exactly:
1. ONLY answer using the business information above. Never invent details.
2. If you are NOT sure of an answer, say exactly: "I want to make sure I give you accurate information — let me have [owner name or 'our team'] confirm that for you. Can I get your contact details?"
3. Never guess prices, availability, or services not listed above.
4. Never make bookings — always direct to the booking link or ask them to call.
5. Keep replies SHORT — 2-4 sentences max unless a detailed answer is truly needed.
6. Be warm but not over-enthusiastic. No excessive exclamation marks.
7. If a message seems urgent or angry, immediately offer to connect them with the owner.
8. Never reveal you are an AI unless directly asked. If asked, say "I'm the virtual assistant for ${business.name}."
9. Language: reply in the same language the customer writes in.
10. If a conversation is going in circles or the customer seems frustrated after 2 exchanges, escalate to human.

ESCALATION TRIGGERS (reply with ESCALATE:[reason]):
- Customer is angry or uses aggressive language
- Booking dispute or complaint about a past visit
- Medical, legal, or safety question
- Request for refund or compensation
- You have answered the same question twice without resolution
- Any question you cannot answer confidently from the business info above`;
}

/**
 * Assess confidence in a response
 * Protects against hallucination
 */
function assessConfidence(response, business) {
  let score = 1.0;
  const text = response.toLowerCase();

  // penalise vague hedging language that suggests guessing
  const hedgeWords = ['probably', 'i think', 'i believe', 'maybe', 'might be', 'not sure but', 'i assume'];
  hedgeWords.forEach(w => { if (text.includes(w)) score -= 0.15; });

  // penalise if numbers mentioned that aren't in business data
  const mentionedPrices = text.match(/€\d+|\$\d+|£\d+|\d+\s*(euro|dollar|pound)/g) || [];
  const knownPrices = JSON.stringify(business.pricing || {}).toLowerCase();
  mentionedPrices.forEach(price => {
    const num = price.replace(/[^0-9]/g, '');
    if (num && !knownPrices.includes(num)) score -= 0.2;
  });

  // penalise if response is very long (often means it's filling gaps)
  if (response.length > 400) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

/**
 * Parse escalation signal from AI response
 */
function parseEscalation(response) {
  const match = response.match(/ESCALATE:(.+)/i);
  if (match) {
    return { escalate: true, reason: match[1].trim() };
  }
  return { escalate: false };
}

/**
 * Main AI response function
 */
async function getAIResponse({ message, business, conversationHistory = [], guestName = null }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = buildSystemPrompt(business);

  // Build messages array with history (max last 10 exchanges)
  const recentHistory = conversationHistory.slice(-20);
  const messages = [
    ...recentHistory,
    { role: 'user', content: guestName ? `[${guestName}]: ${message}` : message }
  ];

  let response;
  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts) {
    attempts++;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: systemPrompt,
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Claude API error: ${err.error?.message || res.status}`);
    }

    const data = await res.json();
    response = data.content[0]?.text || '';

    // Check for escalation signal
    const escalation = parseEscalation(response);
    if (escalation.escalate) {
      return {
        reply: null,
        escalate: true,
        escalateReason: escalation.reason,
        confidence: 1.0,
        model: 'claude-sonnet-4-20250514',
      };
    }

    // Assess confidence
    const confidence = assessConfidence(response, business);

    if (confidence >= CONFIDENCE_THRESHOLD) {
      return {
        reply: response.replace(/ESCALATE:.*/gi, '').trim(),
        escalate: false,
        confidence,
        model: 'claude-sonnet-4-20250514',
        attempts,
      };
    }

    // Low confidence — add a retry instruction
    messages.push({ role: 'assistant', content: response });
    messages.push({
      role: 'user',
      content: 'Please revise your answer. Only use information explicitly provided in your instructions. If you are not certain, use the escalation response instead of guessing.'
    });
  }

  // After max attempts, return safe fallback
  return {
    reply: `I want to make sure I give you accurate information — let me have our team confirm that for you. Could you leave your contact details or call us directly?`,
    escalate: false,
    confidence: 0,
    usedFallback: true,
    model: 'claude-sonnet-4-20250514',
  };
}

/**
 * Generate escalation notification message for business owner
 */
function buildEscalationAlert({ guestName, guestContact, reason, lastMessage, channel, businessName }) {
  return `🔔 *Guest.Manager Alert — ${businessName}*

A conversation needs your attention.

*Guest:* ${guestName || 'Unknown'}
*Contact:* ${guestContact || 'Via ' + channel}
*Channel:* ${channel}
*Reason:* ${reason}
*Last message:* "${lastMessage}"

Reply directly to this contact or open your dashboard to take over.`;
}

module.exports = { getAIResponse, buildEscalationAlert, buildSystemPrompt };
