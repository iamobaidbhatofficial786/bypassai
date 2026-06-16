import { NextResponse } from 'next/server';
import { getSystemSettings, saveSystemSettings } from '@/lib/db';
import crypto from 'crypto';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

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
    const settings = await getSystemSettings();
    return NextResponse.json(settings, { headers: corsHeaders() });
  } catch (error) {
    console.error('Get Settings API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const { system_locked } = body;
    
    const settings = await getSystemSettings();
    settings.system_locked = !!system_locked;
    
    await saveSystemSettings(settings);
    return NextResponse.json(settings, { headers: corsHeaders() });
  } catch (error) {
    console.error('Save Settings API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
