/**
 * Record of Work — the teacher's actual account of what was covered vs
 * what was planned, typically compiled from a scheme of work + lesson
 * notes at the end of a period/term.
 */
module.exports = {
  label: 'Record of Work',
  requiredParams: ['class', 'subject', 'term', 'year', 'coveredSummary'],

  buildPrompt(p) {
    return `You are an experienced Ugandan secondary school teacher compiling a
Record of Work for inspection/reporting purposes.

Class: ${p.class}
Subject: ${p.subject}
Term: ${p.term}, ${p.year}
Teacher's rough notes on what was actually taught (dates/topics, possibly
messy or out of order): ${p.coveredSummary}
${p.plannedTopics ? `What the scheme of work had originally planned: ${p.plannedTopics}` : ''}

Turn this into a clean, dated Record of Work entries list. For each entry give
the date (or week if exact dates aren't available), topic/subtopic taught, and
a brief remark (e.g. "covered as planned", "extra revision given", "topic
carried forward to next week"). Return ONLY the JSON object described by the
response schema — no markdown, no commentary.`;
  },

  responseSchema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            topic: { type: 'string' },
            subtopic: { type: 'string' },
            remark: { type: 'string' }
          },
          required: ['date', 'topic']
        }
      },
      summaryRemark: { type: 'string' }
    },
    required: ['entries']
  }
};
