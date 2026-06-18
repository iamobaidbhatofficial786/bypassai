(function () {
console.log("[PowerkitsHook] starting");

window.__qlLastMessage = "";
window.__qlFixTimer = null;

function applyQlBypassState(active) {
  try {
    if (active) document.documentElement.setAttribute("data-ql-bypass", "1");
    else document.documentElement.removeAttribute("data-ql-bypass");
  } catch (e) {}
}

function requestPromptValidation(prompt) {
  return new Promise((resolve) => {
    const requestId = "req_" + Math.random().toString(36).substring(2);
    function responseHandler(ev) {
      if (ev.source !== window || !ev.data) return;
      if (ev.data.type !== "lovablePromptValidationResult" || ev.data.requestId !== requestId) return;
      window.removeEventListener("message", responseHandler);
      resolve(ev.data.result);
    }
    window.addEventListener("message", responseHandler);
    window.postMessage({ type: "lovablePromptValidationRequest", requestId: requestId, prompt: prompt }, "*");
  });
}

function disableLovableChatbox() {
  try {
    const editor = document.querySelector('form#chat-input [contenteditable="true"]');
    if (editor) {
      editor.setAttribute("contenteditable", "false");
      editor.style.opacity = "0.5";
      editor.style.pointerEvents = "none";
    }
    const sendBtn = document.getElementById("chatinput-send-message-button");
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.style.opacity = "0.5";
    }
  } catch(e) {}
}

window.addEventListener("message", function(ev) {
  if (ev.source !== window || !ev.data) return;
  if (ev.data.type !== "qlBypassState") return;
  applyQlBypassState(!!ev.data.active);
});

try {
  if (localStorage.getItem("__ql_bypass_active") === "1") {
    applyQlBypassState(true);
  }
} catch (e) {}

let capturedToken = null;
let capturedProjectId = null;
let capturedBrowserSessionId = null;
let _qlWsSessions = [];

// ── WebSocket injection (native send — no proxy-command credits) ─────────────
window.addEventListener("message", function(ev) {
  if(ev.source !== window || !ev.data) return;
  if(ev.data.type !== "lovableSendViaWs") return;

  const open = _qlWsSessions.filter(s => s.ws.readyState === WebSocket.OPEN);
  if(!open.length) {
    window.postMessage({ type: "lovableWsSendResult", success: false, error: "No active WebSocket connection" }, "*");
    return;
  }
  const session = open[open.length - 1];
  try {
    const msg = typeof ev.data.payload === "string" ? ev.data.payload : JSON.stringify(ev.data.payload);
    session.origSend(msg);
    window.postMessage({ type: "lovableWsSendResult", success: true }, "*");
  } catch(e) {
    window.postMessage({ type: "lovableWsSendResult", success: false, error: e.message }, "*");
  }
});

function storeBrowserSessionId(id) {
  if (!id || typeof id !== "string" || !/^bsess_[A-Za-z0-9]+$/i.test(id)) return;
  if (id === capturedBrowserSessionId) return;
  capturedBrowserSessionId = id;
  try {
    if (typeof pkPageStorageSet === "function") pkPageStorageSet("browser_session_id", id);
    else localStorage.setItem("gringow_browser_session_id", id);
  } catch (e) {}
  window.postMessage({ type: "lovableBrowserSession", browserSessionId: id }, "*");
}

function readHeaderValue(headers, name) {
  if (!headers) return null;
  var lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name) || headers.get(lower);
  if (typeof headers === "object") {
    return headers[name] || headers[lower] || headers[name.toUpperCase()] || null;
  }
  return null;
}

function getProjectFromPage(){
  try{
    const m = window.location.pathname.match(/projects\/([0-9a-fA-F-]{36})/i);
    return m ? m[1] : null;
  }catch{ return null; }
}

