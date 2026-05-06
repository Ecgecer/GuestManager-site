/**
 * Guest.Manager — Encrypted credential store
 * Reads/writes per-business channel credentials from business_credentials table.
 * Uses AES-256-GCM with CREDENTIAL_ENCRYPTION_KEY env var (32 bytes base64).
 */

const crypto = require('crypto');
const { supabase } = require('./conversation-store');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

// ── IN-MEMORY CACHE ──────────────────────────────────────────
const cache = new Map(); // key -> { data, expiresAt }
const CACHE_TTL = 60 * 1000; // 60 seconds

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return undefined; }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

// ── ENCRYPTION ───────────────────────────────────────────────

function getKey() {
  const b64 = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!b64) throw new Error('CREDENTIAL_ENCRYPTION_KEY env var not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (base64-encoded)');
  return key;
}

/**
 * Encrypt plaintext string.
 * Output format (base64): [IV (12 bytes)][TAG (16 bytes)][ciphertext]
 */
function encrypt(plain) {
  if (plain == null) return null;
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt base64 ciphertext produced by encrypt().
 * Returns null gracefully if input is null/undefined.
 */
function decrypt(b64) {
  if (b64 == null) return null;
  try {
    const key = getKey();
    const buf  = Buffer.from(b64, 'base64');
    const iv   = buf.slice(0, IV_LENGTH);
    const tag  = buf.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const data = buf.slice(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data) + decipher.final('utf8');
  } catch (err) {
    console.error('[Credentials] Decrypt error:', err.message);
    return null;
  }
}

// ── ROW -> SHAPE ─────────────────────────────────────────────

function rowToShape(row) {
  return {
    businessId: row.business_id,
    whatsapp: row.whatsapp_phone_number_id ? {
      phoneNumberId:      row.whatsapp_phone_number_id,
      accessToken:        decrypt(row.whatsapp_access_token_encrypted),
      verifyToken:        row.whatsapp_verify_token,
      displayNumber:      row.whatsapp_display_number,
      businessAccountId:  row.whatsapp_business_account_id,
    } : null,
    instagram: row.instagram_page_id ? {
      pageId:       row.instagram_page_id,
      accessToken:  decrypt(row.instagram_access_token_encrypted),
      username:     row.instagram_username,
    } : null,
    facebook: row.facebook_page_id ? {
      pageId:       row.facebook_page_id,
      accessToken:  decrypt(row.facebook_access_token_encrypted),
      pageName:     row.facebook_page_name,
    } : null,
    twilio: row.twilio_account_sid ? {
      accountSid:   row.twilio_account_sid,
      authToken:    decrypt(row.twilio_auth_token_encrypted),
      phoneNumber:  row.twilio_phone_number,
    } : null,
  };
}

// ── LOOKUPS ──────────────────────────────────────────────────

async function getCredentialsByBusinessId(businessId) {
  const cacheKey = `biz:${businessId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const { data, error } = await supabase
    .from('business_credentials')
    .select('*')
    .eq('business_id', businessId)
    .single();

  if (error || !data) { cacheSet(cacheKey, null); return null; }
  const result = rowToShape(data);
  cacheSet(cacheKey, result);
  return result;
}

async function getCredentialsByWhatsAppPhoneNumberId(pnid) {
  const cacheKey = `wa:${pnid}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const { data, error } = await supabase
    .from('business_credentials')
    .select('*')
    .eq('whatsapp_phone_number_id', pnid)
    .single();

  if (error || !data) { cacheSet(cacheKey, null); return null; }
  const result = rowToShape(data);
  cacheSet(cacheKey, result);
  return result;
}

async function getCredentialsByMetaPageId(pageId) {
  const cacheKey = `meta:${pageId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  // Check instagram_page_id first, then facebook_page_id
  let { data, error } = await supabase
    .from('business_credentials')
    .select('*')
    .eq('instagram_page_id', pageId)
    .single();

  if (error || !data) {
    ({ data, error } = await supabase
      .from('business_credentials')
      .select('*')
      .eq('facebook_page_id', pageId)
      .single());
  }

  if (error || !data) { cacheSet(cacheKey, null); return null; }
  const result = rowToShape(data);
  cacheSet(cacheKey, result);
  return result;
}

async function getCredentialsByTwilioNumber(toNumber) {
  const cacheKey = `twilio:${toNumber}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const { data, error } = await supabase
    .from('business_credentials')
    .select('*')
    .eq('twilio_phone_number', toNumber)
    .single();

  if (error || !data) { cacheSet(cacheKey, null); return null; }
  const result = rowToShape(data);
  cacheSet(cacheKey, result);
  return result;
}

// ── SAVE CREDENTIALS ─────────────────────────────────────────

const CHANNEL_FIELD_MAP = {
  whatsapp: {
    phoneNumberId:      'whatsapp_phone_number_id',
    businessAccountId:  'whatsapp_business_account_id',
    accessToken:        { col: 'whatsapp_access_token_encrypted', encrypt: true },
    verifyToken:        'whatsapp_verify_token',
    displayNumber:      'whatsapp_display_number',
  },
  instagram: {
    pageId:       'instagram_page_id',
    accessToken:  { col: 'instagram_access_token_encrypted', encrypt: true },
    username:     'instagram_username',
  },
  facebook: {
    pageId:       'facebook_page_id',
    accessToken:  { col: 'facebook_access_token_encrypted', encrypt: true },
    pageName:     'facebook_page_name',
  },
  sms: {
    accountSid:   'twilio_account_sid',
    authToken:    { col: 'twilio_auth_token_encrypted', encrypt: true },
    phoneNumber:  'twilio_phone_number',
  },
};

async function saveCredentials(businessId, channel, fields) {
  const map = CHANNEL_FIELD_MAP[channel];
  if (!map) throw new Error(`Unknown channel: ${channel}`);

  const row = { business_id: businessId };
  for (const [fieldKey, colDef] of Object.entries(map)) {
    if (fields[fieldKey] === undefined) continue;
    if (typeof colDef === 'object' && colDef.encrypt) {
      row[colDef.col] = encrypt(fields[fieldKey]);
    } else {
      row[colDef] = fields[fieldKey];
    }
  }

  const { error } = await supabase
    .from('business_credentials')
    .upsert(row, { onConflict: 'business_id' });

  if (error) throw new Error(`saveCredentials error: ${error.message}`);

  // Invalidate cache for this business
  for (const key of cache.keys()) {
    if (key.startsWith(`biz:${businessId}`)) cache.delete(key);
  }
}

module.exports = {
  encrypt,
  decrypt,
  getCredentialsByBusinessId,
  getCredentialsByWhatsAppPhoneNumberId,
  getCredentialsByMetaPageId,
  getCredentialsByTwilioNumber,
  saveCredentials,
};
