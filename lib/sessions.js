/* Staff sessions: every login gets its own signed token with an expiry, so a
   leaked cookie stops working on its own and a device can be signed out.

   Token: v1.<sessionId>.<expiresAt ms>.<issuedAt ms>.<hmac>
   Sign-outs are stored in a small JSON file so they survive a restart:
   { "notBefore": <ms>, "revoked": { "<sessionId>": <expiresAt ms> } } */

const crypto = require('crypto');
const fs = require('fs');

function createSessionStore({ secret, ttlMs, file, now = Date.now }) {
  let state = load();

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const revoked = data.revoked && typeof data.revoked === 'object' ? data.revoked : {};
      return { notBefore: Number(data.notBefore) || 0, revoked };
    } catch {
      return { notBefore: 0, revoked: {} };
    }
  }

  function pruneExpired() {
    const t = now();
    const revoked = Object.fromEntries(Object.entries(state.revoked).filter(([, exp]) => exp > t));
    state = { ...state, revoked };
  }

  function save() {
    pruneExpired();
    try {
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    } catch (e) {
      console.error('Sessions could not be saved:', e.message);
    }
  }

  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  function issue() {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const issuedAt = now();
    const payload = `v1.${sessionId}.${issuedAt + ttlMs}.${issuedAt}`;
    return `${payload}.${sign(payload)}`;
  }

  function hasValidSignature(payload, signature) {
    const expected = Buffer.from(sign(payload), 'hex');
    const given = Buffer.from(signature || '', 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  /** Returns { sessionId, expiresAt } for a valid token, otherwise null. */
  function verify(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') return null;
    if (!hasValidSignature(parts.slice(0, 4).join('.'), parts[4])) return null;
    const [, sessionId, expiresAtText, issuedAtText] = parts;
    const expiresAt = Number(expiresAtText);
    const issuedAt = Number(issuedAtText);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) return null;
    if (!Number.isFinite(issuedAt) || issuedAt < state.notBefore) return null;
    if (state.revoked[sessionId]) return null;
    return { sessionId, expiresAt };
  }

  function revoke(session) {
    state = { ...state, revoked: { ...state.revoked, [session.sessionId]: session.expiresAt } };
    save();
  }

  /** Ends every session issued before now ("sign out all other devices"). */
  function revokeAllBefore() {
    state = { ...state, notBefore: now() };
    save();
  }

  return { issue, verify, revoke, revokeAllBefore };
}

module.exports = { createSessionStore };
