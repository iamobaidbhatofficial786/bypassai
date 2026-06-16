/**
 * Lovable Powerkits — license enforcement (client).
 * Requires an active PK- license validated by lov.powerkits.net before protected actions.
 */
(function () {
  var ASSERT_TTL_MS = 30000;
  var _assertCache = { at: 0, allowed: false };

  function pkApiBase() {
    if (typeof POWERKITS_LICENSE_API_BASE !== "undefined" && POWERKITS_LICENSE_API_BASE) {
      return POWERKITS_LICENSE_API_BASE;
    }
    return typeof POWERKITS_API_BASE !== "undefined" ? POWERKITS_API_BASE : "https://lov.powerkits.net";
  }

  function pkApiKey() {
    return typeof POWERKITS_API_KEY !== "undefined" ? POWERKITS_API_KEY : "";
  }

  function pkAssertSessionUrl() {
    return pkApiBase() + "/functions/v1/assert-session";
  }

  function pkLicenseHeaders(extra) {
    var h = typeof powerkitsApiHeaders === "function"
      ? powerkitsApiHeaders({ "Content-Type": "application/json" })
      : { apikey: pkApiKey(), "Content-Type": "application/json" };
    return Object.assign({}, h, extra || {});
  }

  function pkProxyFetch(url, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({
        action: "proxyFetch",
        url: url,
        method: options.method || "POST",
        headers: options.headers || {},
        body: options.body || null
      }, function (resp) {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!resp) {
          return reject(new Error("No response from background. Reload the extension."));
        }
        if (!resp.ok) {
          var errText = (resp.data && (resp.data.message || resp.data.error || resp.data.error_display))
            || (resp.data && resp.data.raw)
            || ("Request failed (HTTP " + resp.status + ")");
          return reject(new Error(errText));
        }
        resolve(resp.data || {});
      });
    });
  }

  function pkInvalidateAssertCache() {
    _assertCache = { at: 0, allowed: false };
  }

  function pkReadLicenseStorage() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(
        ["ql_license_valid", "ql_license_key", "ql_session_id"],
        function (res) {
          resolve(res || {});
        }
      );
    });
  }

  function pkResolveDeviceId() {
    if (typeof getHardwareFingerprint === "function") {
      return getHardwareFingerprint();
    }
    return Promise.resolve("");
  }

  function pkLocalLicenseReady(stored) {
    if (typeof INTERNAL_LICENSE_MODE !== "undefined" && INTERNAL_LICENSE_MODE) {
      return true;
    }
    if (!stored || !stored.ql_license_valid) return false;
    if (typeof resolveTeamLicenseKey !== "function") return false;
    var key = resolveTeamLicenseKey(stored.ql_license_key);
    if (!key) return false;
    if (key === "INTERNAL") return true;
    if (!stored.ql_session_id) return false;
    return true;
  }

  function pkRevokeLicenseStorage() {
    pkInvalidateAssertCache();
    if (typeof window.__pkSetCreditBypass === "function") {
      window.__pkSetCreditBypass(false);
    }
    return new Promise(function (resolve) {
      if (typeof pkSafeClearLicenseStorage === "function") {
        pkSafeClearLicenseStorage(resolve);
      } else {
        chrome.storage.local.remove([
          "ql_license_valid",
          "ql_license_key",
          "ql_session_id",
          "ql_user_name",
          "ql_expires_at",
          "ql_activated_at",
          "ql_license_status",
          "ql_validity_minutes"
        ], resolve);
      }
    });
  }

  /**
   * @returns {{ lock: boolean, conflictCount: number, message?: string }}
   */
  function pkShouldLockoutFromValidation(data, conflictCount) {
    if (!data || data.valid) {
      return { lock: false, conflictCount: 0 };
    }
    if (data.reason === "device_conflict") {
      conflictCount = (conflictCount || 0) + 1;
      if (conflictCount < 2) {
        return { lock: false, conflictCount: conflictCount };
      }
    }
    return {
      lock: true,
      conflictCount: conflictCount || 0,
      message: data.message || "License not active. Activate your PK- key in the side panel.",
      reason: data.reason || null
    };
  }

  /**
   * Server confirmation that PK- license + session are still active.
   * @param {boolean} force
   */
  function pkEnsureActiveLicense(force) {
    if (typeof INTERNAL_LICENSE_MODE !== "undefined" && INTERNAL_LICENSE_MODE) {
      return Promise.resolve({ allowed: true, valid: true, status: "active", expires_at: null });
    }

    var now = Date.now();
    if (!force && _assertCache.allowed && (now - _assertCache.at) < ASSERT_TTL_MS) {
      return Promise.resolve({ allowed: true, cached: true });
    }

    return pkReadLicenseStorage().then(function (stored) {
      if (!pkLocalLicenseReady(stored)) {
        return pkRevokeLicenseStorage().then(function () {
          throw new Error("Activate your PK- license key first.");
        });
      }

      var licenseKey = resolveTeamLicenseKey(stored.ql_license_key);
      if (licenseKey === "INTERNAL") {
        _assertCache = { at: Date.now(), allowed: true };
        return { allowed: true, valid: true, status: "active", expires_at: null };
      }
      if (typeof isDevLicenseKey === "function" && isDevLicenseKey(licenseKey)) {
        _assertCache = { at: Date.now(), allowed: true };
        var devData = mockDevLicenseResponse(licenseKey, {
          session_id: stored.ql_session_id || "",
          device_id: ""
        });
        if (typeof pkLicenseStoragePatch === "function" && (devData.expires_at || devData.validity_minutes != null)) {
          chrome.storage.local.set(pkLicenseStoragePatch(devData));
        }
        return devData;
      }
      return pkResolveDeviceId().then(function (deviceId) {
        return pkProxyFetch(pkAssertSessionUrl(), {
          method: "POST",
          headers: pkLicenseHeaders(),
          body: JSON.stringify({
            license_key: licenseKey,
            session_id: stored.ql_session_id || "",
            device_id: deviceId || "",
            heartbeat: true
          })
        }).then(function (data) {
          if (data && data.allowed) {
            _assertCache = { at: Date.now(), allowed: true };
            if (typeof pkLicenseStoragePatch === "function" && (data.expires_at || data.validity_minutes != null)) {
              chrome.storage.local.set(pkLicenseStoragePatch(data));
            }
            return data;
          }
          if (typeof pkInvalidateAssertCache === "function") {
            pkInvalidateAssertCache();
          }
          var msg = (data && data.message) || "License not active.";
          var err = new Error(msg);
          err.pkReason = (data && data.reason) || "inactive";
          return pkRevokeLicenseStorage().then(function () {
            throw err;
          });
        });
      });
    });
  }

  /** Headers for storage upload (backend validates license). */
  function pkLicenseUploadHeaders(extra) {
    return pkReadLicenseStorage().then(function (stored) {
      if (!pkLocalLicenseReady(stored)) {
        throw new Error("Activate your PK- license key first.");
      }
      return pkResolveDeviceId().then(function (deviceId) {
        return pkEnsureActiveLicense(false).then(function () {
          return Object.assign({}, extra || {}, {
            "x-license-key": resolveTeamLicenseKey(stored.ql_license_key),
            "x-session-id": stored.ql_session_id || "",
            "x-device-id": deviceId || ""
          });
        });
      });
    });
  }

  window.pkInvalidateAssertCache = pkInvalidateAssertCache;
  window.pkEnsureActiveLicense = pkEnsureActiveLicense;
  window.pkRevokeLicenseStorage = pkRevokeLicenseStorage;
  window.pkShouldLockoutFromValidation = pkShouldLockoutFromValidation;
  window.pkLicenseUploadHeaders = pkLicenseUploadHeaders;
  window.pkLocalLicenseReady = pkLocalLicenseReady;
})();
