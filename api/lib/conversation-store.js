/**
 * Guest.Manager — Conversation Store
 * In-memory store with KV persistence hooks
 * Tracks conversation history, guest sessions, escalation state
 */

// In-memory store (replace with Redis/KV in production)
const store = new Map();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a session key from channel + contact identifier
 */
function sessionKey(businessId, channel, contactId) {
  return `${businessId}:${channel}:${contactId}`;
}

/**
 * Get or create a guest session
 */
function getSession(businessId, channel, contactId, guestName = null) {
  const key = sessionKey(businessId, channel, contactId);
  const now = Date.now();

  if (store.has(key)) {
    const session = store.get(key);
    // Reset if expired
    if (now - session.lastActivity > SESSION_TTL_MS) {
      store.delete(key);
      return createSession(key, businessId, channel, contactId, guestName, now);
    }
    session.lastActivity = now;
    if (guestName && !session.guestName) session.guestName = guestName;
    return session;
  }

  return createSession(key, businessId, channel, contactId, guestName, now);
}

function createSession(key, businessId, channel, contactId, guestName, now) {
  const session = {
    key,
    businessId,
    channel,
    contactId,
    guestName,
    history: [],           // Claude message format [{role, content}]
    messageCount: 0,
    escalated: false,
    escalateCount: 0,
    satisfactionSignals: 0,
    createdAt: now,
    lastActivity: now,
  };
  store.set(key, session);
  return session;
}

/**
 * Add a message to session history
 */
function addToHistory(session, role, content) {
  session.history.push({ role, content });
  session.messageCount++;
  // Keep last 20 messages to manage context window
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
}

/**
 * Mark session as escalated
 */
function markEscalated(session, reason) {
  session.escalated = true;
  session.escalateReason = reason;
  session.escalateCount++;
  session.escalatedAt = Date.now();
}

/**
 * Mark session as resolved
 */
function resolveSession(session) {
  session.escalated = false;
  session.resolvedAt = Date.now();
}

/**
 * Get all active sessions for a business (for dashboard)
 */
function getBusinessSessions(businessId) {
  const sessions = [];
  for (const [, session] of store) {
    if (session.businessId === businessId) {
      sessions.push(session);
    }
  }
  return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Get session stats for a business
 */
function getBusinessStats(businessId) {
  const sessions = getBusinessSessions(businessId);
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const todaySessions = sessions.filter(s => s.createdAt > dayAgo);
  const weekSessions  = sessions.filter(s => s.createdAt > weekAgo);

  const totalMessages = weekSessions.reduce((sum, s) => sum + s.messageCount, 0);
  const escalated     = weekSessions.filter(s => s.escalateCount > 0).length;
  const aiHandled     = weekSessions.length - escalated;

  return {
    totalSessionsToday:  todaySessions.length,
    totalSessionsWeek:   weekSessions.length,
    totalMessagesWeek:   totalMessages,
    escalatedWeek:       escalated,
    aiHandledWeek:       aiHandled,
    aiHandledRate:       weekSessions.length > 0
      ? Math.round((aiHandled / weekSessions.length) * 100)
      : 0,
  };
}

module.exports = {
  getSession,
  addToHistory,
  markEscalated,
  resolveSession,
  getBusinessSessions,
  getBusinessStats,
};
