/**
 * Guest.Manager — Usage Tracker
 * Counts AI replies per business per month.
 * Triggers notifications at 80% and 100% of plan cap.
 * Called after every successful AI reply.
 */

const OVERAGE_RATE = 0.03; // $ per message over cap

// ── PLAN CAPS (mirrors Supabase plans table) ─────────────────
const PLAN_CAPS = {
  trial:   250,
  starter: 250,
  growth:  1000,
  agency:  null, // unlimited
};

// ── NOTIFICATION MESSAGES ────────────────────────────────────
function build80Message(businessName, cap, plan) {
  return `Hi! This is Guest.Manager. 👋 A quick heads-up: ${businessName} has used 80% of its ${cap} monthly AI replies on the ${plan} plan. You still have ${Math.round(cap * 0.2)} replies left this month. If you're growing fast, you might want to upgrade to avoid any overage charges. Reply UPGRADE to learn more, or visit guestmanager.co/billing.`;
}

function build100Message(businessName, cap, plan, nextPlan) {
  return `Congratulations ${businessName}! 🎉 You've reached your ${cap} AI reply limit — that means your bot has been seriously busy this month! You're now on metered billing at $0.03 per additional AI reply (your bot keeps running, no interruptions). To get a higher cap and better value, upgrade to ${nextPlan} at guestmanager.co/billing. You're doing great!`;
}

function buildOverageMessage(businessName, extra, cost) {
  return `Guest.Manager update for ${businessName}: You've used ${extra} extra AI replies this month (beyond your cap). At $0.03 each, that's $${cost.toFixed(2)} in overages so far. Your bot is still running normally. Upgrade anytime at guestmanager.co/billing to get a higher cap.`;
}

function getNextPlan(currentPlan) {
  const ladder = { trial: 'Starter ($19/mo)', starter: 'Growth ($49/mo)', growth: 'Agency ($149/mo)', agency: null };
  return ladder[currentPlan] || 'a higher plan';
}

// ── CORE: INCREMENT USAGE ─────────────────────────────────────
/**
 * Called after every AI reply is sent.
 * Increments counter, checks thresholds, fires notifications.
 *
 * @param {string} businessId
 * @param {object} supabase  - supabase client
 * @param {object} opts      - { channel, contactId } for sending notifications
 */
async function trackAIReply(businessId, supabase, opts = {}) {
  if (!supabase || !businessId || businessId === 'demo') return;

  const month = new Date().toISOString().slice(0, 7); // "2026-04"

  try {
    // 1. Upsert monthly_usage — increment ai_replies atomically
    const { data: usage, error: upsertErr } = await supabase.rpc('increment_usage', {
      p_business_id: businessId,
      p_month: month,
    });

    if (upsertErr) {
      // RPC not available yet — fall back to manual upsert
      await manualIncrement(businessId, month, supabase);
      return;
    }

    // 2. Get current usage + plan info
    const current = await getCurrentUsage(businessId, supabase);
    if (!current) return;

    const cap = PLAN_CAPS[current.plan_id];
    if (cap === null) return; // unlimited plan — no tracking needed

    const used       = current.ai_replies;
    const pct        = used / cap;
    const isOverage  = used > cap;

    // 3. Check thresholds and notify
    if (isOverage) {
      const extra = used - cap;
      const cost  = extra * OVERAGE_RATE;

      // Update overage cost
      await supabase.from('monthly_usage').update({
        overage_msgs: extra,
        overage_cost: cost,
      }).eq('business_id', businessId).eq('month', month);

    } else if (pct >= 1.0 && !current.notified_100) {
      // Hit 100% — send congratulation + overage warning
      await sendUsageNotification(businessId, month, 100, current, supabase, opts);

    } else if (pct >= 0.8 && !current.notified_80) {
      // Hit 80% — send gentle heads-up
      await sendUsageNotification(businessId, month, 80, current, supabase, opts);
    }

  } catch (err) {
    console.error('[Usage] trackAIReply error:', err.message);
    // Never crash the bot over usage tracking
  }
}

// ── MANUAL INCREMENT FALLBACK ─────────────────────────────────
async function manualIncrement(businessId, month, supabase) {
  // Try to increment existing row
  const { data: existing } = await supabase
    .from('monthly_usage')
    .select('ai_replies')
    .eq('business_id', businessId)
    .eq('month', month)
    .single();

  if (existing) {
    await supabase.from('monthly_usage')
      .update({ ai_replies: (existing.ai_replies || 0) + 1 })
      .eq('business_id', businessId)
      .eq('month', month);
  } else {
    await supabase.from('monthly_usage').insert({
      business_id: businessId,
      month,
      ai_replies: 1,
    });
  }
}

