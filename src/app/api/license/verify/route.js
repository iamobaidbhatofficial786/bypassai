import { NextResponse } from 'next/server';
import { findKey, saveKey, saveSession, logAudit, getSystemSettings } from '@/lib/db';
import crypto from 'crypto';

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
        { valid: false, message: 'The extension is temporarily locked by the administrator.' },
        { headers: corsHeaders() }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { license_key, device_id } = body;

    if (!license_key) {
      return NextResponse.json(
        { valid: false, message: 'License key is required.' },
        { headers: corsHeaders() }
      );
    }

    const cleanKey = String(license_key).trim().toUpperCase();
    const keyObj = await findKey(cleanKey);

    if (!keyObj) {
      await logAudit(cleanKey, 'verify_failed', 'Invalid license key attempt', ip);
      return NextResponse.json(
        { valid: false, message: 'Invalid license key. Please check and try again.' },
        { headers: corsHeaders() }
      );
    }

    // Check status
    if (keyObj.status !== 'active' && keyObj.status !== 'trial') {
      await logAudit(cleanKey, 'verify_failed', `Blocked key verify attempt (Status: ${keyObj.status})`, ip);
      return NextResponse.json(
        { valid: false, message: `License is not active (Status: ${keyObj.status}).` },
        { headers: corsHeaders() }
      );
    }

    // Check expiration (only if the key is activated, or has a fixed expiry date without validity_minutes)
    const now = new Date();
    if (keyObj.expires_at && (!keyObj.validity_minutes || keyObj.activated_at) && new Date(keyObj.expires_at) < now) {
      keyObj.status = 'expired';
      await saveKey(keyObj);
      await logAudit(cleanKey, 'verify_failed', 'License expired', ip);
      return NextResponse.json(
        { valid: false, message: 'License has expired. Contact support to renew.' },
        { headers: corsHeaders() }
      );
    }

    // Initialize devices list if missing
    if (!keyObj.devices) {
      keyObj.devices = [];
    }

    let keyUpdated = false;
    const cleanDeviceId = device_id ? String(device_id).trim() : '';

    // Manage device association
    if (cleanDeviceId) {
      if (!keyObj.devices.includes(cleanDeviceId)) {
        // Enforce plan-specific device limits
        const plan = keyObj.plan || 'pro';
        const PLAN_MAX_DEVICES = {
          free: 1,
          pro: 2,
          enterprise: 5
        };
        const allowedMax = keyObj.max_devices || PLAN_MAX_DEVICES[plan] || 2;

        if (keyObj.devices.length >= allowedMax) {
          await logAudit(cleanKey, 'verify_failed', `Device limit reached (${keyObj.devices.length}/${allowedMax}) for device ${cleanDeviceId}`, ip);
          return NextResponse.json(
            {
              valid: false,
              reason: 'device_conflict',
              message: `Device limit reached (${keyObj.devices.length}/${allowedMax}). Reset devices via your admin dashboard.`,
            },
            { headers: corsHeaders() }
          );
        }
        keyObj.devices.push(cleanDeviceId);
        keyUpdated = true;
        await logAudit(cleanKey, 'device_register', `Registered device ${cleanDeviceId}`, ip);
      }
    }

    // Perform first-time activation setup
    if (!keyObj.activated_at) {
      keyObj.activated_at = now.toISOString();
      if (keyObj.validity_minutes) {
        keyObj.expires_at = new Date(now.getTime() + keyObj.validity_minutes * 60 * 1000).toISOString();
      }
      keyUpdated = true;
      await logAudit(cleanKey, 'activation', 'License key activated for the first time', ip);
    }

    if (keyUpdated) {
      await saveKey(keyObj);
    }

    // Generate active session ID (session token)
    const sessionId = `sess_${crypto.randomBytes(16).toString('hex')}`;
    const sessionExpiry = new Date(now.getTime() + 20 * 60 * 1000).toISOString(); // 20 minutes short-lived
    
    // Save session
    await saveSession({
      session_id: sessionId,
      key: keyObj.key,
      device_id: cleanDeviceId,
      created_at: now.toISOString(),
      expires_at: sessionExpiry,
      last_seen: now.toISOString(),
      user_name: keyObj.user_name,
    });

    const plan = keyObj.plan || 'pro';
    const rateLimits = plan === 'free' ? { min: 2, day: 10 } : plan === 'pro' ? { min: 20, day: 200 } : { min: 100, day: 10000 };

    return NextResponse.json(
      {
        valid: true,
        session_token: sessionId,
        plan: plan,
        limits: rateLimits,
        expires_at: keyObj.expires_at || null,
        user_name: keyObj.user_name,
        online_count: keyObj.devices.length
      },
      { headers: corsHeaders() }
    );
  } catch (error) {
    console.error('License verify endpoint error:', error);
    return NextResponse.json(
      { valid: false, message: 'Internal Server Error.' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
