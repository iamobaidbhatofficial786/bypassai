-- PostgreSQL / Supabase DB Initialization Schema

-- License Keys Table
CREATE TABLE IF NOT EXISTS license_keys (
  key VARCHAR(50) PRIMARY KEY,
  user_name VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'trial', 'suspended', 'expired'
  plan VARCHAR(20) DEFAULT 'pro', -- 'free', 'pro', 'enterprise'
  expires_at TIMESTAMP WITH TIME ZONE,
  validity_minutes INTEGER,
  max_devices INTEGER DEFAULT 2,
  role VARCHAR(20) DEFAULT 'user',
  devices TEXT[] DEFAULT '{}',
  device_public_keys JSONB DEFAULT '{}', -- Persistent device public keys for signature validation (device_id -> base64_public_key)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMP WITH TIME ZONE
);

-- Active Sessions Table
CREATE TABLE IF NOT EXISTS active_sessions (
  session_id TEXT PRIMARY KEY,
  key VARCHAR(50) REFERENCES license_keys(key) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  user_name VARCHAR(100) NOT NULL
);

-- Global System Settings Table
CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(20) PRIMARY KEY DEFAULT 'global',
  system_locked BOOLEAN DEFAULT FALSE,
  enable_hints BOOLEAN DEFAULT FALSE
);

-- Usage Logs Table
CREATE TABLE IF NOT EXISTS usage_logs (
  id VARCHAR(50) PRIMARY KEY,
  license_key VARCHAR(50) NOT NULL,
  device_id TEXT NOT NULL,
  prompt_preview TEXT,
  ip VARCHAR(45),
  allowed BOOLEAN NOT NULL,
  plan VARCHAR(20),
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(50) PRIMARY KEY,
  license_key VARCHAR(50),
  action VARCHAR(50) NOT NULL,
  details TEXT,
  ip VARCHAR(45),
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Persistent Rate Limits Table
CREATE TABLE IF NOT EXISTS rate_limits (
  key VARCHAR(100) PRIMARY KEY,
  count INTEGER DEFAULT 0,
  expire_at BIGINT NOT NULL
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_usage_logs_lic_time ON usage_logs(license_key, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_active_sessions_expiry ON active_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expire ON rate_limits(expire_at);
