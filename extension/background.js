console.log("[Background] Lovable Powerkits service worker started");

try {
  importScripts("platform-config.js");
} catch (e) {
  console.warn("[Background] platform-config.js not loaded:", e && e.message ? e.message : e);
}

function decodeJwtExpMs(token) {
  try {
    var parts = String(token || "").replace(/^Bearer\s+/i, "").trim().split(".");
    if (parts.length < 2) return 0;
    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    var padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    var json = JSON.parse(atob(padded));
    return json.exp ? json.exp * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

function normalizeJwtToken(token) {
  return String(token || "").replace(/^Bearer\s+/i, "").trim();
}

function pickBestJwtToken(candidates) {
  var best = "";
  var bestExp = 0;
  (candidates || []).forEach(function(item) {
    var t = normalizeJwtToken(item);
    if (!t || t.indexOf("eyJ") !== 0 || t.split(".").length !== 3) return;
    var exp = decodeJwtExpMs(t);
    if (!best || exp > bestExp) {
      best = t;
      bestExp = exp;
    }
  });
  return best;
}

function extractJwtTokensFromCookies(cookies) {
  var found = [];
  (cookies || []).forEach(function(cookie) {
    if (!cookie || !cookie.value) return;
    var value = String(cookie.value).replace(/^"|"$/g, "");
    if (value.indexOf("eyJ") === 0 && value.split(".").length === 3) {
      found.push(value);
    }
  });
  return found;
}

function projectIdFromUrl(url) {
  var m = String(url || "").match(/\/projects\/([0-9a-fA-F-]{36})/);
  return m ? m[1] : "";
}

var LOVABLE_TAB_URLS = ["*://lovable.dev/*", "*://*.lovable.dev/*"];
var CHATGPT_TAB_URLS = ["*://chatgpt.com/*", "*://*.chatgpt.com/*", "*://chat.openai.com/*"];

function platformTabUrls(platformId) {
  if (typeof pkGetPlatform === "function") {
    var p = pkGetPlatform(platformId);
    if (p && p.tabUrls && p.tabUrls.length) return p.tabUrls;
  }
  if (platformId === "chatgpt") return CHATGPT_TAB_URLS;
  return LOVABLE_TAB_URLS;
}

function platformBridgeFiles(platformId) {
  if (typeof pkGetPlatform === "function") {
    var cfg = pkGetPlatform(platformId);
    if (cfg && cfg.bridgeFiles && cfg.bridgeFiles.length) return cfg.bridgeFiles;
  }
  if (platformId === "chatgpt") {
    return [
      "extension-config.js",
      "platform-config.js",
      "hwFingerprint.js",
      "license-guard.js",
      "user-messages.js",
      "chatgpt-bridge.js"
    ];
  }
  return [
    "extension-config.js",
    "platform-config.js",
    "hwFingerprint.js",
    "license-guard.js",
    "user-messages.js",
    "content-bridge.js"
  ];
}

function findPlatformTab(platformId, callback) {
  var urls = platformTabUrls(platformId);
  chrome.windows.getCurrent(function (win) {
    chrome.tabs.query({ url: urls }, function (tabs) {
      var list = tabs || [];
      var activeMatch = null;
      var anyMatch = null;

      if (platformId === "lovable") {
        chrome.storage.local.get(["lovable_projectId"], function (stored) {
          var storedPid = stored.lovable_projectId || "";
          var activeProject = null;
          var storedMatch = null;
          var anyProject = null;
          var anyLovable = null;

          list.forEach(function (tab) {
            if (!tab || !tab.url || tab.url.indexOf("lovable.dev") === -1) return;
            if (!anyLovable) anyLovable = tab;
            var pid = projectIdFromUrl(tab.url);
            if (!pid) return;
            if (!anyProject) anyProject = tab;
            if (storedPid && pid === storedPid) storedMatch = tab;
            if (win && tab.windowId === win.id && tab.active) activeProject = tab;
          });

          callback(activeProject || storedMatch || anyProject || anyLovable || null);
        });
        return;
      }

      list.forEach(function (tab) {
        if (!tab || !tab.url) return;
        if (!anyMatch) anyMatch = tab;
        if (win && tab.windowId === win.id && tab.active) activeMatch = tab;
      });
      callback(activeMatch || anyMatch || null);
    });
  });
}

function findLovableProjectTab(callback) {
  findPlatformTab("lovable", callback);
}

function tabPing(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { action: "ping" }, function (resp) {
      if (chrome.runtime.lastError) return resolve(false);
      resolve(!!(resp && resp.ok));
    });
  });
}

