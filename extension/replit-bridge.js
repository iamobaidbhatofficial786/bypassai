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
    // 1. Check all textareas, inputs and divs for Replit Agent placeholders
    var candidates = document.querySelectorAll("textarea, input, div[contenteditable='true']");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      
      // Filter out code editors
      var className = String(el.className || "").toLowerCase();
      var id = String(el.id || "").toLowerCase();
      if (className.includes("monaco") || className.includes("cm-") || className.includes("editor") || className.includes("inputarea")) {
        continue;
      }
      
      var placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
      var label = (el.getAttribute("aria-label") || "").toLowerCase();
      var title = (el.getAttribute("title") || "").toLowerCase();
      
      if (placeholder.includes("make") || placeholder.includes("test") || placeholder.includes("iterate") || 
          placeholder.includes("ask") || placeholder.includes("agent") || placeholder.includes("message") ||
          label.includes("make") || label.includes("ask") || label.includes("prompt") ||
          title.includes("make") || title.includes("ask")) {
        return el;
      }
    }

    // 2. Try specific selectors with placeholders
    var selectors = [
      "textarea[placeholder*='Make']",
      "textarea[placeholder*='make']",
      "textarea[placeholder*='test']",
      "textarea[placeholder*='iterate']",
      "div[placeholder*='Make']",
      "div[placeholder*='make']",
      "textarea[placeholder*='Ask']",
      "textarea[placeholder*='ask']",
      "div[placeholder*='Ask']",
      "div[placeholder*='ask']",
      "textarea[placeholder*='message']",
      "textarea[placeholder*='Message']",
      "div[placeholder*='message']",
      "div[placeholder*='Message']"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }

    // 3. Fallback: find a textarea or input that is likely the chat input (not the code editor)
    var textareas = document.querySelectorAll("textarea, input");
    for (var i = 0; i < textareas.length; i++) {
      var ta = textareas[i];
      var className = String(ta.className || "").toLowerCase();
      if (!className.includes("monaco") && !className.includes("cm-") && !className.includes("editor") && !className.includes("inputarea")) {
        var rect = ta.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return ta;
        }
      }
    }

    return null;
  }

  function findReplitSendButton() {
    var input = findReplitInput();
    if (input) {
      // 1. Look for a button inside the same parent container
      var container = input.closest("div");
      for (var depth = 0; depth < 4 && container; depth++) {
        var buttons = container.querySelectorAll("button");
        var bestBtn = null;
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          if (btn.disabled) continue;
          
          var html = String(btn.outerHTML).toLowerCase();
          var aria = (btn.getAttribute("aria-label") || "").toLowerCase();
          var title = (btn.getAttribute("title") || "").toLowerCase();
          var text = (btn.textContent || "").toLowerCase();
          
          // Specific send/submit matching (highest priority)
          if (aria.includes("send") || title.includes("send") || text.includes("send") || 
              aria.includes("submit") || title.includes("submit") || 
              html.includes("arrowup") || html.includes("arrow-up") || html.includes("send-icon")) {
            return btn;
          }
          
          // Fallback candidates: buttons with SVGs that are NOT upload (+), mic, or chevron (Economy dropdown)
          var svg = btn.querySelector("svg");
          if (svg) {
            var isUpload = html.includes("plus") || html.includes("add") || html.includes("upload") || aria.includes("upload") || title.includes("upload") || html.includes("attach");
            var isMic = html.includes("mic") || html.includes("audio") || html.includes("voice") || aria.includes("voice") || title.includes("voice") || html.includes("speech");
            var isDropdown = html.includes("chevron") || html.includes("down") || html.includes("economy") || aria.includes("select") || title.includes("select");
            var isPlan = html.includes("plan") || aria.includes("plan") || title.includes("plan");
            
            if (!isUpload && !isMic && !isDropdown && !isPlan) {
              bestBtn = btn;
            }
          }
        }
        if (bestBtn) return bestBtn;
        container = container.parentElement;
      }
    }

    // 2. Global selectors fallback (excluding common controls)
    var selectors = [
      "button[aria-label*='Send']",
      "button[aria-label*='send']",
      "button[aria-label*='Submit']",
      "button[aria-label*='submit']",
      "button[title*='Send']",
      "button[title*='send']",
      "button[type='submit']"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && !el.disabled) {
        return el;
      }
    }
    return null;
  }

  function triggerClick(element) {
    if (!element) return;
    try {
      element.focus();
      element.click();
    } catch (e) {}
    try {
      var mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window });
      var mouseup = new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window });
      var click = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
      element.dispatchEvent(mousedown);
      element.dispatchEvent(mouseup);
      element.dispatchEvent(click);
    } catch (e) {}
  }

  function triggerEnterKey(element) {
    if (!element) return;
    try {
      element.focus();
    } catch(e) {}
    var events = ["keydown", "keypress", "keyup"];
    for (var i = 0; i < events.length; i++) {
      try {
        var ev = new KeyboardEvent(events[i], {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        element.dispatchEvent(ev);
      } catch (e) {}
    }
  }

  function setReplitComposerText(editor, text) {
    editor.focus();
    var tag = (editor.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") {
      var proto = (tag === "textarea" ? window.HTMLTextAreaElement : window.HTMLInputElement) && (tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
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
    await new Promise(function (r) { setTimeout(r, 150); });
    var sendBtn = findReplitSendButton();
    if (sendBtn) {
      triggerClick(sendBtn);
      return;
    }
    triggerEnterKey(editor);
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
