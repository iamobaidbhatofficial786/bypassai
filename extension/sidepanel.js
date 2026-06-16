// ============================================================
// Lovable Powerkits - Side Panel Logic (Business Logic Only)
// Templates/HTML are in sidepanel-templates.js
// ============================================================

(function(){
  try { chrome.storage.local.set({ ql_sidebar_mode: true }); } catch (e) {}

  const API_BASE = typeof POWERKITS_API_BASE !== "undefined" ? POWERKITS_API_BASE : GRINGOW_API_BASE;
  function getLicenseApiBase() {
    return typeof POWERKITS_LICENSE_API_BASE !== "undefined" && POWERKITS_LICENSE_API_BASE ? POWERKITS_LICENSE_API_BASE : API_BASE;
  }
  const API_KEY = typeof POWERKITS_API_KEY !== "undefined" ? POWERKITS_API_KEY : GRINGOW_API_KEY;
  const PROXY_CMD_URL = (typeof window !== "undefined" && window.PROXY_COMMAND_URL)
    || (API_BASE + "/functions/v1/proxy-command");

  function getValidateUrl() { return getLicenseApiBase() + "/functions/v1/validate-license"; }
  const OPTIMIZE_URL = API_BASE + "/functions/v1/optimize-prompt";
  const NOTIFICATIONS_URL = API_BASE + "/rest/v1/notifications?select=*&order=created_at.desc&limit=20";
  const PACKAGES_URL = API_BASE + "/rest/v1/packages?select=*&is_active=eq.true&order=sort_order.asc";
  const VERSIONS_URL = API_BASE + "/rest/v1/extension_versions?select=version,changelog,file_path,is_alert_active&order=created_at.desc&limit=1&is_alert_active=eq.true";
  function getUserRolesUrl() { return getLicenseApiBase() + "/rest/v1/user_roles?select=role"; }
  function getLicensesUrl() { return getLicenseApiBase() + "/rest/v1/licenses?select=user_id"; }
  const CREATE_PROJECT_URL = API_BASE + "/functions/v1/create-lovable-project";
  const REMOVE_WATERMARK_URL = API_BASE + "/functions/v1/remove-watermark";
  const PUBLISH_PROJECT_URL = API_BASE + "/functions/v1/publish-project";
  const ENABLE_CLOUD_URL = API_BASE + "/functions/v1/enable-cloud";

  function apiHeaders(extra) {
    return typeof powerkitsApiHeaders === "function" ? powerkitsApiHeaders(extra) : gringowApiHeaders(extra);
  }

  function ensureInternalSessionLocal() {
    if (!INTERNAL_LICENSE_MODE) return Promise.resolve();
    return new Promise(function(resolve) {
      chrome.storage.local.get(["ql_license_valid", "ql_session_id", "ql_user_name", "ql_license_key"], function(res) {
        if (res.ql_license_valid && res.ql_session_id) {
          sessionId = res.ql_session_id;
          userName = normalizeLicenseUserName(res.ql_user_name);
          expiresAt = res.ql_expires_at || null;
          return resolve();
        }
        var sid = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
        sessionId = sid;
        userName = normalizeLicenseUserName(userName);
        expiresAt = null;
        chrome.storage.local.set(
          typeof powerkitsInternalSessionStorage === "function"
            ? powerkitsInternalSessionStorage(sid, userName)
            : gringowInternalSessionStorage(sid, userName),
          function() { resolve(); }
        );
      });
    });
  }

  function getBrowserSessionId() {
    return new Promise(function(resolve) {
      chrome.storage.local.get(["lovable_browserSessionId"], function(res) {
        resolve(res.lovable_browserSessionId || null);
      });
    });
  }

  async function buildProxyCommandPayload(projectId, token, licenseKey, mensagem, modoPensar) {
    var normalizedToken = String(token || "").replace(/^Bearer\s+/i, "").trim();
    var payload = {
      license_key: licenseKey || "",
      session_id: sessionId || "",
      projeto_id: projectId,
      token_lovable: normalizedToken,
      mensagem: mensagem,
      modo_pensar: !!modoPensar,
      device_id: deviceId
    };
    payload.session_headers = await fetchSessionHeadersFromTab(projectId);
    var bsess = await getBrowserSessionId();
    if (bsess) payload.browser_session_id = bsess;
    var nativeBody = await fetchNativeChatCaptureFromTab();
    if (nativeBody) payload.native_chat_body = nativeBody;
    return payload;
  }

  function activateInternalSession() {
    return bgFetch(getValidateUrl(), {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        license_key: "INTERNAL",
        session_id: sessionId,
        device_id: deviceId,
        max_devices: 2,
        device_limit: 2,
        allowed_devices: 2
      })
    }).then(function(data) {
      if (!data || !data.valid) {
        throw new Error((data && data.message) || "Internal activation failed");
      }
      sessionId = data.session_id || sessionId;
      userName = normalizeLicenseUserName(data.user_name || userName);
      expiresAt = data.expires_at || expiresAt;
      licenseStatus = data.status || licenseStatus;
      return new Promise(function(resolve) {
        chrome.storage.local.set({
          ql_license_valid: true,
          ql_license_key: "INTERNAL",
          ql_session_id: sessionId,
          ql_user_name: userName,
          ql_expires_at: expiresAt,
          ql_activated_at: data.activated_at || null,
          ql_license_status: licenseStatus
        }, function() { resolve(data); });
      });
    });
  }

  let sessionId = null, userName = null, expiresAt = null, licenseStatus = null, validityMinutes = null, spActivatedAt = null, heartbeatInterval = null, deviceId = null, isResellerUser = false;
  let spCountdownInterval = null;
  let spExpiryConfirming = false;
  let spSpeechRecognition = null, spIsRecording = false;
  let spAttachedFiles = [];
  let spActiveTab = 'prompt';
  let spChatHistory = [];
  const SP_MAX_FILES = 15;
  const SP_MAX_FILE_SIZE = 20 * 1024 * 1024;
  const SP_HISTORY_KEY = 'ql_chat_history';
  const SP_MAX_HISTORY = 200;
  const CURRENT_EXT_VERSION = extensionVersionShort();
  let spActivePlatform = 'lovable';

  function getStoredPlatform(cb) {
    chrome.storage.local.get(['pk_active_platform'], function(res) {
      var stored = res.pk_active_platform;
      if (stored === 'chatgpt' || stored === 'lovable') {
        spActivePlatform = stored;
        return cb(spActivePlatform);
      }
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        var tab = tabs && tabs[0];
        var detected = tab && typeof pkPlatformFromUrl === 'function' ? pkPlatformFromUrl(tab.url) : null;
        spActivePlatform = detected || 'lovable';
        chrome.storage.local.set({ pk_active_platform: spActivePlatform });
        cb(spActivePlatform);
      });
    });
  }

  function setActivePlatform(platformId) {
    spActivePlatform = platformId === 'chatgpt' ? 'chatgpt' : 'lovable';
    chrome.storage.local.set({ pk_active_platform: spActivePlatform });
    updateSync();
    refreshPlatformUI();
  }

  function isChatGptPlatform() {
    return spActivePlatform === 'chatgpt';
  }

  function platformLabel(platformId) {
    if (typeof pkGetPlatform === 'function') {
      var cfg = pkGetPlatform(platformId);
      if (cfg && cfg.label) return cfg.label;
    }
    return platformId === 'chatgpt' ? 'ChatGPT' : 'Lovable';
  }

  function findPlatformTab(platformId, callback) {
    chrome.runtime.sendMessage({ action: 'findPlatformTab', platform: platformId || spActivePlatform }, function(resp) {
      if (resp && resp.ok && resp.tab && resp.tab.id) {
        callback({ id: resp.tab.id, url: resp.tab.url || '' });
      } else {
        callback(null);
      }
    });
  }

  function findLovableProjectTab(callback) {
    findPlatformTab('lovable', callback);
  }

  function refreshPlatformUI() {
    var planWrap = document.querySelector('.sp-action-left');
    if (planWrap) planWrap.style.display = isChatGptPlatform() ? 'none' : '';
    var advToggle = document.getElementById('sp-advanced-toggle');
    var advPanel = document.getElementById('sp-advanced-panel');
    if (advToggle) advToggle.style.display = isChatGptPlatform() ? 'none' : '';
    if (advPanel) advPanel.style.display = isChatGptPlatform() ? 'none' : '';
    document.querySelectorAll('.sp-platform-btn').forEach(function(btn) {
      btn.classList.toggle('sp-platform-active', btn.getAttribute('data-platform') === spActivePlatform);
    });
    var syncEl = document.getElementById('sp-sync');
    if (syncEl && isChatGptPlatform()) {
      syncEl.className = 'sp-sync-status sp-sync-waiting';
      syncEl.textContent = '⏳ Open chatgpt.com in a tab';
    }
  }

  function setupPlatformPicker() {
    document.querySelectorAll('.sp-platform-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        setActivePlatform(btn.getAttribute('data-platform'));
      });
    });
    refreshPlatformUI();
  }

  function applySidepanelFooterVersion() {
    var el = document.getElementById("sp-footer-version");
    if (el) el.textContent = extensionFooterBadge();
  }
  applySidepanelFooterVersion();

  function fetchNativeChatCaptureFromTab() {
    return new Promise(function(resolve) {
      try {
        findLovableProjectTab(function(tab) {
          if (!tab || !tab.id) return resolve(null);
          chrome.tabs.sendMessage(tab.id, { action: "getNativeChatCapture" }, function(resp) {
            if (chrome.runtime.lastError) return resolve(null);
            resolve((resp && resp.body) ? resp.body : null);
          });
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function requestLatestTokenFromTab(timeoutMs) {
    return new Promise(function(resolve) {
      var finished = false;
      var timeout = Math.max(800, timeoutMs || 2500);
      findLovableProjectTab(function(tab) {
        chrome.storage.local.get(["lovable_token"], function(before) {
          var prevToken = before.lovable_token || "";
          function finish() {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearInterval(poller);
            chrome.storage.onChanged.removeListener(onStorageChange);
            resolve();
          }
          function onStorageChange(changes, area) {
            if (area !== "local") return;
            if (changes.lovable_token && changes.lovable_token.newValue && changes.lovable_token.newValue !== prevToken) {
              finish();
            }
          }
          var timer = setTimeout(finish, timeout);
          var poller = setInterval(function() {
            chrome.storage.local.get(["lovable_token"], function(now) {
              var t = now.lovable_token || "";
              if (t && t !== prevToken) finish();
            });
          }, 200);
          chrome.storage.onChanged.addListener(onStorageChange);
          if (tab && tab.id) {
            chrome.tabs.sendMessage(tab.id, { action: "requestTokenRefresh" }, function() {});
          }
        });
      });
    });
  }

  function fetchSessionHeadersFromTab(projectId) {
    return new Promise(function(resolve) {
      try {
        findLovableProjectTab(function(tab) {
          if (!tab || !tab.id) {
            buildSessionHeaders(projectId).then(resolve);
            return;
          }
          chrome.tabs.sendMessage(tab.id, { action: "getSessionHeaders", projectId: projectId || "" }, function(resp) {
            if (chrome.runtime.lastError || !resp || !resp.headers) {
              buildSessionHeaders(projectId).then(resolve);
              return;
            }
            resolve(resp.headers);
          });
        });
      } catch (e) {
        buildSessionHeaders(projectId).then(resolve);
      }
    });
  }

  // Build per-device session headers (UA + sec-ch-ua + cookies de lovable.dev)
  function buildSessionHeaders(projectId) {
    return new Promise(function(resolve) {
      var ua = navigator.userAgent || "";
      var hints = (navigator.userAgentData && navigator.userAgentData.brands) ? navigator.userAgentData.brands : [];
      var brandsStr = "";
      for (var i = 0; i < hints.length; i++) {
        if (i > 0) brandsStr += ", ";
        brandsStr += '"' + hints[i].brand + '";v="' + hints[i].version + '"';
      }
      var platform = (navigator.userAgentData && navigator.userAgentData.platform) ? navigator.userAgentData.platform : "Windows";
      var mobile = (navigator.userAgentData && navigator.userAgentData.mobile) ? "?1" : "?0";
      var langs = navigator.languages && navigator.languages.length ? navigator.languages.slice(0, 3).join(",") : (navigator.language || "en-US");
      var headers = {
        "user-agent": ua,
        "sec-ch-ua": brandsStr,
        "sec-ch-ua-mobile": mobile,
        "sec-ch-ua-platform": '"' + platform + '"',
        "accept-language": langs,
        "accept-encoding": "gzip, deflate, br, zstd",
        "origin": "https://lovable.dev",
        "referer": "https://lovable.dev/projects/" + (projectId || ""),
        "priority": "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site"
      };
      try {
        chrome.runtime.sendMessage({ action: "getLovableCookies" }, function(resp) {
          if (resp && resp.cookie) headers["cookie"] = resp.cookie;
          resolve(headers);
        });
      } catch (e) {
        resolve(headers);
      }
    });
  }

  // --- Utilities ---
  function safeSendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) return reject(new Error("Extension context invalidated"));
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        });
      } catch(e) { reject(new Error("Extension context invalidated")); }
    });
  }

  function bgFetch(url, opts = {}) {
    const requireSuccess = opts.requireSuccess === true;
    const vendorFeatureCompat = opts.vendorFeatureCompat === true || opts.featureUiCompat === true;
    return new Promise((resolve, reject) => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) return reject(new Error("Extension context invalidated"));
        if (typeof POWERKITS_DEBUG !== "undefined" && POWERKITS_DEBUG) console.log("[SP] bgFetch ->", url);
        chrome.runtime.sendMessage({ action: "proxyFetch", url, method: opts.method || "POST", headers: opts.headers || {}, body: opts.body || null }, (resp) => {
          if(chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if(!resp) return reject(new Error("No response from background"));
          const data = resp.data;
          if (typeof POWERKITS_DEBUG !== "undefined" && POWERKITS_DEBUG) console.log("[SP] bgFetch <-", url, "status", resp.status, data);
          if (vendorFeatureCompat && typeof pkResolveFeatureBgFetch === "function") {
            var vf = pkResolveFeatureBgFetch(resp);
            if (!vf.ok) return reject(new Error(vf.error));
            return resolve(vf.data);
          }
          if(!resp.ok) {
            const errText = (data && (data.error_display || data.message || data.error))
              || (data && data.raw)
              || ("Request failed (HTTP " + resp.status + ")");
            return reject(new Error(formatApiError(errText)));
          }
          if(requireSuccess && (!data || data.success !== true)) {
            const errText = (data && (data.error_display || data.message || data.error))
              || "Server did not confirm the send (success !== true)";
            return reject(new Error(formatApiError(errText)));
          }
          resolve(data);
        });
      } catch(e) { reject(new Error("Extension context invalidated")); }
    });
  }

  function getDeviceId() {
    return getHardwareFingerprint();
  }


  function decodeJwtPayload(token) {
    try {
      var raw = String(token || '').replace(/^Bearer\s+/i, '').trim();
      var parts = raw.split('.');
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      var padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      return JSON.parse(atob(padded));
    } catch (e) { return null; }
  }

  function jwtExpMs(token) {
    var p = decodeJwtPayload(token);
    return (p && p.exp) ? p.exp * 1000 : null;
  }

  function isTokenFresh(token, skewMs) {
    var t = String(token || '').replace(/^Bearer\s+/i, '').trim();
    if (!t) return false;
    var exp = jwtExpMs(t);
    if (!exp) return true;
    return exp > Date.now() + (skewMs || 60000);
  }

  function pickBestToken(candidates) {
    var best = '';
    var bestExp = 0;
    (candidates || []).forEach(function(item) {
      var t = String(item || '').replace(/^Bearer\s+/i, '').trim();
      if (!t) return;
      var exp = jwtExpMs(t) || 0;
      if (!best || exp > bestExp) {
        best = t;
        bestExp = exp;
      }
    });
    return best;
  }

  function projectIdFromTabUrl(url) {
    if (!url) return '';
    var m = String(url).match(/\/projects\/([0-9a-fA-F-]{36})/);
    return m ? m[1] : '';
  }

  function readAuthTokensFromCookies() {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage({ action: 'readCookies' }, function(resp) {
        if (!resp || !resp.tokens || !resp.tokens.length) return resolve('');
        resolve(pickBestToken(resp.tokens.map(function(x) { return x.token; })));
      });
    });
  }

  async function resolveLovableAuth() {
    var lovableTab = await new Promise(function(resolve) {
      findLovableProjectTab(function(tab) { resolve(tab); });
    });
    await new Promise(function(resolve) {
      chrome.runtime.sendMessage({
        action: "syncLovableAuth",
        tabUrl: lovableTab && lovableTab.url || "",
        projectId: projectIdFromTabUrl(lovableTab && lovableTab.url)
      }, function() { resolve(); });
    });

    if (lovableTab && lovableTab.id) {
      var session = await new Promise(function(resolve) {
        chrome.tabs.sendMessage(lovableTab.id, { action: "getLovableSession" }, function(resp) {
          if (chrome.runtime.lastError || !resp) return resolve(null);
          resolve(resp);
        });
      });
      if (session && session.ok) {
        await new Promise(function(r) {
          chrome.storage.local.set({
            lovable_token: session.token,
            lovable_projectId: session.projectId
          }, r);
        });
        return { token: session.token, projectId: session.projectId };
      }
    }

    await requestLatestTokenFromTab(3000);
    var sd = await new Promise(function(r) { chrome.storage.local.get(['lovable_token', 'lovable_projectId'], r); });
    var tabPid = projectIdFromTabUrl(lovableTab && lovableTab.url);
    return {
      token: sd.lovable_token || '',
      projectId: tabPid || sd.lovable_projectId || ''
    };
  }

  function withLovableTab(callback) {
    findLovableProjectTab(function(tab) { callback(tab || null); });
  }

  function sendToLovableTab(message) {
    return new Promise(function(resolve, reject) {
      withLovableTab(function(tab) {
        if (!tab || !tab.id) {
          return reject(new Error("Open a Lovable project tab on lovable.dev first."));
        }
        chrome.tabs.sendMessage(tab.id, message, function(resp) {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve(resp);
        });
      });
    });
  }

  function syncCreditBypassOnLovableTabs(enabled) {
    var active = !!enabled;
    var bypassAction = active ? "qlActivateBypass" : "qlDeactivateBypass";
    chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] }, function(tabs) {
      (tabs || []).forEach(function(tab) {
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, { action: bypassAction }, function() {});
        chrome.tabs.sendMessage(tab.id, { action: "setCreditBypass", active: active }, function() {});
      });
    });
    sendToLovableTab({ action: bypassAction }).catch(function() {});
    sendToLovableTab({ action: "setCreditBypass", active: active }).catch(function() {});
  }

  /** Feature API: storage + { license_key, token_lovable, project_id } */
  async function postLovableFeature(url, extra, opts) {
    opts = opts || {};
    var ensureLicense = window.pkEnsureActiveLicense;
    if (typeof ensureLicense === "function") {
      await ensureLicense(false);
    } else {
      throw new Error("License guard not loaded. Close and reopen the side panel, then try again.");
    }
    var sd = await new Promise(function(r) {
      chrome.storage.local.get(["lovable_projectId", "lovable_token", "ql_license_key"], r);
    });
    var token = sd.lovable_token || "";
    var projectId = sd.lovable_projectId || "";
    var licKey = sd.ql_license_key || "";

    if (!opts.skipProjectId && (!projectId || !token)) {
      throw new Error("Project not synced.");
    }
    if (opts.skipProjectId && !token) {
      throw new Error("Project not synced.");
    }

    var payload = typeof pkFeatureRequestBody === "function"
      ? pkFeatureRequestBody(licKey, token, opts.skipProjectId ? "" : projectId, extra)
      : { license_key: licKey, token_lovable: token, project_id: projectId };

    return bgFetch(url, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      featureUiCompat: true
    });
  }

  function formatApiError(value) {
    if (value == null) return 'Send failed.';
    var s = pkSanitizeServerError(String(value));
    if (s.charAt(0) === '{') {
      try {
        var parsed = JSON.parse(s);
        if (parsed && (parsed.message || parsed.error_display)) {
          s = String(parsed.message || parsed.error_display);
        }
      } catch (e) {}
    }
    if (/invalid token/i.test(s) || /unauthorized/i.test(s)) {
      return 'Lovable session expired. Refresh lovable.dev, wait for Synced, then send again.';
    }
    if (/receiving end does not exist|could not establish connection/i.test(s)) {
      return 'Lovable tab is not connected. Open your project on lovable.dev, refresh that tab, reload the extension, then send again.';
    }
    return spUserText(s);
  }

  function spUserText(value) {
    return typeof translateUserMessage === 'function' ? translateUserMessage(value) : value;
  }

  function showAlert(title, message) {
    const existing = document.querySelector('.sp-alert-overlay');
    if(existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'sp-alert-overlay';
    overlay.innerHTML = spTemplateAlert(spUserText(title), spUserText(message));
    document.body.appendChild(overlay);
    overlay.querySelector('.sp-alert-ok').addEventListener('click', () => overlay.remove());
    setTimeout(() => overlay.remove(), 4000);
  }

  try { chrome.storage.local.set({ ql_sidebar_mode: true }); } catch (e) {}

  // --- Header Event Listeners ---
  var backToPopup = document.getElementById('sp-back-to-popup');
  if (backToPopup) backToPopup.style.display = 'none';

  document.querySelector('.sp-theme-btn').addEventListener('click', () => {
    const isLight = document.body.classList.toggle('sp-light');
    chrome.storage.local.set({ ql_dark_mode: !isLight });
  });

  document.querySelector('.sp-logout-btn').addEventListener('click', () => {
    if(heartbeatInterval) clearInterval(heartbeatInterval);
    syncCreditBypassOnLovableTabs(false);
    pkSafeClearLicenseStorage(() => {
      userName = null; expiresAt = null; licenseStatus = null; sessionId = null;
      showLicenseGate();
    });
  });

  // --- Notifications ---
  const notifPanel = document.getElementById('sp-notif-panel');
  document.querySelector('.sp-notif-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = notifPanel.style.display !== 'none';
    notifPanel.style.display = isOpen ? 'none' : 'block';
    if(!isOpen) loadNotifications();
  });
  document.getElementById('sp-notif-close').addEventListener('click', () => { notifPanel.style.display = 'none'; });

  async function loadNotifications() {
    const list = document.getElementById('sp-notif-list');
    list.innerHTML = '<p class="sp-notif-empty">Loading...</p>';
    try {
      const data = await bgFetch(NOTIFICATIONS_URL, { method: "GET", headers: { apikey: API_KEY } });
      if(!data || !data.length) { list.innerHTML = '<p class="sp-notif-empty">No notifications.</p>'; return; }
      const ids = data.map(n => n.id);
      chrome.storage.local.set({ ql_read_notifs: ids });
      const badge = document.querySelector('.sp-notif-badge');
      if(badge) badge.style.display = 'none';
      list.innerHTML = data.map(n => spTemplateNotifItem(n)).join('');
    } catch(e) { list.innerHTML = '<p class="sp-notif-empty">Error loading.</p>'; }
  }

  async function checkUnread() {
    try {
      const data = await bgFetch(NOTIFICATIONS_URL, { method: "GET", headers: { apikey: API_KEY } });
      if(!data || !data.length) return;
      chrome.storage.local.get(["ql_read_notifs"], res => {
        const readIds = res.ql_read_notifs || [];
        const unread = data.filter(n => !readIds.includes(n.id)).length;
        const badge = document.querySelector('.sp-notif-badge');
        if(badge) { badge.textContent = unread; badge.style.display = unread > 0 ? 'flex' : 'none'; }
      });
    } catch(e) {}
  }

  // --- Update Check ---
  async function checkForUpdate() {
    try {
      const data = await bgFetch(VERSIONS_URL, { method: "GET", headers: { apikey: API_KEY } });
      if (!data || !data.length) return;
      const latest = data[0];
      if (latest.version !== CURRENT_EXT_VERSION && latest.is_alert_active) {
        const banner = document.getElementById('sp-update-banner');
        if (banner) {
          const dlUrl = latest.file_path ? API_BASE + "/storage/v1/object/public/extension-releases/" + latest.file_path : null;
          banner.innerHTML = spTemplateUpdateBanner(latest.version, latest.changelog, dlUrl);
          banner.style.display = 'block';
        }
      }
    } catch(e) {}
  }

  // --- Reseller Role Check ---
  async function checkResellerRole() {
    try {
      const data = await bgFetch(getUserRolesUrl() + "&user_id=eq." + (await getUserId()), { method: "GET", headers: { apikey: API_KEY } });
      if (data && Array.isArray(data) && data.some(r => r.role === 'reseller' || r.role === 'admin')) {
        isResellerUser = true;
        const btn = document.getElementById('sp-reseller-btn');
        if (btn) btn.style.display = 'block';
      }
    } catch(e) {}
  }

  async function getUserId() {
    return new Promise(r => chrome.storage.local.get(["ql_license_key"], async res => {
      if (!res.ql_license_key) return r('');
      try {
        const data = await bgFetch(getLicensesUrl() + "&license_key=eq." + encodeURIComponent(res.ql_license_key) + "&limit=1", { method: "GET", headers: { apikey: API_KEY } });
        if (data && data.length && data[0].user_id) r(data[0].user_id);
        else r('');
      } catch(e) { r(''); }
    }));
  }

  // --- License Gate ---
  function showLicenseGate() {
    const body = document.getElementById('sp-body');
    body.innerHTML = spTemplateLicenseGate();
    document.getElementById('sp-validate-btn').addEventListener('click', validateLicense);
  }

  async function validateLicense() {
    const input = document.getElementById('sp-license-input');
    const log = document.getElementById('sp-license-log');
    const key = input ? input.value.trim() : '';
    if(!key) { log.className = 'sp-log sp-log-error'; log.textContent = '⚠ Enter a key'; return; }
    log.className = 'sp-log sp-log-info'; log.textContent = '⏳ Validating...';
    try {
      if(!deviceId) deviceId = await getDeviceId();
      var data;
      if (typeof isDevLicenseKey === "function" && isDevLicenseKey(key)) {
        data = mockDevLicenseResponse(key, { device_id: deviceId });
      } else {
        data = await bgFetch(getValidateUrl(), { method: "POST", headers: apiHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ license_key: key, device_id: deviceId, max_devices: 2, device_limit: 2, allowed_devices: 2 }) });
      }
      if(data.valid) {
        sessionId = data.session_id;
        userName = normalizeLicenseUserName(data.user_name);
        spApplyLicenseApiData(data);
        chrome.storage.local.set(Object.assign({
          ql_license_valid: true,
          ql_license_key: key,
          ql_session_id: data.session_id,
          ql_user_name: userName
        }, typeof pkLicenseStoragePatch === "function" ? pkLicenseStoragePatch(data) : {
          ql_expires_at: data.expires_at || null,
          ql_activated_at: data.activated_at || null,
          ql_license_status: data.status || null
        }), () => {
          if (typeof pkInvalidateAssertCache === "function") pkInvalidateAssertCache();
          syncCreditBypassOnLovableTabs(true);
          log.className = 'sp-log sp-log-success'; log.textContent = '✓ ' + spUserText(data.message);
          setTimeout(() => { showMainUI(); startHeartbeat(key); }, 800);
        });
      } else {
        log.className = 'sp-log sp-log-error'; log.textContent = '✗ ' + spUserText(data.message);
      }
    } catch(err) {
      log.className = 'sp-log sp-log-error';
      log.textContent = '✗ ' + spUserText(err.message || 'Connection error');
    }
  }

  // --- Chat History ---
  function loadChatHistory(cb) {
    chrome.storage.local.get([SP_HISTORY_KEY], function(r) {
      spChatHistory = r[SP_HISTORY_KEY] || [];
      if (cb) cb();
    });
  }

  function saveChatHistory() {
    if (spChatHistory.length > SP_MAX_HISTORY) spChatHistory = spChatHistory.slice(-SP_MAX_HISTORY);
    chrome.storage.local.set({ [SP_HISTORY_KEY]: spChatHistory });
  }

  function addToHistory(text, status) {
    spChatHistory.push({ text: text, timestamp: new Date().toISOString(), status: status || 'ok' });
    saveChatHistory();
    updateHistoryBadge();
  }

  function updateHistoryBadge() {
    var badge = document.querySelector('.sp-tab[data-tab="history"] .sp-tab-badge');
    if (badge) badge.textContent = spChatHistory.length;
  }

  function renderHistoryTab() {
    var container = document.getElementById('sp-tab-content');
    if (!container) return;
    container.innerHTML = spTemplateChatHistory(spChatHistory);
    // Scroll to bottom
    var msgs = container.querySelector('.sp-chat-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    // Clear button
    var clearBtn = document.getElementById('sp-chat-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        spChatHistory = [];
        saveChatHistory();
        renderHistoryTab();
      });
    }
  }

  function renderPromptTab() {
    var container = document.getElementById('sp-tab-content');
    if (!container) return;
    container.innerHTML = spTemplatePromptContent();
  }

  function switchTab(tab) {
    spActiveTab = tab;
    document.querySelectorAll('.sp-tab').forEach(function(t) {
      t.classList.toggle('sp-tab-active', t.getAttribute('data-tab') === tab);
    });
    if (tab === 'history') {
      loadChatHistory(function() { renderHistoryTab(); });
    } else {
      showMainUIContent();
    }
  }

  // --- Main UI ---
  function showMainUI() {
    const greeting = spEscapeHtml(normalizeLicenseUserName(userName));
    const statusBadge = spTemplateStatusBadge(licenseStatus);
    const body = document.getElementById('sp-body');
    loadChatHistory(function() {
      body.innerHTML = '<div id="sp-update-banner" style="display:none"></div>' +
        '<div class="sp-profile-card">' +
          '<div class="sp-profile-top"><span class="sp-profile-name" id="sp-name">' + greeting + '</span>' + statusBadge + '</div>' +
          '<div class="sp-platform-picker">' +
            '<button type="button" class="sp-platform-btn' + (spActivePlatform === 'lovable' ? ' sp-platform-active' : '') + '" data-platform="lovable">Lovable</button>' +
            '<button type="button" class="sp-platform-btn' + (spActivePlatform === 'chatgpt' ? ' sp-platform-active' : '') + '" data-platform="chatgpt">ChatGPT</button>' +
          '</div>' +
          '<div class="sp-sync-status" id="sp-sync">⏳ Waiting for sync...</div>' +
          '<div class="sp-trial-countdown" id="sp-countdown" style="display:none"></div>' +
        '</div>' +
        '<div id="sp-reseller-btn" style="display:none;margin-bottom:14px">' +
          '<a href="' + ((typeof DISCORD_SUPPORT_URL !== "undefined" && DISCORD_SUPPORT_URL) || "https://discord.gg/9ZBezyTEu5") + '" target="_blank" rel="noopener noreferrer" class="pk-discord-cta">' +
            '🔑 Request your key via Discord<span style="margin-left:auto;font-size:10px;opacity:0.6">→</span>' +
          '</a>' +
        '</div>' +
        spTemplateTabs(spActiveTab, spChatHistory.length) +
        '<div id="sp-tab-content"></div>';

      // Tab click handlers
      document.querySelectorAll('.sp-tab').forEach(function(t) {
        t.addEventListener('click', function() { switchTab(t.getAttribute('data-tab')); });
      });

      // Show active content
      if (spActiveTab === 'history') {
        renderHistoryTab();
      } else {
        showMainUIContent();
      }

      // Sync status
      setupPlatformPicker();
      updateSync();
      chrome.storage.onChanged.addListener((ch) => {
        if(ch.lovable_projectId || ch.lovable_token || ch.pk_active_platform) updateSync();
      });

      // Countdown
      updateCountdown();

      // Heartbeat
      chrome.storage.local.get(["ql_license_key","ql_session_id"], r => {
        if(r.ql_license_key) { sessionId = r.ql_session_id || sessionId; startHeartbeat(r.ql_license_key); }
      });

      checkUnread();
      checkForUpdate();
      checkResellerRole();
    });
  }

  function showMainUIContent() {
    var container = document.getElementById('sp-tab-content');
    if (!container) return;
    container.innerHTML =
      '<textarea class="sp-textarea" id="sp-msg" rows="3" placeholder="Type your command..." spellcheck="false"></textarea>' +
      '<div id="sp-attach-preview" class="sp-attach-preview" style="display:none"></div>' +
      '<div class="sp-action-bar">' +
        '<div class="sp-action-left"><label class="sp-toggle"><input type="checkbox" id="sp-modo-plano"><span class="sp-toggle-slider"></span></label><span class="sp-toggle-label">Plan</span></div>' +
        '<div class="sp-action-center">' +
          '<button class="sp-attach-btn" id="sp-attach-btn" title="Attach file">📎</button>' +
          '<button class="sp-tool-btn" id="sp-optimize" title="Optimize with AI">' + SP_SVG.sparkles + '</button>' +
          '<button class="sp-tool-btn" id="sp-speech" title="Voice">' + SP_SVG.mic + '</button>' +
        '</div>' +
        '<button class="sp-send-btn" id="sp-send">Send</button>' +
      '</div>' +
      '<input type="file" id="sp-file-input" multiple style="display:none" accept="*/*">' +
      '<div class="sp-log" id="sp-log"></div>' +
      '<span class="sp-shortcuts-title">QUICK SHORTCUTS</span>' +
      '<div class="sp-shortcuts-grid" id="sp-chips"></div>' +
      '<button type="button" class="sp-advanced-toggle" id="sp-advanced-toggle" aria-expanded="false" aria-controls="sp-advanced-panel">' +
        '<span class="sp-advanced-toggle-label">⚙️ Advanced Options</span>' +
        '<span class="sp-advanced-chevron" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="sp-advanced-panel" id="sp-advanced-panel" hidden>' +
        '<button id="sp-remove-watermark" class="sp-watermark-btn">Remove Watermark</button>' +
        '<button id="sp-shield-btn" class="sp-shield-btn"><span id="sp-shield-label">Enable Shield</span></button>' +
        '<button id="sp-native-chat-btn" class="sp-shield-btn sp-btn-feature sp-btn-native-chat"><span id="sp-native-chat-label">Use Native Chat</span></button>' +
        '<button id="sp-download-project" class="sp-watermark-btn sp-btn-feature sp-btn-download">Download Source Code</button>' +
        '<button id="sp-quick-init" class="sp-watermark-btn sp-btn-feature sp-btn-quick-init">Create New Project</button>' +
        '<span class="sp-shortcuts-title sp-section-label">Powerkits Features</span>' +
        '<button id="sp-publish-project" class="sp-watermark-btn sp-btn-feature sp-btn-publish">🌐 Publish Project</button>' +
        '<button id="sp-enable-cloud" class="sp-watermark-btn sp-btn-feature sp-btn-cloud">☁️ Enable Lovable Cloud</button>' +
      '</div>' +
      '<div id="sp-download-status" class="sp-log" style="display:none"></div>';

    // Setup chips
    const chips = document.getElementById('sp-chips');
    SP_TEMPLATES.forEach(t => {
      const chip = document.createElement('button');
      chip.className = 'sp-chip';
      chip.innerHTML = t.icon + ' ' + t.label;
      chip.title = t.prompt;
      chip.addEventListener('click', () => { document.getElementById('sp-msg').value = t.prompt; });
      chips.appendChild(chip);
    });

    // Advanced Options collapse/expand (collapsed by default)
    const advToggle = document.getElementById('sp-advanced-toggle');
    const advPanel = document.getElementById('sp-advanced-panel');
    if (advToggle && advPanel) {
      advToggle.addEventListener('click', function () {
        const isOpen = !advPanel.hasAttribute('hidden');
        if (isOpen) {
          advPanel.setAttribute('hidden', '');
          advToggle.setAttribute('aria-expanded', 'false');
          advToggle.classList.remove('sp-advanced-open');
        } else {
          advPanel.removeAttribute('hidden');
          advToggle.setAttribute('aria-expanded', 'true');
          advToggle.classList.add('sp-advanced-open');
        }
      });
    }

    // Plan Mode (workflow only — sends use native Lovable chat, not relay)
    if (!isChatGptPlatform()) {
      migratePlanModeStorageKeys(function(on) {
        var toggle = document.getElementById("sp-modo-plano");
        if (toggle) toggle.checked = on;
      });
      var planToggle = document.getElementById("sp-modo-plano");
      if (planToggle) {
        planToggle.addEventListener("change", function() {
          const checkbox = this;
          writePlanModeToStorage(checkbox.checked);
          if (checkbox.checked) showModoPlanoAlert();
        });
      }
    }

    // File attachment
    setupSpFileAttachment();

    // Clipboard paste (Ctrl+V) for images
    setupSpClipboardPaste();

    // Event listeners
    document.getElementById('sp-send').addEventListener('click', handleSend);
    document.getElementById('sp-optimize').addEventListener('click', handleOptimize);
    setupSpSpeech();
    if (!isChatGptPlatform()) {
      setupSpWatermarkButton();
      setupSpShield();
      setupSpNativeChat();
      setupSpDownloadProject();
      setupSpQuickInit();
      setupSpPublishProject();
      setupSpEnableCloud();
    }
    refreshPlatformUI();
  }

  // --- Speech Recognition (Web Speech API) ---
  function setupSpSpeech() {
    var btn = document.getElementById('sp-speech');
    if (!btn) return;

    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      btn.title = "Speech is not supported in this browser";
      btn.style.opacity = "0.4";
      btn.style.cursor = "not-allowed";
      return;
    }

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();

      if (spIsRecording && spSpeechRecognition) {
        spSpeechRecognition.stop();
        return;
      }

      try {
        spSpeechRecognition = new SpeechRecognition();
        spSpeechRecognition.lang = "en-US";
        spSpeechRecognition.continuous = true;
        spSpeechRecognition.interimResults = true;
        spSpeechRecognition.maxAlternatives = 1;

        var finalTranscript = "";
        var textarea = document.getElementById('sp-msg');

        spSpeechRecognition.onstart = function() {
          spIsRecording = true;
          btn.classList.add('sp-recording');
          btn.style.color = '#ef4444';
          btn.style.animation = 'pulse 1s infinite';
          finalTranscript = textarea ? textarea.value : "";
          console.log("[SP Speech] recording started");
        };

        spSpeechRecognition.onresult = function(event) {
          var interim = "";
          for (var i = event.resultIndex; i < event.results.length; i++) {
            var transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalTranscript += transcript + " ";
            } else {
              interim += transcript;
            }
          }
          if (textarea) textarea.value = finalTranscript + interim;
        };

        spSpeechRecognition.onerror = function(event) {
          console.warn("[SP Speech] error:", event.error);
          spIsRecording = false;
          btn.classList.remove('sp-recording');
          btn.style.color = '';
          btn.style.animation = '';

          if (event.error === "not-allowed") {
            spAlert("Permission Denied", "Allow microphone access in your browser settings.");
          } else if (event.error === "no-speech") {
            spAlert("No Audio", "No speech detected. Try again.");
          } else if (event.error !== "aborted") {
            spAlert("Voice Error", "Error: " + event.error);
          }
        };

        spSpeechRecognition.onend = function() {
          spIsRecording = false;
          btn.classList.remove('sp-recording');
          btn.style.color = '';
          btn.style.animation = '';
          if (textarea) textarea.value = finalTranscript.trim();
          console.log("[SP Speech] recording finished");
        };

        spSpeechRecognition.start();
      } catch(err) {
        console.error("[SP Speech] failed to start:", err);
        spIsRecording = false;
        btn.classList.remove('sp-recording');
        btn.style.color = '';
        btn.style.animation = '';
        spAlert("Error", "Could not start voice recognition.");
      }
    });
  }

  function renderSyncFromStorage(r) {
    const el = document.getElementById('sp-sync');
    if(!el) return;
    if (isChatGptPlatform()) {
      findPlatformTab('chatgpt', function(tab) {
        if (tab && tab.id) {
          chrome.tabs.sendMessage(tab.id, { action: 'resolvePlatformAuth' }, function(resp) {
            if (chrome.runtime.lastError) {
              el.className = 'sp-sync-status sp-sync-waiting';
              el.textContent = '⏳ Open chatgpt.com and start a chat';
              return;
            }
            if (resp && resp.ready) {
              el.className = 'sp-sync-status sp-sync-ok';
              el.textContent = '✅ ChatGPT ready';
            } else {
              el.className = 'sp-sync-status sp-sync-waiting';
              el.textContent = '⏳ Open a chat on chatgpt.com';
            }
          });
        } else {
          el.className = 'sp-sync-status sp-sync-waiting';
          el.textContent = '⏳ Open chatgpt.com in a tab';
        }
      });
      return;
    }
    var token = r.lovable_token || '';
    if(r.lovable_projectId && token && isTokenFresh(token)) {
      el.className = 'sp-sync-status sp-sync-ok';
      el.textContent = '✅ Synced! Project: ' + r.lovable_projectId.substring(0,6) + '...';
    } else if (r.lovable_projectId && token) {
      el.className = 'sp-sync-status sp-sync-waiting';
      el.textContent = '⚠ Log in on lovable.dev and open your project';
    } else {
      el.className = 'sp-sync-status sp-sync-waiting';
      el.textContent = '⏳ Open lovable.dev on your project tab';
    }
  }

  function updateSync() {
    if (isChatGptPlatform()) {
      renderSyncFromStorage({});
      return;
    }
    findLovableProjectTab(function(tab) {
      chrome.runtime.sendMessage({
        action: 'syncLovableAuth',
        tabUrl: tab && tab.url || '',
        projectId: projectIdFromTabUrl(tab && tab.url)
      }, function() {
        if (tab && tab.id) {
          try { chrome.tabs.sendMessage(tab.id, { action: 'requestTokenRefresh' }); } catch (e) {}
        }
        chrome.storage.local.get(["lovable_projectId","lovable_token"], renderSyncFromStorage);
      });
    });
  }

  function spApplyLicenseApiData(data) {
    if (!data) return;
    if (typeof pkResolveLicenseStatus === "function") {
      licenseStatus = pkResolveLicenseStatus(data);
    } else {
      licenseStatus = data.status || licenseStatus;
    }
    if (Object.prototype.hasOwnProperty.call(data, "expires_at")) {
      expiresAt = data.expires_at || null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "activated_at")) {
      spActivatedAt = data.activated_at || null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "validity_minutes")) {
      validityMinutes = data.validity_minutes != null ? data.validity_minutes : null;
    }
  }

  function spRevokeAndShowLicenseGate(message) {
    if (typeof pkInvalidateAssertCache === "function") pkInvalidateAssertCache();
    syncCreditBypassOnLovableTabs(false);
    var after = function () {
      showLicenseGate();
      if (message) setTimeout(function () { showAlert("Access Denied", message); }, 400);
    };
    if (typeof pkRevokeLicenseStorage === "function") {
      pkRevokeLicenseStorage().then(after);
    } else {
      pkSafeClearLicenseStorage(after);
    }
  }

  function spHandleLicenseExpired() {
    if (spCountdownInterval) { clearInterval(spCountdownInterval); spCountdownInterval = null; }
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    spRevokeAndShowLicenseGate("License has expired. Contact your provider to renew.");
  }

  function spHandleLicenseInvalid(data) {
    var reason = data && data.reason;
    if (reason === "expired") {
      spHandleLicenseExpired();
      return;
    }
    spRevokeAndShowLicenseGate((data && data.message) || "License not active.");
  }

  // --- Countdown ---
  function updateCountdown() {
    const el = document.getElementById('sp-countdown');
    // Always clear any previous ticking interval so a removed/changed expiry can't linger.
    if (spCountdownInterval) { clearInterval(spCountdownInterval); spCountdownInterval = null; }
    // No expiry (unlimited license) — hide the countdown entirely.
    if(!expiresAt) {
      if (validityMinutes && el) {
        el.style.display = 'flex';
        el.innerHTML = '<span style="color:var(--ql-text-muted);font-size:12px">⏳ Trial: ' + validityMinutes + ' min after activation</span>';
      } else if (el) {
        el.style.display = 'none';
        el.innerHTML = '';
      }
      return;
    }
    if(!el) return;
    el.style.display = 'flex';
    var expiresMs = typeof pkParseUtcExpiry === "function" ? pkParseUtcExpiry(expiresAt) : new Date(expiresAt).getTime();
    if (expiresMs == null || isNaN(expiresMs)) {
      el.style.display = 'none';
      return;
    }
    var startMs = typeof pkParseUtcExpiry === "function" ? pkParseUtcExpiry(spActivatedAt) : (spActivatedAt ? new Date(spActivatedAt).getTime() : null);
    if (startMs == null || isNaN(startMs)) startMs = expiresMs - 3600000;
    const totalDuration = Math.max(expiresMs - startMs, 60000);
    function tick() {
      const remaining = expiresMs - Date.now();
      if(remaining <= 0) {
        if (!spExpiryConfirming && typeof pkEnsureActiveLicense === "function") {
          spExpiryConfirming = true;
          pkEnsureActiveLicense(true).then(function (resp) {
            spExpiryConfirming = false;
            if (resp && resp.expires_at) {
              expiresAt = resp.expires_at;
              updateCountdown();
              return;
            }
            spHandleLicenseExpired();
          }).catch(function () {
            spExpiryConfirming = false;
            spHandleLicenseExpired();
          });
          return;
        }
        if (!spExpiryConfirming) spHandleLicenseExpired();
        return;
      }
      const days = Math.floor(remaining / 86400000);
      const hrs = Math.floor((remaining % 86400000) / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      const pct = Math.max(0, Math.min(100, (remaining / totalDuration) * 100));
      let timeStr = days > 0 ? days + 'd ' + hrs + 'h ' + mins + 'm' : hrs > 0 ? hrs + 'h ' + mins + 'm ' + String(secs).padStart(2,'0') + 's' : mins + ':' + String(secs).padStart(2,'0');
      const label = licenseStatus === 'trial' ? 'Trial expires in' : 'License expires in';
      const urgentClass = pct < 20 ? ' sp-bar-urgent' : '';
      el.innerHTML = spTemplateCountdown(label, timeStr, pct, urgentClass);
    }
    tick();
    spCountdownInterval = setInterval(tick, 1000);
  }

  // --- JWT Decode ---
  function spDecodeJwtUserId(token) {
    try {
      const parts = token.split('.');
      if (parts.length < 2) return null;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const payload = JSON.parse(atob(padded));
      return payload.sub || payload.user_id || null;
    } catch(e) { return null; }
  }

  // --- Image Compression ---
  async function spCompressImage(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const MAX_DIM = 1280;
        let w = img.width, h = img.height;
        if (w > MAX_DIM || h > MAX_DIM) {
          const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob((blob) => {
          if (!blob) return resolve({ file, previewUrl: null });
          resolve({ file: new File([blob], file.name, { type: outputType }), previewUrl: URL.createObjectURL(blob) });
        }, outputType, file.type === 'image/png' ? undefined : 0.8);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve({ file, previewUrl: null }); };
      img.src = url;
    });
  }

  // --- File Upload ---
  function spInferContentType(file) {
    if (file && typeof file.type === 'string' && file.type.trim()) return file.type;
    const name = (file && file.name ? file.name : '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const map = {
      pdf: 'application/pdf',
      txt: 'text/plain',
      csv: 'text/csv',
      json: 'application/json',
      zip: 'application/zip',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      mp4: 'video/mp4',
      webm: 'video/webm'
    };
    return map[ext] || 'application/octet-stream';
  }

  function spBuildUploadFileName(fileId, file) {
    const rawName = file && file.name ? String(file.name) : '';
    const ext = rawName.includes('.') ? rawName.split('.').pop().toLowerCase() : '';
    const safeExt = ext && /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin';
    return fileId + '.' + safeExt;
  }

  async function spUploadFileDirect(file, token) {
    const fileId = crypto.randomUUID();
    const contentType = spInferContentType(file);
    const uploadFileName = spBuildUploadFileName(fileId, file);
    const objectKey = 'uploads/' + Date.now() + '-' + uploadFileName;
    const uploadUrl = API_BASE + '/storage/v1/object/prompt-images/' + objectKey;
    const licenseHdrs = typeof pkLicenseUploadHeaders === "function"
      ? await pkLicenseUploadHeaders()
      : {};

    await new Promise(function(resolve, reject) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', uploadUrl, true);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.setRequestHeader('apikey', API_KEY);
      xhr.setRequestHeader('Authorization', 'Bearer ' + API_KEY);
      xhr.setRequestHeader('x-upsert', 'true');
      if (licenseHdrs['x-license-key']) xhr.setRequestHeader('x-license-key', licenseHdrs['x-license-key']);
      if (licenseHdrs['x-session-id']) xhr.setRequestHeader('x-session-id', licenseHdrs['x-session-id']);
      if (licenseHdrs['x-device-id']) xhr.setRequestHeader('x-device-id', licenseHdrs['x-device-id']);
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('PUT failed: ' + xhr.status));
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(file);
    });

    return { file_id: objectKey, file_name: file.name || 'file', public_url: API_BASE + '/storage/v1/object/public/prompt-images/' + objectKey };
  }

  // --- Attachment Preview ---
  function spRenderAttachPreview() {
    const container = document.getElementById('sp-attach-preview');
    if (!container) return;
    if (spAttachedFiles.length === 0) { container.style.display = 'none'; container.innerHTML = ''; return; }
    container.style.display = 'flex';
    container.innerHTML = spAttachedFiles.map((f, i) => spTemplateAttachItem(f, i)).join('');
    container.querySelectorAll('.sp-attach-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'));
        if (spAttachedFiles[idx] && spAttachedFiles[idx].previewUrl) URL.revokeObjectURL(spAttachedFiles[idx].previewUrl);
        spAttachedFiles.splice(idx, 1);
        spRenderAttachPreview();
      });
    });
  }

  // --- File Attachment Setup ---
  function setupSpFileAttachment() {
    const attachBtn = document.getElementById('sp-attach-btn');
    const fileInput = document.getElementById('sp-file-input');
    if (!attachBtn || !fileInput) return;
    attachBtn.addEventListener('click', () => {
      if (spAttachedFiles.length >= SP_MAX_FILES) { showAlert('Limit', 'Maximum ' + SP_MAX_FILES + ' files.'); return; }
      fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (!files.length) return;
      const sd = await new Promise(r => chrome.storage.local.get(['lovable_token'], r));
      let token = sd.lovable_token || '';
      if (!token) { showAlert('Error', 'Token not captured.'); return; }
      if (token.startsWith('Bearer ')) token = token.slice(7);
      for (const file of files) {
        if (spAttachedFiles.length >= SP_MAX_FILES) break;
        if (file.size > SP_MAX_FILE_SIZE) { showAlert('File Too Large', file.name + ' exceeds 20MB.'); continue; }
        let processedFile = file, previewUrl = null;
        if (['image/png','image/jpeg','image/webp'].includes(file.type)) {
          const r = await spCompressImage(file);
          processedFile = r.file; previewUrl = r.previewUrl;
        }
        const isImage = ['image/png','image/jpeg','image/webp'].includes(processedFile.type);
        const idx = spAttachedFiles.length;
        spAttachedFiles.push({ file_id: null, file_name: file.name, previewUrl, file_type: processedFile.type, sizeLabel: spFormatFileSize(processedFile.size), uploading: true, rawFile: processedFile });
        spRenderAttachPreview();
        try {
          const res = await spUploadFileDirect(processedFile, token);
          spAttachedFiles[idx].file_id = res.file_id;
          spAttachedFiles[idx].public_url = res.public_url;
          spAttachedFiles[idx].uploading = false;
          spRenderAttachPreview();
        } catch(err) {
          console.warn('[Powerkits] Image upload failed:', err.message);
          spAttachedFiles[idx].uploading = false;
          spAttachedFiles[idx].uploadFailed = true;
          spRenderAttachPreview();
          showAlert('Upload Error', 'Could not upload the image: ' + (err.message || 'unknown error'));
        }
      }
    });
  }

  // --- Plan Mode Alert ---
  function showModoPlanoAlert() {
    const overlay = document.createElement("div");
    overlay.className = "sp-modal-overlay";
    overlay.innerHTML = '<div class="sp-modal">' +
      '<div class="sp-modal-icon">⚠️</div>' +
      '<div class="sp-modal-title">Attention — Plan Mode</div>' +
      '<div class="sp-modal-body">' +
        '<strong>Plan Mode</strong> (Think mode in Lovable) may use credits while planning. Use in moderation, then send builds through the extension with Plan Mode off.' +
      '</div>' +
      '<div style="margin-bottom:14px;">' +
        '<div class="sp-modal-step"><span class="sp-modal-step-num">1</span><span class="sp-modal-step-text">Enable <strong>Plan Mode</strong> and send your prompt through the extension.</span></div>' +
        '<div class="sp-modal-step"><span class="sp-modal-step-num">2</span><span class="sp-modal-step-text">Lovable will generate a plan. <strong>Do not click Approve</strong> in Lovable.</span></div>' +
        '<div class="sp-modal-step"><span class="sp-modal-step-num">3</span><span class="sp-modal-step-text"><strong>Copy the plan</strong> and paste it into the extension prompt.</span></div>' +
        '<div class="sp-modal-step"><span class="sp-modal-step-num">4</span><span class="sp-modal-step-text"><strong>Turn off Plan Mode</strong> and send through the extension. No extra credits.</span></div>' +
      "</div>" +
      '<div class="sp-modal-check">' +
        '<input type="checkbox" id="sp-modal-dismiss" />' +
        '<label for="sp-modal-dismiss">Do not show again</label>' +
      "</div>" +
      '<button class="sp-modal-btn" id="sp-modal-ok">Got it!</button>' +
    "</div>";
    document.body.appendChild(overlay);
    document.getElementById("sp-modal-ok").addEventListener("click", function() {
      var dismiss = document.getElementById("sp-modal-dismiss").checked;
      if (dismiss) chrome.storage.local.set({ ql_modo_plano_alert_dismissed: true });
      overlay.remove();
    });
    overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
  }

  function sendPromptViaPlatform(finalMsg, platformId) {
    return new Promise(function(resolve, reject) {
      chrome.runtime.sendMessage({
        action: "sendPromptToPlatform",
        platform: platformId || spActivePlatform,
        message: finalMsg
      }, function(resp) {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (resp && resp.ok) resolve();
        else reject(new Error((resp && resp.error) || "Send failed"));
      });
    });
  }

  function sendPromptViaLovableTab(finalMsg) {
    return sendPromptViaPlatform(finalMsg, "lovable");
  }

  function showSpPublishedUrlModal(url){
    var existing = document.getElementById("sp-publish-modal");
    if(existing) existing.remove();
    var overlay = document.createElement("div");
    overlay.id = "sp-publish-modal";
    overlay.className = "pk-publish-overlay";
    overlay.innerHTML =
      '<div class="pk-publish-modal">' +
        '<div class="pk-publish-emoji" style="font-size:28px">🎉</div>' +
        '<h3>Project Published!</h3>' +
        '<p>Open your project using the link below:</p>' +
        '<div class="pk-publish-url-box"><a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a></div>' +
        '<div class="pk-publish-actions">' +
          '<button id="sp-publish-copy" class="pk-publish-copy">📋 Copy</button>' +
          '<button id="sp-publish-open" class="pk-publish-open">🔗 Open</button>' +
        '</div>' +
        '<button id="sp-publish-close" class="pk-publish-close">Close</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById("sp-publish-copy").addEventListener("click", function(){
      navigator.clipboard.writeText(url);
      this.textContent = "✓ Copied!";
    });
    document.getElementById("sp-publish-open").addEventListener("click", function(){ window.open(url, "_blank"); });
    document.getElementById("sp-publish-close").addEventListener("click", function(){ overlay.remove(); });
    overlay.addEventListener("click", function(e){ if(e.target === overlay) overlay.remove(); });
  }

  function setupSpPublishProject(){
    var btn = document.getElementById("sp-publish-project");
    if(!btn) return;
    btn.addEventListener("click", async function(){
      var log = document.getElementById("sp-log");
      btn.disabled = true;
      btn.textContent = "⏳ Publishing...";

      try {
        var result = await postLovableFeature(PUBLISH_PROJECT_URL, {});
        if(result && result.success === false){
          throw new Error(result.error_display || result.message || "Publish error");
        }
        log.className = "sp-log sp-log-success";
        log.textContent = "✓ Project published!";
        if(result && result.url) showSpPublishedUrlModal(result.url);
      } catch(err) {
        log.className = "sp-log sp-log-error";
        log.textContent = "✗ " + (err.message || err);
      } finally {
        btn.disabled = false;
        btn.textContent = "🌐 Publish Project";
      }
    });
  }

  function setupSpEnableCloud(){
    var btn = document.getElementById("sp-enable-cloud");
    if(!btn) return;
    btn.addEventListener("click", async function(){
      var log = document.getElementById("sp-log");
      btn.disabled = true;
      btn.textContent = "⏳ Activating Cloud...";

      try {
        var result = await postLovableFeature(ENABLE_CLOUD_URL, { region: "america" });
        if(result && result.success === false){
          throw new Error(result.error_display || result.message || "Cloud activation error");
        }
        log.className = "sp-log sp-log-success";
        log.textContent = "✓ " + (result && result.message ? result.message : "Lovable Cloud activated!");
      } catch(err) {
        log.className = "sp-log sp-log-error";
        log.textContent = "✗ " + (err.message || err);
      } finally {
        btn.disabled = false;
        btn.textContent = "☁️ Enable Lovable Cloud";
      }
    });
  }

  var SP_WATERMARK_PROMPT = "Add this CSS to global styles on every page: #lovable-badge { display: none !important; visibility: hidden !important; pointer-events: none !important; } Completely remove the entire Lovable branding widget — the Made with Lovable text AND the floating close X button. Hide the parent #lovable-badge container, not just the text inside it. No empty box or orphaned X button should remain visible.";

  function setupSpWatermarkButton(){
    var btn = document.getElementById("sp-remove-watermark");
    if(!btn) return;
    btn.addEventListener("click", async function(){
      var log = document.getElementById("sp-log");
      btn.disabled = true;
      btn.textContent = "⏳ Sending...";

      try {
        await sendPromptViaLovableTab(SP_WATERMARK_PROMPT);
        log.className = "sp-log sp-log-success";
        log.textContent = "✓ Prompt sent! Wait for Lovable to apply the CSS.";
      } catch(err) {
        log.className = "sp-log sp-log-error";
        log.textContent = "✗ " + (err.message || err);
      } finally {
        btn.disabled = false;
        btn.textContent = "Remove Watermark";
      }
    });
  }

  // --- Send Message ---
  async function handleSend() {
    const msg = document.getElementById("sp-msg").value.trim();
    const log = document.getElementById("sp-log");
    const btn = document.getElementById("sp-send");
    if (!msg) { log.className = "sp-log sp-log-error"; log.textContent = "⚠ Empty prompt"; return; }
    btn.disabled = true; btn.textContent = "⏳";

    const stillUploading = spAttachedFiles.filter(function(f) { return f.uploading; });
    if (stillUploading.length > 0) {
      log.className = "sp-log sp-log-error";
      log.textContent = "⏳ Wait — " + stillUploading.length + " file(s) still uploading.";
      btn.disabled = false; btn.textContent = "Send";
      return;
    }
    const failedUploads = spAttachedFiles.filter(function(f) { return f.uploadFailed; });
    if (failedUploads.length > 0) {
      log.className = "sp-log sp-log-error";
      log.textContent = "✗ " + failedUploads.length + " file(s) failed to upload. Remove them and try again.";
      btn.disabled = false; btn.textContent = "Send";
      return;
    }

    const uploadedImages = spAttachedFiles.filter(function(f) { return f.public_url && !f.uploading && !f.uploadFailed; });
    const hasImage = uploadedImages.length > 0;
    var finalMsg = msg;
    if (hasImage) {
      var linkLines = uploadedImages.map(function(f) { return f.public_url; }).join("\n");
      var sep = uploadedImages.length > 1 ? "Analyze the files at these links:\n" : "Analyze the file at this link: ";
      finalMsg = msg + "\n\n" + sep + linkLines;
    }

    log.className = "sp-log sp-log-info";
    log.textContent = hasImage ? "📎 Attaching image link..." : "⏳ Sending...";

    try {
      const sd = await new Promise(r => chrome.storage.local.get(["lovable_projectId", "ql_license_key"], r));
      const pid = sd.lovable_projectId || "";
      const licKey = sd.ql_license_key || "";
      if (!isChatGptPlatform() && !pid) {
        log.className = "sp-log sp-log-error";
        log.textContent = "⚠ Project not synced. Open lovable.dev on your project.";
        btn.disabled = false; btn.textContent = "Send";
        return;
      }
      var teamLicenseKey = resolveTeamLicenseKey(licKey);
      if (!teamLicenseKey && !(typeof INTERNAL_LICENSE_MODE !== "undefined" && INTERNAL_LICENSE_MODE)) {
        log.className = "sp-log sp-log-error";
        log.textContent = "⚠ Activate your license key first";
        btn.disabled = false; btn.textContent = "Send";
        return;
      }

      await sendPromptViaPlatform(finalMsg, spActivePlatform);

      log.className = "sp-log sp-log-success";
      log.textContent = hasImage ? "✓ Prompt sent! Valid image 😁" : "✓ Prompt sent!";
      addToHistory(msg, "ok");
      document.getElementById("sp-msg").value = "";
      spAttachedFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
      spAttachedFiles = [];
      spRenderAttachPreview();
    } catch (err) {
      log.className = "sp-log sp-log-error";
      log.textContent = "✗ " + formatApiError(err.message || err);
      addToHistory(msg, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Send";
    }
  }

  // --- Optimize Prompt ---
  async function handleOptimize() {
    const textarea = document.getElementById('sp-msg');
    const btn = document.getElementById('sp-optimize');
    if(!textarea || !textarea.value.trim()) { showAlert('Attention', 'Type a prompt before optimizing.'); return; }
    btn.classList.add('sp-tool-loading'); btn.disabled = true;
    try {
      const sd = await new Promise(r => chrome.storage.local.get(["ql_license_key"], r));
      const data = await bgFetch(OPTIMIZE_URL, { method: "POST", headers: { "Content-Type": "application/json", apikey: API_KEY, "x-license-key": sd.ql_license_key || "" }, body: JSON.stringify({ prompt: textarea.value.trim() }) });
      if(data.optimized_prompt) { textarea.value = data.optimized_prompt; showAlert('Prompt Optimized! ✨', 'Your prompt was improved with AI.'); }
      else if(data.error) showAlert('Error', data.error);
    } catch(err) { showAlert('Error', 'Failed to optimize: ' + (err.message || '')); }
    finally { btn.classList.remove('sp-tool-loading'); btn.disabled = false; }
  }

  // --- Heartbeat ---
  let spHbConflictCount = 0;

  function startHeartbeat(key) {
    if (INTERNAL_LICENSE_MODE) return;
    if(heartbeatInterval) clearInterval(heartbeatInterval);
    spHbConflictCount = 0;
    heartbeatInterval = setInterval(async () => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          clearInterval(heartbeatInterval);
          console.warn("[SP] Heartbeat stopped: extension context invalidated");
          return;
        }
        var data;
        if (typeof isDevLicenseKey === "function" && isDevLicenseKey(key)) {
          data = mockDevLicenseResponse(key, { session_id: sessionId, device_id: deviceId });
        } else {
          data = await bgFetch(getValidateUrl(), { method: "POST", headers: apiHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ license_key: key, session_id: sessionId, heartbeat: true, device_id: deviceId, max_devices: 2, device_limit: 2, allowed_devices: 2 }) });
        }
        if(!data.valid) {
          var decision = typeof pkShouldLockoutFromValidation === "function"
            ? pkShouldLockoutFromValidation(data, spHbConflictCount)
            : { lock: true, conflictCount: spHbConflictCount, message: data.message };
          spHbConflictCount = decision.conflictCount;

          if(decision.lock) {
            clearInterval(heartbeatInterval);
            if (typeof pkInvalidateAssertCache === "function") pkInvalidateAssertCache();
            spHandleLicenseInvalid({ reason: data.reason || decision.reason, message: decision.message || data.message });
          }
          return;
        }
        spHbConflictCount = 0;
        if(data.user_name) { userName = normalizeLicenseUserName(data.user_name); const el = document.getElementById('sp-name'); if(el) el.textContent = userName; }
        spApplyLicenseApiData(data);
        chrome.storage.local.set(typeof pkLicenseStoragePatch === "function" ? pkLicenseStoragePatch(data) : { ql_expires_at: expiresAt });
        updateCountdown();
      } catch(e) {
        if (e.message && e.message.includes("Extension context invalidated")) {
          clearInterval(heartbeatInterval);
          console.warn("[SP] Heartbeat stopped: extension context invalidated");
        }
      }
    }, 60000);
  }

  // --- Clipboard Paste (Ctrl+V) & Drag-and-Drop for ANY Files ---
  function setupSpClipboardPaste() {
    var textarea = document.getElementById('sp-msg');
    if (!textarea) return;

    // --- Drag and Drop ---
    var dropZone = document.getElementById('sp-body') || textarea;
    var dragOverlay = null;

    function showDragOverlay() {
      if (dragOverlay) return;
      dragOverlay = document.createElement('div');
      dragOverlay.className = 'sp-drag-overlay';
      dragOverlay.innerHTML = '<div class="sp-drag-overlay-inner">📂 Drop files here</div>';
      document.body.appendChild(dragOverlay);
    }

    function hideDragOverlay() {
      if (dragOverlay) { dragOverlay.remove(); dragOverlay = null; }
    }

    dropZone.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); showDragOverlay(); });
    dropZone.addEventListener('dragleave', function(e) { e.preventDefault(); e.stopPropagation(); if (!dropZone.contains(e.relatedTarget)) hideDragOverlay(); });
    dropZone.addEventListener('drop', async function(e) {
      e.preventDefault(); e.stopPropagation(); hideDragOverlay();
      var files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;
      await spHandleFilesAttach(files);
    });

    // --- Paste (images + non-image files) ---
    textarea.addEventListener('paste', async function(e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var filesToAttach = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.kind === 'file') {
          e.preventDefault();
          var file = item.getAsFile();
          if (file) filesToAttach.push(file);
        }
      }
      if (filesToAttach.length > 0) await spHandleFilesAttach(filesToAttach);
    });
  }

  async function spHandleFilesAttach(files) {
    if (spAttachedFiles.length >= SP_MAX_FILES) {
      showAlert('Limit', 'Maximum ' + SP_MAX_FILES + ' files.');
      return;
    }
    var sd = await new Promise(function(r) { chrome.storage.local.get(['lovable_token'], r); });
    var token = sd.lovable_token || '';
    if (!token) { showAlert('Error', 'Token not captured.'); return; }
    if (token.indexOf('Bearer ') === 0) token = token.slice(7);

    for (var fi = 0; fi < files.length; fi++) {
      var file = files[fi];
      if (spAttachedFiles.length >= SP_MAX_FILES) break;
      if (file.size > SP_MAX_FILE_SIZE) { showAlert('File Too Large', file.name + ' exceeds 20MB.'); continue; }

      var processedFile = file;
      var previewUrl = null;
      if (['image/png','image/jpeg','image/webp'].indexOf(file.type) >= 0) {
        var compressed = await spCompressImage(file);
        processedFile = compressed.file;
        previewUrl = compressed.previewUrl;
      }

      var idx = spAttachedFiles.length;
      spAttachedFiles.push({
        file_id: null,
        file_name: file.name || ('file_' + Date.now()),
        previewUrl: previewUrl,
        file_type: processedFile.type,
        sizeLabel: spFormatFileSize(processedFile.size),
        uploading: true,
        rawFile: processedFile
      });
      spRenderAttachPreview();

      try {
        var res = await spUploadFileDirect(processedFile, token);
        spAttachedFiles[idx].file_id = res.file_id;
          spAttachedFiles[idx].public_url = res.public_url;
        spAttachedFiles[idx].uploading = false;
        spRenderAttachPreview();
      } catch(err) {
        spAttachedFiles[idx].uploading = false;
        spAttachedFiles[idx].uploadFailed = true;
        spRenderAttachPreview();
          showAlert('Upload Error', 'Could not upload the image: ' + (err.message || 'unknown error'));
      }
    }
  }

  // --- Download All Project Files ---
  function setupSpDownloadProject() {
    var btn = document.getElementById('sp-download-project');
    if (!btn) return;
    btn.addEventListener('click', async function() {
      var statusEl = document.getElementById('sp-download-status');
      btn.disabled = true;
      btn.textContent = '🔄 Preparing...';
      if (statusEl) { statusEl.style.display = 'block'; statusEl.className = 'sp-log sp-log-info'; statusEl.textContent = '🔍 Checking token and project...'; }

      try {
        // ---- Feature flag gate ----
        try {
          var flagUrl = API_BASE + "/rest/v1/feature_flags?select=enabled&flag_key=eq.download_files";
          var flagData = await bgFetch(flagUrl, { method: "GET", headers: apiHeaders() });
          if (flagData && flagData.length > 0 && flagData[0].enabled === false) {
            throw new Error('Error using the extension resources.');
          }
        } catch (flagErr) {
          if (flagErr && flagErr.message === 'Error using the extension resources.') throw flagErr;
        }

        await requestLatestTokenFromTab(2000);
        var auth = await resolveLovableAuth();
        var authToken = String(auth.token || '').replace(/^Bearer\s+/i, '').trim();
        var projectId = auth.projectId || '';

        if (!projectId) {
          throw new Error('Open a Lovable project page first.');
        }

        if (!authToken) {
          throw new Error('Token not found. Open a Lovable project and wait for sync.');
        }

        // Download project
        if (statusEl) { statusEl.textContent = '📡 Downloading project files...'; }
        btn.textContent = '📡 Downloading...';

        var dlResponse = await new Promise(function(resolve) {
          chrome.runtime.sendMessage({ action: "downloadProject", projectId: projectId, token: authToken }, function(resp) { resolve(resp); });
        });

        if (!dlResponse || !dlResponse.success) {
          throw new Error(dlResponse && dlResponse.error ? dlResponse.error : 'Download failed');
        }

        var files = dlResponse.files;
        if (!files || files.length === 0) throw new Error('No files found in the project.');

        // Create ZIP
        if (statusEl) statusEl.textContent = '📦 Creating ZIP with ' + files.length + ' files...';
        btn.textContent = '📦 Packaging...';

        if (typeof JSZip === 'undefined') throw new Error('JSZip library not loaded.');
        var zip = new JSZip();
        var imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff'];
        var addedFiles = 0;

        for (var fi = 0; fi < files.length; fi++) {
          var f = files[fi];
          if (!f.name) continue;
          if (f.sizeExceeded) continue;

          if (f.contents && f.binary) {
            zip.file(f.name, f.contents, { base64: true, binary: true });
            addedFiles++;
          } else if (!f.contents && imageExts.some(function(ext) { return f.name.toLowerCase().indexOf(ext, f.name.length - ext.length) !== -1; })) {
            try {
              var encodedPath = encodeURIComponent(f.name);
              var imgUrl = 'https://api.lovable.dev/projects/' + projectId + '/files/raw?path=' + encodedPath;
              var imgResp = await fetch(imgUrl, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + authToken, 'Accept': '*/*' },
                credentials: 'omit',
                mode: 'cors'
              });
              if (imgResp.ok) {
                var ab = await imgResp.arrayBuffer();
                zip.file(f.name, ab, { binary: true });
                addedFiles++;
              } else if (f.contents) {
                zip.file(f.name, f.contents);
                addedFiles++;
              }
            } catch(imgErr) {
              if (f.contents) { zip.file(f.name, f.contents); addedFiles++; }
            }
          } else if (f.contents) {
            zip.file(f.name, f.contents);
            addedFiles++;
          }
        }

        if (statusEl) statusEl.textContent = '🗜️ Comprimindo ' + addedFiles + ' files...';
        var zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } });
        var timestamp = new Date().toISOString().split('T')[0];
        var zipName = 'lovable-' + projectId.substring(0, 8) + '-' + timestamp + '.zip';

        var url = URL.createObjectURL(zipBlob);
        var a = document.createElement('a');
        a.href = url;
        a.download = zipName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (statusEl) { statusEl.className = 'sp-log sp-log-success'; statusEl.textContent = '✅ ' + addedFiles + ' files downloaded successfully!'; }
        btn.textContent = '✅ Download Complete!';
        setTimeout(function() {
          btn.textContent = '📥 Download All Files';
          btn.disabled = false;
          if (statusEl) statusEl.style.display = 'none';
        }, 4000);
      } catch(err) {
        if (statusEl) { statusEl.className = 'sp-log sp-log-error'; statusEl.textContent = '❌ ' + (err.message || err); statusEl.style.display = 'block'; }
        btn.textContent = '❌ Failed';
        setTimeout(function() {
          btn.textContent = '📥 Download All Files';
          btn.disabled = false;
        }, 3000);
      }
    });
  }

  // --- Initialize ---
  (async function init() {
    deviceId = await getDeviceId();
    await new Promise(function(resolve) { getStoredPlatform(function() { resolve(); }); });
    chrome.storage.local.get(["ql_dark_mode"], r => { if(r.ql_dark_mode === false) document.body.classList.add('sp-light'); });
    chrome.storage.local.get(["ql_license_valid","ql_license_key","ql_user_name","ql_expires_at","ql_activated_at","ql_license_status","ql_validity_minutes","ql_session_id"], async (res) => {
      if (res.ql_license_valid) {
        userName = normalizeLicenseUserName(res.ql_user_name);
        expiresAt = res.ql_expires_at || null;
        spActivatedAt = res.ql_activated_at || null;
        licenseStatus = res.ql_license_status || null;
        validityMinutes = res.ql_validity_minutes != null ? res.ql_validity_minutes : null;
        sessionId = res.ql_session_id || null;
        syncCreditBypassOnLovableTabs(true);
        showMainUI();
        if(res.ql_license_key) {
          const _doSpStartupHb = async (attempt) => {
            try {
              var data;
              if (typeof isDevLicenseKey === "function" && isDevLicenseKey(res.ql_license_key)) {
                data = mockDevLicenseResponse(res.ql_license_key, { session_id: sessionId, device_id: deviceId });
              } else {
                data = await bgFetch(getValidateUrl(), { method: "POST", headers: apiHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ license_key: res.ql_license_key, session_id: sessionId, heartbeat: true, device_id: deviceId, max_devices: 2, device_limit: 2, allowed_devices: 2 }) });
              }
              if(data.valid) {
                userName = normalizeLicenseUserName(data.user_name || userName);
                spApplyLicenseApiData(data);
                sessionId = data.session_id || sessionId;
                chrome.storage.local.set(Object.assign({ ql_user_name: userName, ql_session_id: sessionId }, typeof pkLicenseStoragePatch === "function" ? pkLicenseStoragePatch(data) : {}));
                const nameEl = document.getElementById('sp-name'); if(nameEl) nameEl.textContent = userName;
                updateCountdown();
                syncCreditBypassOnLovableTabs(true);
              } else {
                if (data.reason === "device_conflict" && attempt < 2) {
                  setTimeout(() => _doSpStartupHb(attempt + 1), 5000);
                  return;
                }
                var _spStartupConflict = data.reason === "device_conflict" ? 2 : 0;
                var _spStartupDecision = typeof pkShouldLockoutFromValidation === "function"
                  ? pkShouldLockoutFromValidation(data, _spStartupConflict)
                  : { lock: true, message: data.message };
                if (_spStartupDecision.lock) {
                  if (typeof pkInvalidateAssertCache === "function") pkInvalidateAssertCache();
                  spHandleLicenseInvalid({ reason: data.reason || _spStartupDecision.reason, message: _spStartupDecision.message || data.message });
                }
              }
            } catch(e) {}
          };
          _doSpStartupHb(1);
        }
      } else {
        showLicenseGate();
      }
    });
  })();

  // ===== SHIELD SYSTEM (Sidebar) =====
  let spShieldActive = false;

  function setupSpShield() {
    const btn = document.getElementById('sp-shield-btn');
    if (!btn) return;

    chrome.storage.local.get(['ql_shield_active'], (res) => {
      if (res.ql_shield_active === true) {
        spShieldActive = true;
        btn.classList.add('sp-shield-active');
        const label = document.getElementById('sp-shield-label');
        if (label) label.textContent = 'Disable Shield';
        applySpShieldOnTab(true);
      }
    });

    btn.addEventListener('click', () => {
      spShieldActive = !spShieldActive;
      chrome.storage.local.set({ ql_shield_active: spShieldActive });

      const label = document.getElementById('sp-shield-label');
      if (spShieldActive) {
        btn.classList.add('sp-shield-active');
        if (label) label.textContent = 'Disable Shield';
        applySpShieldOnTab(true);
        showAlert('Shield Enabled 🛡️', 'The Lovable input is locked.');
      } else {
        btn.classList.remove('sp-shield-active');
        if (label) label.textContent = 'Enable Shield';
        applySpShieldOnTab(false);
        showAlert('Shield Disabled', 'The Lovable input is unlocked.');
      }
    });
  }

  function applySpShieldOnTab(active) {
    sendToLovableTab({ action: "setShieldActive", active: !!active }).catch(function() {});
  }

  // ===== NATIVE CHAT MODE (Sidebar) =====
  var spNativeChatActive = false;

  function setSpNativeChatBtnState(active) {
    var btn = document.getElementById('sp-native-chat-btn');
    var label = document.getElementById('sp-native-chat-label');
    if (!btn) return;
    btn.classList.toggle('sp-native-active', !!active);
    if (label) label.textContent = active ? 'Return to Extension' : 'Use Native Chat';
  }

  function setupSpNativeChat() {
    var btn = document.getElementById('sp-native-chat-btn');
    if (!btn) return;

    chrome.storage.local.get(['ql_native_chat'], function(res) {
      if (res.ql_native_chat === true) {
        spNativeChatActive = true;
        setSpNativeChatBtnState(true);
        applySpNativeChatOnTab(true);
      }
    });

    btn.addEventListener('click', function() {
      spNativeChatActive = !spNativeChatActive;
      chrome.storage.local.set({ ql_native_chat: spNativeChatActive });
      setSpNativeChatBtnState(spNativeChatActive);
      applySpNativeChatOnTab(spNativeChatActive);
      if (spNativeChatActive) {
        showAlert('Native Chat Enabled 💬', "Use Lovable's native input with the extension features.");
      } else {
        showAlert('Native Chat Disabled', 'Returned to extension mode.');
      }
    });
  }

  function applySpNativeChatOnTab(active) {
    sendToLovableTab({ action: "setNativeChatActive", active: !!active }).catch(function() {});
  }

  function setupSpQuickInit() {
    var btn = document.getElementById('sp-quick-init') || document.getElementById('sp-create-project');
    if (!btn) return;
    btn.addEventListener('click', async function() {
      var statusEl = document.getElementById('sp-download-status');
      var originalLabel = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Waiting for project...';
      if (statusEl) { statusEl.style.display = 'block'; statusEl.className = 'sp-log sp-log-info'; statusEl.textContent = '🚀 Typing placeholder and clicking Build...'; }

      try {
        var tabs = await new Promise(function(r) { chrome.tabs.query({ active: true, currentWindow: true }, r); });
        if (!tabs[0] || !tabs[0].id) throw new Error('No active tab found.');
        if (!tabs[0].url || tabs[0].url.indexOf('lovable.dev') === -1) {
          throw new Error('Open the Lovable home screen in your active tab first.');
        }

        var resp = await new Promise(function(resolve, reject) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'qlQuickProjectInit' }, function(r) {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(r);
          });
        });

        if (resp && resp.ok) {
          if (statusEl) { statusEl.className = 'sp-log sp-log-success'; statusEl.textContent = '✅ Empty project created! Send your real prompt from the extension.'; }
          btn.textContent = '✅ Done!';
        } else {
          throw new Error((resp && resp.error) || 'No response. Make sure you are on the Lovable home screen.');
        }
      } catch(err) {
        console.error('[SpCreateProject]', err);
        if (statusEl) { statusEl.className = 'sp-log sp-log-error'; statusEl.textContent = '❌ ' + (err.message || 'Error'); }
        btn.textContent = '❌ Failed';
      }
      setTimeout(function() {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
        if (statusEl) statusEl.style.display = 'none';
      }, 5000);
    });
  }

})();
