export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS headers so the landing page can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  try {
    // Add contact to Resend audience
    const audienceId = process.env.RESEND_AUDIENCE_ID;
    const apiKey = process.env.RESEND_API_KEY;

    const contactRes = await fetch(
      `https://api.resend.com/audiences/${audienceId}/contacts`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          subscribed: true,
        }),
      }
    );

    if (!contactRes.ok) {
      const err = await contactRes.json();
      // If contact already exists, treat as success
      if (err?.name === 'validation_error' && err?.message?.includes('already exists')) {
        return res.status(200).json({ success: true, message: 'Already on the list!' });
      }
      throw new Error(err?.message || 'Resend error');
    }

    // Send a confirmation email to the user
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Guest.Manager <hello@guestmanager.co>',
        to: email,
        subject: "You're on the Guest.Manager waitlist 🌿",
        html: `
          <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 40px 24px; color: #2E2C29;">
            <div style="font-size: 22px; font-weight: 700; margin-bottom: 6px;">
              Guest<span style="color: #C4613A;">.</span>Manager
            </div>
            <div style="height: 1px; background: #E0D9D1; margin: 16px 0 28px;"></div>
            <p style="font-size: 17px; line-height: 1.6; margin-bottom: 16px;">
              You're on the list. 🎉
            </p>
            <p style="font-size: 15px; color: #6E6860; line-height: 1.7; margin-bottom: 24px;">
              We're putting the finishing touches on Guest.Manager — AI messaging that handles your WhatsApp, SMS, and Instagram so you can focus on your guests.
            </p>
            <p style="font-size: 15px; color: #6E6860; line-height: 1.7; margin-bottom: 32px;">
              You'll be among the first to get access. We'll reach out personally when your spot is ready.
            </p>
            <div style="height: 1px; background: #E0D9D1; margin-bottom: 24px;"></div>
            <p style="font-size: 13px; color: #9A948C;">
              — The Guest.Manager team<br/>
              <a href="https://guestmanager.co" style="color: #C4613A;">guestmanager.co</a>
            </p>
          </div>
        `,
      }),
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Subscribe error:', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
