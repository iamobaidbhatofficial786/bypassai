/**
 * Bypass Ai — extension configuration
 */
var EXTENSION_NAME = "Bypass Ai";
var EXTENSION_VERSION = "6.4.4";
var DEFAULT_LICENSE_USER_NAME = "Licensed User";

/** Single source for UI version labels (footer, badges). Keep in sync with manifest.json version. */
function extensionVersionShort() {
  return typeof EXTENSION_VERSION !== "undefined" ? String(EXTENSION_VERSION) : "0.0.0";
}

function extensionFooterBadge() {
  var name = typeof EXTENSION_NAME !== "undefined" ? String(EXTENSION_NAME) : "Bypass Ai";
  return name + " • v" + extensionVersionShort();
}

var POWERKITS_API_BASE = "https://lov.powerkits.net";
var POWERKITS_LICENSE_API_BASE = "https://bypassai-chi.vercel.app"; // Default production Vercel URL

// Load dynamic license base URL from storage if auto-detected
try {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["ql_license_api_base"], function(res) {
      if (res && res.ql_license_api_base) {
        POWERKITS_LICENSE_API_BASE = res.ql_license_api_base;
      }
    });
  }
} catch (e) {}
var POWERKITS_API_KEY = "pk_lov_ext_a8f3c21e9d4b7f0e6a2c5d8b1e4f7a0c";

/** @deprecated Use POWERKITS_* — kept for older script references */
var GRINGOW_API_BASE = POWERKITS_API_BASE;
var GRINGOW_API_KEY = POWERKITS_API_KEY;

/** Telegram support */
var DISCORD_SUPPORT_URL = "https://t.me/Iamsamkhanofficial";

/** Emergency fallback only — normal sends must not use relay (credits). */
var PROXY_COMMAND_URL = POWERKITS_API_BASE + "/functions/v1/proxy-command";

/**
 * Prompt send strategy:
 * - "native" — fill Lovable chat + click Send (default)
 * - "websocket" — inject via pageHook WebSocket, fallback to native
 * - "relay" — server proxy-command (debug only; consumes credits)
 */
var SEND_STRATEGY = "native";

var POWERKITS_DEBUG = false;

var INTERNAL_LICENSE_MODE = false;

// Local dev/test/internal bypass options removed for production security.
function isDevLicenseKey(key) {
  return false;
}
function mockDevLicenseResponse(key, opts) {
  return { valid: false, message: "Invalid license key.", reason: "invalid" };
}

/** Side panel only — no floating bubble on lovable.dev. */
var SIDE_PANEL_ONLY = true;

function powerkitsApiHeaders(extra) {
  return Object.assign({ apikey: POWERKITS_API_KEY }, extra || {});
}

function gringowApiHeaders(extra) {
  return powerkitsApiHeaders(extra);
}

function normalizeLicenseUserName(name) {
  var n = String(name || "").trim();
  if (!n || n.toLowerCase() === "test" || n.toLowerCase() === "user" || /gringow|powerkits/i.test(n)) {
    return DEFAULT_LICENSE_USER_NAME;
  }
  return n;
}

/** User PK- license sent to the Powerkits API for validation. */
function resolveTeamLicenseKey(storedKey) {
  var k = String(storedKey || "").trim();
  if (!k) {
    return "";
  }
  return k;
}

function powerkitsInternalSessionStorage(sessionId, userName) {
  var key = resolveTeamLicenseKey("");
  return {
    ql_license_valid: true,
    ql_license_key: key || "INTERNAL",
    ql_session_id: sessionId,
    ql_user_name: normalizeLicenseUserName(userName),
    ql_license_status: "active",
    ql_expires_at: null,
    ql_activated_at: new Date().toISOString()
  };
}

function gringowInternalSessionStorage(sessionId, userName) {
  return powerkitsInternalSessionStorage(sessionId, userName);
}

/** Read Plan Mode toggle (migrates legacy ql_license_mode keys). */
function readPlanModeFromStorage(res) {
  res = res || {};
  return !!(res.ql_modo_plano || res.ql_license_mode || res.ql_modo_licença);
}

/** Persist Plan Mode and migrate away from legacy license-mode keys. */
function writePlanModeToStorage(on, cb) {
  chrome.storage.local.set({ ql_modo_plano: !!on }, cb);
}