var BRIDGE_INJECT_FILES = [
  "extension-config.js",
  "platform-config.js",
  "hwFingerprint.js",
  "license-guard.js",
  "user-messages.js",
  "content-bridge.js"
];

function injectContentBridge(tabId, platformId) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: platformBridgeFiles(platformId || "lovable")
  });
}

function sendPromptOnTab(tabId, message) {
  return new Promise(function (resolve, reject) {
    chrome.tabs.sendMessage(tabId, { action: "qlSendViaWs", message: message }, function (resp) {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (resp && resp.ok) return resolve(resp);
      reject(new Error((resp && resp.error) || "Send failed"));
    });
  });
}

async function deliverPromptViaTab(message, platformId) {
  platformId = platformId || "lovable";
  var tab = await new Promise(function (resolve) {
    findPlatformTab(platformId, resolve);
  });
  if (!tab || !tab.id) {
    if (platformId === "chatgpt") {
      throw new Error("Open a ChatGPT chat at chatgpt.com, then try again.");
    }
    throw new Error("Open your Lovable project on lovable.dev (project URL), then try again.");
  }
  if (platformId === "lovable" && !projectIdFromUrl(tab.url) && tab.url.indexOf("lovable.dev") === -1) {
    throw new Error("Open a lovable.dev project tab and refresh it after updating the extension.");
  }

  var tabId = tab.id;
  var alive = await tabPing(tabId);
  if (!alive) {
    try {
      await injectContentBridge(tabId, platformId);
      await new Promise(function (r) { setTimeout(r, 150); });
    } catch (e) {
      if (platformId === "chatgpt") {
        throw new Error("Could not attach to the ChatGPT tab. Refresh chatgpt.com and try again.");
      }
      throw new Error("Could not attach to the Lovable tab. Refresh the project page and try again.");
    }
  }

  try {
    return await sendPromptOnTab(tabId, message);
  } catch (firstErr) {
    var errMsg = (firstErr && firstErr.message) || "";
    if (errMsg.indexOf("Receiving end") === -1 && errMsg.indexOf("Could not establish connection") === -1) {
      throw firstErr;
    }
    await injectContentBridge(tabId, platformId);
    await new Promise(function (r) { setTimeout(r, 200); });
    return await sendPromptOnTab(tabId, message);
  }
}

function collectLovableCookies(callback) {
  var domains = ["lovable.dev", ".lovable.dev"];
  var all = [];
  var pending = domains.length;
  if (!pending) return callback(all);
  domains.forEach(function(domain) {
    chrome.cookies.getAll({ domain: domain }, function(cookies) {
      if (cookies && cookies.length) all = all.concat(cookies);
      pending -= 1;
      if (pending === 0) callback(all);
    });
  });
}

