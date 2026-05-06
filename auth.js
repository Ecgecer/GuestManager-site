(async function () {
  const { supabaseUrl, supabaseAnonKey } = window.GM_CONFIG;
  const sb = supabase.createClient(supabaseUrl, supabaseAnonKey);

  async function requireSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      window.location.href = '/login.html';
      return null;
    }
    return session;
  }

  async function authFetch(url, opts = {}) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { window.location.href = '/login.html'; return null; }
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}), Authorization: `Bearer ${session.access_token}` };
    return fetch(url, { ...opts, headers });
  }

  async function signOut() {
    await sb.auth.signOut();
    window.location.href = '/login.html';
  }

  window.GM = { sb, requireSession, authFetch, signOut };
})();
