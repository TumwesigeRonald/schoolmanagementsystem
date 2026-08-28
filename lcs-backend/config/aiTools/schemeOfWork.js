/**
 * Termly Scheme of Work — week-by-week breakdown of a subject's syllabus
 * for one class/term.
 */
module.exports = {
  label: 'Scheme of Work',
  requiredParams: ['class', 'subject', 'term', 'year', 'weeksInTerm'],

  buildPrompt(p) {
    return `You are an experienced Ugandan secondary school teacher preparing a
termly Scheme of Work aligned with the NCDC competency-based curriculum.

Class: ${p.class}
Subject: ${p.subject}
Term: ${p.term}, ${p.year}
Number of teaching weeks this term: ${p.weeksInTerm}
${p.syllabusCoverage ? `Syllabus topics to cover this term: ${p.syllabusCoverage}` : ''}

Break the term's syllabus into a week-by-week scheme. For each week give the
topic, sub-topics, learning outcomes, suggested learning activities, resources,
and assessment method. Return ONLY the JSON object described by the response
schema — no markdown, no commentary.`;
  },

  responseSchema: {
    type: 'object',
    properties: {
      weeks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            weekNumber: { type: 'number' },
            topic: { type: 'string' },
            subtopics: { type: 'array', items: { type: 'string' } },
            learningOutcomes: { type: 'array', items: { type: 'string' } },
            activities: { type: 'array', items: { type: 'string' } },
            resources: { type: 'array', items: { type: 'string' } },
            assessmentMethod: { type: 'string' }
          },
          required: ['weekNumber', 'topic', 'learningOutcomes']
        }
      }
    },
    required: ['weeks']
  }
};