function extractProjectIdFromUrl(url){
  try{
    const m = String(url).match(/projects\/([0-9a-fA-F-]{36})/i);
    return m ? m[1] : null;
  }catch{ return null; }
}

function captureChatRequest(method, url, body) {
  try {
    if (!url || String(method).toUpperCase() !== "POST") return;
    if (!/\/projects\/[0-9a-fA-F-]{36}\/chat/i.test(String(url))) return;
    var text = "";
    if (typeof body === "string") text = body;
    else if (body instanceof URLSearchParams) text = body.toString();
    else if (body && typeof body.text === "function") {
      body.clone().text().then(function(t) {
        storeChatCapture(String(url), t);
      }).catch(function(){});
      return;
    }
    if (text) storeChatCapture(String(url), text);
  } catch (e) {}
}

function storeChatCapture(url, text) {
  var parsed = null;
  try { parsed = JSON.parse(text); } catch (e) {}
  var summary = {
    url: url,
    captured_at: new Date().toISOString(),
    body_size: text.length,
    top_level_keys: parsed && typeof parsed === "object" ? Object.keys(parsed) : [],
    body_preview: text.slice(0, 4000)
  };
  try {
    var captureKey = "pk_last_native_chat_capture";
    localStorage.setItem(captureKey, JSON.stringify({
      summary: summary,
      body: text.slice(0, 200000)
    }));
  } catch (e) {}
  window.postMessage({ type: "lovableChatCaptured", summary: summary }, "*");
}

function notifyFound(token, projectId, force = false){
  const newProject = projectId || getProjectFromPage();
  const normalizedToken = typeof token === "string" ? token.replace(/^Bearer\s+/i, "").trim() : null;
  let changed = false;
  if(normalizedToken && normalizedToken !== capturedToken){ capturedToken = normalizedToken; changed = true; }
  if(newProject && newProject !== capturedProjectId){ capturedProjectId = newProject; changed = true; }
  if(!changed && !force) return;
  if(!normalizedToken && !capturedToken && !newProject) return;
  window.postMessage({ type:"lovableTokenFound", token:capturedToken, projectId:capturedProjectId },"*");
}

window.addEventListener("message", (event)=>{
  if(event.source !== window) return;
  if(!event.data || event.data.type !== "lovableRequestToken") return;
  notifyFound(capturedToken, getProjectFromPage() || capturedProjectId, true);
});

