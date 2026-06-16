/**
 * Platform registry — Lovable + ChatGPT share the same side panel and license shell.
 */
var PLATFORMS = {
  lovable: {
    id: "lovable",
    label: "Lovable",
    tabUrls: ["*://lovable.dev/*", "*://*.lovable.dev/*"],
    bridgeFiles: [
      "extension-config.js",
      "platform-config.js",
      "hwFingerprint.js",
      "license-guard.js",
      "user-messages.js",
      "content-bridge.js"
    ],
    needsProjectSync: true,
    lovableFeatures: true
  },
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    tabUrls: ["*://chatgpt.com/*", "*://*.chatgpt.com/*", "*://chat.openai.com/*"],
    bridgeFiles: [
      "extension-config.js",
      "platform-config.js",
      "hwFingerprint.js",
      "license-guard.js",
      "user-messages.js",
      "chatgpt-bridge.js"
    ],
    needsProjectSync: false,
    lovableFeatures: false
  },
  replit: {
    id: "replit",
    label: "Replit",
    tabUrls: ["*://replit.com/*", "*://*.replit.com/*"],
    bridgeFiles: [
      "extension-config.js",
      "platform-config.js",
      "hwFingerprint.js",
      "license-guard.js",
      "user-messages.js",
      "replit-bridge.js"
    ],
    needsProjectSync: true,
    lovableFeatures: false
  }
};

function pkPlatformFromUrl(url) {
  var u = String(url || "").toLowerCase();
  if (!u) return null;
  if (u.indexOf("lovable.dev") !== -1) return "lovable";
  if (u.indexOf("chatgpt.com") !== -1 || u.indexOf("chat.openai.com") !== -1) return "chatgpt";
  if (u.indexOf("replit.com") !== -1) return "replit";
  return null;
}

function pkGetPlatform(id) {
  return PLATFORMS[id] || PLATFORMS.lovable;
}

function pkAllPlatformTabUrls() {
  var urls = [];
  Object.keys(PLATFORMS).forEach(function (id) {
    var p = PLATFORMS[id];
    if (p && p.tabUrls) urls = urls.concat(p.tabUrls);
  });
  return urls;
}
