import { logger } from './logger.js';
import path from 'path';
import crypto from 'crypto';
import { Pool } from 'pg';
import fs from 'fs';

// Enforce production environment requirements
// In production we prefer DATABASE_URL, JWT_SECRET, and ADMIN_PASSWORD to be set.
// However, for environments like Vercel where these may be omitted (using KV fallback),
// we provide safe defaults to allow the build to succeed.
if (process.env.NODE_ENV === 'production') {
  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL not set – falling back to KV/local storage');
  }
  if (!process.env.JWT_SECRET) {
    console.warn('WARNING: JWT_SECRET not set – using insecure default');
    process.env.JWT_SECRET = 'insecure-default-secret';
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('WARNING: ADMIN_PASSWORD not set – using insecure default');
    process.env.ADMIN_PASSWORD = 'insecure-default-admin';
  }
}

// Initialize PostgreSQL pool if DATABASE_URL is configured
let pgPool = null;
if (process.env.DATABASE_URL) {
  try {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    });
    // Verify connection at startup
    pgPool.query('SELECT 1').catch(err => {
      logger.error('PostgreSQL connection test failed', { error: err.message, stack: err.stack });
      throw err;
    });
  } catch (err) {
    logger.error('Failed to initialize PostgreSQL pool', { error: err.message, stack: err.stack });
  }
}

// Local fallback storage – ONLY enabled in non‑production environments
const isVercel = !!(process.env.VERCEL || process.env.NOW_BUILDER || process.env.LAMBDA_TASK_ROOT);
let LOCAL_DB_PATH = '';
if (process.env.NODE_ENV !== 'production') {
  LOCAL_DB_PATH = isVercel 
    ? path.join('/tmp', 'db.json') 
    : path.join(process.cwd(), 'db.json');
}

const DEFAULT_KEYS = {
  "PK-DEV-TEST-001": {
    key: "PK-DEV-TEST-001",
    user_name: "Trial Tester",
    status: "trial",
    plan: "free",
    max_devices: 1,
    role: "user",
    devices: [],
    device_public_keys: {},
    created_at: "2026-06-17T00:00:00.000Z",
    validity_minutes: 60
  },
  "PK-DEV-TEST-002": {
    key: "PK-DEV-TEST-002",
    user_name: "Active Tester",
    status: "active",
    plan: "pro",
    max_devices: 2,
    role: "user",
    devices: [],
    device_public_keys: {},
    created_at: "2026-06-17T00:00:00.000Z",
    validity_minutes: 10080 // 7 days
  },
  "PK-DEV-TEST-003": {
    key: "PK-DEV-TEST-003",
    user_name: "Unlimited Tester",
    status: "active",
    plan: "enterprise",
    max_devices: 5,
    role: "user",
    devices: [],
    device_public_keys: {},
    created_at: "2026-06-17T00:00:00.000Z",
    expires_at: null
  },
  "PK-DEV-TEST-004": {
    key: "PK-DEV-TEST-004",
    user_name: "Short Trial",
    status: "trial",
    plan: "free",
    max_devices: 1,
    role: "user",
    devices: [],
    device_public_keys: {},
    created_at: "2026-06-17T00:00:00.000Z",
    validity_minutes: 30
  },
  "PK-DEV-TEST-005": {
    key: "PK-DEV-TEST-005",
    user_name: "Day Pass",
    status: "active",
    plan: "pro",
    max_devices: 2,
    role: "user",
    devices: [],
    device_public_keys: {},
    created_at: "2026-06-17T00:00:00.000Z",
    validity_minutes: 1440 // 24 hours
  }
};

// JWT secret – required for token signing. Provide a fallback in production if missing.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set – using insecure default');
  JWT_SECRET = 'insecure-default-secret';
}
if (['changeme','default-secret-key-123','123456'].includes(JWT_SECRET)) {
  console.warn('WARNING: JWT_SECRET uses a known insecure value');
}

// Admin password – required for legacy token generation. Provide fallback in production.
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD not set – using insecure default');
  ADMIN_PASSWORD = 'insecure-default-admin';
}
if (['admin','password','changeme'].includes(ADMIN_PASSWORD)) {
  console.warn('WARNING: ADMIN_PASSWORD uses a known insecure value');
}
const SIGNING_SECRET = JWT_SECRET || ADMIN_PASSWORD;


