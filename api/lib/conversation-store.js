/**
 * Guest.Manager — Supabase Conversation Store
 * Replaces the in-memory store with persistent Supabase storage.
 * Drop-in replacement: same function signatures as conversation-store.js
 */

const { createClient } = require('@supabase/supabase-js');

// Initialise Supabase client (uses service role key — bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── LOCAL CACHE ──────────────────────────────────────────────
// Cache sessions in memory within a single function invocation
// to avoid hammering the DB on every message in a conversation.
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheKey(businessId, channel, contactId) {
  return `${businessId}:${channel}:${contactId}`;
}

// ── GET OR CREATE SESSION ────────────────────────────────────
async function getSession(businessId, channel, contactId, guestName = null) {
  const key = cacheKey(businessId, channel, contactId);

  // Return from cache if fresh
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (Date.now() - cached._cachedAt < CACHE_TTL) {
      if (guestName && !cached.guestName) cached.guestName = guestName;
      return cached;
    }
  }

  // Try to fetch existing conversation from Supabase
  const { data: existing, error } = await supabase
    .from('conversations')
    .select('*, messages(role, content, confidence, created_at)')
    .eq('business_id', businessId)
    .eq('channel', channel)
    .eq('contact_id', contactId)
    .order('created_at', { referencedTable: 'messages', ascending: true })
    .single();

  if (existing && !error) {
    // Build session from DB row
    const session = dbRowToSession(existing);
    if (guestName && !session.guestName) {
      await supabase
        .from('conversations')
        .update({ guest_name: guestName })
        .eq('id', existing.id);
      session.guestName = guestName;
    }
    cache.set(key, { ...session, _cachedAt: Date.now() });
    return session;
  }

  // Create new conversation
  const { data: created, error: createError } = await supabase
    .from('conversations')
    .insert({
      business_id: businessId,
      channel,
      contact_id: contactId,
      guest_name: guestName,
      status: 'open',
      ai_handling: true,
    })
    .select()
    .single();

  if (createError) {
    console.error('[Store] Failed to create conversation:', createError);
    // Fall back to in-memory session so bot doesn't crash
    return createInMemorySession(businessId, channel, contactId, guestName);
  }

  const session = dbRowToSession({ ...created, messages: [] });
  cache.set(key, { ...session, _cachedAt: Date.now() });
  return session;
}

function dbRowToSession(row) {
  return {
    id:           row.id,
    businessId:   row.business_id,
    channel:      row.channel,
    contactId:    row.contact_id,
    guestName:    row.guest_name,
    status:       row.status,
    escalated:    row.escalated,
    escalateReason: row.escalate_reason,
    escalateCount:  row.escalate_count,
    messageCount:   row.message_count,
    aiHandling:     row.ai_handling,
    createdAt:      new Date(row.created_at).getTime(),
    lastActivity:   new Date(row.last_message_at || row.created_at).getTime(),
    // Build history in Claude format (last 20 messages)
    history: (row.messages || []).slice(-20).map(m => ({
      role: m.role === 'guest' ? 'user' : 'assistant',
      content: m.content,
    })),
  };
}

function createInMemorySession(businessId, channel, contactId, guestName) {
  return {
    id: 'mem_' + Date.now(),
    businessId, channel, contactId, guestName,
    status: 'open', escalated: false, escalateCount: 0,
    messageCount: 0, aiHandling: true,
    history: [],
    createdAt: Date.now(), lastActivity: Date.now(),
  };
}

// ── ADD TO HISTORY ───────────────────────────────────────────
async function addToHistory(session, role, content, confidence = null) {
  // Update in-memory history immediately (for this invocation)
  const claudeRole = role === 'guest' ? 'user' : 'assistant';
  session.history.push({ role: claudeRole, content });
  session.messageCount++;

  // Keep last 20 in memory
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }

  // Persist to Supabase (fire-and-forget is fine here)
  if (!session.id.startsWith('mem_')) {
    const dbRole = role === 'guest' ? 'guest' : (role === 'ai' ? 'ai' : 'owner');

    supabase.from('messages').insert({
      conversation_id: session.id,
      role: dbRole,
      content,
      confidence,
      channel: session.channel,
    }).then(({ error }) => {
      if (error) console.error('[Store] Failed to save message:', error);
    });

    // Update conversation metadata
    supabase.from('conversations').update({
      message_count: session.messageCount,
      last_message_at: new Date().toISOString(),
      status: session.escalated ? 'waiting' : 'open',
    }).eq('id', session.id).then(({ error }) => {
      if (error) console.error('[Store] Failed to update conversation:', error);
    });

    // If owner replied manually — maybe trigger Reply Memory analysis
    if (dbRole === 'owner') {
      try {
        const { maybeAnalyse } = require('./reply-memory');
        maybeAnalyse(session.businessId, supabase).catch(err =>
          console.error('[Store] Reply Memory trigger failed:', err.message)
        );
      } catch (err) {
        // reply-memory module not available yet — skip silently
      }
    }
  }
}