function syncLovableAuth(tabUrl, hintProjectId, done) {
  collectLovableCookies(function(cookies) {
    var cookieToken = pickBestJwtToken(extractJwtTokensFromCookies(cookies));
    var projectId = projectIdFromUrl(tabUrl) || hintProjectId || "";
    chrome.storage.local.get(["lovable_token", "lovable_projectId"], function(stored) {
      var storedToken = normalizeJwtToken(stored.lovable_token || "");
      var token = storedToken;
      if (cookieToken && decodeJwtExpMs(cookieToken) >= decodeJwtExpMs(storedToken)) {
        token = cookieToken;
      }
      var updates = {};
      if (token) updates.lovable_token = token;
      if (projectId) updates.lovable_projectId = projectId;
      else if (stored.lovable_projectId) updates.lovable_projectId = stored.lovable_projectId;

      var finish = function(result) {
        if (typeof done === "function") done(result);
      };

      if (!Object.keys(updates).length) {
        finish({ ok: false, token: storedToken, projectId: stored.lovable_projectId || "" });
        return;
      }

      chrome.storage.local.set(updates, function() {
        finish({
          ok: !!token,
          token: updates.lovable_token || storedToken,
          projectId: updates.lovable_projectId || stored.lovable_projectId || "",
          fresh: decodeJwtExpMs(updates.lovable_token || storedToken) > Date.now() + 30000
        });
      });
    });
  });
}

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (changeInfo.status !== "complete" || !tab || !tab.url) return;
  if (tab.url.indexOf("lovable.dev") !== -1) {
    syncLovableAuth(tab.url, "", function() {
      try {
        chrome.tabs.sendMessage(tabId, { action: "requestTokenRefresh" }, function() {});
      } catch (e) {}
    });
    return;
  }
  if (tab.url.indexOf("chatgpt.com") !== -1 || tab.url.indexOf("chat.openai.com") !== -1) {
    chrome.storage.local.set({ chatgpt_tab_ready: true });
  }
});

async function enableActionSidePanel() {
  try {
    await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
  } catch (err) {
    console.warn("[Background] sidePanel.setOptions:", err && err.message ? err.message : err);
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn("[Background] sidePanel.setPanelBehavior:", err && err.message ? err.message : err);
  }
}

async function openPowerkitsSidePanel(tab) {
  await enableActionSidePanel();
  if (!tab || !tab.id) throw new Error("Active tab not found.");
  await chrome.sidePanel.open({ tabId: tab.id });
  await chrome.storage.local.set({ ql_sidebar_mode: true });
  return { ok: true };
}

enableActionSidePanel();
chrome.storage.local.set({ ql_sidebar_mode: true });

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ ql_sidebar_mode: true });
  enableActionSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  enableActionSidePanel();
});

