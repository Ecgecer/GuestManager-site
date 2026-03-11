/**
 * Guest.Manager — Main API Router
 * Single entry point for all webhooks and API calls
 * Deploy as Vercel serverless functions
 */

const qs = require('querystring');
const whatsapp  = require('./lib/whatsapp');
const sms       = require('./lib/sms');
const instagram = require('./lib/instagram');
const facebook  = require('./lib/facebook');
const { scrapeBusinessFromUrl, validateBusinessData } = require('./lib/scraper');
const { getBusinessStats } = require('./lib/conversation-store');

// ─── MOCK BUSINESS STORE ───────────────────────────────────────────
// In production: replace with your database (Supabase, PlanetScale, etc.)
const BUSINESSES = {
  'demo': {
    id: 'demo',
    name: 'Studio Bloom',
    type: 'spa & wellness',
    hours: 'Mon-Sat 9am-7pm, Sun 10am-5pm',
    location: 'Berlin Mitte',
    phone: '+49 30 12345678',
    services: ['Facial', 'Massage', 'Manicure', 'Pedicure', 'Waxing'],
    pricing: { 'Facial': '€65', 'Massage': '€80', 'Manicure': '€35', 'Pedicure': '€45' },
    faqs: [
      { q: 'Do I need to book in advance?', a: 'Yes, booking in advance is recommended. Walk-ins are welcome when available.' },
      { q: 'What should I bring?', a: 'Just yourself! We provide everything you need.' },
      { q: 'Do you have parking?', a: 'Street parking is available nearby. The nearest underground car park is 2 minutes away.' },
    ],
    bookingUrl: 'https://studiobloom.com/book',
    notes: 'First-time guests get 10% off. We use organic, cruelty-free products.',
    ownerWhatsApp: process.env.OWNER_WHATSAPP_NUMBER,
    replyMemory: 'Warm and welcoming tone. Use guest name when known. Sign off with "See you soon 🌿"',
  },
};

function getBusiness(req) {
  // In production: look up by subdomain, API key, or phone number
  const businessId = req.headers['x-business-id'] || req.query.businessId || 'demo';
  return BUSINESSES[businessId] || BUSINESSES['demo'];
}

/**
 * Escalation alert — notifies business owner via WhatsApp
 */
async function sendEscalationAlert(business, alertText) {
  if (!business.ownerWhatsApp) return;
  try {
    await whatsapp.sendWhatsAppMessage(business.ownerWhatsApp, alertText, business);
  } catch (err) {
    console.error('Escalation alert failed:', err);
  }
}

// ─── WEBHOOK HANDLERS ──────────────────────────────────────────────

/**
 * /api/webhook/whatsapp
 * GET  — Meta verification challenge
 * POST — Incoming messages
 */
async function whatsappWebhook(req, res) {
  if (req.method === 'GET')  return whatsapp.verifyWebhook(req, res);
  if (req.method === 'POST') {
    const business = getBusiness(req);
    return whatsapp.handleWebhook(req, res, { business, sendEscalationAlert });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * /api/webhook/sms
 * POST — Twilio incoming SMS
 */
async function smsWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const business = getBusiness(req);
  return sms.handleWebhook(req, res, { business, sendEscalationAlert });
}

/**
 * /api/webhook/instagram
 * GET  — Meta verification
 * POST — Incoming DMs
 */
async function instagramWebhook(req, res) {
  if (req.method === 'GET') {
    // Instagram uses same verify flow as WhatsApp
    return whatsapp.verifyWebhook(req, res);
  }
  if (req.method === 'POST') {
    const business = getBusiness(req);
    return instagram.handleWebhook(req, res, { business, sendEscalationAlert });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * /api/webhook/facebook
 * GET  — Meta verification
 * POST — Incoming messages
 */
async function facebookWebhook(req, res) {
  if (req.method === 'GET')  return whatsapp.verifyWebhook(req, res);
  if (req.method === 'POST') {
    const business = getBusiness(req);
    return facebook.handleWebhook(req, res, { business, sendEscalationAlert });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * /api/onboard
 * POST — 60-second onboarding: scrape URL and return business profile
 */
async function onboard(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const businessData = await scrapeBusinessFromUrl(url);
    const validation   = validateBusinessData(businessData);

    return res.status(200).json({
      success: true,
      business: businessData,
      validation,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * /api/stats
 * GET — Business stats for dashboard
 */
async function stats(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const business = getBusiness(req);
  const data = getBusinessStats(business.id);
  return res.status(200).json(data);
}

/**
 * /api/health
 * GET — Health check
 */
async function health(req, res) {
  return res.status(200).json({
    status: 'ok',
    version: '1.0.0',
    product: 'Guest.Manager',
    timestamp: new Date().toISOString(),
    env: {
      anthropic:  !!process.env.ANTHROPIC_API_KEY,
      twilio:     !!process.env.TWILIO_ACCOUNT_SID,
      meta:       !!process.env.META_ACCESS_TOKEN,
      whatsapp:   !!process.env.WHATSAPP_PHONE_NUMBER_ID,
    },
  });
}

module.exports = async function handler(req, res) {
  // Parse form-encoded body (Twilio sends this format)
  if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    req.body = qs.parse(Buffer.concat(buffers).toString());
  }

  const path = req.url.split('?')[0].replace(/\/$/, '');

  if (path === '/api/health')            return health(req, res);
  if (path === '/api/stats')             return stats(req, res);
  if (path === '/api/onboard')           return onboard(req, res);
  if (path === '/api/webhook/whatsapp')  return whatsappWebhook(req, res);
  if (path === '/api/webhook/sms')       return smsWebhook(req, res);
  if (path === '/api/webhook/instagram') return instagramWebhook(req, res);
  if (path === '/api/webhook/facebook')  return facebookWebhook(req, res);

  return res.status(404).json({ error: 'Not found' });
};
