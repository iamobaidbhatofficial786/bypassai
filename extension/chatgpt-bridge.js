/**
 * ChatGPT page bridge — injects prompts into the ChatGPT composer.
 */
(function () {
  if (window.__pkChatgptBridgeReady) return;
  window.__pkChatgptBridgeReady = true;

  function pkLicenseGuard() {
    return window.pkEnsureActiveLicense || (typeof pkEnsureActiveLicense === "function" ? pkEnsureActiveLicense : null);
  }

  function findChatInput() {
    var selectors = [
      "#prompt-textarea",
      "textarea#prompt-textarea",
      "div#prompt-textarea[contenteditable='true']",
      "div.ProseMirror[contenteditable='true']",
      "textarea[data-id='root']",
      "textarea[placeholder*='Message']",
      "textarea[placeholder*='message']",
      "div[contenteditable='true'][data-placeholder]"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function findSendButton() {
    var selectors = [
      "button[data-testid='send-button']",
      "button[data-testid='composer-send-button']",
      "button[aria-label='Send prompt']",
      "button[aria-label='Send message']",
      "button[aria-label='Send']"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && !el.disabled) return el;
    }
    return null;
  }

  function setComposerText(editor, text) {
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

  async function sendNativeToChatGPT(text) {
    var editor = findChatInput();
    if (!editor) {
      throw new Error("ChatGPT input not found. Open a chat at chatgpt.com and wait for the page to load.");
    }
    setComposerText(editor, text);
    await new Promise(function (r) { setTimeout(r, 120); });
    var sendBtn = findSendButton();
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

  async function deliverPromptToChatGPT(text) {
    var ensureLicense = pkLicenseGuard();
    if (typeof ensureLicense === "function") {
      await ensureLicense(false);
    } else if (!(typeof INTERNAL_LICENSE_MODE !== "undefined" && INTERNAL_LICENSE_MODE)) {
      throw new Error("License guard not loaded. Refresh your ChatGPT tab, then try again.");
    }
    await sendNativeToChatGPT(text);
  }

  window.__pkDeliverPrompt = deliverPromptToChatGPT;

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.action === "ping") {
      sendResponse({ ok: true, bridge: true, platform: "chatgpt" });
      return false;
    }
    if (msg && msg.action === "qlSendViaWs") {
      deliverPromptToChatGPT(msg.message || "")
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (err) { sendResponse({ ok: false, error: err.message || String(err) }); });
      return true;
    }
    if (msg && msg.action === "resolvePlatformAuth") {
      sendResponse({
        ok: true,
        platform: "chatgpt",
        ready: !!findChatInput()
      });
      return false;
    }
  });
})();
