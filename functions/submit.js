export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { name, phone, company, reason, email, turnstileToken, networkInfo } = body;

    // Validate required fields
    if (!name || !email || !turnstileToken) {
      return Response.json({ error: 'Missing required fields.' }, { status: 400 });
    }

    // Basic email sanity check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: 'Invalid email address.' }, { status: 400 });
    }

    // Reject free/consumer email domains
    const blockedDomains = [
      'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
      'aol.com','protonmail.com','mail.com','ymail.com','live.com',
    ];
    const domain = email.split('@')[1].toLowerCase();
    if (blockedDomains.includes(domain)) {
      return Response.json({ error: 'Please use your corporate email address.' }, { status: 400 });
    }

    // Verify Turnstile token
    const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${env.TURNSTILE_SECRET}&response=${turnstileToken}`,
    });
    const tsData = await tsRes.json();
    if (!tsData.success) {
      return Response.json({ error: 'Bot check failed. Please try again.' }, { status: 403 });
    }

    // Rate limit — one pending OTP per email at a time
    const existing = await env.OTP_STORE.get(`otp:${email}`);
    if (existing) {
      return Response.json({ error: 'A code was already sent. Check your inbox or wait 10 minutes.' }, { status: 429 });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store in KV — expires in 10 minutes
    await env.OTP_STORE.put(
      `otp:${email}`,
      JSON.stringify({ otp, name, phone, company, reason, email, networkInfo }),
      { expirationTtl: 600 }
    );

    // Send OTP email to requester via Resend
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Access Request <noreply@vasantpatel.xyz>',
        to: [email],
        subject: 'Your verification code',
        html: `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px 24px;">
            <h2 style="margin:0 0 8px">Verify your email</h2>
            <p style="color:#666;margin:0 0 24px">Enter this code to complete your access request:</p>
            <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#2e6be6;margin-bottom:24px">${otp}</div>
            <p style="color:#999;font-size:13px">This code expires in 10 minutes. If you didn't request access, ignore this email.</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      await env.OTP_STORE.delete(`otp:${email}`);
      return Response.json({ error: 'Failed to send verification email. Check the address and try again.' }, { status: 500 });
    }

    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ error: 'Server error. Please try again.' }, { status: 500 });
  }
}
