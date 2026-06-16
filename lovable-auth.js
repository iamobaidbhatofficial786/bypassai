/**
 * Shared Lovable session helpers (Firebase token + project tab URL).
 * Loaded in content scripts and side panel after extension-config.js.
 */

function scanFirebaseAccessToken() {
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i) || "";
      if (k.indexOf("firebase") === -1) continue;
      var raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        var data = JSON.parse(raw);
        if (data && data.stsTokenManager && data.stsTokenManager.accessToken) {
          return String(data.stsTokenManager.accessToken).replace(/^Bearer\s+/i, "").trim();
        }
        if (data && data.accessToken) {
          return String(data.accessToken).replace(/^Bearer\s+/i, "").trim();
        }
      } catch (e) {}
    }
  } catch (e) {}
  return "";
}

function lovableProjectIdFromUrl(url) {
  if (!url) return "";
  var m = String(url).match(/\/projects\/([0-9a-fA-F-]{36})/i);
  return m ? m[1] : "";
}

function isValidLovableProjectId(projectId) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(projectId || ""));
}

function pickLovableApiToken(firebaseToken, storedToken, cookieToken) {
  if (typeof pickBestToken === "function") {
    var api = pickBestToken([storedToken, cookieToken].filter(Boolean));
    if (api) return api;
  }
  var stored = String(storedToken || "").replace(/^Bearer\s+/i, "").trim();
  if (stored) return stored;
  var cookie = String(cookieToken || "").replace(/^Bearer\s+/i, "").trim();
  if (cookie) return cookie;
  return String(firebaseToken || "").replace(/^Bearer\s+/i, "").trim();
}
