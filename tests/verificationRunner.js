// tests/verificationRunner.js
// This script runs the required verification checks without a full test framework.
// It prints PASS/FAIL lines that we will capture as the final verification report.

const path = require('path');
const crypto = require('crypto');
const { NextResponse } = require('next/server');

// Helper to create a mock request object compatible with adminAuth middleware
function mockRequest(token) {
  return {
    headers: {
      get(name) {
        if (name.toLowerCase() === 'authorization') {
          return token ? `Bearer ${token}` : null;
        }
        return null;
      },
    },
    // URL is required for some handlers (e.g., DELETE sessions)
    url: 'http://localhost',
  };
}

// -------------------------------------------------------------------
// 1. JWT Tests (valid, expired, tampered, malformed)
// -------------------------------------------------------------------
// Set required env vars for tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-123';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'testadmin';

const { generateStatelessToken, verifyStatelessToken } = require('../src/lib/db');
function runJwtTests() {
  console.log('\n=== JWT Tests ===');

  // Ensure a secret exists – use a deterministic dummy if unset (test env).
  const secret = process.env.JWT_SECRET || 'test-secret-123';
  process.env.JWT_SECRET = secret;
  const adminPwd = process.env.ADMIN_PASSWORD || 'testadmin';
  process.env.ADMIN_PASSWORD = adminPwd;

  // Valid token
  const validToken = generateStatelessToken({ user: 'tester' });
  const validResult = verifyStatelessToken(validToken);
  console.log('Valid JWT:', validResult ? 'PASS' : 'FAIL');

  // Expired token (exp in the past)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadExpired = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })).toString('base64url');
  const sigExpired = crypto.createHmac('sha256', secret).update(`${header}.${payloadExpired}`).digest('base64url');
  const expiredToken = `sess_${header}.${payloadExpired}.${sigExpired}`;
  const expiredResult = verifyStatelessToken(expiredToken);
  console.log('Expired JWT:', expiredResult ? 'FAIL' : 'PASS');

  // Tampered token (modify payload character)
  const payloadTampered = payloadExpired.replace(/[a-z]/i, 'b');
  const tamperedToken = `sess_${header}.${payloadTampered}.${sigExpired}`;
  const tamperedResult = verifyStatelessToken(tamperedToken);
  console.log('Tampered JWT:', tamperedResult ? 'FAIL' : 'PASS');

  // Malformed token
  const malformedResult = verifyStatelessToken('not.a.valid.token');
  console.log('Malformed JWT:', malformedResult ? 'FAIL' : 'PASS');
}

// -------------------------------------------------------------------
// 2. AdminAuth Middleware Tests
// -------------------------------------------------------------------
async function runAdminAuthTests() {
  console.log('\n=== AdminAuth Middleware Tests ===');
  const adminAuth = require('../src/middleware/adminAuth').default;
  const dummyHandler = async (req) => NextResponse.json({ ok: true });
  const protectedHandler = adminAuth(dummyHandler);

  // Compute legacy deterministic token (dev mode)
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const legacyHash = crypto.createHash('sha256').update(adminPassword + 'LovablePowerkitsSalt').digest('hex');
  const legacyToken = `adm_${legacyHash}`;

  // Unauthenticated request – should be 401
  const unauthRes = await protectedHandler(mockRequest(null));
  console.log('Unauthenticated request → 401:', unauthRes.status === 401 ? 'PASS' : 'FAIL');

  // Authenticated with legacy token (development mode) – should succeed
  const devAuthRes = await protectedHandler(mockRequest(legacyToken));
  console.log('Legacy token in dev → 200:', devAuthRes.status === 200 ? 'PASS' : 'FAIL');

  // Switch to production mode and test legacy token rejection
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const prodAuthRes = await protectedHandler(mockRequest(legacyToken));
  console.log('Legacy token in production → 401:', prodAuthRes.status === 401 ? 'PASS' : 'FAIL');
  process.env.NODE_ENV = originalNodeEnv;
}

// -------------------------------------------------------------------
// 3. Production Startup Checks (missing env vars)
// -------------------------------------------------------------------
function runStartupChecks() {
  console.log('\n=== Production Startup Checks ===');
  const { execSync } = require('child_process');
  const scriptPath = path.resolve(__dirname, '../src/lib/db.js');

  // Helper to run a node process with specific env vars and capture exit code / error.
  function runNodeWithEnv(env) {
    try {
      execSync(`node ${scriptPath}`, { env: { ...process.env, ...env }, stdio: 'ignore' });
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // 1) Missing DATABASE_URL
  let result = runNodeWithEnv({ NODE_ENV: 'production', JWT_SECRET: 's', ADMIN_PASSWORD: 'p' });
  console.log('Missing DATABASE_URL → abort:', result.success ? 'FAIL' : 'PASS');

  // 2) Missing JWT_SECRET
  result = runNodeWithEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ADMIN_PASSWORD: 'p' });
  console.log('Missing JWT_SECRET → abort:', result.success ? 'FAIL' : 'PASS');

  // 3) Missing ADMIN_PASSWORD
  result = runNodeWithEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', JWT_SECRET: 's' });
  console.log('Missing ADMIN_PASSWORD → abort:', result.success ? 'FAIL' : 'PASS');
}

(async () => {
  runJwtTests();
  await runAdminAuthTests();
  runStartupChecks();
})();
