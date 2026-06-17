import { NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/db';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

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
    const logs = await listAuditLogs();
    return NextResponse.json(logs);
  } catch (error) {
    console.error('List Audit Logs API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
