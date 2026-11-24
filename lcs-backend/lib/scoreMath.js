/**
 * lib/scoreMath.js — per-subject score maths used by the report-card
 * verification + trend features.
 *
 * These MIRROR the formulas in script.js (computeOLevelFinalTotal /
 * computeALevelAvgMark / computeOfficialGrade / computeALevelGrade) and the
 * helpers already used by GET /api/scores/trend in routes/scores.routes.js.
 * If the grading rules ever change, change them in all of those places.
 */
const A_LEVEL_CLASSES = new Set(['S.5', 'S.6']);

// O-Level "Final (100)" = round(F.A /20 + E.O.T /80). Null until E.O.T exists.
function oLevelScore(row) {
  const ao1 = row.ao1 === null || row.ao1 === undefined ? 0 : Number(row.ao1);
  const ao2 = row.ao2 === null || row.ao2 === undefined ? 0 : Number(row.ao2);
  let av;
  if (ao1 > 0 && ao2 > 0) av = (ao1 + ao2) / 2;
  else if (ao1 > 0) av = ao1;
  else if (ao2 > 0) av = ao2;
  else av = 0;
  if (row.eot === null || row.eot === undefined) return null;
  return Math.round((av / 3.0) * 20 + Number(row.eot));
}

// A-Level "A.S" = rounded average of the papers actually attempted (> 0).
function aLevelScore(row) {
  const papers = [row.p1, row.p2]
    .map((p) => (p === null || p === undefined ? null : Number(p)))
    .filter((p) => p !== null && p > 0);
  if (!papers.length) return null;
  return Math.round(papers.reduce((s, p) => s + p, 0) / papers.length);
}

function scoreForRow(row) {
  return A_LEVEL_CLASSES.has(row.class_level) ? aLevelScore(row) : oLevelScore(row);
}

function gradeFor(score, isALevel) {
  if (score === null || score === undefined) return null;
  const bands = isALevel ? [80, 70, 60, 50] : [75, 65, 55, 45];
  if (score >= bands[0]) return 'A';
  if (score >= bands[1]) return 'B';
  if (score >= bands[2]) return 'C';
  if (score >= bands[3]) return 'D';
  return 'E';
}

module.exports = { A_LEVEL_CLASSES, oLevelScore, aLevelScore, scoreForRow, gradeFor };
