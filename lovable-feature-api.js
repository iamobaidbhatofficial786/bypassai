/**
 * Shared Lovable feature helpers (watermark, publish, cloud, create project).
 */
function pkSanitizeServerError(value) {
  if (value == null) return "";
  var s = String(value).trim();
  if (!s) return s;
  if (s.length > 200 && /<!DOCTYPE|<html|cloudflare|bad gateway|error code 502|error code 503/i.test(s)) {
    return "Service is temporarily unavailable. Try again in a few minutes.";
  }
  if (/^error code: 502$/i.test(s) || /^error code: 503$/i.test(s)) {
    return "Request timed out. Try again in a few minutes.";
  }
  if (/^Request failed \(HTTP 502\)$/i.test(s) || /^Request failed \(HTTP 503\)$/i.test(s)) {
    return "Service is temporarily unavailable. Try again in a few minutes.";
  }
  if (typeof translateUserMessage === "function") {
    return translateUserMessage(s);
  }
  return s;
}

function pkCreateProjectLink(data) {
  if (!data || data.success === false) return "";
  if (data.link) return String(data.link);
  if (data.url) return String(data.url);
  var id = data.project_id || data.id;
  if (id) return "https://lovable.dev/projects/" + String(id);
  return "";
}

function pkFeatureApiHeaders(extra) {
  return typeof powerkitsApiHeaders === "function"
    ? powerkitsApiHeaders(Object.assign({ "Content-Type": "application/json" }, extra || {}))
    : typeof gringowApiHeaders === "function"
      ? gringowApiHeaders(Object.assign({ "Content-Type": "application/json" }, extra || {}))
      : Object.assign({ apikey: typeof POWERKITS_API_KEY !== "undefined" ? POWERKITS_API_KEY : "" }, { "Content-Type": "application/json" }, extra || {});
}

/** Feature buttons: resolve JSON body even on HTTP 4xx (same UX as legacy store extension). */
function pkResolveFeatureBgFetch(resp) {
  if (!resp) {
    return { ok: false, error: "No response from background" };
  }
  var data = resp.data;
  if (data && typeof data === "object") {
    return { ok: true, data: data };
  }
  if (!resp.ok) {
    return { ok: false, error: "Fetch failed (" + resp.status + ")" };
  }
  return { ok: true, data: data };
}

function pkResolveVendorFeatureBgFetch(resp) {
  return pkResolveFeatureBgFetch(resp);
}

/** Edge request body: license_key, token_lovable, project_id */
function pkFeatureRequestBody(licenseKey, token, projectId, extra) {
  var body = {
    license_key: licenseKey || "",
    token_lovable: String(token || "").replace(/^Bearer\s+/i, "").trim()
  };
  if (projectId) {
    body.project_id = projectId;
  }
  return Object.assign(body, extra || {});
}

function pkVendorFeatureBody(licenseKey, token, projectId, extra) {
  return pkFeatureRequestBody(licenseKey, token, projectId, extra);
}
