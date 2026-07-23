const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const CHECKOUT_FROM_EMAIL = process.env.CHECKOUT_FROM_EMAIL || "";

// Shared low-level SendGrid sender, used both for checkout confirmations and
// low-stock alerts so there's one place that knows about the email provider.
export async function sendEmail({ to, subject, text, fromName }) {
  if (!SENDGRID_API_KEY) return { sent: false, reason: "no SENDGRID_API_KEY configured" };
  if (!CHECKOUT_FROM_EMAIL) return { sent: false, reason: "no CHECKOUT_FROM_EMAIL configured" };
  if (!to) return { sent: false, reason: "no recipient email" };

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SENDGRID_API_KEY}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: CHECKOUT_FROM_EMAIL, name: fromName || "Lab Supply Checkout" },
        subject,
        content: [{ type: "text/plain", value: text }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return { sent: false, reason: `sendgrid error ${res.status}: ${errBody}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: String(e) };
  }
}
