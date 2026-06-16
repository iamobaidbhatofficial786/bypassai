import { NextResponse } from 'next/server';
import { listKeys, saveKey, deleteKey, findKey } from '@/lib/db';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

// Helper to authenticate admin token
function verifyAdmin(req) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.substring(7);
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const expectedHash = crypto
    .createHash('sha256')
    .update(adminPassword + 'LovablePowerkitsSalt')
    .digest('hex');
  return token === `adm_${expectedHash}`;
}

export async function GET(req) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const keys = await listKeys();
    return NextResponse.json(keys);
  } catch (error) {
    console.error('List Keys API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    let { key, user_name, status, expires_at, validity_minutes, max_devices, role } = body;

    // Generate random key if not provided (Format: XXXX-XXXX-XXXX-XXXX)
    if (!key) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const randStr = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      key = `${randStr(4)}-${randStr(4)}-${randStr(4)}-${randStr(4)}`;
    } else {
      key = String(key).trim().toUpperCase();
    }

    // Check if key already exists
    const existing = await findKey(key);
    if (existing) {
      return NextResponse.json({ error: 'License key already exists' }, { status: 400 });
    }

    // Calculate expiry based on validity_minutes if provided
    if (validity_minutes && !expires_at) {
      expires_at = new Date(Date.now() + parseInt(validity_minutes) * 60 * 1000).toISOString();
    }

    const keyObj = {
      key,
      user_name: user_name || 'Licensed User',
      status: status || 'active',
      expires_at: expires_at || null,
      validity_minutes: validity_minutes ? parseInt(validity_minutes) : null,
      max_devices: max_devices ? parseInt(max_devices) : 2,
      role: role || 'user',
      devices: [],
      created_at: new Date().toISOString(),
      activated_at: null,
    };

    await saveKey(keyObj);
    return NextResponse.json(keyObj);
  } catch (error) {
    console.error('Create Key API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { key, user_name, status, expires_at, validity_minutes, max_devices, role, reset_devices } = body;

    if (!key) {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    }

    const keyObj = await findKey(key.trim().toUpperCase());
    if (!keyObj) {
      return NextResponse.json({ error: 'Key not found' }, { status: 404 });
    }

    // Update fields
    if (user_name !== undefined) keyObj.user_name = user_name;
    if (status !== undefined) keyObj.status = status;
    if (expires_at !== undefined) keyObj.expires_at = expires_at || null;
    if (validity_minutes !== undefined) keyObj.validity_minutes = validity_minutes ? parseInt(validity_minutes) : null;
    if (max_devices !== undefined) keyObj.max_devices = max_devices ? parseInt(max_devices) : 2;
    if (role !== undefined) keyObj.role = role || 'user';
    
    // Clear device bindings if requested
    if (reset_devices === true) {
      keyObj.devices = [];
    }

    await saveKey(keyObj);
    return NextResponse.json(keyObj);
  } catch (error) {
    console.error('Update Key API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get('key');

    if (!key) {
      return NextResponse.json({ error: 'Key parameter is required' }, { status: 400 });
    }

    const deleted = await deleteKey(key.trim().toUpperCase());
    if (deleted) {
      return NextResponse.json({ success: true, message: 'Key revoked successfully' });
    }

    return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  } catch (error) {
    console.error('Delete Key API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
