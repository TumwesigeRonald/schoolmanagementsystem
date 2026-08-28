/**
 * NCDC-aligned Lesson Plan generator.
 * Structured around the competency-based framework: key/generic
 * competences, values, learning outcomes, suggested activities,
 * assessment strategy — teachers should still review/adapt output
 * against the current NCDC syllabus for their subject.
 */
module.exports = {
  label: 'NCDC Lesson Plan',
  requiredParams: ['class', 'subject', 'topic', 'subtopic', 'duration', 'term', 'year'],

  buildPrompt(p) {
    return `You are an experienced Ugandan secondary school teacher generating a
lesson plan aligned with the NCDC (National Curriculum Development Centre)
lower/upper secondary competency-based curriculum framework.

Class: ${p.class}
Subject: ${p.subject}
Topic: ${p.topic}
Sub-topic: ${p.subtopic}
Lesson duration: ${p.duration} minutes
Term: ${p.term}, ${p.year}
${p.extraContext ? `Additional context from the teacher: ${p.extraContext}` : ''}

Produce a complete lesson plan. Include key competences, generic skills, and
values addressed; clear learning outcomes; a suggested lesson flow (introduction,
main activities, conclusion) with approximate timings; teaching/learning
resources needed; and an assessment strategy. Return ONLY the JSON object
described by the response schema — no markdown, no commentary.`;
  },

  responseSchema: {
    type: 'object',
    properties: {
      keyCompetences: { type: 'array', items: { type: 'string' } },
      genericSkills: { type: 'array', items: { type: 'string' } },
      values: { type: 'array', items: { type: 'string' } },
      learningOutcomes: { type: 'array', items: { type: 'string' } },
      resources: { type: 'array', items: { type: 'string' } },
      lessonFlow: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stage: { type: 'string' },
            durationMinutes: { type: 'number' },
            teacherActivity: { type: 'string' },
            learnerActivity: { type: 'string' }
          },
          required: ['stage', 'teacherActivity', 'learnerActivity']
        }
      },
      assessmentStrategy: { type: 'string' },
      homework: { type: 'string' }
    },
    required: ['learningOutcomes', 'lessonFlow', 'assessmentStrategy']
  }
};
