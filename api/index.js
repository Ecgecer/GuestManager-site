/**
 * Guest.Manager — API Router (Smart Routing edition)
 */

const store     = require('./lib/conversation-store');
const whatsapp  = require('./lib/whatsapp');
const sms       = require('./lib/sms');
const instagram = require('./lib/instagram');
const facebook  = require('./lib/facebook');
const routing   = require('./lib/routing-engine');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const DEFAULT_BUSINESS_ID = process.env.DEFAULT_BUSINESS_ID || 'demo';

const BUSINESSES = {
  demo: {
    id: 'demo',
    name: 'Studio Bloom',
    type: 'Spa & Wellness',
    hours: 'Mon–Sat 9:00–20:00, Sun 10:00–18:00',
    location: 'Rosenthaler Str. 12, Berlin Mitte',
    phone: '+49 30 12345678',
    services: ['Facial', 'Deep Tissue Massage', 'Manicure', 'Pedicure', 'Body Wrap'],
    notes: 'Organic products only. Dog friendly.',
    bookingUrl: 'https://studiobloom.com/book',
    confidence: 0.95,
  },
};

async function getBusinessProfile(businessId) {
  if (store.getBusiness) {
    const biz = await store.getBusiness(businessId);
    if (biz) return biz;
  }
  return BUSINESSES[businessId] || BUSINESSES.demo;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0];
  const query = Object.fromEntries(new URL(req.url, 'https://x').searchParams);
  console.log(`[Router] ${req.method} ${path}`);

  try {

    // ── HEALTH ──────────────────────────────────────────────
    if (path === '/api/health' && req.method === 'GET') {
      return res.status(200).json({
        status: 'ok',
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        twilio:    !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
        meta:      !!process.env.META_ACCESS_TOKEN,
        whatsapp:  !!process.env.WHATSAPP_PHONE_NUMBER_ID,
        supabase:  !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
        timestamp: new Date().toISOString(),
      });
    }

    // ── WEBHOOKS ────────────────────────────────────────────
    if (path === '/api/webhook/whatsapp') {
      const business = await getBusinessProfile(DEFAULT_BUSINESS_ID);
      return whatsapp.handleWebhook(req, res, { business });
    }

    if (path === '/api/webhook/sms') {
      const business = await getBusinessProfile(DEFAULT_BUSINESS_ID);
      return sms.handleWebhook(req, res, { business });
    }

    if (path === '/api/webhook/instagram') {
      const business = await getBusinessProfile(DEFAULT_BUSINESS_ID);
      return instagram.handleWebhook(req, res, { business });
    }

    if (path === '/api/webhook/facebook') {
      const business = await getBusinessProfile(DEFAULT_BUSINESS_ID);
      return facebook.handleWebhook(req, res, { business });
    }

    // ── SUBSCRIBE ────────────────────────────────────────────
    if (path === '/api/subscribe' && req.method === 'POST') {
      const subscribe = require('./subscribe');
      return subscribe(req, res);
    }

    // ── ONBOARD ─────────────────────────────────────────────
    if (path === '/api/onboard' && req.method === 'POST') {
      const scraper = require('./lib/scraper');
      const { url } = req.body || {};
      if (!url) return res.status(400).json({ success: false, error: 'URL required' });

      const result = await scraper.scrape(url);
      if (!result.success) return res.status(422).json({ success: false, error: result.error });

      let savedBusiness = result.business;
      if (store.saveBusiness) {
        const saved = await store.saveBusiness({ ...result.business, sourceUrl: url });
        if (saved) savedBusiness = saved;
      }

      // Auto-suggest spaces for new business
      let spaceSuggestions = [];
      try {
        spaceSuggestions = await routing.suggestSpaces(savedBusiness);
      } catch (err) {
        console.error('[Onboard] Space suggestion failed:', err.message);
      }

      return res.status(200).json({
        success: true,
        business: savedBusiness,
        validation: result.validation,
        suggestedSpaces: spaceSuggestions,
      });
    }

    // ── CONVERSATIONS ────────────────────────────────────────
    if (path === '/api/conversations' && req.method === 'GET') {
      const businessId = query.businessId || DEFAULT_BUSINESS_ID;
      const spaceId    = query.spaceId || null;

      if (store.supabase) {
        let q = store.supabase
          .from('conversations')
          .select('*, messages(role, content, confidence, created_at), spaces(name, color)')
          .eq('business_id', businessId)
          .order('last_message_at', { ascending: false })
          .limit(50);

        if (spaceId === 'unrouted') {
          q = q.is('space_id', null);
        } else if (spaceId) {
          q = q.eq('space_id', spaceId);
        }

        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ success: true, conversations: data || [] });
      }

      return res.status(200).json({ success: true, conversations: [] });
    }

    // ── STATS ────────────────────────────────────────────────
    if (path === '/api/stats' && req.method === 'GET') {
      const businessId = query.businessId || DEFAULT_BUSINESS_ID;
      if (store.getBusinessStats) {
        const stats = await store.getBusinessStats(businessId);
        return res.status(200).json({ success: true, stats });
      }
      return res.status(200).json({ success: true, stats: {} });
    }

    // ── RESOLVE ──────────────────────────────────────────────
    if (path === '/api/conversations/resolve' && req.method === 'POST') {
      const { conversationId } = req.body || {};
      if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
      if (store.supabase) {
        await store.supabase
          .from('conversations')
          .update({ status: 'resolved', escalated: false })
          .eq('id', conversationId);
      }
      return res.status(200).json({ success: true });
    }

    // ── REPLY MEMORY: STATUS ─────────────────────────────────
    if (path === '/api/reply-memory' && req.method === 'GET') {
      const businessId = query.businessId || DEFAULT_BUSINESS_ID;
      try {
        const { getMemoryStatus } = require('./lib/reply-memory');
        const status = await getMemoryStatus(businessId, store.supabase);
        return res.status(200).json({ success: true, status });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── REPLY MEMORY: MANUAL TRIGGER ─────────────────────────
    if (path === '/api/reply-memory/analyse' && req.method === 'POST') {
      const { businessId = DEFAULT_BUSINESS_ID } = req.body || {};
      try {
        const { triggerManualAnalysis } = require('./lib/reply-memory');
        const result = await triggerManualAnalysis(businessId, store.supabase);
        return res.status(200).json(result);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── USAGE SUMMARY ────────────────────────────────────────
    if (path === '/api/usage' && req.method === 'GET') {
      const businessId = query.businessId || DEFAULT_BUSINESS_ID;
      try {
        const { getUsageSummary } = require('./lib/usage-tracker');
        const usage = await getUsageSummary(businessId, store.supabase);
        if (!usage) return res.status(404).json({ error: 'Business not found' });
        return res.status(200).json({ success: true, usage });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── SPACES: LIST ─────────────────────────────────────────
    if (path === '/api/spaces' && req.method === 'GET') {
      const businessId = query.businessId || DEFAULT_BUSINESS_ID;
      if (!store.supabase) return res.status(200).json({ success: true, spaces: [] });

      const { data, error } = await store.supabase
        .from('spaces')
        .select('*, space_members(*)')
        .eq('business_id', businessId)
        .order('sort_order', { ascending: true });

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, spaces: data || [] });
    }

    // ── SPACES: CREATE ───────────────────────────────────────
    if (path === '/api/spaces' && req.method === 'POST') {
      const { businessId = DEFAULT_BUSINESS_ID, name, keywords, color, members } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!store.supabase) return res.status(503).json({ error: 'Supabase not configured' });

      const { data, error } = await store.supabase
        .from('spaces')
        .insert({ business_id: businessId, name, keywords: keywords || [], color: color || '#D4734A' })
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ success: true, space: data });
    }

    // ── SPACES: UPDATE (toggle, rename, keywords) ────────────
    if (path.startsWith('/api/spaces/') && req.method === 'PUT') {
      const spaceId = path.split('/')[3];
      const updates = req.body || {};
      if (!store.supabase) return res.status(503).json({ error: 'Supabase not configured' });

      // Whitelist updatable fields
      const allowed = ['name', 'keywords', 'color', 'active', 'sort_order'];
      const safeUpdates = {};
      allowed.forEach(k => { if (updates[k] !== undefined) safeUpdates[k] = updates[k]; });

      const { data, error } = await store.supabase
        .from('spaces')
        .update(safeUpdates)
        .eq('id', spaceId)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, space: data });
    }

    // ── SPACES: DELETE ───────────────────────────────────────
    if (path.startsWith('/api/spaces/') && req.method === 'DELETE') {
      const spaceId = path.split('/')[3];
      if (!store.supabase) return res.status(503).json({ error: 'Supabase not configured' });

      const { error } = await store.supabase
        .from('spaces')
        .delete()
        .eq('id', spaceId);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    // ── SPACES: AI SUGGEST ───────────────────────────────────
    if (path === '/api/spaces/suggest' && req.method === 'POST') {
      const { businessId = DEFAULT_BUSINESS_ID } = req.body || {};
      const business = await getBusinessProfile(businessId);
      const suggestions = await routing.suggestSpaces(business);
      return res.status(200).json({ success: true, suggestions });
    }

    // ── SPACES: REROUTE CONVERSATION ─────────────────────────
    if (path === '/api/conversations/reroute' && req.method === 'POST') {
      const { conversationId, spaceId } = req.body || {};
      if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
      if (!store.supabase) return res.status(503).json({ error: 'Supabase not configured' });

      await store.supabase
        .from('conversations')
        .update({ space_id: spaceId || null, routing_reason: 'manual' })
        .eq('id', conversationId);

      return res.status(200).json({ success: true });
    }

    // ── 404 ─────────────────────────────────────────────────
    return res.status(404).json({ error: 'Route not found', path });

  } catch (err) {
    console.error('[Router] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
