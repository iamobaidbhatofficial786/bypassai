import { NextResponse } from 'next/server';
import { listActiveSessions, deleteSession } from '@/lib/db';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

import adminAuth from '@/middleware/adminAuth';

export const GET = adminAuth(async (req) => {
  try {
    const sessions = await listActiveSessions();
    return NextResponse.json(sessions);
  } catch (error) {
    logger.error('List Sessions API error:', { error: error.message, stack: error.stack });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
});

export const DELETE = adminAuth(async (req) => {
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
    logger.error('Delete Session API error:', { error: error.message, stack: error.stack });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
});
