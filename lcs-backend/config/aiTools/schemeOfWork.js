/**
 * Termly Scheme of Work — week-by-week breakdown of a subject's syllabus
 * for one class/term, in the standard 10-column format
 * (WEEK, PERIODS, THEME, CHAPTER, COMPETENCY, LEARNING OUTCOMES,
 * TEACHING RESOURCES, METHODOLOGY, REFERENCE, REMARKS) used across
 * Ugandan secondary schools. Column keys here MUST stay in sync with
 * SCHEME_COLUMN_KEYS in teacher-toolbox.js.
 */
module.exports = {
  label: 'Scheme of Work',
  requiredParams: ['class', 'subject', 'term', 'year', 'weeksInTerm'],

  buildPrompt(p) {
    return `You are an experienced Ugandan secondary school teacher preparing a
termly Scheme of Work aligned with the NCDC competency-based curriculum, in
the standard 10-column format used by Ugandan secondary schools.

Class: ${p.class}
Subject: ${p.subject}
Term: ${p.term}, ${p.year}
Number of teaching weeks this term: ${p.weeksInTerm}
${p.syllabusCoverage ? `Syllabus topics to cover this term: ${p.syllabusCoverage}` : ''}

Produce one row per week (week 1 through ${p.weeksInTerm}) giving: the number
of periods that week, the theme/topic area, the chapter/unit reference, the
competency being developed, the learning outcomes, the teaching/learning
resources needed, the teaching methodology, a reference (textbook/syllabus
section), and any remarks. Keep each cell concise — a phrase or short
sentence, not a paragraph; where a cell would naturally list several items,
separate them with semicolons rather than returning a nested list. Return
ONLY the JSON object described by the response schema — no markdown, no
commentary.`;
  },

  responseSchema: {
    type: 'object',
    properties: {
      weeks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            week: { type: 'string' },
            periods: { type: 'string' },
            theme: { type: 'string' },
            chapter: { type: 'string' },
            competency: { type: 'string' },
            learningOutcomes: { type: 'string' },
            teachingResources: { type: 'string' },
            methodology: { type: 'string' },
            reference: { type: 'string' },
            remarks: { type: 'string' }
          },
          required: [
            'week', 'periods', 'theme', 'chapter', 'competency',
            'learningOutcomes', 'teachingResources', 'methodology',
            'reference', 'remarks'
          ]
        }
      }
    },
    required: ['weeks']
  }
};
