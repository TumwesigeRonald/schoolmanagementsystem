/**
 * Activity of Integration (AOI) + Continuous Assessment Item (CAI).
 * An AOI is a real-life scenario task that requires learners to combine
 * outcomes from several topics; the CAI is the scored task + rubric used
 * to assess it, typically against the national curriculum's Basic /
 * Moderate / Outstanding competency-level descriptors.
 */
module.exports = {
  label: 'Activity of Integration & CAI',
  requiredParams: ['class', 'subject', 'term', 'year', 'topicsCovered'],

  buildPrompt(p) {
    return `You are an experienced Ugandan secondary school teacher designing an
Activity of Integration (AOI) and its accompanying Continuous Assessment Item
(CAI), aligned with the national competency-based curriculum's integration
and continuous assessment approach.

Class: ${p.class}
Subject: ${p.subject}
Term: ${p.term}, ${p.year}
Topics/outcomes already covered that this activity should integrate: ${p.topicsCovered}
${p.context ? `Context/scenario preference: ${p.context}` : ''}

Design a realistic, contextualised scenario requiring learners to apply and
combine the listed outcomes, the task instructions given to learners, and a
scoring rubric with three competency levels (Basic, Moderate, Outstanding)
describing what performance looks like at each level. Return ONLY the JSON
object described by the response schema — no markdown, no commentary.`;
  },

  responseSchema: {
    type: 'object',
    properties: {
      scenario: { type: 'string' },
      taskInstructions: { type: 'array', items: { type: 'string' } },
      integratedOutcomes: { type: 'array', items: { type: 'string' } },
      rubric: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string' },
            basic: { type: 'string' },
            moderate: { type: 'string' },
            outstanding: { type: 'string' }
          },
          required: ['criterion', 'basic', 'moderate', 'outstanding']
        }
      }
    },
    required: ['scenario', 'taskInstructions', 'rubric']
  }
};