// ── GET CURRENT USAGE ─────────────────────────────────────────
async function getCurrentUsage(businessId, supabase) {
  const month = new Date().toISOString().slice(0, 7);

  const { data, error } = await supabase
    .from('monthly_usage')
    .select('*, businesses(plan_id, owner_contact_id, owner_channel, trial_ends_at, name)')
    .eq('business_id', businessId)
    .eq('month', month)
    .single();

  if (error || !data) {
    // No usage record yet this month — return zeros
    const { data: biz } = await supabase
      .from('businesses')
      .select('plan_id, owner_contact_id, owner_channel, trial_ends_at, name')
      .eq('id', businessId)
      .single();

    return biz ? {
      ai_replies: 0, guest_msgs: 0, overage_msgs: 0, overage_cost: 0,
      notified_80: false, notified_100: false,
      plan_id: biz.plan_id || 'trial',
      owner_contact_id: biz.owner_contact_id,
      owner_channel: biz.owner_channel || 'sms',
      trial_ends_at: biz.trial_ends_at,
      business_name: biz.name,
    } : null;
  }

  return {
    ...data,
    plan_id:          data.businesses?.plan_id || 'trial',
    owner_contact_id: data.businesses?.owner_contact_id,
    owner_channel:    data.businesses?.owner_channel || 'sms',
    trial_ends_at:    data.businesses?.trial_ends_at,
    business_name:    data.businesses?.name,
  };
}

// ── SEND USAGE NOTIFICATION ───────────────────────────────────
async function sendUsageNotification(businessId, month, threshold, usage, supabase, opts) {
  const cap       = PLAN_CAPS[usage.plan_id] || 250;
  const planName  = usage.plan_id?.charAt(0).toUpperCase() + usage.plan_id?.slice(1) || 'Starter';
  const nextPlan  = getNextPlan(usage.plan_id);
  const bizName   = usage.business_name || 'your business';

  let messageText;
  if (threshold === 80) {
    messageText = build80Message(bizName, cap, planName);
  } else {
    messageText = build100Message(bizName, cap, planName, nextPlan);
  }

  // Mark as notified first (prevent double-send)
  const field = threshold === 80 ? 'notified_80' : 'notified_100';
  await supabase.from('monthly_usage')
    .update({ [field]: true })
    .eq('business_id', businessId)
    .eq('month', month);

  // Log the notification
  const contactId = opts.contactId || usage.owner_contact_id;
  const channel   = opts.channel   || usage.owner_channel || 'sms';

  await supabase.from('usage_notifications').insert({
    business_id:  businessId,
    month,
    threshold,
    channel,
    contact_id:   contactId,
    message_text: messageText,
  });

  // Send via SMS if we have a contact
  if (contactId && channel === 'sms') {
    await sendSMSNotification(contactId, messageText);
  }

  console.log(`[Usage] Sent ${threshold}% notification to ${contactId} for business ${businessId}`);
}

// ── SMS SENDER ────────────────────────────────────────────────
async function sendSMSNotification(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !from) return;

  try {
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const auth   = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (err) {
    console.error('[Usage] SMS notification failed:', err.message);
  }
}

// ── GET USAGE FOR DASHBOARD ───────────────────────────────────
async function getUsageSummary(businessId, supabase) {
  const month = new Date().toISOString().slice(0, 7);

  const { data: biz } = await supabase
    .from('businesses')
    .select('*, plans(*)')
    .eq('id', businessId)
    .single();

  if (!biz) return null;

  const { data: usage } = await supabase
    .from('monthly_usage')
    .select('*')
    .eq('business_id', businessId)
    .eq('month', month)
    .single();

  const { data: notifications } = await supabase
    .from('usage_notifications')
    .select('*')
    .eq('business_id', businessId)
    .order('sent_at', { ascending: false })
    .limit(10);

  const plan     = biz.plans || { id: 'trial', name: '14-Day Trial', monthly_price: 0, ai_cap: 250, overage_rate: 0.03 };
  const aiReplies = usage?.ai_replies || 0;
  const cap       = plan.ai_cap;
  const pct       = cap ? Math.min(100, Math.round((aiReplies / cap) * 100)) : 0;
  const overage   = Math.max(0, aiReplies - (cap || 0));
  const overageCost = overage * (plan.overage_rate || 0.03);

  const trialEnds   = biz.trial_ends_at ? new Date(biz.trial_ends_at) : null;
  const trialDaysLeft = trialEnds ? Math.max(0, Math.ceil((trialEnds - new Date()) / (1000 * 60 * 60 * 24))) : null;

  return {
    business: { id: biz.id, name: biz.name, plan_id: biz.plan_id },
    plan,
    usage: {
      month,
      ai_replies: aiReplies,
      guest_msgs: usage?.guest_msgs || 0,
      overage_msgs: overage,
      overage_cost: overageCost,
      notified_80:  usage?.notified_80 || false,
      notified_100: usage?.notified_100 || false,
    },
    meter: { pct, cap, used: aiReplies, isOverage: overage > 0 },
    trial: { active: !!trialEnds, daysLeft: trialDaysLeft, endsAt: biz.trial_ends_at },
    notifications: notifications || [],
    nextPlan: getNextPlan(biz.plan_id),
  };
}

module.exports = { trackAIReply, getUsageSummary, getCurrentUsage, OVERAGE_RATE, PLAN_CAPS };
