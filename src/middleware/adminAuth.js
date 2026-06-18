// Provide a minimal NextResponse fallback for non-Next.js environments
let NextResponse;
try {
  // Attempt to import from Next.js runtime
  ({ NextResponse } = require('next/server'));
} catch {
  // Simple fallback: json method returns object with status
  NextResponse = {
    json: (payload, init = {}) => ({ ...payload, status: init.status || 200 })
  };
}

import crypto from 'crypto';
import { logger } from '../lib/logger.js';

/**
 * Shared admin authentication middleware.
 * Expects an Authorization header of the form:
 *   Bearer adm_<sha256(ADMIN_PASSWORD + 'LovablePowerkitsSalt')>
 * In production, deterministic tokens are deprecated – the middleware
 * will also accept a short‑lived JWT signed with JWT_SECRET (handled by
 * the `verifyAdminJwt` helper).  This fallback keeps dev environments
 * functional without breaking existing clients.
 */
export default function adminAuth(handler) {
  return async (req) => {
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Admin auth missing header');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const token = authHeader.substring(7);
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      logger.error('ADMIN_PASSWORD not set');
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }
    // Deterministic legacy token (dev only)
    const legacyHash = crypto
      .createHash('sha256')
      .update(adminPassword + 'LovablePowerkitsSalt')
      .digest('hex');
    const legacyToken = `adm_${legacyHash}`;
    if (token === legacyToken) {
      // In production the deterministic token is rejected – enforce that.
      if (process.env.NODE_ENV === 'production') {
        logger.warn('Legacy admin token used in production');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return handler(req);
    }
    // JWT fallback – verify signature and expiration
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload && payload.admin === true) {
        return handler(req);
      }
    } catch (e) {
      // ignore – will fall through to unauthorized
    }
    logger.warn('Invalid admin token');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  };
}