/** One-time migration: ql_license_mode → ql_modo_plano. */
function migratePlanModeStorageKeys(cb) {
  chrome.storage.local.get([
    "ql_modo_plano", "ql_license_mode", "ql_modo_licença",
    "ql_modo_plano_alert_dismissed", "ql_license_mode_alert_dismissed"
  ], function(res) {
    var patch = {};
    var on = readPlanModeFromStorage(res);
    if (on && res.ql_modo_plano !== true) patch.ql_modo_plano = true;
    var dismissed = !!(res.ql_modo_plano_alert_dismissed || res.ql_license_mode_alert_dismissed);
    if (dismissed && res.ql_modo_plano_alert_dismissed !== true) {
      patch.ql_modo_plano_alert_dismissed = true;
    }
    if (Object.keys(patch).length) {
      chrome.storage.local.set(patch, function() { if (cb) cb(on, dismissed); });
    } else if (cb) {
      cb(on, dismissed);
    }
  });
}

/** Page localStorage (migrates legacy gringow_* keys). */
function pkPageStorageGet(suffix) {
  try {
    return localStorage.getItem("pk_" + suffix) || localStorage.getItem("gringow_" + suffix) || "";
  } catch (e) {
    return "";
  }
}

function pkPageStorageSet(suffix, value) {
  try {
    localStorage.setItem("pk_" + suffix, value);
  } catch (e) {}
}

/** Parse API expiry (UTC ISO or legacy "Y-m-d H:i:s") to epoch ms. */
function pkParseUtcExpiry(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && !isNaN(value)) return value;
  var s = String(value).trim();
  if (!s) return null;
  if (!/Z|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }
  var ms = Date.parse(s);
  return isNaN(ms) ? null : ms;
}

/** Display status for UI badges and countdown labels. */
function pkResolveLicenseStatus(data) {
  if (!data) return "active";
  if (data.is_trial || data.status === "trial") return "trial";
  return data.status || "active";
}

/** Fields to persist after validate / heartbeat / assert-session. */
function pkLicenseStoragePatch(data) {
  if (!data) return {};
  var patch = {
    ql_license_status: pkResolveLicenseStatus(data)
  };
  if (Object.prototype.hasOwnProperty.call(data, "expires_at")) {
    patch.ql_expires_at = data.expires_at || null;
  }
  if (Object.prototype.hasOwnProperty.call(data, "activated_at")) {
    patch.ql_activated_at = data.activated_at || null;
  }
  if (Object.prototype.hasOwnProperty.call(data, "validity_minutes")) {
    patch.ql_validity_minutes = data.validity_minutes != null ? data.validity_minutes : null;
  }
  return patch;
}

/** Safe storage write wrapper to prevent false-positive tamper detections during legitimate logins/updates */
function pkSafeSetLicenseStorage(data, cb) {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ ql_authorized_write: true }, function() {
      chrome.storage.local.set(data, function() {
        setTimeout(function() {
          chrome.storage.local.remove(["ql_authorized_write"], function() {
            if (cb) cb();
          });
        }, 500);
      });
    });
  } else {
    if (cb) cb();
  }
}

/** Safe storage cleanup wrapper to prevent false-positive tamper detections during legitimate logouts/expiries */
function pkSafeClearLicenseStorage(cb) {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ ql_authorized_write: true }, function() {
      chrome.storage.local.remove([
        "ql_license_valid",
        "ql_license_key",
        "ql_session_id",
        "ql_user_name",
        "ql_expires_at",
        "ql_activated_at",
        "ql_license_status",
        "ql_validity_minutes",
        "ql_license_api_base"
      ], function() {
        setTimeout(function() {
          chrome.storage.local.remove(["ql_authorized_write"], function() {
            if (cb) cb();
          });
        }, 500);
      });
    });
  } else {
    if (cb) cb();
  }
}

// Global storage listener for tamper protection
try {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area !== "local") return;
      if (changes.ql_license_valid || changes.ql_license_key) {
        var isRemoved = changes.ql_license_valid && (changes.ql_license_valid.newValue !== true);
        var isKeyChanged = changes.ql_license_key && (changes.ql_license_key.newValue !== changes.ql_license_key.oldValue);
        
        if (isRemoved || isKeyChanged) {
          chrome.storage.local.get(["ql_authorized_write"], function(res) {
            if (!res || !res.ql_authorized_write) {
              console.warn("[TamperProtection] Unauthorized license state modification detected.");
              pkSafeClearLicenseStorage(function() {
                if (typeof window !== "undefined" && window.location) {
                  window.location.reload();
                }
              });
            }
          });
        }
      }
    });
  }
} catch (e) {}
