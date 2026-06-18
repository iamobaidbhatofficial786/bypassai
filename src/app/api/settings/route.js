import { NextResponse } from 'next/server';
import { getSystemSettings, saveSystemSettings } from '@/lib/db';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

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

import adminAuth from '@/middleware/adminAuth';

export const GET = adminAuth(async (req) => {
  try {
    const settings = await getSystemSettings();
    return NextResponse.json(settings, { headers: corsHeaders() });
  } catch (error) {
    logger.error('Get Settings API error:', { error: error.message, stack: error.stack });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
});

export const POST = adminAuth(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const settings = await getSystemSettings();
    if (body.hasOwnProperty('system_locked')) {
      settings.system_locked = !!body.system_locked;
    }
    if (body.hasOwnProperty('enable_hints')) {
      settings.enable_hints = !!body.enable_hints;
    }
    await saveSystemSettings(settings);
    return NextResponse.json(settings, { headers: corsHeaders() });
  } catch (error) {
    logger.error('Save Settings API error:', { error: error.message, stack: error.stack });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
});
