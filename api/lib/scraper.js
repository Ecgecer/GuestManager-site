/**
 * Guest.Manager — Business Scraper
 * Powers the 60-second onboarding — paste URL, we do the rest
 * Uses Claude to intelligently extract business context
 */

/**
 * Scrape and parse business info from a URL
 */
async function scrapeBusinessFromUrl(url) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Fetch the page content
  let pageContent = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GuestManagerBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    pageContent = await res.text();
    // Strip HTML tags for cleaner input
    pageContent = pageContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 6000); // limit to 6k chars
  } catch (err) {
    throw new Error(`Could not fetch URL: ${err.message}`);
  }

  // Use Claude to extract structured business info
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Extract business information from this webpage content and return ONLY valid JSON, no other text.

URL: ${url}
Content: ${pageContent}

Return this exact JSON structure (use null for missing fields, never guess):
{
  "name": "business name",
  "type": "type of business (e.g. hair salon, restaurant, gym)",
  "hours": "opening hours as a clear string",
  "location": "address or area",
  "phone": "phone number or null",
  "services": ["service 1", "service 2"],
  "pricing": {"service name": "price"},
  "faqs": [{"q": "question", "a": "answer"}],
  "bookingUrl": "booking URL or null",
  "notes": "any other important info for customer service",
  "confidence": 0.0-1.0
}`,
      }],
    }),
  });

  if (!res.ok) throw new Error('Claude extraction failed');

  const data = await res.json();
  const text = data.content[0]?.text || '';

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    throw new Error('Could not parse business data');
  }
}

/**
 * Validate scraped business data quality
 */
function validateBusinessData(data) {
  const issues = [];
  if (!data.name)      issues.push('Business name not found');
  if (!data.hours)     issues.push('Opening hours not found');
  if (!data.services?.length) issues.push('Services not found');
  if (data.confidence < 0.6)  issues.push('Low confidence — manual review recommended');

  return {
    valid: issues.length === 0,
    issues,
    needsReview: data.confidence < 0.75,
  };
}

module.exports = { scrapeBusinessFromUrl, validateBusinessData };