// Base64url encoders for standardized JWT structure
function base64urlEncode(strOrBuf) {
  const buf = Buffer.isBuffer(strOrBuf) ? strOrBuf : Buffer.from(strOrBuf, 'utf8');
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

// Generate a standard cryptographically signed JWT token
export function generateStatelessToken(sessionData) {
  const header = { alg: "HS256", typ: "JWT" };
  const headerEncoded = base64urlEncode(JSON.stringify(header));
  const payloadEncoded = base64urlEncode(JSON.stringify(sessionData));
  
  const signature = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${headerEncoded}.${payloadEncoded}`)
    .digest();
  
  const signatureEncoded = base64urlEncode(signature);
  return `sess_${headerEncoded}.${payloadEncoded}.${signatureEncoded}`;
}

// Verify standard signed JWT token
export function verifyStatelessToken(token) {
  if (!token || !token.startsWith('sess_')) return null;
  const parts = token.substring(5).split('.');
  if (parts.length !== 3) return null;
  
  const [headerEncoded, payloadEncoded, signatureEncoded] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${headerEncoded}.${payloadEncoded}`)
    .digest();
  
  if (base64urlEncode(expectedSignature) !== signatureEncoded) {
    return null;
  }
  
  try {
    const payload = JSON.parse(base64urlDecode(payloadEncoded));
    // Verify expiration if exp claim present
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }
    return payload;
  } catch (e) {
    return null;
  }
}

// Verify cryptographic ECDSA request signatures from devices
export function verifyEcdsaSignature(publicKeyJwkString, dataText, signatureBase64) {
  try {
    const publicKeyJwk = JSON.parse(publicKeyJwkString);
    const pubKey = crypto.createPublicKey({
      key: publicKeyJwk,
      format: 'jwk'
    });
    
    const verifier = crypto.createVerify('SHA256');
    verifier.update(dataText);
    const signatureBuffer = Buffer.from(signatureBase64, 'base64');
    return verifier.verify(pubKey, signatureBuffer);
  } catch (e) {
    console.error("[Crypto] Verification failed:", e.message || e);
    return false;
  }
}

// Helper to query PostgreSQL pool
async function queryPg(text, params) {
  if (!pgPool) throw new Error("PostgreSQL pool is not initialized.");
  const client = await pgPool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Helper to initialize local db file if it doesn't exist
function initLocalDb() {
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    try {
      fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify({ 
        keys: DEFAULT_KEYS, 
        sessions: {}, 
        settings: { system_locked: false, enable_hints: false }, 
        usage_logs: [], 
        audit_logs: [], 
        rate_limits: {} 
      }, null, 2), 'utf-8');
    } catch (e) {
      console.error("Failed to initialize local DB:", e);
    }
  }
}

