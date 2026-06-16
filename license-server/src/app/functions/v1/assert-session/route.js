import { NextResponse } from 'next/server';
import { findKey, findSession, saveSession } from '@/lib/db';

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
    const body = await req.json().catch(() => ({}));
    const { license_key, session_id, device_id } = body;

    if (!session_id || !license_key) {
      return NextResponse.json(
        { allowed: false, reason: 'missing_parameters', message: 'Session ID and License key are required.' },
        { headers: corsHeaders() }
      );
    }

    const session = await findSession(session_id);

    if (!session) {
      return NextResponse.json(
        { allowed: false, reason: 'session_not_found', message: 'Session expired or invalidated by admin.' },
        { headers: corsHeaders() }
      );
    }

    // Verify session matches license key
    if (session.key !== license_key.trim()) {
      return NextResponse.json(
        { allowed: false, reason: 'key_mismatch', message: 'Session key mismatch.' },
        { headers: corsHeaders() }
      );
    }

    const keyObj = await findKey(license_key.trim());

    if (!keyObj) {
      return NextResponse.json(
        { allowed: false, reason: 'invalid_key', message: 'License key is invalid.' },
        { headers: corsHeaders() }
      );
    }

    // Verify key status
    if (keyObj.status !== 'active' && keyObj.status !== 'trial') {
      return NextResponse.json(
        { allowed: false, reason: 'inactive', message: 'License is no longer active.' },
        { headers: corsHeaders() }
      );
    }

    // Verify expiration
    if (keyObj.expires_at && new Date(keyObj.expires_at) < new Date()) {
      return NextResponse.json(
        { allowed: false, reason: 'expired', message: 'License has expired.' },
        { headers: corsHeaders() }
      );
    }

    // Verify device association matches
    if (device_id && keyObj.devices) {
      const cleanDeviceId = String(device_id).trim();
      if (!keyObj.devices.includes(cleanDeviceId)) {
        return NextResponse.json(
          { allowed: false, reason: 'device_conflict', message: 'Device is not associated with this license.' },
          { headers: corsHeaders() }
        );
      }
    }

    // Touch session (update last_seen)
    await saveSession(session);

    return NextResponse.json(
      {
        allowed: true,
        valid: true,
        status: keyObj.status,
        expires_at: keyObj.expires_at || null,
        activated_at: keyObj.activated_at || null,
        validity_minutes: keyObj.validity_minutes || null,
        online_count: keyObj.devices ? keyObj.devices.length : 1,
      },
      { headers: corsHeaders() }
    );
  } catch (error) {
    console.error('Assert Session endpoint error:', error);
    return NextResponse.json(
      { allowed: false, reason: 'server_error', message: 'Internal Server Error.' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
