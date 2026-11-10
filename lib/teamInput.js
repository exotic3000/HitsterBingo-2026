/* Validation for what a team chooses when joining. Names and emojis are
   shown on the Beamer, moderator and overview screens, so only harmless
   values are accepted here (the screens additionally escape everything). */

// Must match TEAM_EMOJIS in public/js/shared.js (checked by a test).
const TEAM_EMOJIS = ['🚀', '🌟', '🪐', '👽', '🛸', '☄️', '🌙', '⭐', '🔭', '🌌', '💫', '🛰️'];

const MAX_NAME_LENGTH = 20; // same as maxlength in team.html
// Control characters and angle brackets (markup) are never part of a team name.
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f<>]/;

/** Returns { ok: true, name } or { ok: false, field, message }. */
function validateTeamName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { ok: false, field: 'name', message: 'Teamname fehlt.' };
  if ([...name].length > MAX_NAME_LENGTH) {
    return { ok: false, field: 'name', message: `Teamname darf höchstens ${MAX_NAME_LENGTH} Zeichen haben.` };
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return { ok: false, field: 'name', message: 'Teamname enthält ungültige Zeichen.' };
  }
  return { ok: true, name };
}

/** Returns { ok: true, emoji } or { ok: false, field, message }. */
function validateTeamEmoji(raw) {
  const emoji = raw === undefined || raw === null || raw === '' ? TEAM_EMOJIS[0] : raw;
  if (!TEAM_EMOJIS.includes(emoji)) {
    return { ok: false, field: 'emoji', message: 'Bitte ein Emoji aus der Auswahl wählen.' };
  }
  return { ok: true, emoji };
}

module.exports = { TEAM_EMOJIS, validateTeamName, validateTeamEmoji };
