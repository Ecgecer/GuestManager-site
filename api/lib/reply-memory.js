/**
 * Guest.Manager — Reply Memory Engine
 *
 * Learns how the business owner writes by analysing their manual replies.
 * Builds a voice profile that gets injected into every AI system prompt.
 *
 * Trigger: called after every owner reply is saved.
 * Analyses when owner reply count hits multiples of 10 (10, 20, 30…).
 * Minimum 10 replies required before activation.
 */

const https = require('https');

const MIN_REPLIES      = 10;   // minimum owner replies before activating
const ANALYSE_EVERY    = 10;   // re-analyse every N new replies
const MAX_REPLIES_READ = 50;   // max replies to send to Claude for analysis

// ── MAIN: MAYBE TRIGGER ANALYSIS ─────────────────────────────
/**
 * Called after every owner reply is saved.
 * Checks if it's time to re-analyse. Fire-and-forget safe.
 */
async function maybeAnalyse(businessId, supabase) {
  if (!supabase || !businessId || businessId === 'demo') return;

  try {
    // Count owner replies for this business
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'owner')
      .eq('channel', 'sms') // expand later when WhatsApp is live
      .in('conversation_id',
        supabase.from('conversations').select('id').eq('business_id', businessId)
      );

    const ownerCount = count || 0;

    // Only analyse at multiples of ANALYSE_EVERY
    if (ownerCount < MIN_REPLIES) {
      console.log(`[ReplyMemory] ${ownerCount}/${MIN_REPLIES} replies — not enough yet`);
      return;
    }

    if (ownerCount % ANALYSE_EVERY !== 0) return;

    console.log(`[ReplyMemory] Triggering analysis at ${ownerCount} owner replies`);
    await analyseAndStore(businessId, supabase);

  } catch (err) {
    console.error('[ReplyMemory] maybeAnalyse error:', err.message);
  }
}

// ── FETCH OWNER REPLIES ───────────────────────────────────────
async function fetchOwnerReplies(businessId, supabase) {
  // Get conversations for this business
  const { data: convs } = await supabase
    .from('conversations')
    .select('id')
    .eq('business_id', businessId);

  if (!convs || convs.length === 0) return [];

  const convIds = convs.map(c => c.id);

  const { data: messages } = await supabase
    .from('messages')
    .select('content, created_at')
    .eq('role', 'owner')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })
    .limit(MAX_REPLIES_READ);

  return (messages || []).map(m => m.content).filter(Boolean);
}

// ── ANALYSE VOICE WITH CLAUDE HAIKU ──────────────────────────
async function analyseVoice(replies, businessName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const repliesText = replies
    .slice(0, MAX_REPLIES_READ)
    .map((r, i) => `Reply ${i + 1}: "${r}"`)
    .join('\n');

  const prompt = `You are analysing how a small business owner communicates with their customers via SMS/WhatsApp.

Business name: ${businessName}
Number of manual replies analysed: ${replies.length}

Here are the owner's actual replies:
${repliesText}

Based on these replies, write a concise voice profile that an AI assistant should follow when replying on behalf of this business owner.

Respond ONLY with a JSON object — no preamble, no markdown:
{
  "summary": "2-3 sentence description of their communication style for the AI to follow",
  "greeting": "typical way they start messages (e.g. 'Hey!' or 'Hallo!' or 'Hi,')",
  "signoff": "typical way they end messages (e.g. 'See you soon!' or 'Bis bald 🌿' or nothing)",
  "formality": "casual | friendly | professional | formal",
  "emojiUsage": "none | occasional | frequent",
  "avgLength": "very short | short | medium | detailed",
  "languages": ["list", "of", "languages", "used"],
  "keyPhrases": ["up to 5 characteristic phrases or words they use"],
  "avoidPhrases": ["phrases or patterns NOT present in their writing that AI should avoid"]
}`;

  try {
    const bodyStr = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
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

    const data    = JSON.parse(result.body);
    const text    = data.content?.[0]?.text || '';
    const match   = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    return JSON.parse(match[0]);
  } catch (err) {
    console.error('[ReplyMemory] analyseVoice error:', err.message);
    return null;
  }
}

// ── BUILD VOICE DESCRIPTION ───────────────────────────────────
/**
 * Converts the JSON profile into a concise instruction string
 * that gets appended to the AI system prompt.
 */
