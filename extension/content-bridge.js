/**
 * Minimal Lovable page bridge — registers early so side panel Send always has a receiver.
 * Full UI logic stays in content.js; prompt delivery is shared via window.__pkDeliverPrompt.
 */
(function () {
  if (window.__pkBridgeReady) return;
  window.__pkBridgeReady = true;

  function activatePkCreditBypass() {
    try { localStorage.setItem("__ql_bypass_active", "1"); } catch (e) {}
    try { document.documentElement.setAttribute("data-ql-bypass", "1"); } catch (e) {}
    try { window.postMessage({ type: "qlBypassState", active: true }, "*"); } catch (e) {}
  }

  function deactivatePkCreditBypass() {
    try { localStorage.removeItem("__ql_bypass_active"); } catch (e) {}
    try { document.documentElement.removeAttribute("data-ql-bypass"); } catch (e) {}
    try { window.postMessage({ type: "qlBypassState", active: false }, "*"); } catch (e) {}
  }

  function setPkCreditBypass(on) {
    if (on) activatePkCreditBypass();
    else deactivatePkCreditBypass();
  }

  (function setupBypassGuard() {
    function enforceLicense() {
      if (typeof INTERNAL_LICENSE_MODE !== "undefined" && INTERNAL_LICENSE_MODE) {
        if (document.documentElement.getAttribute("data-ql-bypass") !== "1") {
          setPkCreditBypass(true);
        }
        return;
      }
      chrome.storage.local.get(["ql_license_valid", "ql_license_key"], function (res) {
        var licensed = !!(res.ql_license_valid && typeof resolveTeamLicenseKey === "function" && resolveTeamLicenseKey(res.ql_license_key));
        if (!licensed) {
          if (document.documentElement.getAttribute("data-ql-bypass") === "1" || localStorage.getItem("__ql_bypass_active") === "1") {
            deactivatePkCreditBypass();
          }
        } else {
          try {
            if (localStorage.getItem("__ql_bypass_active") === "1") {
              if (document.documentElement.getAttribute("data-ql-bypass") !== "1") {
                activatePkCreditBypass();
              }
            }
          } catch (e) {}
        }
      });
    }

    var obs = new MutationObserver(enforceLicense);
    if (document.documentElement) {
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ql-bypass"] });
    }

    // Periodically enforce license validation state on the page context to prevent tamper overrides
    setInterval(enforceLicense, 2000);
  })();

  function syncPkCreditBypassFromStorage() {
    if (typeof INTERNAL_LICENSE_MODE !== "undefined" && INTERNAL_LICENSE_MODE) {
      setPkCreditBypass(true);
      return;
    }
    chrome.storage.local.get(["ql_license_valid", "ql_license_key"], function (res) {
      var licensed = !!(res.ql_license_valid && typeof resolveTeamLicenseKey === "function" && resolveTeamLicenseKey(res.ql_license_key));
      setPkCreditBypass(licensed);
    });
  }

  window.__pkSetCreditBypass = setPkCreditBypass;
  window.__pkActivateCreditBypass = activatePkCreditBypass;
  window.__pkDeactivateCreditBypass = deactivatePkCreditBypass;
  window.__pkSyncCreditBypass = syncPkCreditBypassFromStorage;
  syncPkCreditBypassFromStorage();
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      if (changes.ql_license_valid || changes.ql_license_key) syncPkCreditBypassFromStorage();
    });
  } catch (e) {}

  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.type === "lovablePromptValidationRequest") {
      const requestId = ev.data.requestId;
      chrome.runtime.sendMessage({ action: "checkPrompt", message: ev.data.prompt }, function (resp) {
        const result = resp || { allowed: false, error: "Validation server connection failed." };
        window.postMessage({
          type: "lovablePromptValidationResult",
          requestId: requestId,
          result: result
        }, "*");
      });
    }
  });

  function projectIdFromPage() {
    try {
      var m = window.location.pathname.match(/projects\/([0-9a-fA-F-]{36})/i);
      return m ? m[1] : "";
    } catch (e) {
      return "";
    }
  }

  function _qlUlid() {
    var C = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    var ts = Date.now();
    var r = "";
    for (var i = 9; i >= 0; i--) {
      r = C[ts % 32] + r;
      ts = Math.floor(ts / 32);
    }
    for (var j = 0; j < 16; j++) r += C[Math.floor(Math.random() * 32)];
    return r;
  }

  function sendViaWs(message) {
    return new Promise(function (resolve, reject) {
      var payload = {
        id: "umsg_" + _qlUlid(),
        message: message,
        files: [],
        selected_elements: [],
        chat_only: false,
        view: "editor",
        view_description: "",
        optimisticImageUrls: [],
        ai_message_id: "aimsg_" + _qlUlid(),
        thread_id: "main",
        current_page: window.location.pathname || "/",
        current_viewport_width: window.innerWidth || 1280,
        current_viewport_height: window.innerHeight || 800,
        current_viewport_dpr: window.devicePixelRatio || 1,
        model: null
      };
      var timer = setTimeout(function () {
        window.removeEventListener("message", handler);
        reject(new Error("Timeout: WebSocket did not respond"));
      }, 6000);
      function handler(ev) {
        if (ev.source !== window || !ev.data) return;
        if (ev.data.type !== "lovableWsSendResult") return;
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        if (ev.data.success) resolve();
        else reject(new Error(ev.data.error || "WebSocket send failed"));
      }
      window.addEventListener("message", handler);
      window.postMessage({ type: "lovableSendViaWs", payload: payload }, "*");
    });
  }

  async function sendNativeToLovable(text) {
    var chatForm = document.querySelector("form#chat-input");
    if (!chatForm) throw new Error("Lovable chat not found. Open your project on lovable.dev.");
    var editor = chatForm.querySelector('[contenteditable="true"]');
    if (!editor) throw new Error("Chat editor not found. Wait for the page to finish loading.");
    var sendBtn = document.getElementById("chatinput-send-message-button");
    if (!sendBtn) throw new Error("Send button not found.");
    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    await new Promise(function (r) { setTimeout(r, 80); });
    sendBtn.click();
  }

  function pkLicenseGuard() {
    return window.pkEnsureActiveLicense || (typeof pkEnsureActiveLicense === "function" ? pkEnsureActiveLicense : null);
  }

  async function deliverPromptToLovable(text) {
    var ensureLicense = pkLicenseGuard();
    if (typeof ensureLicense === "function") {
      await ensureLicense(false);
    } else {
      throw new Error("License guard not loaded. Refresh your Lovable project tab, then try again.");
    }
    var strategy = (typeof SEND_STRATEGY !== "undefined" && SEND_STRATEGY) ? SEND_STRATEGY : "native";
    if (strategy === "relay") {
      throw new Error("Relay send is disabled. Use native or websocket strategy.");
    }
    if (strategy === "websocket") {
      try {
        await sendViaWs(text);
        return;
      } catch (e) {
        if (typeof POWERKITS_DEBUG !== "undefined" && POWERKITS_DEBUG) {
          console.warn("[PK Bridge] WebSocket failed, using native:", e.message);
        }
      }
    }
    await sendNativeToLovable(text);
  }

  window.__pkDeliverPrompt = deliverPromptToLovable;

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.action === "ping") {
      sendResponse({ ok: true, bridge: true, platform: "lovable" });
      return false;
    }
    if (msg && msg.action === "qlActivateBypass") {
      var ensureLicenseActivate = pkLicenseGuard();
      if (typeof ensureLicenseActivate === "function") {
        ensureLicenseActivate(false).then(function () {
          setPkCreditBypass(true);
          sendResponse({ ok: true });
        }).catch(function () {
          setPkCreditBypass(false);
          sendResponse({ ok: false });
        });
        return true;
      }
      setPkCreditBypass(false);
      sendResponse({ ok: false });
      return false;
    }
    if (msg && msg.action === "qlDeactivateBypass") {
      setPkCreditBypass(false);
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.action === "setCreditBypass") {
      var ensureLicenseBypass = pkLicenseGuard();
      if (msg.active && typeof ensureLicenseBypass === "function") {
        ensureLicenseBypass(false).then(function () {
          setPkCreditBypass(true);
          sendResponse({ ok: true });
        }).catch(function () {
          setPkCreditBypass(false);
          sendResponse({ ok: false });
        });
        return true;
      }
      setPkCreditBypass(!!msg.active);
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.action === "syncCreditBypass") {
      syncPkCreditBypassFromStorage();
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.action === "qlSendViaWs") {
      deliverPromptToLovable(msg.message || "")
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (err) { sendResponse({ ok: false, error: err.message || String(err) }); });
      return true;
    }
    if (msg && msg.action === "requestTokenRefresh") {
      try { window.postMessage({ type: "lovableRequestToken" }, "*"); } catch (e) {}
      setTimeout(function () {
        try { window.postMessage({ type: "lovableRequestToken" }, "*"); } catch (e2) {}
      }, 120);
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.action === "resolveLovableAuth") {
      (async function () {
        try { window.postMessage({ type: "lovableRequestToken" }, "*"); } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 200); });
        var sd = await new Promise(function (r) {
          chrome.storage.local.get(["lovable_token", "lovable_projectId"], r);
        });
        sendResponse({
          token: sd.lovable_token || "",
          projectId: projectIdFromPage() || sd.lovable_projectId || ""
        });
      })();
      return true;
    }
  });
})();
