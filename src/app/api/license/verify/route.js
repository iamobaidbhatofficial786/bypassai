import { NextResponse } from 'next/server';
import { findKey, saveKey, saveSession, logAudit, getSystemSettings, generateStatelessToken, verifyEcdsaSignature } from '@/lib/db';
import { validate, verifyLicenseSchema } from '@/middleware/validation';
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
        { valid: false, message: 'The extension is temporarily locked by the administrator.' },
        { headers: corsHeaders() }
      );
    }

    const validationResult = await validate(verifyLicenseSchema, req);
    if (validationResult) return validationResult;
    const body = await req.json();
    const { license_key, device_id, device_public_key, timestamp, signature } = body;

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

    // Check expiration
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

    // Initialize fields if missing
    if (!keyObj.devices) {
      keyObj.devices = [];
    }
    if (!keyObj.device_public_keys) {
      keyObj.device_public_keys = {};
    }

    let keyUpdated = false;
    const cleanDeviceId = device_id ? String(device_id).trim() : '';

    if (cleanDeviceId) {
      // 1. Replay attack check for signed requests
      if (signature && timestamp) {
        const nowMs = Date.now();
        const requestTime = parseInt(timestamp);
        if (isNaN(requestTime) || Math.abs(nowMs - requestTime) > 5 * 60 * 1000) {
          return NextResponse.json(
            { valid: false, message: 'Request signature out of sync. Please synchronize device clock.' },
            { headers: corsHeaders() }
          );
        }
      }

      // 2. Cryptographic signature check if public key is already registered for this device ID
      const registeredPublicKey = keyObj.device_public_keys[cleanDeviceId];
      if (registeredPublicKey) {
        if (!signature || !timestamp) {
          return NextResponse.json(
            { valid: false, message: 'Cryptographic signature required for this registered device.' },
            { headers: corsHeaders() }
          );
        }
        const messageToVerify = `${cleanKey}.${timestamp}`;
        const isVerified = verifyEcdsaSignature(registeredPublicKey, messageToVerify, signature);
        if (!isVerified) {
          await logAudit(cleanKey, 'security_alert', `ECDSA signature verification failed for device ${cleanDeviceId}`, ip);
          return NextResponse.json(
            { valid: false, message: 'Cryptographic signature verification failed.' },
            { headers: corsHeaders() }
          );
        }
      } 
      // 3. New device registering with a signature and public key
      else if (device_public_key && signature && timestamp) {
        // Enforce plan-specific device limits first
        const plan = keyObj.plan || 'pro';
        const PLAN_MAX_DEVICES = { free: 1, pro: 2, enterprise: 5 };
        const allowedMax = keyObj.max_devices || PLAN_MAX_DEVICES[plan] || 2;

        if (!keyObj.devices.includes(cleanDeviceId) && keyObj.devices.length >= allowedMax) {
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

        // Verify initial registration signature to prove private key ownership
        const messageToVerify = `${cleanKey}.${timestamp}`;
        const isVerified = verifyEcdsaSignature(device_public_key, messageToVerify, signature);
        if (!isVerified) {
          return NextResponse.json(
            { valid: false, message: 'Initial device key registration signature failed.' },
            { headers: corsHeaders() }
          );
        }

        if (!keyObj.devices.includes(cleanDeviceId)) {
          keyObj.devices.push(cleanDeviceId);
        }
        keyObj.device_public_keys[cleanDeviceId] = device_public_key;
        keyUpdated = true;
        await logAudit(cleanKey, 'device_register', `Registered cryptographic public key for device ${cleanDeviceId}`, ip);
      } 
      // 4. Fallback to standard check (warn/log in audit) if no signature/public key provided (legacy fallback)
      else {
        // If they try to verify without signature but a public key was registered, block them
        const deviceHasAnyKey = Object.keys(keyObj.device_public_keys).length > 0;
        if (deviceHasAnyKey) {
          return NextResponse.json(
            { valid: false, message: 'Security enforcement: Cryptographic request signature is required.' },
            { headers: corsHeaders() }
          );
        }

        if (!keyObj.devices.includes(cleanDeviceId)) {
          const plan = keyObj.plan || 'pro';
          const PLAN_MAX_DEVICES = { free: 1, pro: 2, enterprise: 5 };
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
          await logAudit(cleanKey, 'device_register', `Registered device ${cleanDeviceId} (Legacy Mode - No Cryptographic Keys)`, ip);
        }
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

    const plan = keyObj.plan || 'pro';
    const sessionExpiry = new Date(now.getTime() + 20 * 60 * 1000).toISOString(); // 20 minutes short-lived JWT
    
    // Generate active session JWT
    const sessionData = {
      key: keyObj.key,
      device_id: cleanDeviceId,
      user_name: keyObj.user_name,
      plan: plan,
      expires_at: sessionExpiry
    };
    const sessionId = generateStatelessToken(sessionData);
    
    // Save session in DB
    await saveSession({
      session_id: sessionId,
      key: keyObj.key,
      device_id: cleanDeviceId,
      created_at: now.toISOString(),
      expires_at: sessionExpiry,
      last_seen: now.toISOString(),
      user_name: keyObj.user_name,
    }).catch(() => null);

    const rateLimits = plan === 'free' ? { min: 2, day: 10 } : plan === 'pro' ? { min: 20, day: 200 } : { min: 100, day: 10000 };

    return NextResponse.json(
      {
        valid: true,
        allowed: true, // Compatibility key for chrome extension
        session_token: sessionId,
        session_id: sessionId, // Compatibility key for sidepanel.js and content.js
        plan: plan,
        limits: rateLimits,
        expires_at: keyObj.expires_at || null,
        user_name: keyObj.user_name,
        online_count: keyObj.devices.length
      },
      { headers: corsHeaders() }
    );
  } catch (error) {
    logger.error('License verify endpoint error', { error: error.message, stack: error.stack, ip });
    return NextResponse.json(
      { valid: false, message: 'Internal Server Error.' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
