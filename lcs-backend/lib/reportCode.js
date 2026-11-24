/**
 * lib/reportCode.js — signed verification codes for printed report cards.
 *
 * A code looks like   LCS/111~3~2026~Ab3dE9fGh1Jk
 *                     id     term year signature
 * The signature is an HMAC of (studentId, "Term N", year) using a secret that
 * only this server knows, so nobody can type a different student/term/year
 * into the link and get a valid page — they would need the secret to sign it.
 * The code carries NO marks: the marks are always read live from the database
 * when the code is scanned (see routes/verify.routes.js).
 *
 * Secret: VERIFY_SECRET if set, otherwise JWT_SECRET (always present). Using
 * a domain-separation prefix means a report code can never double as a JWT.
 */
const crypto = require('crypto');

const SIG_LENGTH = 12; // base64url chars = 72 bits, plenty against an online (rate-limited) guesser

function getSecret() {
  const secret = process.env.VERIFY_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('VERIFY_SECRET or JWT_SECRET must be set to sign report codes.');
  return secret;
}

function termNumber(term) {
  const m = String(term || '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

function sign(studentId, termNum, year) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`lcs-report-verify-v1|${studentId}|Term ${termNum}|${year}`)
    .digest('base64url')
    .slice(0, SIG_LENGTH);
}

// Returns the code string, or null if the term/year can't be turned into one.
function makeCode(studentId, term, year) {
  const termNum = termNumber(term);
  const yr = Number(year);
  if (!studentId || termNum === null || !Number.isInteger(yr)) return null;
  return `${studentId}~${termNum}~${yr}~${sign(studentId, termNum, yr)}`;
}

// Returns { studentId, term, year } for a genuine code, otherwise null.
function parseCode(code) {
  if (typeof code !== 'string' || code.length > 120) return null;
  const parts = code.split('~');
  if (parts.length < 4) return null;
  const sig = parts.pop();
  const year = Number(parts.pop());
  const termNum = Number(parts.pop());
  const studentId = parts.join('~');
  if (!studentId || !Number.isInteger(year) || !Number.isInteger(termNum)) return null;

  const expected = Buffer.from(sign(studentId, termNum, year));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return { studentId, term: `Term ${termNum}`, year };
}

module.exports = { makeCode, parseCode, termNumber };
