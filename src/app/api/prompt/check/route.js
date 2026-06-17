import { NextResponse } from 'next/server';
import { findKey, saveKey, findSession, saveSession, checkAndTrackRateLimit, logUsage, logAudit, getSystemSettings, listUsageLogs } from '@/lib/db';

export const dynamic = 'force-dynamic';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-license-key, x-session-id, x-device-id',
  };
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function POST(req) {
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';
  try {
    const settings = await getSystemSettings().catch(() => ({}));
    if (settings && settings.system_locked) {
      return NextResponse.json(
        { allowed: false, message: 'The extension is temporarily locked by the administrator.' },
        { headers: corsHeaders() }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { session_token, prompt, device_id } = body;

    if (!session_token) {
      return NextResponse.json(
        { allowed: false, message: 'Session token is required.' },
        { headers: corsHeaders() }
      );
    }

    const cleanSessionToken = String(session_token).trim();
    const session = await findSession(cleanSessionToken);

    if (!session) {
      return NextResponse.json(
        { allowed: false, message: 'Session invalid or expired. Please re-verify your license key.' },
        { headers: corsHeaders() }
      );
    }

    // Verify session belongs to this device
    const cleanDeviceId = device_id ? String(device_id).trim() : '';
    if (cleanDeviceId && session.device_id && session.device_id !== cleanDeviceId) {
      await logAudit(session.key, 'security_alert', `Session hijacking suspected: session device ${session.device_id} vs request device ${cleanDeviceId}`, ip);
      return NextResponse.json(
        { allowed: false, message: 'Session device mismatch. Access denied.' },
        { headers: corsHeaders() }
      );
    }

    // Check session expiration (20 minutes sliding window)
    const now = new Date();
    const lastSeenTime = new Date(session.last_seen || session.created_at);
    const sessionAgeMs = now.getTime() - lastSeenTime.getTime();
    const SESSION_TIMEOUT_MS = 20 * 60 * 1000;

    if (sessionAgeMs > SESSION_TIMEOUT_MS) {
      return NextResponse.json(
        { allowed: false, message: 'Session expired due to inactivity. Please re-verify.' },
        { headers: corsHeaders() }
      );
    }

    // Extend (slide) session token window
    session.last_seen = now.toISOString();
    session.expires_at = new Date(now.getTime() + SESSION_TIMEOUT_MS).toISOString();
    await saveSession(session);

    // Validate the associated license key is active and not expired
    const licenseKey = session.key;
    const keyObj = await findKey(licenseKey);

    if (!keyObj) {
      return NextResponse.json(
        { allowed: false, message: 'License key no longer exists.' },
        { headers: corsHeaders() }
      );
    }

    if (keyObj.status !== 'active' && keyObj.status !== 'trial') {
      return NextResponse.json(
        { allowed: false, message: `License key status is currently: ${keyObj.status}. Access denied.` },
        { headers: corsHeaders() }
      );
    }

    if (keyObj.expires_at && new Date(keyObj.expires_at) < now) {
      keyObj.status = 'expired';
      await saveKey(keyObj);
      await logAudit(licenseKey, 'expired', 'License expired during session check', ip);
      return NextResponse.json(
        { allowed: false, message: 'Your license key has expired.' },
        { headers: corsHeaders() }
      );
    }

    // Verify device association matches
    if (cleanDeviceId && keyObj.devices) {
      if (!keyObj.devices.includes(cleanDeviceId)) {
        return NextResponse.json(
          { allowed: false, message: 'Device is not registered with this license.' },
          { headers: corsHeaders() }
        );
      }
    }

    const plan = keyObj.plan || 'pro';

    // ABUSE DETECTION: Check if the license key is being shared concurrently
    // Count unique IPs and devices using this license in the last 5 minutes
    const logs = await listUsageLogs().catch(() => []);
    const fiveMinutesAgo = now.getTime() - 5 * 60 * 1000;
    
    const recentLogs = logs.filter(l => 
      l.license_key === licenseKey && 
      new Date(l.timestamp).getTime() > fiveMinutesAgo
    );

    const uniqueIps = new Set(recentLogs.map(l => l.ip));
    const uniqueDevices = new Set(recentLogs.map(l => l.device_id));

    // Exclude 'unknown' and current request IP/device from uniqueness count comparison to prevent self-conflict
    uniqueIps.add(ip);
    if (cleanDeviceId) uniqueDevices.add(cleanDeviceId);

    if (uniqueIps.size >= 3 || uniqueDevices.size >= 3) {
      keyObj.status = 'suspended';
      await saveKey(keyObj);
      await logAudit(licenseKey, 'abuse_suspend', `License automatically suspended for multi-device abuse: ${uniqueIps.size} IPs, ${uniqueDevices.size} devices`, ip);
      await logUsage(licenseKey, cleanDeviceId, prompt, ip, false, plan);
      return NextResponse.json(
        { allowed: false, message: 'Your license has been suspended due to abnormal concurrent usage on multiple devices.' },
        { headers: corsHeaders() }
      );
    }

    // RATE LIMITING
    const rateCheck = await checkAndTrackRateLimit(licenseKey, ip, cleanDeviceId, plan);
    if (!rateCheck.allowed) {
      await logUsage(licenseKey, cleanDeviceId, prompt, ip, false, plan);
      return NextResponse.json(
        { allowed: false, message: rateCheck.message },
        { headers: corsHeaders() }
      );
    }

    // PROMPT ENGINE: Optionally block or modify/enhance prompts
    let allowed = true;
    let message = 'Prompt approved.';
    let modifiedPrompt = prompt || '';

    // Check for prohibited keywords (simple safety/abuse guard)
    const blockedKeywords = ['bypass credit', 'crack license', 'hack server', 'steal code', 'bypass server'];
    const promptLower = String(prompt || '').toLowerCase();
    for (const kw of blockedKeywords) {
      if (promptLower.includes(kw)) {
        allowed = false;
        message = 'Prompt rejected by security policy (prohibited keywords).';
        modifiedPrompt = '';
        break;
      }
    }

    // Enhance prompt: append target instructions if allowed
    if (allowed) {
      // Enhance prompt with standard optimization instructions if the user requests it or by default for Pro/Enterprise
      if (plan === 'pro') {
        modifiedPrompt = modifiedPrompt + '\n\n[ByPass AI System Hint: Optimize the generated code for production stability and modern styling.]';
      } else if (plan === 'enterprise') {
        modifiedPrompt = modifiedPrompt + '\n\n[ByPass AI Enterprise Hint: Enforce comprehensive error boundaries, absolute responsiveness, and clear documentation in the codebase.]';
      }
    }

    // Log prompt usage
    await logUsage(licenseKey, cleanDeviceId, prompt, ip, allowed, plan);

    return NextResponse.json(
      {
        allowed: allowed,
        message: message,
        modified_prompt: allowed ? modifiedPrompt : null,
        remaining_quota: rateCheck.remaining
      },
      { headers: corsHeaders() }
    );
  } catch (error) {
    console.error('Prompt check endpoint error:', error);
    return NextResponse.json(
      { allowed: false, message: 'Internal Server Error.' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
