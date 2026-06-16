import { NextResponse } from 'next/server';
import { findKey } from '@/lib/db';
import crypto from 'crypto';

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

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    let licenseKey = '';
    
    // Parse Supabase style eq parameter (e.g. license_key=eq.PK-DEV-TEST-002)
    const keyParam = searchParams.get('license_key');
    if (keyParam) {
      if (keyParam.startsWith('eq.')) {
        licenseKey = keyParam.substring(3);
      } else {
        licenseKey = keyParam;
      }
    }

    if (!licenseKey) {
      return NextResponse.json([], { headers: corsHeaders() });
    }

    const keyObj = await findKey(licenseKey.trim());

    if (!keyObj) {
      return NextResponse.json([], { headers: corsHeaders() });
    }

    // Generate a deterministic user_id based on the key
    const hash = crypto.createHash('sha256').update(keyObj.key).digest('hex').substring(0, 36);
    
    return NextResponse.json([{ user_id: hash }], { headers: corsHeaders() });
  } catch (error) {
    console.error('REST Licenses API error:', error);
    return NextResponse.json([], { headers: corsHeaders() });
  }
}
