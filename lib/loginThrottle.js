/* Throttles password guessing per client. Behind the Cloudflare tunnel every
   request arrives from cloudflared on localhost, so the real client address
   comes from CF-Connecting-IP — trusted only when the request itself comes
   from localhost, so a direct LAN client can't fake it. */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_TRACKED_CLIENTS = 10000;

function createLoginThrottle({ maxFailures = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const failures = new Map(); // client → { count, since }

  function clientKey(req) {
    const remote = req.socket.remoteAddress || 'unknown';
    const forwarded = req.headers['cf-connecting-ip'];
    if (LOOPBACK.has(remote) && typeof forwarded === 'string' && forwarded) return forwarded;
    return remote;
  }

  function activeEntry(key) {
    const entry = failures.get(key);
    if (!entry) return null;
    if (now() - entry.since > windowMs) {
      failures.delete(key);
      return null;
    }
    return entry;
  }

  /** Seconds until the client may try again, or 0 if it isn't blocked. */
  function blockedForSeconds(key) {
    const entry = activeEntry(key);
    if (!entry || entry.count < maxFailures) return 0;
    return Math.max(1, Math.ceil((entry.since + windowMs - now()) / 1000));
  }

  function pruneExpired() {
    for (const [key, entry] of failures) {
      if (now() - entry.since > windowMs) failures.delete(key);
    }
  }

  function recordFailure(key) {
    const entry = activeEntry(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    if (failures.size >= MAX_TRACKED_CLIENTS) pruneExpired();
    failures.set(key, { count: 1, since: now() });
  }

  function reset(key) {
    failures.delete(key);
  }

  return { clientKey, blockedForSeconds, recordFailure, reset };
}

module.exports = { createLoginThrottle };
