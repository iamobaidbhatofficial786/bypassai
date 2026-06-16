/**
 * Replit page bridge — handles prompt delivery and workspace repl project sync.
 */
(function () {
  if (window.__pkReplitBridgeReady) return;
  window.__pkReplitBridgeReady = true;

  function pkLicenseGuard() {
    return window.pkEnsureActiveLicense || (typeof pkEnsureActiveLicense === "function" ? pkEnsureActiveLicense : null);
  }

  function findReplitInput() {
    var selectors = [
      "textarea[placeholder*='message']",
      "textarea[placeholder*='Message']",
      "textarea[placeholder*='Ask']",
      "textarea[placeholder*='ask']",
      "textarea[placeholder*='Agent']",
      "textarea[placeholder*='agent']",
      "div[contenteditable='true'][role='textbox']",
      "textarea"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function findReplitSendButton() {
    var selectors = [
      "button[aria-label='Send']",
      "button[aria-label='Send message']",
      "button[title*='Send']",
      "button[type='submit']",
      "button svg"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && !el.disabled) {
        if (el.tagName === "svg") {
          var btn = el.closest("button");
          if (btn && !btn.disabled) return btn;
        } else {
          return el;
        }
      }
    }
    return null;
  }

  function setReplitComposerText(editor, text) {
    editor.focus();
    var tag = (editor.tagName || "").toLowerCase();
    if (tag === "textarea") {
      var proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
      var setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    try {
      editor.textContent = "";
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    } catch (e) {
      editor.textContent = text;
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function sendNativeToReplit(text) {
    var editor = findReplitInput();
    if (!editor) {
      throw new Error("Replit chat input not found. Open your Repl on replit.com and wait for the workspace to load.");
    }
    setReplitComposerText(editor, text);
    await new Promise(function (r) { setTimeout(r, 120); });
    var sendBtn = findReplitSendButton();
    if (sendBtn) {
      sendBtn.click();
      return;
    }
    editor.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true
    }));
  }

  async function deliverPromptToReplit(text) {
    var ensureLicense = pkLicenseGuard();
    if (typeof ensureLicense === "function") {
      await ensureLicense(false);
    } else if (!(typeof INTERNAL_LICENSE_MODE !== "undefined" && INTERNAL_LICENSE_MODE)) {
      throw new Error("License guard not loaded. Refresh your Replit tab, then try again.");
    }
    await sendNativeToReplit(text);
  }

  window.__pkDeliverPrompt = deliverPromptToReplit;

  // Repl project sync from URL pathname (e.g. /@username/repl-name)
  function syncReplitProject() {
    try {
      var path = window.location.pathname;
      var match = path.match(/^\/(@[^\/]+\/[^\/]+)/i);
      if (match) {
        var replId = match[1];
        chrome.storage.local.get(["replit_projectId"], function (res) {
          if (res.replit_projectId !== replId) {
            chrome.storage.local.set({ replit_projectId: replId });
          }
        });
      }
    } catch (e) {}
  }
  syncReplitProject();
  setInterval(syncReplitProject, 5000);

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.action === "ping") {
      sendResponse({ ok: true, bridge: true, platform: "replit" });
      return false;
    }
    if (msg && msg.action === "qlSendViaWs") {
      deliverPromptToReplit(msg.message || "")
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (err) { sendResponse({ ok: false, error: err.message || String(err) }); });
      return true;
    }
    if (msg && msg.action === "resolvePlatformAuth") {
      sendResponse({
        ok: true,
        platform: "replit",
        ready: !!findReplitInput()
      });
      return false;
    }
  });
})();