(function wrapFetch(){
  try{
    const originalFetch = window.fetch;
    window.fetch = async function(...args){
      try{
        let reqUrl = typeof args[0] === "string" ? args[0] : ((args[0] && args[0].url) || "");
        let opts = args[1] || {};
        let auth = null;
        if(args[0] instanceof Request){
          reqUrl = args[0].url || reqUrl;
          auth = (args[0].headers && typeof args[0].headers.get === "function") ? (args[0].headers.get("Authorization") || args[0].headers.get("authorization")) : null;
        }
        if(opts.headers){
          if(opts.headers instanceof Headers) auth = opts.headers.get("Authorization");
          else if(typeof opts.headers === "object") auth = opts.headers.Authorization || opts.headers.authorization;
        }
        storeBrowserSessionId(readHeaderValue(opts.headers, "X-Browser-Session-Id"));
        if (args[0] instanceof Request) {
          storeBrowserSessionId(readHeaderValue(args[0].headers, "X-Browser-Session-Id"));
        }
        const pid = extractProjectIdFromUrl(reqUrl);
        if(auth && auth.startsWith("Bearer ")){
          const rawToken = auth.slice(7);
          notifyFound(rawToken, pid);
        }
        var method = (opts.method || (args[0] instanceof Request ? args[0].method : "GET") || "GET");
        var body = opts.body;
        if (args[0] instanceof Request && !body) body = args[0].body;
        captureChatRequest(method, reqUrl, body);
      }catch(e){}
      try{
        const chatUrl = typeof args[0] === "string" ? args[0] : ((args[0] && args[0].url) || "");
        if(chatUrl.includes("api.lovable.dev") && chatUrl.includes("/chat")){
          const chatOpts = args[1] || {};
          const chatMethod = (chatOpts.method || "GET").toUpperCase();
          if(chatMethod === "POST" && chatOpts.body && typeof chatOpts.body === "string"){
            const body = JSON.parse(chatOpts.body);
            
            // Check prompt with Vercel backend check first
            const valResult = await requestPromptValidation(body.message || "");
            
            if (!valResult || !valResult.allowed) {
              alert(valResult.error || valResult.message || "Prompt blocked by Bypass Ai security rules.");
              disableLovableChatbox();
              throw new Error("Bypass Ai: Prompt rejected by license server.");
            }

            body.message = valResult.modified_prompt || body.message;

            if(document.documentElement.getAttribute("data-ql-bypass") === "1" && !body.intent){
              body.intent = "fix_error";
              body.message_intent_metadata = { fix_error_metadata: { errors: [] } };
            }
            
            args = [args[0], Object.assign({}, chatOpts, { body: JSON.stringify(body) })];
            window.__qlLastMessage = body.message || "";
            if (window.__qlFixTimer) clearInterval(window.__qlFixTimer);
            var _attempts = 0;
            window.__qlFixTimer = setInterval(function() {
              _attempts++;
              if (!window.__qlLastMessage || _attempts > 100) { clearInterval(window.__qlFixTimer); return; }
              document.querySelectorAll("div.special-message").forEach(function(el) {
                if (el.textContent.trim() === "Fix errors") el.textContent = window.__qlLastMessage;
              });
            }, 100);
          }
        }
      }catch(e){}
      return originalFetch.apply(this,args);
    };
  }catch(e){ console.warn("[PowerkitsHook] fetch error",e); }
})();

(function wrapXHR(){
  try{
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(method,url){
      this._lovable_url = url;
      this._lovable_method = method;
      return origOpen.apply(this,arguments);
    };
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body){
      try {
        captureChatRequest(this._lovable_method, this._lovable_url, body);
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(name,value){
      if(name && name.toLowerCase()==="authorization" && value && value.startsWith("Bearer ")){
        const rawToken = value.slice(7);
        notifyFound(rawToken, extractProjectIdFromUrl(this._lovable_url));
      }
      if (name && name.toLowerCase() === "x-browser-session-id" && value) {
        storeBrowserSessionId(String(value).trim());
      }
      return origSetHeader.apply(this,arguments);
    };
  }catch(e){ console.warn("[PowerkitsHook] xhr error",e); }
})();

try {
  var existingBsess = typeof pkPageStorageGet === "function" ? pkPageStorageGet("browser_session_id") : localStorage.getItem("gringow_browser_session_id");
  if (existingBsess) capturedBrowserSessionId = existingBsess;
} catch (e) {}

setInterval(()=>{
  const p = getProjectFromPage();
  if(p && p !== capturedProjectId){
    capturedProjectId = p;
    window.postMessage({ type:"lovableTokenFound", token:capturedToken, projectId:p },"*");
  }
},1500);

(function wrapWebSocket(){
  try{
    const OrigWS = window.WebSocket;
    window.WebSocket = function(url, protocols){
      const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      const urlStr = String(url);
      if(urlStr.includes("lovable") || urlStr.includes("trajectory")){
        const origSend = ws.send.bind(ws);
        _qlWsSessions = _qlWsSessions.filter(s => s.ws.readyState !== WebSocket.CLOSED);
        _qlWsSessions.push({ ws, origSend });
        window.postMessage({ type: "lovableWsConnected", url: urlStr.replace(/token=[^&]+/, "token=***") }, "*");
        ws.send = function(data){
          return origSend(data);
        };
      }
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  }catch(e){ console.warn("[PowerkitsHook] ws wrap error",e); }
})();

})();
