/**
 * Guest.Manager — API Router (Supabase edition)
 * Single entry point for all serverless routes.
 * vercel.json rewrites /api/* → this file.
 */

const store     = require('./lib/conversation-store');
const whatsapp  = require('./lib/whatsapp');
const sms       = require('./lib/sms');
const instagram = require('./lib/instagram');
const facebook  = require('./lib/facebook');

// ── CORS HELPER ──────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── DEFAULT BUSINESS ID ──────────────────────────────────────
// Hardcoded during beta; replaced with auth lookup in production
const DEFAULT_BUSINESS_ID = process.env.DEFAULT_BUSINESS_ID || 'demo';

// ── DEMO BUSINESS FALLBACK ───────────────────────────────────
// Used when Supabase has no matching business (dev/demo mode)
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
  // Try Supabase first
  if (store.getBusiness) {
    const biz = await store.getBusiness(businessId);
    if (biz) return biz;
  }
  // Fall back to hardcoded demo
  return BUSINESSES[businessId] || BUSINESSES.demo;
}

// ── MAIN HANDLER ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0];
  console.log(`[Router] ${req.method} ${path}`);

  try {

    // ── HEALTH ──────────────────────────────────────────────
    if (path === '/api/health' && req.method === 'GET') {
      const supabaseOk = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
      return res.status(200).json({
        status: 'ok',
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        twilio:    !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
        meta:      !!process.env.META_ACCESS_TOKEN,
        whatsapp:  !!process.env.WHATSAPP_PHONE_NUMBER_ID,
        supabase:  supabaseOk,
        timestamp: new Date().toISOString(),
      });
    }

    // ── WEBHOOKS ────────────────────────────────────────────
    if (path === '/api/webhook/whatsapp') {
      const business = await getBusinessProfile(DEFAULT_BUSINESS_ID);
      return whatsapp.handle(req, res, business);
    }

    if (path === '/api/webhook/sms') {
      const business = await getBusinessProfile(DEFAULT_BUSINESS_ID);
      return sms.handle(req, res, business);
    }

    if (path === '/api/webhook/instagram') {
      const business = await getBusinessProfile(DEFAULT_BUSINESS_ID);
      return instagram.handle(req, res, business);
    }

    if (path === '/api/webhook/facebook') {
      const business = await getBusinessProfile(DEFAULT_BUSINESS_ID);
      return facebook.handle(req, res, business);
    }

    // ── SUBSCRIBE (waitlist) ─────────────────────────────────
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

      if (!result.success) {
        return res.status(422).json({ success: false, error: result.error });
      }

      // Persist to Supabase if store supports it
      let savedBusiness = result.business;
      if (store.saveBusiness) {
        const saved = await store.saveBusiness({
          ...result.business,
          sourceUrl: url,
        });
        if (saved) savedBusiness = saved;
      }

      return res.status(200).json({
        success: true,
        business: savedBusiness,
        validation: result.validation,
      });
    }

    // ── CONVERSATIONS (dashboard) ───────────────────────────
    if (path === '/api/conversations' && req.method === 'GET') {
      const businessId = req.query?.businessId || DEFAULT_BUSINESS_ID;

      if (store.getBusinessSessions) {
        const sessions = await store.getBusinessSessions(businessId);
        return res.status(200).json({ success: true, conversations: sessions });
      }

      return res.status(200).json({ success: true, conversations: [] });
    }

    // ── STATS (dashboard) ───────────────────────────────────
    if (path === '/api/stats' && req.method === 'GET') {
      const businessId = req.query?.businessId || DEFAULT_BUSINESS_ID;

      if (store.getBusinessStats) {
        const stats = await store.getBusinessStats(businessId);
        return res.status(200).json({ success: true, stats });
      }

      return res.status(200).json({
        success: true,
        stats: {
          totalSessionsToday: 0,
          totalSessionsWeek: 0,
          totalMessagesWeek: 0,
          escalatedWeek: 0,
          aiHandledWeek: 0,
          aiHandledRate: 0,
        },
      });
    }

    // ── RESOLVE CONVERSATION ────────────────────────────────
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

    // ── 404 ─────────────────────────────────────────────────
    return res.status(404).json({ error: 'Route not found', path });

  } catch (err) {
    console.error('[Router] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
