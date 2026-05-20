export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { email, otp } = await request.json();

    if (!email || !otp) {
      return Response.json({ error: 'Missing fields.' }, { status: 400 });
    }

    // Look up stored OTP
    const stored = await env.OTP_STORE.get(`otp:${email}`);
    if (!stored) {
      return Response.json({ error: 'Code expired or not found. Please start over.' }, { status: 404 });
    }

    const data = JSON.parse(stored);

    if (data.otp !== otp.trim()) {
      return Response.json({ error: 'Incorrect code. Please try again.' }, { status: 401 });
    }

    // Valid — delete OTP immediately
    await env.OTP_STORE.delete(`otp:${email}`);

    // Build access request email to admin
    const { name, phone, company, reason, requestedURL, networkInfo: n = {} } = data;

    const textBody = [
      '--- Requester ---',
      `Name:        ${name}`,
      `Phone:       ${phone        || '—'}`,
      `Company:     ${company      || '—'}`,
      `Email:       ${email}`,
      `Reason:      ${reason       || '—'}`,
      `Requested URL: ${requestedURL || '—'}`,
      '',
      '--- Network ---',
      `IP:          ${n.ip       || '—'}`,
      `ISP:         ${n.isp      || '—'}`,
      `ASN:         ${n.asn      || '—'}`,
      `Hostname:    ${n.hostname || '—'}`,
      `Location:    ${[n.city, n.region, n.country].filter(Boolean).join(', ') || '—'}`,
      `Postal:      ${n.postal   || '—'}`,
      `Timezone:    ${n.timezone || '—'}`,
      `Coordinates: ${n.loc      || '—'}`,
      '',
      '--- Browser ---',
      `User Agent: ${n.ua       || '—'}`,
      `Platform:   ${n.platform || '—'}`,
      `Language:   ${n.language || '—'}`,
      `Screen:     ${n.screen   || '—'}`,
    ].join('\n');

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Access Request <noreply@vasantpatel.xyz>',
        to: ['patelv26@gmail.com'],
        reply_to: email,
        subject: `Access Request — ${name} @ ${company || 'Unknown'}`,
        text: textBody,
      }),
    });

    // Set verified cookie — valid for 30 days across all subdomains
    const cookie = [
      `vasant_verified=${env.VERIFIED_COOKIE_SECRET}`,
      'Domain=vasantpatel.xyz',
      'Path=/',
      'Max-Age=2592000',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
    ].join('; ');

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookie,
      },
    });
  } catch (e) {
    return Response.json({ error: 'Server error. Please try again.' }, { status: 500 });
  }
}
