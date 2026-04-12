/**
 * Guest.Manager — Smart Routing Engine
 * Classifies incoming messages into the right Space.
 *
 * Two-stage approach:
 *   1. Keyword match (fast, free, runs first)
 *   2. AI semantic classification (only if keyword match fails or is ambiguous)
 */

const https = require('https');

// ── KEYWORD CLASSIFIER ───────────────────────────────────────
/**
 * Fast keyword-based routing.
 * Returns { spaceId, spaceName, confidence, method: 'keyword' } or null
 */
function keywordMatch(message, spaces) {
  if (!spaces || spaces.length === 0) return null;

  const text = message.toLowerCase();
  const scores = [];

  for (const space of spaces) {
    if (!space.active) continue;
    const keywords = space.keywords || [];
    let hits = 0;

    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        // Weight longer keywords more (more specific)
        hits += kw.length > 5 ? 2 : 1;
      }
    }

    if (hits > 0) {
      scores.push({ space, hits });
    }
  }

  if (scores.length === 0) return null;

  // Sort by hits descending
  scores.sort((a, b) => b.hits - a.hits);

  const top = scores[0];
  const isAmbiguous = scores.length > 1 && scores[1].hits >= top.hits * 0.8;

  // Confidence: 1.0 if clear winner, 0.7 if ambiguous
  const confidence = isAmbiguous ? 0.7 : Math.min(1, 0.8 + (top.hits * 0.05));

  return {
    spaceId:    top.space.id,
    spaceName:  top.space.name,
    confidence,
    method:     'keyword',
    isAmbiguous,
  };
}

// ── AI CLASSIFIER ────────────────────────────────────────────
/**
 * Semantic AI routing using Claude.
 * Only called when keyword match fails or is ambiguous.
 * Returns { spaceId, spaceName, confidence, method: 'ai', reason }
 */
async function aiClassify(message, spaces, business) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const activeSpaces = spaces.filter(s => s.active);
  if (activeSpaces.length === 0) return null;

  const spaceDescriptions = activeSpaces.map(s =>
    `- "${s.name}" (keywords: ${(s.keywords || []).join(', ')})`
  ).join('\n');

  const prompt = `You are a message routing system for ${business.name || 'a business'}.

Available routing spaces:
${spaceDescriptions}

Incoming message: "${message}"

Which space should this message be routed to? Reply with ONLY a JSON object:
{
  "spaceName": "exact space name from the list above, or null if no match",
  "confidence": 0.0-1.0,
  "reason": "one sentence explanation"
}

If no space is a good match, set spaceName to null.`;

  try {
    const bodyStr = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',  // Use Haiku for speed + cost
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ ok: res.statusCode < 300, body: data }));
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });

    if (!result.ok) return null;

    const data = JSON.parse(result.body);
    const text = data.content?.[0]?.text || '';

    // Parse JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (!parsed.spaceName) return null;

    // Find matching space
    const space = activeSpaces.find(s =>
      s.name.toLowerCase() === parsed.spaceName.toLowerCase()
    );
    if (!space) return null;

    return {
      spaceId:    space.id,
      spaceName:  space.name,
      confidence: parsed.confidence || 0.8,
      reason:     parsed.reason || '',
      method:     'ai',
    };
  } catch (err) {
    console.error('[Router] AI classify error:', err.message);
    return null;
  }
}

// ── SUGGEST SPACES FROM WEBSITE ──────────────────────────────
/**
 * AI-powered space suggestion from scraped business data.
 * Called once during onboarding to auto-generate spaces.
 * Returns array of suggested spaces.
 */
async function suggestSpaces(business) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const prompt = `You are helping set up Smart Routing for a business messaging system.

Business info:
- Name: ${business.name}
- Type: ${business.type || 'unknown'}
- Services: ${JSON.stringify(business.services || [])}
- Notes: ${business.notes || 'none'}

Suggest 2-5 routing spaces that would make sense for this business.
For example, a therapy clinic might have spaces for each therapist.
A restaurant might have spaces for reservations, takeaway, general.
A salon might have spaces for each stylist.

Reply ONLY with a JSON array:
[
  {
    "name": "space name",
    "keywords": ["keyword1", "keyword2", "keyword3"],
    "color": "#hexcolor",
    "reason": "why this space makes sense"
  }
]

Use these colors: #D4734A #3DBE7A #5B9CF6 #A78BFA #F472B6 #F0B429
Keep keywords practical — words a customer would actually type.`;

  try {
    const bodyStr = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ ok: res.statusCode < 300, body: data }));
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });

    if (!result.ok) return [];

    const data = JSON.parse(result.body);
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const suggestions = JSON.parse(match[0]);
    return suggestions.map(s => ({ ...s, ai_generated: true }));
  } catch (err) {
    console.error('[Router] suggestSpaces error:', err.message);
    return [];
  }
}

// ── MAIN ROUTE FUNCTION ──────────────────────────────────────
/**
 * Route a message to the best matching space.
 *
 * @param {string} message - incoming message text
 * @param {Array}  spaces  - active spaces from DB
 * @param {Object} business - business profile
 * @returns {Object|null} routing result or null if no match
 */
async function routeMessage(message, spaces, business) {
  if (!spaces || spaces.length === 0) return null;

  // Stage 1: keyword match (fast)
  const kwResult = keywordMatch(message, spaces);

  // If confident keyword match → use it directly
  if (kwResult && !kwResult.isAmbiguous && kwResult.confidence >= 0.8) {
    console.log(`[Routing] Keyword match → "${kwResult.spaceName}" (${Math.round(kwResult.confidence * 100)}%)`);
    return kwResult;
  }

  // Stage 2: AI classification (semantic)
  const aiResult = await aiClassify(message, spaces, business);

  if (aiResult && aiResult.confidence >= 0.7) {
    console.log(`[Routing] AI match → "${aiResult.spaceName}" (${Math.round(aiResult.confidence * 100)}%) — ${aiResult.reason}`);
    return aiResult;
  }

  // Fall back to keyword result if we have one
  if (kwResult) {
    console.log(`[Routing] Fallback keyword → "${kwResult.spaceName}"`);
    return kwResult;
  }

  // No match → goes to general inbox
  console.log('[Routing] No space match — unrouted');
  return null;
}

// ── LOAD SPACES FROM SUPABASE ────────────────────────────────
async function loadSpaces(businessId, supabase) {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('spaces')
      .select('*')
      .eq('business_id', businessId)
      .eq('active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[Routing] loadSpaces error:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[Routing] loadSpaces exception:', err.message);
    return [];
  }
}

// ── SAVE ROUTING RESULT ──────────────────────────────────────
async function saveRouting(conversationId, routing, supabase) {
  if (!supabase || !conversationId || !routing) return;
  try {
    await supabase
      .from('conversations')
      .update({
        space_id:           routing.spaceId,
        routing_confidence: routing.confidence,
        routing_reason:     routing.reason || routing.method,
      })
      .eq('id', conversationId);
  } catch (err) {
    console.error('[Routing] saveRouting error:', err.message);
  }
}

module.exports = {
  routeMessage,
  keywordMatch,
  aiClassify,
  suggestSpaces,
  loadSpaces,
  saveRouting,
};