function buildVoiceInstruction(profile, replyCount) {
  if (!profile) return null;

  const lines = [
    `REPLY MEMORY ACTIVE (learned from ${replyCount} manual replies by the business owner):`,
    '',
    profile.summary,
    '',
    `Greeting style: ${profile.greeting || 'none specific'}`,
    `Sign-off style: ${profile.signoff || 'none specific'}`,
    `Formality: ${profile.formality}`,
    `Emoji usage: ${profile.emojiUsage}`,
    `Message length: ${profile.avgLength}`,
  ];

  if (profile.languages?.length > 0) {
    lines.push(`Languages: ${profile.languages.join(', ')}`);
  }

  if (profile.keyPhrases?.length > 0) {
    lines.push(`Characteristic phrases to use naturally: ${profile.keyPhrases.join(', ')}`);
  }

  if (profile.avoidPhrases?.length > 0) {
    lines.push(`Phrases/patterns to avoid: ${profile.avoidPhrases.join(', ')}`);
  }

  lines.push('', 'Mirror this style closely in all replies. The goal is that customers cannot tell the difference between the AI and the owner.');

  return lines.join('\n');
}

// ── STORE ANALYSIS ────────────────────────────────────────────
async function analyseAndStore(businessId, supabase) {
  // Fetch business name
  const { data: biz } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', businessId)
    .single();

  const businessName = biz?.name || 'this business';

  // Fetch owner replies
  const replies = await fetchOwnerReplies(businessId, supabase);

  if (replies.length < MIN_REPLIES) {
    console.log(`[ReplyMemory] Only ${replies.length} replies — skipping`);
    return;
  }

  // Analyse with Claude
  const profile = await analyseVoice(replies, businessName);

  if (!profile) {
    console.error('[ReplyMemory] Analysis failed');
    return;
  }

  // Build instruction string
  const instruction = buildVoiceInstruction(profile, replies.length);

  // Store in businesses table
  await supabase.from('businesses').update({
    reply_memory:        instruction,
    reply_memory_json:   JSON.stringify(profile),
    reply_memory_count:  replies.length,
    reply_memory_updated_at: new Date().toISOString(),
  }).eq('id', businessId);

  console.log(`[ReplyMemory] ✅ Profile updated for "${businessName}" (${replies.length} replies)`);
  return profile;
}

// ── MANUAL TRIGGER (API endpoint) ────────────────────────────
async function triggerManualAnalysis(businessId, supabase) {
  const replies = await fetchOwnerReplies(businessId, supabase);

  if (replies.length === 0) {
    return { success: false, error: 'No owner replies found for this business' };
  }

  if (replies.length < MIN_REPLIES) {
    return {
      success: false,
      error: `Need at least ${MIN_REPLIES} manual replies to activate Reply Memory. Currently have ${replies.length}.`,
      replyCount: replies.length,
      needed: MIN_REPLIES - replies.length,
    };
  }

  await analyseAndStore(businessId, supabase);

  return { success: true, replyCount: replies.length };
}

// ── GET MEMORY STATUS ─────────────────────────────────────────
async function getMemoryStatus(businessId, supabase) {
  const { data: biz } = await supabase
    .from('businesses')
    .select('reply_memory, reply_memory_json, reply_memory_count, reply_memory_updated_at')
    .eq('id', businessId)
    .single();

  if (!biz) return null;

  const replies = await fetchOwnerReplies(businessId, supabase);

  return {
    active:       !!biz.reply_memory,
    replyCount:   replies.length,
    analysedCount: biz.reply_memory_count || 0,
    lastUpdated:  biz.reply_memory_updated_at,
    profile:      biz.reply_memory_json ? JSON.parse(biz.reply_memory_json) : null,
    nextAnalysis: biz.reply_memory_count
      ? ANALYSE_EVERY - (replies.length % ANALYSE_EVERY)
      : Math.max(0, MIN_REPLIES - replies.length),
    progress:     Math.min(100, Math.round((replies.length / MIN_REPLIES) * 100)),
  };
}

module.exports = {
  maybeAnalyse,
  triggerManualAnalysis,
  getMemoryStatus,
  buildVoiceInstruction,
  MIN_REPLIES,
  ANALYSE_EVERY,
};
