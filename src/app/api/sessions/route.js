import { NextResponse } from 'next/server';
import { listActiveSessions, deleteSession } from '@/lib/db';
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
    const sessions = await listActiveSessions();
    return NextResponse.json(sessions);
  } catch (error) {
    console.error('List Sessions API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('session_id');

    if (!sessionId) {
      return NextResponse.json({ error: 'Session ID parameter is required' }, { status: 400 });
    }

    const deleted = await deleteSession(sessionId);
    if (deleted) {
      return NextResponse.json({ success: true, message: 'Session kicked successfully' });
    }

    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  } catch (error) {
    console.error('Delete Session API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
