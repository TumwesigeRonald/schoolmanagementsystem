/**
 * Curriculum-aligned Lesson Plan generator.
 * Structured around the competency-based framework: key/generic
 * competences, values, learning outcomes, suggested activities,
 * assessment strategy — teachers should still review/adapt output
 * against their subject's current national syllabus.
 *
 * Output shape is intentionally split in two:
 *  - Header metadata (School, Title, Teacher Name, Subject, Class, Date,
 *    Duration, Learners) is assembled from form params + the logged-in
 *    teacher, not generated — see teacher-toolbox.js's exportToolboxToWord.
 *  - Everything below (Curriculum Context, the 3-column operational body,
 *    and the Teacher's Self Assessment footer) is this tool's responseSchema.
 */
module.exports = {
  label: 'Lesson Plan',
  requiredParams: [
    'class', 'subject', 'topic', 'subtopic', 'specificLearningOutcome',
    'duration', 'date', 'numberOfLearners', 'term', 'year'
  ],

  buildPrompt(p) {
    return `You are an experienced Ugandan secondary school teacher generating a
lesson plan aligned with the national lower/upper secondary competency-based
curriculum framework.

Class: ${p.class}
Subject: ${p.subject}
Theme/Topic: ${p.topic}
Sub-topic: ${p.subtopic}
Specific Learning Outcome / Focus for this lesson (the precise objective the
lesson plan must be built around): ${p.specificLearningOutcome}
Lesson duration: ${p.duration} minutes
Number of learners: ${p.numberOfLearners}
Date: ${p.date}
Term: ${p.term}, ${p.year}
${p.extraContext ? `Additional context from the teacher: ${p.extraContext}` : ''}

Produce a complete lesson plan tailored precisely to the Specific Learning
Outcome / Focus given above. Include:
- The broad theme, the topic, the competency being developed, and the
  specific learning outcomes (tailored to the given focus).
- Generic skills, values, and cross-cutting issues addressed.
- One overall key learning outcome for the lesson.
- Pre-requisite knowledge learners should already have.
- References (textbook/syllabus sections, teaching aids).
- A lesson flow broken into exactly four phases, in this order:
  "Introduction", "Lesson Development", "Evaluation", "Conclusion" — each
  with an approximate duration in minutes (summing to the total lesson
  duration), what the teacher does, and what the learners do.
- A short Teacher's Self Assessment section: a few reflection prompts the
  teacher can fill in after delivering the lesson (e.g. whether outcomes
  were achieved, what worked, what to adjust next time) — write these as
  open prompts/questions, not answers, since the teacher completes them
  after the lesson.

Return ONLY the JSON object described by the response schema — no markdown,
no commentary.`;
  },

  responseSchema: {
    type: 'object',
    properties: {
      theme: { type: 'string' },
      topic: { type: 'string' },
      competency: { type: 'string' },
      learningOutcomes: { type: 'array', items: { type: 'string' } },
      genericSkills: { type: 'array', items: { type: 'string' } },
      values: { type: 'array', items: { type: 'string' } },
      crossCuttingIssues: { type: 'array', items: { type: 'string' } },
      keyLearningOutcome: { type: 'string' },
      preRequisiteKnowledge: { type: 'string' },
      references: { type: 'array', items: { type: 'string' } },
      lessonPhases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            phase: {
              type: 'string',
              enum: ['Introduction', 'Lesson Development', 'Evaluation', 'Conclusion']
            },
            durationMinutes: { type: 'number' },
            teacherActivity: { type: 'string' },
            learnerActivity: { type: 'string' }
          },
          required: ['phase', 'teacherActivity', 'learnerActivity']
        }
      },
      teacherSelfAssessment: { type: 'array', items: { type: 'string' } }
    },
    required: ['learningOutcomes', 'lessonPhases', 'teacherSelfAssessment']
  }
};
