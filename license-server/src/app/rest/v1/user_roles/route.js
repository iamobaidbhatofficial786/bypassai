import { NextResponse } from 'next/server';
import { listKeys } from '@/lib/db';
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
    let userId = '';

    // Parse eq param
    const userParam = searchParams.get('user_id');
    if (userParam) {
      if (userParam.startsWith('eq.')) {
        userId = userParam.substring(3);
      } else {
        userId = userParam;
      }
    }

    if (!userId) {
      return NextResponse.json([], { headers: corsHeaders() });
    }

    const keys = await listKeys();
    let matchingRole = 'user'; // Default role

    // Check which key hashes to this userId
    for (const keyObj of keys) {
      const hash = crypto.createHash('sha256').update(keyObj.key).digest('hex').substring(0, 36);
      if (hash === userId) {
        matchingRole = keyObj.role || 'user';
        break;
      }
    }

    return NextResponse.json([{ role: matchingRole }], { headers: corsHeaders() });
  } catch (error) {
    console.error('REST User Roles API error:', error);
    return NextResponse.json([], { headers: corsHeaders() });
  }
}
