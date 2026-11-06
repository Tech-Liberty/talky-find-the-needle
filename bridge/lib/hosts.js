// Outgoing "http" steps may only reach the hosts listed in bridge/config.json
// ("httpAllowedHosts"). talky_config.json lives in Zomboid/Lua, a folder every other
// mod can write to: without this list, any mod could add an http step and use the
// bridge to send data anywhere (internet or local network).

'use strict';

const DEFAULT_HTTP_ALLOWED_HOSTS = ['*.liberty-talk.com'];

// Entries: "api.example.com" (exact host), "*.example.com" (any subdomain, at any
// depth, but not example.com itself), "example.com:8443" (host and port), "*" (any host).
function normalizeEntry(entry) {
  return String(entry ?? '').trim().toLowerCase().replace(/\.$/, '');
}

function hostMatches(entry, url) {
  const e = normalizeEntry(entry);
  if (!e) return false;
  if (e === '*') return true;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  // An entry with a port is compared with host:port
  const target = /:\d+$/.test(e) ? `${hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}` : hostname;
  if (e.startsWith('*.')) {
    const suffix = e.slice(1); // ".example.com" or ".example.com:443"
    return target.endsWith(suffix) && target.length > suffix.length;
  }
  return target === e;
}

// Returns { ok: true, url } or { ok: false, reason }.
function checkHttpUrl(rawUrl, allowedHosts) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return { ok: false, reason: `invalid URL "${rawUrl}"` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `protocol "${url.protocol}" is not allowed` };
  }
  const list = Array.isArray(allowedHosts) ? allowedHosts : DEFAULT_HTTP_ALLOWED_HOSTS;
  if (!list.some((entry) => hostMatches(entry, url))) {
    return { ok: false, reason: `host "${url.host}" is not in httpAllowedHosts (bridge/config.json)` };
  }
  return { ok: true, url };
}

module.exports = { DEFAULT_HTTP_ALLOWED_HOSTS, hostMatches, checkHttpUrl };
