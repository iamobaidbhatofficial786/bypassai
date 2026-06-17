import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// On Vercel serverless, the root filesystem is read-only. We must write local files to /tmp.
const isVercel = !!(process.env.VERCEL || process.env.NOW_BUILDER || process.env.LAMBDA_TASK_ROOT);
const LOCAL_DB_PATH = isVercel 
  ? path.join('/tmp', 'db.json') 
  : path.join(process.cwd(), 'db.json');

const DEFAULT_KEYS = {
  "PK-DEV-TEST-001": {
    key: "PK-DEV-TEST-001",
    user_name: "Trial Tester",
    status: "trial",
    plan: "free",
    max_devices: 1,
    role: "user",
    devices: [],
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
    created_at: "2026-06-17T00:00:00.000Z",
    validity_minutes: 1440 // 24 hours
  }
};

// Stateless token signature logic
const SIGNING_SECRET = process.env.ADMIN_PASSWORD || 'default-secret-key-123';

export function generateStatelessToken(sessionData) {
  const payload = Buffer.from(JSON.stringify(sessionData)).toString('base64');
  const signature = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  return `sess_${payload}.${signature}`;
}

export function verifyStatelessToken(token) {
  if (!token || !token.startsWith('sess_')) return null;
  const parts = token.substring(5).split('.');
  if (parts.length !== 2) return null;
  
  const [payload, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  
  if (signature !== expectedSignature) return null;
  
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

// Helper to initialize local db file if it doesn't exist
function initLocalDb() {
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    try {
      fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify({ 
        keys: DEFAULT_KEYS, 
        sessions: {}, 
        settings: { system_locked: false }, 
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

// Adapter interface
export async function getDb() {
  const isKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

  if (isKv) {
    return {
      // Keys management
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

      // Sessions management
      async getSessions() {
        const data = await kvRequest('GET', 'pk_sessions');
        return data ? JSON.parse(data) : {};
      },
      async saveSessions(sessions) {
        await kvRequest('SET', 'pk_sessions', JSON.stringify(sessions));
      },

      // Settings management
      async getSettings() {
        const data = await kvRequest('GET', 'pk_settings');
        return data ? JSON.parse(data) : {};
      },
      async saveSettings(settings) {
        await kvRequest('SET', 'pk_settings', JSON.stringify(settings));
      },

      // Logs & limits
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
    // Local JSON implementation
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

// Business logic wrappers

export async function findKey(key) {
  const db = await getDb();
  const keys = await db.getKeys();
  return keys[key] || null;
}

export async function saveKey(keyData) {
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
  const db = await getDb();
  const keys = await db.getKeys();
  if (keys[key]) {
    delete keys[key];
    await db.saveKeys(keys);
    // Also clean up any active sessions associated with this key
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

export async function listKeys() {
  const db = await getDb();
  const keys = await db.getKeys();
  return Object.values(keys).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function findSession(sessionId) {
  const db = await getDb();
  const sessions = await db.getSessions();
  return sessions[sessionId] || null;
}

export async function saveSession(sessionData) {
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
  const db = await getDb();
  const sessions = await db.getSessions();
  const now = Date.now();
  let changed = false;
  
  // Define session timeout: if no activity in 20 minutes, remove session
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
  await cleanExpiredSessions();
  const db = await getDb();
  const sessions = await db.getSessions();
  return Object.values(sessions).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function getSystemSettings() {
  const db = await getDb();
  let settings = {};
  if (typeof db.getSettings === 'function') {
    settings = await db.getSettings();
  }
  
  // Inject database environment warning info
  const isVercel = !!(process.env.VERCEL || process.env.NOW_BUILDER || process.env.LAMBDA_TASK_ROOT);
  const isKv = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  settings.db_ephemeral_warning = isVercel && !isKv;
  
  return settings;
}

export async function saveSystemSettings(settings) {
  const db = await getDb();
  if (typeof db.saveSettings === 'function') {
    // Strip warnings before saving to keep config clean
    const toSave = { ...settings };
    delete toSave.db_ephemeral_warning;
    await db.saveSettings(toSave);
    return settings;
  }
  return {};
}

export async function logUsage(licenseKey, deviceId, prompt, ip, allowed, plan) {
  const db = await getDb();
  if (typeof db.getUsageLogs !== 'function') return;
  const logs = await db.getUsageLogs();
  
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
  
  logs.unshift(newLog);
  if (logs.length > 1000) {
    logs.length = 1000;
  }
  await db.saveUsageLogs(logs);
  return newLog;
}

export async function logAudit(licenseKey, action, details, ip) {
  const db = await getDb();
  if (typeof db.getAuditLogs !== 'function') return;
  const logs = await db.getAuditLogs();
  
  const newLog = {
    id: `aud_${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : crypto.randomBytes(16).toString('hex')}`,
    license_key: licenseKey || 'system',
    action: action,
    details: details || '',
    ip: ip || 'unknown',
    timestamp: new Date().toISOString()
  };
  
  logs.unshift(newLog);
  if (logs.length > 1000) {
    logs.length = 1000;
  }
  await db.saveAuditLogs(logs);
  return newLog;
}

export async function listUsageLogs() {
  const db = await getDb();
  if (typeof db.getUsageLogs !== 'function') return [];
  return await db.getUsageLogs();
}

export async function listAuditLogs() {
  const db = await getDb();
  if (typeof db.getAuditLogs !== 'function') return [];
  return await db.getAuditLogs();
}

export async function checkAndTrackRateLimit(licenseKey, ip, deviceId, plan) {
  const db = await getDb();
  if (typeof db.getRateLimits !== 'function') return { allowed: true, remaining: 999 };
  
  const limits = await db.getRateLimits();
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const currentDay = Math.floor(now / 86400000);
  
  // Clean up old limit entries periodically to prevent DB bloat
  let limitKeys = Object.keys(limits);
  if (limitKeys.length > 5000) {
    for (const key of limitKeys) {
      if (limits[key].expire_at && limits[key].expire_at < now) {
        delete limits[key];
      }
    }
  }

  // Rate configurations
  const PLAN_LIMITS = {
    free: { min: 2, day: 10 },
    pro: { min: 20, day: 200 },
    enterprise: { min: 100, day: 10000 }
  };

  const planConf = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  // Track License / IP / Device
  const lKeyMin = `lim:min:lic:${licenseKey}:${currentMinute}`;
  const lKeyDay = `lim:day:lic:${licenseKey}:${currentDay}`;
  const ipKeyMin = `lim:min:ip:${ip}:${currentMinute}`;
  const ipKeyDay = `lim:day:ip:${ip}:${currentDay}`;

  // Initialize if not exist
  const initKey = (k, expireOffset) => {
    if (!limits[k]) {
      limits[k] = { count: 0, expire_at: now + expireOffset };
    }
  };

  initKey(lKeyMin, 60000);
  initKey(lKeyDay, 86400000);
  initKey(ipKeyMin, 60000);
  initKey(ipKeyDay, 86400000);

  // Check rate limit overflow
  if (limits[lKeyMin].count >= planConf.min) {
    return { allowed: false, reason: 'rate_limit_minute', message: 'Rate limit exceeded (minute). Please wait.' };
  }
  if (limits[lKeyDay].count >= planConf.day) {
    return { allowed: false, reason: 'rate_limit_day', message: 'Rate limit exceeded (day). Please upgrade plan.' };
  }

  // IP strict check to prevent brute force/abuse from single client (even on enterprise)
  const ipMinLimit = plan === 'enterprise' ? 120 : (planConf.min * 2);
  const ipDayLimit = plan === 'enterprise' ? 10000 : (planConf.day * 2);

  if (limits[ipKeyMin].count >= ipMinLimit) {
    return { allowed: false, reason: 'ip_limit_minute', message: 'IP is sending prompts too rapidly.' };
  }
  if (limits[ipKeyDay].count >= ipDayLimit) {
    return { allowed: false, reason: 'ip_limit_day', message: 'IP daily usage exceeded.' };
  }

  // Increment counts
  limits[lKeyMin].count++;
  limits[lKeyDay].count++;
  limits[ipKeyMin].count++;
  limits[ipKeyDay].count++;

  await db.saveRateLimits(limits);

  const remaining = Math.max(0, planConf.day - limits[lKeyDay].count);
  return { allowed: true, remaining };
}