// ── ESCALATE ────────────────────────────────────────────────
async function markEscalated(session, reason) {
  session.escalated = true;
  session.escalateReason = reason;
  session.escalateCount++;

  if (!session.id.startsWith('mem_')) {
    await supabase.from('conversations').update({
      escalated: true,
      escalate_reason: reason,
      escalate_count: session.escalateCount,
      status: 'waiting',
    }).eq('id', session.id);

    // Log analytics event
    supabase.from('analytics_events').insert({
      business_id: session.businessId,
      event_type: 'escalation',
      channel: session.channel,
      metadata: { reason, conversation_id: session.id },
    });
  }
}

// ── RESOLVE ──────────────────────────────────────────────────
async function resolveSession(session) {
  session.escalated = false;
  session.status = 'resolved';

  if (!session.id.startsWith('mem_')) {
    await supabase.from('conversations').update({
      escalated: false,
      status: 'resolved',
    }).eq('id', session.id);

    supabase.from('analytics_events').insert({
      business_id: session.businessId,
      event_type: 'resolved',
      channel: session.channel,
      metadata: { conversation_id: session.id },
    });
  }
}

// ── BUSINESS QUERIES ─────────────────────────────────────────
async function getBusinessSessions(businessId, limit = 50) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*, messages(role, content, created_at)')
    .eq('business_id', businessId)
    .order('last_message_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Store] getBusinessSessions error:', error);
    return [];
  }

  return (data || []).map(dbRowToSession);
}

async function getBusinessStats(businessId) {
  const now = new Date();
  const dayAgo  = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Parallel queries
  const [todayRes, weekRes, escalRes] = await Promise.all([
    supabase
      .from('conversations')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .gte('created_at', dayAgo),

    supabase
      .from('conversations')
      .select('id, message_count, escalate_count', { count: 'exact' })
      .eq('business_id', businessId)
      .gte('created_at', weekAgo),

    supabase
      .from('conversations')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .eq('escalated', true)
      .gte('created_at', weekAgo),
  ]);

  const weekSessions   = weekRes.data || [];
  const totalMessages  = weekSessions.reduce((s, c) => s + (c.message_count || 0), 0);
  const escalatedCount = escalRes.count || 0;
  const weekCount      = weekRes.count || 0;
  const aiHandled      = weekCount - escalatedCount;

  return {
    totalSessionsToday:  todayRes.count || 0,
    totalSessionsWeek:   weekCount,
    totalMessagesWeek:   totalMessages,
    escalatedWeek:       escalatedCount,
    aiHandledWeek:       aiHandled,
    aiHandledRate:       weekCount > 0
      ? Math.round((aiHandled / weekCount) * 100)
      : 0,
  };
}

// ── GET BUSINESS PROFILE ─────────────────────────────────────
async function getBusiness(businessId) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', businessId)
    .single();

  if (error) return null;
  return data;
}

// ── SAVE BUSINESS (onboarding) ───────────────────────────────
async function saveBusiness(businessData) {
  const { data, error } = await supabase
    .from('businesses')
    .upsert({
      name:         businessData.name,
      type:         businessData.type,
      hours:        businessData.hours,
      location:     businessData.location,
      phone:        businessData.phone,
      booking_url:  businessData.bookingUrl,
      services:     businessData.services || [],
      notes:        businessData.notes,
      source_url:   businessData.sourceUrl,
      confidence:   businessData.confidence || 1,
    })
    .select()
    .single();

  if (error) {
    console.error('[Store] saveBusiness error:', error);
    return null;
  }

  return data;
}

// ── LOG ANALYTICS EVENT ──────────────────────────────────────
function logEvent(businessId, eventType, channel, metadata = {}) {
  supabase.from('analytics_events').insert({
    business_id: businessId,
    event_type: eventType,
    channel,
    metadata,
  }).then(({ error }) => {
    if (error) console.error('[Store] logEvent error:', error);
  });
}

// ── EXPORTS ──────────────────────────────────────────────────
module.exports = {
  getSession,
  addToHistory,
  markEscalated,
  resolveSession,
  getBusinessSessions,
  getBusinessStats,
  getBusiness,
  saveBusiness,
  logEvent,
  supabase,  // export for direct queries if needed
};