// REST Client for Vercel KV (Redis) to avoid external dependency issues in serverless
async function kvRequest(command, ...args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) return null;

  try {
    const res = await fetch(`${url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([command, ...args]),
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new Error(`KV API Error: ${res.statusText}`);
    }

    const data = await res.json();
    return data.result;
  } catch (error) {
    console.error('Vercel KV Request failed:', error);
    throw error;
  }
}

// Adapter interface for KV/JSON file fallback
async function getDb() {
  const isKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

  if (isKv) {
    return {
      async getKeys() {
        const data = await kvRequest('GET', 'pk_license_keys');
        const keys = data ? JSON.parse(data) : {};
        let updated = false;
        for (const k in DEFAULT_KEYS) {
          if (!keys[k]) {
            keys[k] = DEFAULT_KEYS[k];
            updated = true;
          }
        }
        if (updated) {
          await kvRequest('SET', 'pk_license_keys', JSON.stringify(keys));
        }
        return keys;
      },
      async saveKeys(keys) {
        await kvRequest('SET', 'pk_license_keys', JSON.stringify(keys));
      },
      async getSessions() {
        const data = await kvRequest('GET', 'pk_sessions');
        return data ? JSON.parse(data) : {};
      },
      async saveSessions(sessions) {
        await kvRequest('SET', 'pk_sessions', JSON.stringify(sessions));
      },
      async getSettings() {
        const data = await kvRequest('GET', 'pk_settings');
        return data ? JSON.parse(data) : {};
      },
      async saveSettings(settings) {
        await kvRequest('SET', 'pk_settings', JSON.stringify(settings));
      },
      async getUsageLogs() {
        const data = await kvRequest('GET', 'pk_usage_logs');
        return data ? JSON.parse(data) : [];
      },
      async saveUsageLogs(logs) {
        await kvRequest('SET', 'pk_usage_logs', JSON.stringify(logs));
      },
      async getAuditLogs() {
        const data = await kvRequest('GET', 'pk_audit_logs');
        return data ? JSON.parse(data) : [];
      },
      async saveAuditLogs(logs) {
        await kvRequest('SET', 'pk_audit_logs', JSON.stringify(logs));
      },
      async getRateLimits() {
        const data = await kvRequest('GET', 'pk_rate_limits');
        return data ? JSON.parse(data) : {};
      },
      async saveRateLimits(limits) {
        await kvRequest('SET', 'pk_rate_limits', JSON.stringify(limits));
      }
    };
  } else {
    initLocalDb();
    return {
      async getKeys() {
        initLocalDb();
        const data = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
        const parsed = JSON.parse(data);
        const keys = parsed.keys || {};
        let updated = false;
        for (const k in DEFAULT_KEYS) {
          if (!keys[k]) {
            keys[k] = DEFAULT_KEYS[k];
            updated = true;
          }
        }
        if (updated) {
          parsed.keys = keys;
          fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(parsed, null, 2), 'utf-8');
        }
        return keys;
      },
      async saveKeys(keys) {
        initLocalDb();
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf-8'));
        data.keys = keys;
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
      },
      async getSessions() {
        initLocalDb();
        const data = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
        return JSON.parse(data).sessions || {};
      },
      async saveSessions(sessions) {
        initLocalDb();
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf-8'));
        data.sessions = sessions;
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
      },
      async getSettings() {
        initLocalDb();
        const data = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
        return JSON.parse(data).settings || {};
      },
      async saveSettings(settings) {
        initLocalDb();
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf-8'));
        data.settings = settings;
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
      },
      async getUsageLogs() {
        initLocalDb();
        const data = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
        return JSON.parse(data).usage_logs || [];
      },
      async saveUsageLogs(logs) {
        initLocalDb();
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf-8'));
        data.usage_logs = logs;
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
      },
      async getAuditLogs() {
        initLocalDb();
        const data = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
        return JSON.parse(data).audit_logs || [];
      },
      async saveAuditLogs(logs) {
        initLocalDb();
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf-8'));
        data.audit_logs = logs;
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
      },
      async getRateLimits() {
        initLocalDb();
        const data = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
        return JSON.parse(data).rate_limits || {};
      },
      async saveRateLimits(limits) {
        initLocalDb();
        const data = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf-8'));
        data.rate_limits = limits;
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
      }
    };
  }
}

// ============================================
// Business Logic Wrapper Methods
// ============================================

export async function findKey(key) {
  if (pgPool) {
    const res = await queryPg('SELECT * FROM license_keys WHERE key = $1', [key]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      key: row.key,
      user_name: row.user_name,
      status: row.status,
      plan: row.plan,
      expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      validity_minutes: row.validity_minutes,
      max_devices: row.max_devices,
      role: row.role,
      devices: row.devices || [],
      device_public_keys: row.device_public_keys || {},
      created_at: new Date(row.created_at).toISOString(),
      activated_at: row.activated_at ? new Date(row.activated_at).toISOString() : null
    };
  }
  
  const db = await getDb();
  const keys = await db.getKeys();
  return keys[key] || null;
}

export async function saveKey(keyData) {
  if (pgPool) {
    await queryPg(
      `INSERT INTO license_keys (
         key, user_name, status, plan, expires_at, validity_minutes, 
         max_devices, role, devices, device_public_keys, created_at, activated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (key) DO UPDATE SET
         user_name = EXCLUDED.user_name,
         status = EXCLUDED.status,
         plan = EXCLUDED.plan,
         expires_at = EXCLUDED.expires_at,
         validity_minutes = EXCLUDED.validity_minutes,
         max_devices = EXCLUDED.max_devices,
         role = EXCLUDED.role,
         devices = EXCLUDED.devices,
         device_public_keys = EXCLUDED.device_public_keys,
         activated_at = EXCLUDED.activated_at`,
      [
        keyData.key,
        keyData.user_name || 'Licensed User',
        keyData.status || 'active',
        keyData.plan || 'pro',
        keyData.expires_at ? new Date(keyData.expires_at) : null,
        keyData.validity_minutes || null,
        keyData.max_devices !== undefined ? parseInt(keyData.max_devices) : 2,
        keyData.role || 'user',
        keyData.devices || [],
        JSON.stringify(keyData.device_public_keys || {}),
        keyData.created_at ? new Date(keyData.created_at) : new Date(),
        keyData.activated_at ? new Date(keyData.activated_at) : null
      ]
    );
    return keyData;
  }

  const db = await getDb();
  const keys = await db.getKeys();
  keys[keyData.key] = {
    ...keys[keyData.key],
    ...keyData,
  };
  await db.saveKeys(keys);
  return keyData;
}

export async function deleteKey(key) {
  if (pgPool) {
    const res = await queryPg('DELETE FROM license_keys WHERE key = $1', [key]);
    return res.rowCount > 0;
  }

  const db = await getDb();
  const keys = await db.getKeys();
  if (keys[key]) {
    delete keys[key];
    await db.saveKeys(keys);
    // Clean associated sessions
    const sessions = await db.getSessions();
    let changed = false;
    for (const sid in sessions) {
      if (sessions[sid].key === key) {
        delete sessions[sid];
        changed = true;
      }
    }
    if (changed) {
      await db.saveSessions(sessions);
    }
    return true;
  }
  return false;
}

// New function to delete all licenses and associated sessions
export async function deleteAllKeys() {
  if (pgPool) {
    await queryPg('DELETE FROM license_keys');
    // Also clear sessions associated with any key
    await queryPg('DELETE FROM active_sessions');
    return true;
  }

  const db = await getDb();
  // Clear all keys
  await db.saveKeys({});
  // Clear all sessions
  await db.saveSessions({});
  return true;
}

export async function listKeys() {
  if (pgPool) {
    const res = await queryPg('SELECT * FROM license_keys ORDER BY created_at DESC');
    return res.rows.map(row => ({
      key: row.key,
      user_name: row.user_name,
      status: row.status,
      plan: row.plan,
      expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      validity_minutes: row.validity_minutes,
      max_devices: row.max_devices,
      role: row.role,
      devices: row.devices || [],
      device_public_keys: row.device_public_keys || {},
      created_at: new Date(row.created_at).toISOString(),
      activated_at: row.activated_at ? new Date(row.activated_at).toISOString() : null
    }));
  }

  const db = await getDb();
  const keys = await db.getKeys();
  return Object.values(keys).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function findSession(sessionId) {
  if (pgPool) {
    const res = await queryPg('SELECT * FROM active_sessions WHERE session_id = $1', [sessionId]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      session_id: row.session_id,
      key: row.key,
      device_id: row.device_id,
      created_at: new Date(row.created_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      last_seen: new Date(row.last_seen).toISOString(),
      user_name: row.user_name
    };
  }

  const db = await getDb();
  const sessions = await db.getSessions();
  return sessions[sessionId] || null;
}

export async function saveSession(sessionData) {
  if (pgPool) {
    await queryPg(
      `INSERT INTO active_sessions (session_id, key, device_id, created_at, expires_at, last_seen, user_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id) DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         last_seen = EXCLUDED.last_seen,
         user_name = EXCLUDED.user_name`,
      [
        sessionData.session_id,
        sessionData.key,
        sessionData.device_id || '',
        sessionData.created_at ? new Date(sessionData.created_at) : new Date(),
        sessionData.expires_at ? new Date(sessionData.expires_at) : new Date(Date.now() + 20 * 60 * 1000),
        new Date(),
        sessionData.user_name || 'Licensed User'
      ]
    );
    return sessionData;
  }

  const db = await getDb();
  const sessions = await db.getSessions();
  sessions[sessionData.session_id] = {
    ...sessions[sessionData.session_id],
    ...sessionData,
    last_seen: new Date().toISOString(),
  };
  await db.saveSessions(sessions);
  return sessionData;
}

export async function deleteSession(sessionId) {
  if (pgPool) {
    const res = await queryPg('DELETE FROM active_sessions WHERE session_id = $1', [sessionId]);
    return res.rowCount > 0;
  }

  const db = await getDb();
  const sessions = await db.getSessions();
  if (sessions[sessionId]) {
    delete sessions[sessionId];
    await db.saveSessions(sessions);
    return true;
  }
  return false;
}

export async function cleanExpiredSessions() {
  if (pgPool) {
    await queryPg(
      `DELETE FROM active_sessions 
       WHERE expires_at < NOW() 
          OR last_seen < NOW() - INTERVAL '20 minutes'`
    );
    return;
  }

  const db = await getDb();
  const sessions = await db.getSessions();
  const now = Date.now();
  let changed = false;
  const SESSION_TIMEOUT_MS = 20 * 60 * 1000;

  for (const sid in sessions) {
    const lastSeenTime = new Date(sessions[sid].last_seen).getTime();
    if (now - lastSeenTime > SESSION_TIMEOUT_MS) {
      delete sessions[sid];
      changed = true;
    }
  }

  if (changed) {
    await db.saveSessions(sessions);
  }
}

export async function listActiveSessions() {
  if (pgPool) {
    await cleanExpiredSessions();
    const res = await queryPg('SELECT * FROM active_sessions ORDER BY created_at DESC');
    return res.rows.map(row => ({
      session_id: row.session_id,
      key: row.key,
      device_id: row.device_id,
      created_at: new Date(row.created_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      last_seen: new Date(row.last_seen).toISOString(),
      user_name: row.user_name
    }));
  }

  await cleanExpiredSessions();
  const db = await getDb();
  const sessions = await db.getSessions();
  return Object.values(sessions).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function getSystemSettings() {
  if (pgPool) {
    const res = await queryPg("SELECT * FROM system_settings WHERE key = 'global'");
    let settings = {};
    if (res.rows.length > 0) {
      settings = {
        system_locked: res.rows[0].system_locked,
        enable_hints: res.rows[0].enable_hints
      };
    } else {
      settings = { system_locked: false, enable_hints: false };
      await queryPg(
        "INSERT INTO system_settings (key, system_locked, enable_hints) VALUES ('global', false, false) ON CONFLICT DO NOTHING"
      );
    }
    settings.db_ephemeral_warning = isVercel && !process.env.DATABASE_URL && !(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
    return settings;
  }

  const db = await getDb();
  let settings = {};
  if (typeof db.getSettings === 'function') {
    settings = await db.getSettings();
  }
  const isKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  settings.db_ephemeral_warning = isVercel && !isKv;
  return settings;
}

export async function saveSystemSettings(settings) {
  if (pgPool) {
    await queryPg(
      `INSERT INTO system_settings (key, system_locked, enable_hints)
       VALUES ('global', $1, $2)
       ON CONFLICT (key) DO UPDATE SET
         system_locked = EXCLUDED.system_locked,
         enable_hints = EXCLUDED.enable_hints`,
      [
        !!settings.system_locked,
        !!settings.enable_hints
      ]
    );
    return settings;
  }

  const db = await getDb();
  if (typeof db.saveSettings === 'function') {
    const toSave = { ...settings };
    delete toSave.db_ephemeral_warning;
    await db.saveSettings(toSave);
    return settings;
  }
  return {};
}

export async function logUsage(licenseKey, deviceId, prompt, ip, allowed, plan) {
  const newLog = {
    id: `log_${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : crypto.randomBytes(16).toString('hex')}`,
    license_key: licenseKey,
    device_id: deviceId || 'unknown',
    prompt_preview: prompt ? prompt.substring(0, 150) : '',
    ip: ip || 'unknown',
    allowed: !!allowed,
    plan: plan || 'free',
    timestamp: new Date().toISOString()
  };

  if (pgPool) {
    await queryPg(
      `INSERT INTO usage_logs (id, license_key, device_id, prompt_preview, ip, allowed, plan, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newLog.id,
        newLog.license_key,
        newLog.device_id,
        newLog.prompt_preview,
        newLog.ip,
        newLog.allowed,
        newLog.plan,
        new Date(newLog.timestamp)
      ]
    );
    if (Math.random() < 0.05) {
      queryPg(
        `DELETE FROM usage_logs 
         WHERE id NOT IN (
           SELECT id FROM usage_logs ORDER BY timestamp DESC LIMIT 1000
         )`
      ).catch(() => null);
    }
    return newLog;
  }

  const db = await getDb();
  if (typeof db.getUsageLogs !== 'function') return;
  const logs = await db.getUsageLogs();
  
  logs.unshift(newLog);
  if (logs.length > 1000) {
    logs.length = 1000;
  }
  await db.saveUsageLogs(logs);
  return newLog;
}

