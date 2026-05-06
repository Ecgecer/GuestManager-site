/**
 * Guest.Manager — API Router (Multi-tenant edition)
 */

const store     = require('./lib/conversation-store');
const whatsapp  = require('./lib/whatsapp');
const sms       = require('./lib/sms');
const instagram = require('./lib/instagram');
const facebook  = require('./lib/facebook');
const routing   = require('./lib/routing-engine');
const { requireAuth } = require('./lib/auth');
const {
  getCredentialsByWhatsAppPhoneNumberId,
  getCredentialsByMetaPageId,
  getCredentialsByTwilioNumber,
  getCredentialsByBusinessId,
  saveCredentials,
} = require('./lib/credentials');

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

async function sendEscalationAlert(business, alertText) {
  const ownerNumber = process.env.OWNER_WHATSAPP_NUMBER;
  if (!ownerNumber) {
    console.warn('[Router] Escalation not sent — set OWNER_WHATSAPP_NUMBER env var. Alert:', alertText);
    return;
  }
  try {
    await whatsapp.sendWhatsAppMessage(ownerNumber, alertText, business);
  } catch (err) {
    console.error('[Router] Escalation alert failed:', err.message);
  }
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── CONFIG (public, no auth) ──────────────────────────────
  if (req.url.split('?')[0] === '/api/config.js' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(
      `window.GM_CONFIG = ${JSON.stringify({
        supabaseUrl:    process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
      })};`
    );
  }

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

    // ── ME ───────────────────────────────────────────────────
    if (path === '/api/me' && req.method === 'GET') {
      const { businessId, userId } = await requireAuth(req);
      const biz = await getBusinessProfile(businessId);
      return res.status(200).json({ success: true, businessId, userId, business: biz });
    }

    // ── WEBHOOKS ────────────────────────────────────────────
    if (path === '/api/webhook/whatsapp') {
      if (req.method === 'GET') return whatsapp.verifyWebhook(req, res);
      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      const pnid  = value?.metadata?.phone_number_id;
      if (!pnid) return res.status(200).end();
      const creds = await getCredentialsByWhatsAppPhoneNumberId(pnid)
        || (process.env.WHATSAPP_PHONE_NUMBER_ID === pnid ? {
            businessId: process.env.DEFAULT_BUSINESS_ID || 'demo',
            whatsapp: { phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID, accessToken: process.env.META_ACCESS_TOKEN, verifyToken: process.env.WHATSAPP_VERIFY_TOKEN }
          } : null);
      if (!creds) { console.warn('[WA] Unknown phone_number_id:', pnid); return res.status(200).end(); }
      const business = await getBusinessProfile(creds.businessId);
      return whatsapp.handleWebhook(req, res, { business, creds, sendEscalationAlert });
    }

    if (path === '/api/webhook/sms') {
      const toNumber = req.body?.To;
      const creds = toNumber
        ? (await getCredentialsByTwilioNumber(toNumber) || (process.env.TWILIO_PHONE_NUMBER === toNumber ? {
            businessId: process.env.DEFAULT_BUSINESS_ID || 'demo',
            twilio: { accountSid: process.env.TWILIO_ACCOUNT_SID, authToken: process.env.TWILIO_AUTH_TOKEN, phoneNumber: process.env.TWILIO_PHONE_NUMBER }
          } : null))
        : null;
      if (!creds) { res.setHeader('Content-Type', 'text/xml'); return res.status(200).send('<Response></Response>'); }
      const business = await getBusinessProfile(creds.businessId);
      return sms.handleWebhook(req, res, { business, creds });
    }

    if (path === '/api/webhook/instagram') {
      if (req.method === 'GET') return instagram.verifyWebhook ? instagram.verifyWebhook(req, res) : res.status(200).send(req.query?.['hub.challenge'] || 'ok');
      const pageId = req.body?.entry?.[0]?.id;
      if (!pageId) return res.status(200).end();
      const creds = await getCredentialsByMetaPageId(pageId)
        || (process.env.INSTAGRAM_PAGE_ID === pageId ? {
            businessId: process.env.DEFAULT_BUSINESS_ID || 'demo',
            instagram: { pageId: process.env.INSTAGRAM_PAGE_ID, accessToken: process.env.META_ACCESS_TOKEN }
          } : null);
      if (!creds) return res.status(200).end();
      const business = await getBusinessProfile(creds.businessId);
      return instagram.handleWebhook(req, res, { business, creds, sendEscalationAlert });
    }

    if (path === '/api/webhook/facebook') {
      if (req.method === 'GET') return facebook.verifyWebhook ? facebook.verifyWebhook(req, res) : res.status(200).send(req.query?.['hub.challenge'] || 'ok');
      const pageId = req.body?.entry?.[0]?.id;
      if (!pageId) return res.status(200).end();
      const creds = await getCredentialsByMetaPageId(pageId)
        || (process.env.FACEBOOK_PAGE_ID === pageId ? {
            businessId: process.env.DEFAULT_BUSINESS_ID || 'demo',
            facebook: { pageId: process.env.FACEBOOK_PAGE_ID, accessToken: process.env.META_ACCESS_TOKEN }
          } : null);
      if (!creds) return res.status(200).end();
      const business = await getBusinessProfile(creds.businessId);
      return facebook.handleWebhook(req, res, { business, creds, sendEscalationAlert });
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
      const { businessId } = await requireAuth(req);
      const spaceId = query.spaceId || null;

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
      const { businessId } = await requireAuth(req);
      if (store.getBusinessStats) {
        const stats = await store.getBusinessStats(businessId);
        return res.status(200).json({ success: true, stats });
      }
      return res.status(200).json({ success: true, stats: {} });
    }

    // ── RESOLVE ──────────────────────────────────────────────
    if (path === '/api/conversations/resolve' && req.method === 'POST') {
      await requireAuth(req);
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
      const { businessId } = await requireAuth(req);
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
      const { businessId } = await requireAuth(req);
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
      const { businessId } = await requireAuth(req);
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
      const { businessId } = await requireAuth(req);
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
      const { businessId } = await requireAuth(req);
      const { name, keywords, color, members } = req.body || {};
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

    // ── SPACES: AI SUGGEST ───────────────────────────────────
    if (path === '/api/spaces/suggest' && req.method === 'POST') {
      const { businessId } = await requireAuth(req);
      const business = await getBusinessProfile(businessId);
      const suggestions = await routing.suggestSpaces(business);
      return res.status(200).json({ success: true, suggestions });
    }

    // ── SPACES: UPDATE (toggle, rename, keywords) ────────────
    if (path.startsWith('/api/spaces/') && req.method === 'PUT') {
      await requireAuth(req);
      const spaceId = path.split('/')[3];
      const updates = req.body || {};
      if (!store.supabase) return res.status(503).json({ error: 'Supabase not configured' });

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
      await requireAuth(req);
      const spaceId = path.split('/')[3];
      if (!store.supabase) return res.status(503).json({ error: 'Supabase not configured' });

      const { error } = await store.supabase
        .from('spaces')
        .delete()
        .eq('id', spaceId);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    // ── SPACES: REROUTE CONVERSATION ─────────────────────────
    if (path === '/api/conversations/reroute' && req.method === 'POST') {
      await requireAuth(req);
      const { conversationId, spaceId } = req.body || {};
      if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
      if (!store.supabase) return res.status(503).json({ error: 'Supabase not configured' });

      await store.supabase
        .from('conversations')
        .update({ space_id: spaceId || null, routing_reason: 'manual' })
        .eq('id', conversationId);

      return res.status(200).json({ success: true });
    }

    // ── CREDENTIALS: GET ─────────────────────────────────────
    if (path === '/api/credentials' && req.method === 'GET') {
      const { businessId } = await requireAuth(req);
      const { supabase } = require('./lib/conversation-store');
      const { data } = await supabase.from('business_credentials').select('*').eq('business_id', businessId).single();
      if (!data) return res.status(200).json({ success: true, channels: {
        whatsapp:  { connected: false },
        instagram: { connected: false },
        facebook:  { connected: false },
        sms:       { connected: false },
      }});
      return res.status(200).json({ success: true, channels: {
        whatsapp:  data.whatsapp_phone_number_id  ? { connected: true, displayNumber: data.whatsapp_display_number, phoneNumberId: data.whatsapp_phone_number_id } : { connected: false },
        instagram: data.instagram_page_id         ? { connected: true, username: data.instagram_username, pageId: data.instagram_page_id }                         : { connected: false },
        facebook:  data.facebook_page_id          ? { connected: true, pageName: data.facebook_page_name, pageId: data.facebook_page_id }                          : { connected: false },
        sms:       data.twilio_phone_number        ? { connected: true, phoneNumber: data.twilio_phone_number }                                                      : { connected: false },
      }});
    }

    // ── CREDENTIALS: SAVE ────────────────────────────────────
    if (path.startsWith('/api/credentials/') && req.method === 'PUT') {
      const { businessId } = await requireAuth(req);
      const channel = path.split('/')[3];
      const body = req.body || {};
      await saveCredentials(businessId, channel, body);
      return res.status(200).json({ success: true });
    }

    // ── CREDENTIALS: DELETE (disconnect channel) ─────────────
    if (path.startsWith('/api/credentials/') && req.method === 'DELETE') {
      const { businessId } = await requireAuth(req);
      const channel = path.split('/')[3];
      const { supabase } = require('./lib/conversation-store');
      const clearFields = {
        whatsapp:  { whatsapp_phone_number_id: null, whatsapp_access_token_encrypted: null, whatsapp_verify_token: null, whatsapp_display_number: null, whatsapp_business_account_id: null },
        instagram: { instagram_page_id: null, instagram_access_token_encrypted: null, instagram_username: null },
        facebook:  { facebook_page_id: null, facebook_access_token_encrypted: null, facebook_page_name: null },
        sms:       { twilio_account_sid: null, twilio_auth_token_encrypted: null, twilio_phone_number: null },
      };
      if (!clearFields[channel]) return res.status(400).json({ error: 'Unknown channel' });
      await supabase.from('business_credentials').update(clearFields[channel]).eq('business_id', businessId);
      return res.status(200).json({ success: true });
    }

    // ── META OAUTH: INITIATE ─────────────────────────────────
    if (path === '/api/auth/meta' && req.method === 'GET') {
      const token   = query.token;
      const channel = query.channel || 'instagram';
      if (!token) return res.status(400).json({ error: 'token required' });

      const { data: { user }, error: authErr } = await store.supabase.auth.getUser(token);
      if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

      const { data: biz } = await store.supabase.from('businesses').select('id').eq('user_id', user.id).single();
      if (!biz) return res.status(403).json({ error: 'No business' });

      const state = Buffer.from(JSON.stringify({ businessId: biz.id, channel })).toString('base64url');
      const scopes = channel === 'facebook'
        ? 'pages_messaging,pages_show_list,pages_read_engagement'
        : 'instagram_business_basic,instagram_business_manage_messages,instagram_manage_comments';

      const oauthUrl = new URL('https://www.facebook.com/dialog/oauth');
      oauthUrl.searchParams.set('client_id',    process.env.FACEBOOK_APP_ID);
      oauthUrl.searchParams.set('redirect_uri', 'https://guestmanager.co/api/auth/meta/callback');
      oauthUrl.searchParams.set('scope',        scopes);
      oauthUrl.searchParams.set('state',        state);
      oauthUrl.searchParams.set('response_type','code');

      res.setHeader('Location', oauthUrl.toString());
      return res.status(302).end();
    }

    // ── META OAUTH: CALLBACK ─────────────────────────────────
    if (path === '/api/auth/meta/callback' && req.method === 'GET') {
      if (query.error) {
        res.setHeader('Location', '/settings.html?error=access_denied');
        return res.status(302).end();
      }

      const { code, state } = query;
      if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

      let businessId, channel;
      try {
        const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
        businessId = decoded.businessId;
        channel    = decoded.channel;
      } catch {
        return res.status(400).json({ error: 'Invalid state' });
      }

      const appId     = process.env.FACEBOOK_APP_ID;
      const appSecret = process.env.FACEBOOK_APP_SECRET;
      const redirect  = 'https://guestmanager.co/api/auth/meta/callback';

      // Exchange code → short-lived token
      const tokenRes  = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirect)}&code=${code}`);
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        console.error('[Meta OAuth] Token exchange failed:', tokenData);
        res.setHeader('Location', '/settings.html?error=token_exchange');
        return res.status(302).end();
      }

      // Exchange → long-lived token (60 days)
      const longRes  = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenData.access_token}`);
      const longData = await longRes.json();
      const userToken = longData.access_token || tokenData.access_token;

      // Fetch pages + connected Instagram accounts
      const pagesRes  = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${userToken}`);
      const pagesData = await pagesRes.json();
      const pages     = pagesData.data || [];

      if (channel === 'instagram') {
        const page = pages.find(p => p.instagram_business_account);
        if (!page) {
          res.setHeader('Location', '/settings.html?error=no_instagram');
          return res.status(302).end();
        }
        await saveCredentials(businessId, 'instagram', {
          pageId:      page.instagram_business_account.id,
          accessToken: page.access_token,
          username:    page.instagram_business_account.username || '',
        });
      } else if (channel === 'facebook') {
        const page = pages[0];
        if (!page) {
          res.setHeader('Location', '/settings.html?error=no_pages');
          return res.status(302).end();
        }
        await saveCredentials(businessId, 'facebook', {
          pageId:      page.id,
          accessToken: page.access_token,
          pageName:    page.name,
        });
      }

      res.setHeader('Location', `/settings.html?connected=${channel}`);
      return res.status(302).end();
    }

    // ── 404 ─────────────────────────────────────────────────
    return res.status(404).json({ error: 'Route not found', path });

  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[Router] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
