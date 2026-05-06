/**
 * Guest.Manager — Auth middleware
 * Validates Supabase JWT and resolves businessId for the caller.
 */

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function requireAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { const e = new Error('Missing token'); e.status = 401; throw e; }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { const e = new Error('Invalid token'); e.status = 401; throw e; }

  const { data: biz } = await supabase.from('businesses').select('id').eq('user_id', user.id).single();
  if (!biz) { const e = new Error('No business for user'); e.status = 403; throw e; }

  return { userId: user.id, businessId: biz.id };
}

module.exports = { requireAuth };
