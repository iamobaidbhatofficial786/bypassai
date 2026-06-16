import fs from 'fs';
import path from 'path';

// Resolve local DB path relative to project root
const LOCAL_DB_PATH = path.join(process.cwd(), 'db.json');

// Helper to initialize local db file if it doesn't exist
function initLocalDb() {
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify({ keys: {}, sessions: {} }, null, 2), 'utf-8');
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
        return data ? JSON.parse(data) : {};
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
      }
    };
  } else {
    // Local JSON implementation
    initLocalDb();
    return {
      async getKeys() {
        initLocalDb();
        const data = fs.readFileSync(LOCAL_DB_PATH, 'utf-8');
        return JSON.parse(data).keys || {};
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
  
  // Define session timeout: if no heartbeat in 2 minutes, remove session
  const SESSION_TIMEOUT_MS = 2 * 60 * 1000;

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
