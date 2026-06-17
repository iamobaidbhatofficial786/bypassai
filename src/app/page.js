'use client';

import { useState, useEffect } from 'react';

export default function Dashboard() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [token, setToken] = useState('');

  // Data states
  const [keys, setKeys] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [stats, setStats] = useState({ total: 0, active: 0, trial: 0, online: 0 });
  const [isSystemLocked, setIsSystemLocked] = useState(false);
  const [dbEphemeralWarning, setDbEphemeralWarning] = useState(false);

  // UI state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingKey, setEditingKey] = useState(null);
  
  // New Key Form state
  const [newKey, setNewKey] = useState({
    key: '',
    user_name: '',
    status: 'active',
    validity_type: 'lifetime', // 'lifetime', 'minutes', 'days'
    validity_value: '60',
    max_devices: '2',
    role: 'user',
  });

  // Load auth state on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('adm_sess_tok');
    if (savedToken) {
      setToken(savedToken);
      setIsLoggedIn(true);
    }
  }, []);

  // Fetch data periodically
  useEffect(() => {
    if (!isLoggedIn || !token) return;

    fetchData();
    const interval = setInterval(fetchData, 8000);
    return () => clearInterval(interval);
  }, [isLoggedIn, token]);

  const fetchData = async () => {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      
      const [keysRes, sessionsRes, settingsRes] = await Promise.all([
        fetch('/api/keys', { headers }),
        fetch('/api/sessions', { headers }),
        fetch('/api/settings', { headers })
      ]);

      if (keysRes.status === 401 || sessionsRes.status === 401 || settingsRes.status === 401) {
        handleLogout();
        return;
      }

      const keysData = await keysRes.json();
      const sessionsData = await sessionsRes.json();
      const settingsData = await settingsRes.json();

      setKeys(Array.isArray(keysData) ? keysData : []);
      setSessions(Array.isArray(sessionsData) ? sessionsData : []);
      setIsSystemLocked(!!settingsData.system_locked);
      setDbEphemeralWarning(!!settingsData.db_ephemeral_warning);
      
      // Calculate Stats
      const total = keysData.length || 0;
      const active = keysData.filter(k => k.status === 'active').length || 0;
      const trial = keysData.filter(k => k.status === 'trial').length || 0;
      const online = sessionsData.length || 0;
      
      setStats({ total, active, trial, online });
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (data.success && data.token) {
        localStorage.setItem('adm_sess_tok', data.token);
        setToken(data.token);
        setIsLoggedIn(true);
      } else {
        setAuthError(data.message || 'Authentication failed');
      }
    } catch (err) {
      setAuthError('Connection failed.');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('adm_sess_tok');
    setToken('');
    setPassword('');
    setIsLoggedIn(false);
    setKeys([]);
    setSessions([]);
  };

  const handleToggleSystemLock = async (locked) => {
    const confirmMsg = locked 
      ? "Are you sure you want to LOCK the extension for ALL users? Active sessions will be terminated and heartbeats will be blocked."
      : "Are you sure you want to UNLOCK the extension and allow user licensing?";
    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ system_locked: locked })
      });
      if (res.ok) {
        const data = await res.json();
        setIsSystemLocked(!!data.system_locked);
        fetchData();
      } else {
        alert("Failed to update system lock status.");
      }
    } catch (err) {
      alert("Network error updating system lock status.");
    }
  };

  const handleCreateKeySubmit = async (e) => {
    e.preventDefault();
    try {
      let expires_at = null;
      let validity_minutes = null;

      if (newKey.validity_type === 'minutes') {
        validity_minutes = parseInt(newKey.validity_value);
      } else if (newKey.validity_type === 'days') {
        validity_minutes = parseInt(newKey.validity_value) * 24 * 60;
      }

      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          key: newKey.key || undefined,
          user_name: newKey.user_name || undefined,
          status: newKey.status,
          validity_minutes,
          max_devices: parseInt(newKey.max_devices),
          role: newKey.role,
        })
      });

      if (res.ok) {
        setShowCreateModal(false);
        setNewKey({
          key: '',
          user_name: '',
          status: 'active',
          validity_type: 'lifetime',
          validity_value: '60',
          max_devices: '2',
          role: 'user',
        });
        fetchData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create key');
      }
    } catch (err) {
      alert('Network error creating key');
    }
  };

  const handleUpdateKeySubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/keys', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(editingKey)
      });

      if (res.ok) {
        setEditingKey(null);
        fetchData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to update key');
      }
    } catch (err) {
      alert('Network error updating key');
    }
  };

  const handleDeleteKey = async (key) => {
    if (!confirm(`Are you sure you want to revoke key: ${key}?`)) return;
    try {
      const res = await fetch(`/api/keys?key=${key}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to revoke key');
      }
    } catch (err) {
      alert('Network error deleting key');
    }
  };

  const handleResetDevices = async (key) => {
    if (!confirm(`Clear all device locks for: ${key}?`)) return;
    try {
      const res = await fetch('/api/keys', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ key, reset_devices: true })
      });
      if (res.ok) {
        fetchData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to reset devices');
      }
    } catch (err) {
      alert('Network error resetting devices');
    }
  };

  const handleKickSession = async (sessionId) => {
    if (!confirm('Kick this session connection? The extension will logout within 60 seconds.')) return;
    try {
      const res = await fetch(`/api/sessions?session_id=${sessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchData();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to kick session');
      }
    } catch (err) {
      alert('Network error kicking session');
    }
  };

  const filteredKeys = keys.filter(k => 
    k.key.toLowerCase().includes(searchQuery.toLowerCase()) ||
    k.user_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Formatter utilities
  const formatTime = (isoString) => {
    if (!isoString) return 'Never';
    const d = new Date(isoString);
    return d.toLocaleString();
  };

  const formatValidity = (mins) => {
    if (!mins) return 'Unlimited';
    if (mins % (24 * 60) === 0) {
      const days = mins / (24 * 60);
      return `${days} ${days === 1 ? 'day' : 'days'} (Pending)`;
    }
    if (mins % 60 === 0) {
      const hours = mins / 60;
      return `${hours} ${hours === 1 ? 'hour' : 'hours'} (Pending)`;
    }
    return `${mins} mins (Pending)`;
  };

  const isExpired = (k) => {
    if (k.validity_minutes && !k.activated_at) return false;
    if (!k.expires_at) return false;
    return new Date(k.expires_at) < new Date();
  };

  if (!isLoggedIn) {
    return (
      <div className="login-container">
        <div className="glass-panel login-card">
          <div className="login-icon">🔐</div>
          <h1 className="login-title">ByPass Ai Admin</h1>
          <p className="login-subtitle">Enter your system administrator password</p>
          
          <form onSubmit={handleLogin}>
            <div className="form-group" style={{ textAlign: 'left' }}>
              <label>Password</label>
              <input
                type="password"
                className="form-control"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>
            
            {authError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '1rem' }}>
                ⚠ {authError}
              </p>
            )}
            
            <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }}>
              Unlock Dashboard
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      {/* Header */}
      <header className="dashboard-header">
        <div className="dashboard-logo">
          <span>🛡</span> ByPass Ai Licensing Hub
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {/* System Lock Toggle */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '0.6rem', 
            background: isSystemLocked ? 'rgba(239, 68, 68, 0.1)' : 'rgba(255, 255, 255, 0.03)', 
            padding: '0.4rem 0.8rem', 
            borderRadius: '8px', 
            border: isSystemLocked ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid rgba(255,255,255,0.06)',
            transition: 'all 0.3s ease'
          }}>
            <span style={{ fontSize: '0.85rem', fontWeight: '600', color: isSystemLocked ? '#ef4444' : '#94a3b8' }}>
              {isSystemLocked ? '🔒 System Locked' : '🔓 System Active'}
            </span>
            <label style={{ position: 'relative', display: 'inline-block', width: '36px', height: '20px', margin: 0, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={isSystemLocked} 
                onChange={(e) => handleToggleSystemLock(e.target.checked)} 
                style={{ opacity: 0, width: 0, height: 0 }}
              />
              <span style={{ 
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, 
                backgroundColor: isSystemLocked ? '#ef4444' : '#334155', 
                transition: '.3s', borderRadius: '34px' 
              }}>
                <span style={{
                  position: 'absolute', height: '14px', width: '14px', left: isSystemLocked ? '18px' : '4px', bottom: '3px',
                  backgroundColor: 'white', transition: '.3s', borderRadius: '50%'
                }} />
              </span>
            </label>
          </div>

          <button onClick={fetchData} className="btn btn-secondary">
            🔄 Refresh
          </button>
          <button onClick={handleLogout} className="btn btn-danger">
            ❌ Sign Out
          </button>
        </div>
      </header>

      {dbEphemeralWarning && (
        <div style={{
          background: 'rgba(245, 158, 11, 0.15)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          color: '#f59e0b',
          padding: '1rem',
          borderRadius: '12px',
          marginBottom: '1.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.8rem',
          fontSize: '0.95rem',
          fontWeight: '500'
        }}>
          <span style={{ fontSize: '1.3rem' }}>⚠️</span>
          <span>
            <strong>Database is running in EPHEMERAL mode:</strong> License keys are stored in a temporary container file and will be lost/reset frequently on Vercel. Please link Vercel KV (Redis) to your project settings using <code>KV_REST_API_URL</code> and <code>KV_REST_API_TOKEN</code> for persistent storage.
          </span>
        </div>
      )}

      {/* Stats Cards */}
      <section className="stats-grid">
        <div className="glass-panel stat-card">
          <span className="stat-label">Total Issued Keys</span>
          <span className="stat-value">{stats.total}</span>
          <span className="stat-detail">Registered profiles</span>
        </div>
        <div className="glass-panel stat-card">
          <span className="stat-label">Active Pro Keys</span>
          <span className="stat-value" style={{ color: 'var(--success)' }}>{stats.active}</span>
          <span className="stat-detail">Premium customers</span>
        </div>
        <div className="glass-panel stat-card">
          <span className="stat-label">Trial Keys</span>
          <span className="stat-value" style={{ color: 'var(--accent-secondary)' }}>{stats.trial}</span>
          <span className="stat-detail">Evaluation keys</span>
        </div>
        <div className="glass-panel stat-card">
          <span className="stat-label">Active Sessions</span>
          <span className="stat-value" style={{ color: '#fff', textShadow: '0 0 10px rgba(255,255,255,0.2)' }}>{stats.online}</span>
          <span className="stat-detail">Devices online now</span>
        </div>
      </section>

      {/* Panels Grid */}
      <div className="dashboard-grid">
        {/* Left side: Keys List */}
        <section className="glass-panel content-section" style={{ padding: '1.5rem' }}>
          <div className="panel-title-bar">
            <h2 className="panel-title">🔑 License Management</h2>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <input
                type="text"
                className="search-bar"
                placeholder="Search keys or name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
                ➕ New Key
              </button>
            </div>
          </div>

          <div className="table-wrapper">
            {filteredKeys.length === 0 ? (
              <p className="empty-state">No license keys found matching your criteria.</p>
            ) : (
              <table className="premium-table">
                <thead>
                  <tr>
                    <th>License Key</th>
                    <th>User Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Expires At</th>
                    <th>Devices</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredKeys.map((k) => {
                    const expired = isExpired(k);
                    return (
                      <tr key={k.key}>
                        <td className="mono" style={{ fontWeight: 'bold' }}>{k.key}</td>
                        <td>{k.user_name}</td>
                        <td>
                          <span className={`badge badge-role-${k.role || 'user'}`}>
                            {k.role || 'user'}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${expired ? 'badge-expired' : k.status === 'trial' ? 'badge-trial' : 'badge-active'}`}>
                            {expired ? 'expired' : k.status}
                          </span>
                        </td>
                        <td style={{ fontSize: '0.8rem', color: expired ? 'var(--danger)' : 'var(--text-color)' }}>
                          {k.expires_at ? formatTime(k.expires_at) : formatValidity(k.validity_minutes)}
                        </td>
                        <td>
                          <div className="devices-list">
                            <span style={{ fontSize: '0.8rem', fontWeight: '600' }}>
                              ({k.devices ? k.devices.length : 0} / {k.max_devices || 2})
                            </span>
                            {k.devices && k.devices.map(d => (
                              <span key={d} className="mono" style={{ fontSize: '0.65rem', padding: '0.05rem 0.2rem', opacity: 0.7 }} title={d}>
                                {d.substring(0, 10)}...
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button onClick={() => setEditingKey(k)} className="btn btn-secondary" style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}>
                              ✏️ Edit
                            </button>
                            <button onClick={() => handleResetDevices(k.key)} className="btn btn-secondary" style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem', borderColor: 'rgba(245,158,11,0.2)' }} title="Clear hardware bindings">
                              🔄 Reset
                            </button>
                            <button onClick={() => handleDeleteKey(k.key)} className="btn btn-danger" style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}>
                              Revoke
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Right side: Active Heartbeats */}
        <section className="glass-panel sessions-panel" style={{ padding: '1.5rem', alignSelf: 'start' }}>
          <h2 className="panel-title">🟢 Active Sessions</h2>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {sessions.length === 0 ? (
              <p className="empty-state" style={{ padding: '2rem 1rem' }}>No active devices currently online.</p>
            ) : (
              sessions.map((s) => (
                <div key={s.session_id} className="glass-panel" style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: '600', color: '#fff' }}>{s.user_name}</span>
                    <button onClick={() => handleKickSession(s.session_id)} className="btn btn-danger" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}>
                      Kick
                    </button>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: varName => 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <div>Key: <span className="mono">{s.key}</span></div>
                    <div>Device ID: <span className="mono" title={s.device_id}>{s.device_id.substring(0, 15)}...</span></div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.8, color: 'var(--accent-secondary)', marginTop: '0.2rem' }}>
                      Last Ping: {new Date(s.last_seen).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* CREATE KEY MODAL */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="glass-panel modal-content">
            <div className="modal-header">
              <h3 className="modal-title">Create License Key</h3>
              <button className="modal-close" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            
            <form onSubmit={handleCreateKeySubmit}>
              <div className="form-group">
                <label>License Key (Optional - Auto-generates if empty)</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  value={newKey.key}
                  onChange={(e) => setNewKey({ ...newKey, key: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>User Name</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="John Doe"
                  value={newKey.user_name}
                  onChange={(e) => setNewKey({ ...newKey, user_name: e.target.value })}
                  required
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select
                    className="form-control"
                    value={newKey.status}
                    onChange={(e) => setNewKey({ ...newKey, status: e.target.value })}
                  >
                    <option value="active">Active (PRO)</option>
                    <option value="trial">Trial (TEST)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Role</label>
                  <select
                    className="form-control"
                    value={newKey.role}
                    onChange={(e) => setNewKey({ ...newKey, role: e.target.value })}
                  >
                    <option value="user">User</option>
                    <option value="reseller">Reseller</option>
                    <option value="admin">Administrator</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Validity Type</label>
                  <select
                    className="form-control"
                    value={newKey.validity_type}
                    onChange={(e) => setNewKey({ ...newKey, validity_type: e.target.value })}
                  >
                    <option value="lifetime">Lifetime / Unlimited</option>
                    <option value="minutes">Minutes</option>
                    <option value="days">Days</option>
                  </select>
                </div>

                {newKey.validity_type !== 'lifetime' && (
                  <div className="form-group">
                    <label>Duration ({newKey.validity_type})</label>
                    <input
                      type="number"
                      className="form-control"
                      min="1"
                      value={newKey.validity_value}
                      onChange={(e) => setNewKey({ ...newKey, validity_value: e.target.value })}
                      disabled={newKey.validity_type === 'lifetime'}
                    />
                  </div>
                )}
              </div>

              <div className="form-group">
                <label>Allowed Connected Devices</label>
                <input
                  type="number"
                  className="form-control"
                  min="1"
                  max="20"
                  value={newKey.max_devices}
                  onChange={(e) => setNewKey({ ...newKey, max_devices: e.target.value })}
                  required
                />
              </div>

              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Generate Key
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT KEY MODAL */}
      {editingKey && (
        <div className="modal-overlay">
          <div className="glass-panel modal-content">
            <div className="modal-header">
              <h3 className="modal-title">Edit License Key</h3>
              <button className="modal-close" onClick={() => setEditingKey(null)}>✕</button>
            </div>
            
            <form onSubmit={handleUpdateKeySubmit}>
              <div className="form-group">
                <label>License Key</label>
                <input
                  type="text"
                  className="form-control"
                  value={editingKey.key}
                  disabled
                />
              </div>

              <div className="form-group">
                <label>User Name</label>
                <input
                  type="text"
                  className="form-control"
                  value={editingKey.user_name}
                  onChange={(e) => setEditingKey({ ...editingKey, user_name: e.target.value })}
                  required
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select
                    className="form-control"
                    value={editingKey.status}
                    onChange={(e) => setEditingKey({ ...editingKey, status: e.target.value })}
                  >
                    <option value="active">Active (PRO)</option>
                    <option value="trial">Trial (TEST)</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Role</label>
                  <select
                    className="form-control"
                    value={editingKey.role}
                    onChange={(e) => setEditingKey({ ...editingKey, role: e.target.value })}
                  >
                    <option value="user">User</option>
                    <option value="reseller">Reseller</option>
                    <option value="admin">Administrator</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Expiration Date (ISO Format or empty for Unlimited)</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="YYYY-MM-DDTHH:MM:SS.SSSZ"
                  value={editingKey.expires_at || ''}
                  onChange={(e) => setEditingKey({ ...editingKey, expires_at: e.target.value })}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Leave empty for no expiration. Current local time: {new Date().toISOString()}
                </span>
              </div>

              <div className="form-group">
                <label>Allowed Connected Devices</label>
                <input
                  type="number"
                  className="form-control"
                  min="1"
                  max="20"
                  value={editingKey.max_devices}
                  onChange={(e) => setEditingKey({ ...editingKey, max_devices: parseInt(e.target.value) })}
                  required
                />
              </div>

              <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditingKey(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
