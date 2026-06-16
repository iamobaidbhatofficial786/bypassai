import { NextResponse } from 'next/server';
import { findKey, saveKey, saveSession, getSystemSettings } from '@/lib/db';
import crypto from 'crypto';

// Enable CORS for Chrome Extension requests
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-license-key, x-session-id, x-device-id',
  };
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function POST(req) {
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
    const maxDevicesLimit = body.max_devices || body.device_limit || body.allowed_devices || 2;

    if (!license_key) {
      return NextResponse.json(
        { valid: false, message: 'License key is required.' },
        { headers: corsHeaders() }
      );
    }

    const keyObj = await findKey(license_key.trim());

    if (!keyObj) {
      return NextResponse.json(
        { valid: false, message: 'Invalid license key. Please check and try again.' },
        { headers: corsHeaders() }
      );
    }

    // Check status
    if (keyObj.status !== 'active' && keyObj.status !== 'trial') {
      return NextResponse.json(
        { valid: false, message: `License is not active (Status: ${keyObj.status}).` },
        { headers: corsHeaders() }
      );
    }

    // Check expiration
    const now = new Date();
    if (keyObj.expires_at && new Date(keyObj.expires_at) < now) {
      return NextResponse.json(
        { valid: false, message: 'License has expired. Contact support to renew.' },
        { headers: corsHeaders() }
      );
    }

    // Initialize devices list if missing
    if (!keyObj.devices) {
      keyObj.devices = [];
    }

    // Manage device association
    if (device_id) {
      const cleanDeviceId = String(device_id).trim();
      if (!keyObj.devices.includes(cleanDeviceId)) {
        const allowedMax = keyObj.max_devices || maxDevicesLimit;
        if (keyObj.devices.length >= allowedMax) {
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
        if (!keyObj.activated_at) {
          keyObj.activated_at = now.toISOString();
        }
        await saveKey(keyObj);
      }
    }

    // Generate active session ID
    const sessionId = `sess_${crypto.randomBytes(16).toString('hex')}`;
    
    // Save session
    await saveSession({
      session_id: sessionId,
      key: keyObj.key,
      device_id: device_id || '',
      created_at: now.toISOString(),
      user_name: keyObj.user_name,
    });

    return NextResponse.json(
      {
        valid: true,
        allowed: true,
        session_id: sessionId,
        user_name: keyObj.user_name,
        status: keyObj.status,
        is_trial: keyObj.status === 'trial',
        message: 'License activated successfully.',
        expires_at: keyObj.expires_at || null,
        activated_at: keyObj.activated_at || now.toISOString(),
        validity_minutes: keyObj.validity_minutes || null,
        online_count: keyObj.devices.length || 1,
      },
      { headers: corsHeaders() }
    );
  } catch (error) {
    console.error('Validate License endpoint error:', error);
    return NextResponse.json(
      { valid: false, message: 'Internal Server Error.' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