export async function logAudit(licenseKey, action, details, ip) {
  const newLog = {
    id: `aud_${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : crypto.randomBytes(16).toString('hex')}`,
    license_key: licenseKey || 'system',
    action: action,
    details: details || '',
    ip: ip || 'unknown',
    timestamp: new Date().toISOString()
  };

  if (pgPool) {
    await queryPg(
      `INSERT INTO audit_logs (id, license_key, action, details, ip, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        newLog.id,
        newLog.license_key,
        newLog.action,
        newLog.details,
        newLog.ip,
        new Date(newLog.timestamp)
      ]
    );
    if (Math.random() < 0.05) {
      queryPg(
        `DELETE FROM audit_logs 
         WHERE id NOT IN (
           SELECT id FROM audit_logs ORDER BY timestamp DESC LIMIT 1000
         )`
      ).catch(() => null);
    }
    return newLog;
  }

  const db = await getDb();
  if (typeof db.getAuditLogs !== 'function') return;
  const logs = await db.getAuditLogs();
  
  logs.unshift(newLog);
  if (logs.length > 1000) {
    logs.length = 1000;
  }
  await db.saveAuditLogs(logs);
  return newLog;
}

export async function listUsageLogs() {
  if (pgPool) {
    const res = await queryPg('SELECT * FROM usage_logs ORDER BY timestamp DESC LIMIT 1000');
    return res.rows.map(row => ({
      id: row.id,
      license_key: row.license_key,
      device_id: row.device_id,
      prompt_preview: row.prompt_preview,
      ip: row.ip,
      allowed: row.allowed,
      plan: row.plan,
      timestamp: new Date(row.timestamp).toISOString()
    }));
  }

  const db = await getDb();
  if (typeof db.getUsageLogs !== 'function') return [];
  return await db.getUsageLogs();
}

export async function listAuditLogs() {
  if (pgPool) {
    const res = await queryPg('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 1000');
    return res.rows.map(row => ({
      id: row.id,
      license_key: row.license_key,
      action: row.action,
      details: row.details,
      ip: row.ip,
      timestamp: new Date(row.timestamp).toISOString()
    }));
  }

  const db = await getDb();
  if (typeof db.getAuditLogs !== 'function') return [];
  return await db.getAuditLogs();
}

export async function checkAndTrackRateLimit(licenseKey, ip, deviceId, plan) {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const currentDay = Math.floor(now / 86400000);

  const PLAN_LIMITS = {
    free: { min: 2, day: 10 },
    pro: { min: 20, day: 200 },
    enterprise: { min: 100, day: 10000 }
  };
  const planConf = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  const lKeyMin = `lim:min:lic:${licenseKey}:${currentMinute}`;
  const lKeyDay = `lim:day:lic:${licenseKey}:${currentDay}`;
  const ipKeyMin = `lim:min:ip:${ip}:${currentMinute}`;
  const ipKeyDay = `lim:day:ip:${ip}:${currentDay}`;

  if (pgPool) {
    const keys = [lKeyMin, lKeyDay, ipKeyMin, ipKeyDay];
    const selectRes = await queryPg(`SELECT key, count FROM rate_limits WHERE key = ANY($1)`, [keys]);
    
    const counts = {};
    keys.forEach(k => counts[k] = 0);
    selectRes.rows.forEach(row => counts[row.key] = row.count);

    if (counts[lKeyMin] >= planConf.min) {
      return { allowed: false, reason: 'rate_limit_minute', message: 'Rate limit exceeded (minute). Please wait.' };
    }
    if (counts[lKeyDay] >= planConf.day) {
      return { allowed: false, reason: 'rate_limit_day', message: 'Rate limit exceeded (day). Please upgrade plan.' };
    }

    const ipMinLimit = plan === 'enterprise' ? 120 : (planConf.min * 2);
    const ipDayLimit = plan === 'enterprise' ? 10000 : (planConf.day * 2);

    if (counts[ipKeyMin] >= ipMinLimit) {
      return { allowed: false, reason: 'ip_limit_minute', message: 'IP is sending prompts too rapidly.' };
    }
    if (counts[ipKeyDay] >= ipDayLimit) {
      return { allowed: false, reason: 'ip_limit_day', message: 'IP daily usage exceeded.' };
    }

    // Upsert rate limit increments
    const queries = [
      [lKeyMin, now + 60000],
      [lKeyDay, now + 86400000],
      [ipKeyMin, now + 60000],
      [ipKeyDay, now + 86400000]
    ];
    for (const [key, expireAt] of queries) {
      await queryPg(
        `INSERT INTO rate_limits (key, count, expire_at)
         VALUES ($1, 1, $2)
         ON CONFLICT (key) DO UPDATE
         SET count = rate_limits.count + 1`,
        [key, expireAt]
      );
    }

    if (Math.random() < 0.05) {
      queryPg(`DELETE FROM rate_limits WHERE expire_at < $1`, [now]).catch(() => null);
    }

    const remaining = Math.max(0, planConf.day - (counts[lKeyDay] + 1));
    return { allowed: true, remaining };
  }

  // Fallback to local / KV rate limiter
  const db = await getDb();
  if (typeof db.getRateLimits !== 'function') return { allowed: true, remaining: 999 };
  
  const limits = await db.getRateLimits();
  
  // Clean entries periodically
  let limitKeys = Object.keys(limits);
  if (limitKeys.length > 5000) {
    for (const key of limitKeys) {
      if (limits[key].expire_at && limits[key].expire_at < now) {
        delete limits[key];
      }
    }
  }

  const initKey = (k, expireOffset) => {
    if (!limits[k]) {
      limits[k] = { count: 0, expire_at: now + expireOffset };
    }
  };

  initKey(lKeyMin, 60000);
  initKey(lKeyDay, 86400000);
  initKey(ipKeyMin, 60000);
  initKey(ipKeyDay, 86400000);

  if (limits[lKeyMin].count >= planConf.min) {
    return { allowed: false, reason: 'rate_limit_minute', message: 'Rate limit exceeded (minute). Please wait.' };
  }
  if (limits[lKeyDay].count >= planConf.day) {
    return { allowed: false, reason: 'rate_limit_day', message: 'Rate limit exceeded (day). Please upgrade plan.' };
  }

  const ipMinLimit = plan === 'enterprise' ? 120 : (planConf.min * 2);
  const ipDayLimit = plan === 'enterprise' ? 10000 : (planConf.day * 2);

  if (limits[ipKeyMin].count >= ipMinLimit) {
    return { allowed: false, reason: 'ip_limit_minute', message: 'IP is sending prompts too rapidly.' };
  }
  if (limits[ipKeyDay].count >= ipDayLimit) {
    return { allowed: false, reason: 'ip_limit_day', message: 'IP daily usage exceeded.' };
  }

  limits[lKeyMin].count++;
  limits[lKeyDay].count++;
  limits[ipKeyMin].count++;
  limits[ipKeyDay].count++;

  await db.saveRateLimits(limits);

  const remaining = Math.max(0, planConf.day - limits[lKeyDay].count);
  return { allowed: true, remaining };
}