chrome.storage.local.get(["ql_sidebar_mode"], (res) => {
  if (res.ql_sidebar_mode !== true) {
    chrome.storage.local.set({ ql_sidebar_mode: true });
  }
  enableActionSidePanel();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ql_sidebar_mode) {
    enableActionSidePanel();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await openPowerkitsSidePanel(tab);
  } catch (err) {
    console.error("[Background] action.onClicked sidePanel error:", err);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "lovableSync") {
    chrome.storage.local.get(["lovable_token", "lovable_projectId"], function(stored) {
      const updates = {};
      if (msg.token) {
        var incoming = normalizeJwtToken(msg.token);
        var current = normalizeJwtToken(stored.lovable_token || "");
        if (incoming && (!current || decodeJwtExpMs(incoming) >= decodeJwtExpMs(current) - 5000)) {
          updates.lovable_token = incoming;
        }
      }
      if (msg.projectId) updates.lovable_projectId = msg.projectId;
      if (msg.browserSessionId) updates.lovable_browserSessionId = String(msg.browserSessionId).trim();
      if (Object.keys(updates).length) {
        chrome.storage.local.set(updates, function() {});
      }
    });
    return false;
  }

  if (msg && msg.action === "activateSidebar") {
    enableActionSidePanel();
    if (sender.tab && sender.tab.id) {
      openPowerkitsSidePanel(sender.tab).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        console.warn("[Background] sidePanel.open deferred:", err.message);
        sendResponse({ ok: false, deferred: true, message: "Click the extension icon to open the side panel." });
      });
    } else {
      sendResponse({ ok: false, deferred: true, message: "Click the extension icon to open the side panel." });
    }
    return true;
  }

  if (msg && msg.action === "deactivateSidebar") {
    sendResponse({ ok: true });
    return false;
  }

  if (msg && msg.action === "openSidePanel") {
    if (sender.tab && sender.tab.id) {
      openPowerkitsSidePanel(sender.tab).then(() => {
        sendResponse({ ok: true });
      }).catch((err) => {
        console.warn("[Background] openSidePanel deferred:", err.message);
        sendResponse({ ok: false, error: err.message });
      });
    } else {
      sendResponse({ ok: false, error: "No tab context" });
    }
    return true;
  }

  if (msg && msg.action === "proxyFetch") {
    (async () => {
      try {
        if (typeof POWERKITS_DEBUG !== "undefined" && POWERKITS_DEBUG) {
          console.log("[Background] proxyFetch ->", msg.url);
        }
        var opts = {
          method: msg.method || "POST",
          headers: msg.headers || {},
        };
        if (msg.body) opts.body = msg.body;
        var resp = await fetch(msg.url, opts);
        var text = await resp.text();
        var data;
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
        if (!resp.ok && data && data.raw && typeof data.raw === "string") {
          var raw = data.raw.trim();
          if (/^error code: 502$/i.test(raw) || /^error code: 503$/i.test(raw)) {
            data.error_display = "Service is temporarily unavailable (gateway timeout). Try again in a few minutes.";
          } else if (raw.length > 120 && /<!DOCTYPE|<html|cloudflare|bad gateway/i.test(raw)) {
            data.error_display = "Service is temporarily unavailable. Try again in a few minutes.";
          }
        }
        sendResponse({ ok: resp.ok, status: resp.status, data: data });
      } catch (err) {
        console.error("[Background] proxyFetch error:", err);
        sendResponse({ ok: false, status: 0, data: { error: err.message || "Fetch failed in background" } });
      }
    })();
    return true;
  }

  if (msg && msg.action === "readCookies") {
    collectLovableCookies(function(cookies) {
      var tokens = extractJwtTokensFromCookies(cookies);
      var foundTokens = tokens.map(function(token, index) {
        return { token: token, cookieName: "scan-" + index, httpOnly: false };
      });
      sendResponse({ success: foundTokens.length > 0, tokens: foundTokens });
    });
    return true;
  }

  if (msg && msg.action === "syncLovableAuth") {
    syncLovableAuth(msg.tabUrl || "", msg.projectId || "", function(result) {
      sendResponse(result || { ok: false });
    });
    return true;
  }

  if (msg && msg.action === "getLovableCookies") {
    chrome.cookies.getAll({ domain: "lovable.dev" }, function (cookies) {
      var parts = [];
      if (cookies && cookies.length) {
        for (var i = 0; i < cookies.length; i++) {
          var c = cookies[i];
          if (c && c.name && typeof c.value === "string") {
            parts.push(c.name + "=" + c.value);
          }
        }
      }
      sendResponse({ ok: true, cookie: parts.join("; ") });
    });
    return true;
  }

  if (msg && msg.action === "sendPromptToLovable") {
    (async function () {
      try {
        await deliverPromptViaTab(msg.message || "", "lovable");
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Send failed" });
      }
    })();
    return true;
  }

  if (msg && msg.action === "sendPromptToPlatform") {
    (async function () {
      try {
        await deliverPromptViaTab(msg.message || "", msg.platform || "lovable");
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Send failed" });
      }
    })();
    return true;
  }

  if (msg && msg.action === "findPlatformTab") {
    findPlatformTab(msg.platform || "lovable", function(tab) {
      sendResponse({ ok: !!tab, tab: tab ? { id: tab.id, url: tab.url || "" } : null });
    });
    return true;
  }

  if (msg && msg.action === "downloadProject") {
    (async function () {
      try {
        var apiUrl = "https://lovable-api.com/projects/" + msg.projectId + "/source-code";
        var resp = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Authorization": "Bearer " + msg.token,
            "Accept": "application/json"
          }
        });
        if (!resp.ok) {
          sendResponse({ success: false, error: "API returned " + resp.status });
          return;
        }
        var data = await resp.json();
        sendResponse({ success: true, files: data.files || [] });
      } catch (err) {
        sendResponse({ success: false, error: err.message || "Download failed" });
      }
    })();
    return true;
  }
});
