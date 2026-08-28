/**
 * config/aiTools/index.js — single source of truth mapping tool_type ->
 * its definition. The controller only ever talks to this registry, never
 * to an individual tool file directly — that's what keeps
 * POST /api/ai/generate free of per-tool branching.
 */
module.exports = {
  lesson_plan: require('./lessonPlan'),
  scheme_of_work: require('./schemeOfWork'),
  activity_of_integration: require('./activityOfIntegration'),
  record_of_work: require('./recordOfWork')
};
