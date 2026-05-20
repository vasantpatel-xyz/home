// Known Prisma Browser + Prisma Access egress IPs
const PRISMA_IPS = new Set(["13.234.188.250","13.234.188.251","13.52.33.111","13.52.33.115","130.211.39.43","130.41.10.20","130.41.158.153","130.41.158.154","130.41.186.216","130.41.186.217","130.41.186.218","130.41.186.219","130.41.198.21","130.41.198.22","130.41.198.44","130.41.198.45","130.41.198.7","130.41.198.8","130.41.200.6","130.41.200.7","130.41.206.202","130.41.206.203","130.41.206.204","130.41.206.205","130.41.210.210","130.41.210.215","130.41.210.216","130.41.210.217","130.41.210.74","130.41.210.75","130.41.210.76","130.41.210.77","130.41.46.19","130.41.46.20","130.41.46.82","130.41.47.45","130.41.48.79","130.41.48.80","130.41.66.85","134.238.0.176","134.238.0.177","134.238.1.75","134.238.1.76","134.238.140.135","134.238.140.136","134.238.143.222","134.238.143.229","134.238.146.210","134.238.146.213","134.238.149.107","134.238.149.108","134.238.16.152","134.238.16.16","134.238.160.174","134.238.160.175","134.238.162.228","134.238.162.245","134.238.165.89","134.238.165.92","134.238.170.79","134.238.170.81","134.238.175.174","134.238.175.175","134.238.180.124","134.238.181.134","134.238.182.86","134.238.182.89","134.238.182.90","134.238.186.195","134.238.186.196","134.238.191.124","134.238.191.125","134.238.193.222","134.238.193.231","134.238.193.252","134.238.193.253","134.238.205.1","134.238.205.10","134.238.205.111","134.238.205.115","134.238.206.208","134.238.31.107","134.238.31.115","134.238.31.116","134.238.31.117","134.238.40.235","134.238.40.238","134.238.42.44","134.238.42.45","134.238.43.235","134.238.43.236","134.238.48.170","134.238.48.171","134.238.52.15","134.238.52.159","134.238.6.195","134.238.6.196","134.238.84.20","134.238.84.200","137.83.219.40","137.83.241.43","139.180.242.35","139.180.242.36","139.180.244.198","139.180.244.79","139.180.245.125","139.180.245.126","139.180.247.144","139.180.247.145","139.180.248.206","139.180.248.207","139.180.248.208","139.180.248.209","139.180.249.187","139.180.249.188","139.180.250.116","139.180.250.121","139.180.250.153","139.180.250.154","139.180.250.43","139.180.250.47","139.180.250.50","139.180.250.55","139.180.251.196","139.180.251.197","15.164.43.195","15.164.43.196","165.1.165.19","165.1.165.20","165.1.174.166","165.1.174.167","165.1.174.168","165.1.174.169","165.1.174.48","165.1.175.19","165.1.200.118","165.1.204.150","165.1.204.151","165.1.204.73","165.1.205.82","165.1.226.204","165.1.226.205","165.1.227.111","165.1.227.112","165.1.227.172","165.1.227.173","165.1.227.55","165.1.227.56","165.1.240.202","165.1.240.203","165.1.243.167","165.1.243.168","165.1.255.203","165.1.255.204","165.85.223.53","165.85.35.120","168.149.240.122","168.149.240.132","168.149.241.18","168.149.241.23","168.149.241.24","168.149.241.33","168.149.241.34","168.149.241.51","168.149.242.161","168.149.242.164","168.149.242.166","168.149.243.120","168.149.244.107","168.149.244.245","168.149.246.87","18.231.224.223","18.231.224.224","208.127.109.235","208.127.109.236","208.127.178.29","208.127.178.30","208.127.189.146","208.127.226.74","208.127.230.56","208.127.230.57","208.127.230.79","208.127.230.80","208.127.65.160","208.127.65.2","208.127.68.219","208.127.89.60","208.127.89.61","3.1.179.102","3.1.179.103","3.1.179.175","3.1.179.176","3.105.76.25","3.105.76.250","34.117.238.171","34.120.72.104","34.96.70.57","35.181.97.32","35.181.97.33","35.183.192.8","35.183.193.93","35.190.22.129","52.194.246.213","52.194.246.214"]);

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { name, phone, company, reason, email, requestedURL, turnstileToken, networkInfo } = body;

    // Validate required fields
    if (!name || !email || !turnstileToken) {
      return Response.json({ error: 'Missing required fields.' }, { status: 400 });
    }

    // Server-side Prisma IP check — flag it in the email but don't block the form
    const clientIP = request.headers.get('CF-Connecting-IP') || '';
    const onPrisma = PRISMA_IPS.has(clientIP);

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
      JSON.stringify({ otp, name, phone, company, reason, email, requestedURL, networkInfo, onPrisma }),
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
        subject: 'Your support verification code',
        html: `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px 24px;">
            <h2 style="margin:0 0 8px">Verify your email</h2>
            <p style="color:#666;margin:0 0 24px">Enter this code to complete your support request:</p>
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
