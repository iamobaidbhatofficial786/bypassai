import { NextResponse } from 'next/server';
import { findKey, saveKey, findSession, saveSession, checkAndTrackRateLimit, logUsage, logAudit, getSystemSettings, listUsageLogs, verifyStatelessToken, generateStatelessToken, verifyEcdsaSignature } from '@/lib/db';
import { validate, promptCheckSchema } from '@/middleware/validation';
import { logger } from '@/lib/logger';

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

    const validationResult = await validate(promptCheckSchema, req);
    if (validationResult) return validationResult;
    const body = await req.json();
    const { session_token, prompt, device_id, timestamp, signature } = body;

    if (!session_token) {
      return NextResponse.json(
        { allowed: false, message: 'Session token is required.' },
        { headers: corsHeaders() }
      );
    }

    const cleanSessionToken = String(session_token).trim();
    
    // Attempt stateless JWT verification
    const statelessSession = verifyStatelessToken(cleanSessionToken);
    const session = statelessSession || await findSession(cleanSessionToken);

    if (!session) {
      return NextResponse.json(
        { allowed: false, message: 'Session invalid or expired. Please re-verify your license key.' },
        { headers: corsHeaders() }
      );
    }

    // Verify session belongs to this device
    const cleanDeviceId = device_id ? String(device_id).trim() : '';
    if (cleanDeviceId && session.device_id && session.device_id !== cleanDeviceId) {
      const auditKey = session.key || 'unknown';
      await logAudit(auditKey, 'security_alert', `Session hijacking suspected: session device ${session.device_id} vs request device ${cleanDeviceId}`, ip).catch(() => null);
      return NextResponse.json(
        { allowed: false, message: 'Session device mismatch. Access denied.' },
        { headers: corsHeaders() }
      );
    }

    const now = new Date();
    const SESSION_TIMEOUT_MS = 20 * 60 * 1000;
    
    // Fetch associated license key
    const licenseKey = session.key;
    let keyObj = await findKey(licenseKey).catch(() => null);

    // If key does not exist in DB but it is a valid stateless token (migration fallback), trust signed metadata
    if (!keyObj && statelessSession) {
      keyObj = {
        key: licenseKey,
        user_name: session.user_name || 'Licensed User',
        status: 'active',
        plan: session.plan || 'pro',
        max_devices: session.plan === 'free' ? 1 : session.plan === 'pro' ? 2 : 5,
        devices: [cleanDeviceId],
        expires_at: null,
        device_public_keys: {}
      };
    }

    if (!keyObj) {
      return NextResponse.json(
        { allowed: false, message: 'License key no longer exists.' },
        { headers: corsHeaders() }
      );
    }

    // SLIDING SESSION WINDOW: If session token signature is valid, but the timestamp is expired,
    // automatically refresh the session window if the license remains active and valid.
    let isSessionExpired = false;
    const expiresAtTime = session.expires_at ? new Date(session.expires_at) : null;
    if (expiresAtTime && expiresAtTime < now) {
      isSessionExpired = true;
    }

    if (isSessionExpired) {
      if (keyObj.status !== 'active' && keyObj.status !== 'trial') {
        return NextResponse.json(
          { allowed: false, message: 'Session expired and license key is inactive.' },
          { headers: corsHeaders() }
        );
      }
      if (keyObj.expires_at && new Date(keyObj.expires_at) < now) {
        keyObj.status = 'expired';
        await saveKey(keyObj).catch(() => null);
        return NextResponse.json(
          { allowed: false, message: 'Session expired and license key has expired.' },
          { headers: corsHeaders() }
        );
      }
      
      // Extend expiration on-the-fly
      session.expires_at = new Date(now.getTime() + SESSION_TIMEOUT_MS).toISOString();
      console.log(`[Auto-Refresh] Automatically sliding session window for key: ${licenseKey}`);
    }

    if (keyObj.status !== 'active' && keyObj.status !== 'trial') {
      return NextResponse.json(
        { allowed: false, message: `License key status is currently: ${keyObj.status}. Access denied.` },
        { headers: corsHeaders() }
      );
    }

    if (keyObj.expires_at && new Date(keyObj.expires_at) < now) {
      keyObj.status = 'expired';
      await saveKey(keyObj).catch(() => null);
      await logAudit(licenseKey, 'expired', 'License expired during session check', ip).catch(() => null);
      return NextResponse.json(
        { allowed: false, message: 'Your license key has expired.' },
        { headers: corsHeaders() }
      );
    }

    // 1. Device Signature Validation if public keys are registered
    if (cleanDeviceId && keyObj.device_public_keys) {
      const registeredPublicKey = keyObj.device_public_keys[cleanDeviceId];
      if (registeredPublicKey) {
        if (!signature || !timestamp) {
          return NextResponse.json(
            { allowed: false, message: 'Security enforcement: Cryptographic request signature is required.' },
            { headers: corsHeaders() }
          );
        }

        // Verify timestamp freshness to prevent replay prompt checks
        const requestTime = parseInt(timestamp);
        if (isNaN(requestTime) || Math.abs(now.getTime() - requestTime) > 5 * 60 * 1000) {
          return NextResponse.json(
            { allowed: false, message: 'Request signature is out of sync. Please check device clock.' },
            { headers: corsHeaders() }
          );
        }

        // Verify signature of prompt + timestamp
        const messageToVerify = `${prompt || ''}.${timestamp}`;
        const isVerified = verifyEcdsaSignature(registeredPublicKey, messageToVerify, signature);
        if (!isVerified) {
          await logAudit(licenseKey, 'security_alert', `ECDSA signature verification failed for prompt check on device ${cleanDeviceId}`, ip);
          return NextResponse.json(
            { allowed: false, message: 'Device verification signature failed.' },
            { headers: corsHeaders() }
          );
        }
      } else {
        // Enforce signature check if device is not registered with public key but license has other cryptographic keys
        const licenseHasAnyKey = Object.keys(keyObj.device_public_keys).length > 0;
        if (licenseHasAnyKey) {
          return NextResponse.json(
            { allowed: false, message: 'Security enforcement: Signature is required for this license.' },
            { headers: corsHeaders() }
          );
        }
      }
    }

    // Verify device association matches in standard DB
    if (cleanDeviceId && keyObj.devices && !statelessSession) {
      if (!keyObj.devices.includes(cleanDeviceId)) {
        return NextResponse.json(
          { allowed: false, message: 'Device is not registered with this license.' },
          { headers: corsHeaders() }
        );
      }
    }

    const plan = keyObj.plan || 'pro';

    // ABUSE DETECTION: Check share fraud over concurrent IPs/devices
    const logs = await listUsageLogs().catch(() => []);
    const fiveMinutesAgo = now.getTime() - 5 * 60 * 1000;
    
    const recentLogs = Array.isArray(logs)
      ? logs.filter(l => l.license_key === licenseKey && new Date(l.timestamp).getTime() > fiveMinutesAgo)
      : [];

    const uniqueIps = new Set(recentLogs.map(l => l.ip));
    const uniqueDevices = new Set(recentLogs.map(l => l.device_id));

    uniqueIps.add(ip);
    if (cleanDeviceId) uniqueDevices.add(cleanDeviceId);

    if (uniqueIps.size >= 3 || uniqueDevices.size >= 3) {
      keyObj.status = 'suspended';
      await saveKey(keyObj).catch(() => null);
      await logAudit(licenseKey, 'abuse_suspend', `License automatically suspended for multi-device abuse: ${uniqueIps.size} IPs, ${uniqueDevices.size} devices`, ip).catch(() => null);
      await logUsage(licenseKey, cleanDeviceId, prompt, ip, false, plan).catch(() => null);
      return NextResponse.json(
        { allowed: false, message: 'Your license has been suspended due to abnormal concurrent usage on multiple devices.' },
        { headers: corsHeaders() }
      );
    }

    // RATE LIMITING
    const rateCheck = await checkAndTrackRateLimit(licenseKey, ip, cleanDeviceId, plan).catch(() => ({ allowed: true, remaining: 99 }));
    if (!rateCheck.allowed) {
      await logUsage(licenseKey, cleanDeviceId, prompt, ip, false, plan).catch(() => null);
      return NextResponse.json(
        { allowed: false, message: rateCheck.message },
        { headers: corsHeaders() }
      );
    }

    // SAFETY CHECKS & INJECTIONS
    let allowed = true;
    let message = 'Prompt approved.';
    let modifiedPrompt = prompt || '';

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

    if (allowed && settings && settings.enable_hints === true) {
      if (plan === 'pro') {
        const hint = '[ByPass AI System Hint: Optimize the generated code for production stability and modern styling.]';
        if (!modifiedPrompt.includes('[ByPass AI System Hint:') && !modifiedPrompt.includes('[ByPass AI Enterprise Hint:')) {
          modifiedPrompt = modifiedPrompt + '\n\n' + hint;
        }
      } else if (plan === 'enterprise') {
        const hint = '[ByPass AI Enterprise Hint: Enforce comprehensive error boundaries, absolute responsiveness, and clear documentation in the codebase.]';
        if (!modifiedPrompt.includes('[ByPass AI System Hint:') && !modifiedPrompt.includes('[ByPass AI Enterprise Hint:')) {
          modifiedPrompt = modifiedPrompt + '\n\n' + hint;
        }
      }
    }

    // Log prompt usage
    await logUsage(licenseKey, cleanDeviceId, prompt, ip, allowed, plan).catch(() => null);

    // Slide JWT expiration window
    const newExpiry = new Date(now.getTime() + SESSION_TIMEOUT_MS).toISOString();
    const newSessionToken = generateStatelessToken({
      key: licenseKey,
      device_id: cleanDeviceId,
      user_name: keyObj.user_name || session.user_name || 'Licensed User',
      plan: plan,
      expires_at: newExpiry
    });

    // Save session in background
    if (!statelessSession || session.id) {
      session.last_seen = now.toISOString();
      session.expires_at = newExpiry;
      await saveSession(session).catch(() => null);
    } else {
      await saveSession({
        session_id: newSessionToken,
        key: licenseKey,
        device_id: cleanDeviceId,
        created_at: session.created_at || now.toISOString(),
        expires_at: newExpiry,
        last_seen: now.toISOString(),
        user_name: keyObj.user_name || 'Licensed User',
      }).catch(() => null);
    }

    return NextResponse.json(
      {
        allowed: allowed,
        valid: true, // Compatibility key for chrome extension
        message: message,
        modified_prompt: allowed ? modifiedPrompt : null,
        remaining_quota: rateCheck.remaining,
        session_token: newSessionToken, // Refreshed sliding JWT token
        session_id: newSessionToken // Compatibility key for sidepanel.js and content.js
      },
      { headers: corsHeaders() }
    );
  } catch (error) {
    logger.error('Prompt check endpoint error', { error: error.message, stack: error.stack, ip });
    return NextResponse.json(
      { allowed: false, message: 'Internal Server Error.' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
