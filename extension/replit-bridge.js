/**
 * Replit page bridge — handles prompt delivery and workspace repl project sync.
 */
(function () {
  if (window.__pkReplitBridgeReady) return;
  window.__pkReplitBridgeReady = true;

  function pkLicenseGuard() {
    return window.pkEnsureActiveLicense || (typeof pkEnsureActiveLicense === "function" ? pkEnsureActiveLicense : null);
  }

  function isValidTextInput(el) {
    if (!el) return false;
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (el.isContentEditable) return true;
    if (tag === "input") {
      var type = String(el.getAttribute("type") || "text").toLowerCase();
      var badTypes = ["radio", "checkbox", "button", "submit", "hidden", "file", "image", "range", "color"];
      return !badTypes.includes(type);
    }
    return false;
  }

  function isInsideModal(el) {
    var parent = el.parentElement;
    while (parent) {
      var role = String(parent.getAttribute("role") || "").toLowerCase();
      var className = String(parent.className || "").toLowerCase();
      var id = String(parent.id || "").toLowerCase();
      var dataTestId = String(parent.getAttribute("data-testid") || "").toLowerCase();
      
      if (role === "dialog" || role === "alertdialog" || role === "modal" ||
          className.includes("modal") || className.includes("dialog") || 
          className.includes("popup") || className.includes("overlay") ||
          id.includes("modal") || id.includes("dialog") ||
          dataTestId.includes("modal") || dataTestId.includes("dialog")) {
        return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  function findReplitInput() {
    console.log("[Replit Bridge] Scanning for Replit chat/agent input elements...");
    
    var textKeywords = ["make, test, iterate", "make, test", "iterate...", "ask a question", "ask agent", "describe your idea", "describe what you want", "what do you want to build", "what do you want to create"];
    
    // 1. Scan candidates (textarea, input, contenteditable)
    var candidates = document.querySelectorAll("textarea, input, [contenteditable]");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isValidTextInput(el)) continue;
      if (isInsideModal(el)) continue; // Bypass inputs inside modals/overlays (e.g. Publish modals)
      
      var placeholder = "";
      try {
        placeholder = el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("aria-placeholder") || "";
        
        // If placeholder is not directly on the element, search the parent container
        if (!placeholder) {
          var parent = el.parentElement;
          for (var depth = 0; depth < 5 && parent; depth++) {
            // Check for CodeMirror placeholder class
            var phEl = parent.querySelector(".cm-placeholder, [class*='placeholder']");
            if (phEl) {
              placeholder = phEl.textContent || "";
              break;
            }
            
            // Check if any visual text in the container matches our keywords
            var containerText = (parent.textContent || "").trim().toLowerCase();
            for (var k = 0; k < textKeywords.length; k++) {
              if (containerText.includes(textKeywords[k])) {
                placeholder = textKeywords[k];
                break;
              }
            }
            if (placeholder) break;
            parent = parent.parentElement;
          }
        }
      } catch (e) {}
      
      placeholder = String(placeholder || "").toLowerCase();
      var label = String(el.getAttribute("aria-label") || "").toLowerCase();
      var title = String(el.getAttribute("title") || "").toLowerCase();
      var className = String(el.className || "").toLowerCase();
      
      var hasAgentKeywords = placeholder.includes("make") || placeholder.includes("test") || placeholder.includes("iterate") || 
          placeholder.includes("ask") || placeholder.includes("agent") || placeholder.includes("message") || placeholder.includes("describe") || placeholder.includes("build") || placeholder.includes("create") ||
          label.includes("make") || label.includes("ask") || label.includes("prompt") || label.includes("describe") || label.includes("build") || label.includes("create") ||
          title.includes("make") || title.includes("ask") || title.includes("describe") || title.includes("build") || title.includes("create");

      if (hasAgentKeywords) {
        console.log("[Replit Bridge] SUCCESS: Matched Replit input with keywords:", el);
        return el;
      }
    }

    // 2. Fallback: find a textarea or input that is likely the chat input
    var textareas = document.querySelectorAll("textarea, input");
    for (var i = 0; i < textareas.length; i++) {
      var ta = textareas[i];
      if (!isValidTextInput(ta)) continue;
      if (isInsideModal(ta)) continue; // Bypass modal textareas
      var className = String(ta.className || "").toLowerCase();
      if (!className.includes("monaco") && !className.includes("cm-") && !className.includes("editor") && !className.includes("inputarea")) {
        var rect = ta.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          console.log("[Replit Bridge] SUCCESS: Selected fallback textarea/input:", ta);
          return ta;
        }
      }
    }

    // 3. Fallback: find any contenteditable element that is likely the chat panel input (small height)
    var editables = document.querySelectorAll("[contenteditable]");
    for (var i = 0; i < editables.length; i++) {
      var ed = editables[i];
      if (!isValidTextInput(ed)) continue;
      if (isInsideModal(ed)) continue; // Bypass modal editables
      var className = String(ed.className || "").toLowerCase();
      if (!className.includes("monaco") && !className.includes("editor") && !className.includes("inputarea")) {
        var rect = ed.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.height < 150) {
          console.log("[Replit Bridge] SUCCESS: Selected fallback contenteditable element:", ed);
          return ed;
        }
      }
    }

    console.warn("[Replit Bridge] WARNING: No matching Replit input element found on page.");
    return null;
  }

  function findReplitSendButton() {
    var input = findReplitInput();
    if (input) {
      console.log("[Replit Bridge] Scanning for send button relative to input element...");
      // 1. Look for a button inside the same parent container
      var container = input.closest("div");
      for (var depth = 0; depth < 5 && container; depth++) {
        var buttons = container.querySelectorAll("button");
        console.log("[Replit Bridge] Depth " + depth + ": found " + buttons.length + " buttons inside container:", container);
        var bestBtn = null;
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          if (btn.disabled) continue;
          
          var html = String(btn.outerHTML).toLowerCase();
          var aria = (btn.getAttribute("aria-label") || "").toLowerCase();
          var title = (btn.getAttribute("title") || "").toLowerCase();
          var text = (btn.textContent || "").toLowerCase();
          
          console.log("[Replit Bridge] Button candidate [" + i + "]: text='" + text + "', label='" + aria + "', title='" + title + "'");

          // Specific send/submit matching (highest priority)
          if (aria.includes("send") || title.includes("send") || text.includes("send") || 
              aria.includes("submit") || title.includes("submit") || 
              html.includes("arrowup") || html.includes("arrow-up") || html.includes("send-icon")) {
            console.log("[Replit Bridge] SUCCESS: Matched send button keywords:", btn);
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
        if (bestBtn) {
          console.log("[Replit Bridge] SUCCESS: Selected fallback SVG button:", bestBtn);
          return bestBtn;
        }
        container = container.parentElement;
      }
    }

    // 2. Global selectors fallback (excluding common controls)
    console.log("[Replit Bridge] Sending button not found in input container. Scanning globally...");
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
        console.log("[Replit Bridge] SUCCESS: Matched global selector send button:", selectors[i], el);
        return el;
      }
    }
    
    console.warn("[Replit Bridge] WARNING: No send button matched. Fallback to Enter key will be used.");
    return null;
  }

  function triggerClick(element) {
    if (!element) return;
    console.log("[Replit Bridge] Simulating clicks on button:", element);
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
    console.log("[Replit Bridge] Simulating Enter key presses on input element:", element);
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

  function setContenteditableText(editor, text) {
    editor.focus();
    
    // Clear existing content safely by dispatching delete selection
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch(e) {}
    
    // Dispatch beforeinput event (crucial for CodeMirror 6)
    try {
      var beforeInputEvent = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text
      });
      editor.dispatchEvent(beforeInputEvent);
      console.log("[Replit Bridge] Dispatched beforeinput event.");
    } catch(e) {
      console.warn("[Replit Bridge] beforeinput event failed:", e);
    }
    
    // Fallback: execCommand insertText
    try {
      document.execCommand("insertText", false, text);
      console.log("[Replit Bridge] Text set via execCommand. Content:", editor.textContent);
    } catch (e) {
      console.warn("[Replit Bridge] execCommand insertText fallback failed:", e);
    }
    
    // Dispatch input event
    try {
      var inputEvent = new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text
      });
      editor.dispatchEvent(inputEvent);
      console.log("[Replit Bridge] Dispatched input event.");
    } catch(e) {}
    
    // Direct DOM text assignment if all else failed (last resort)
    var currentText = editor.textContent || "";
    if (currentText.trim() !== text.trim()) {
      try {
        editor.innerHTML = "";
        editor.textContent = text;
        console.log("[Replit Bridge] Content set via textContent fallback.");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) {
        console.warn("[Replit Bridge] textContent update failed:", e);
      }
    }
  }

  function setReplitComposerText(editor, text) {
    console.log("[Replit Bridge] setReplitComposerText targeting element:", editor, "with text length:", text.length);
    editor.focus();
    var tag = (editor.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") {
      var proto = (tag === "textarea" ? window.HTMLTextAreaElement : window.HTMLInputElement) && (tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
      var setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      console.log("[Replit Bridge] Text set successfully on form input field.");
      return;
    }
    
    setContenteditableText(editor, text);
  }

  async function sendNativeToReplit(text) {
    console.log("[Replit Bridge] sendNativeToReplit started.");
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
