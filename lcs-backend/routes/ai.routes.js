/**
 * routes/ai.routes.js — AI Teacher Toolbox
 * (Lesson Plan Generator, Scheme of Work, Activity of Integration & CAI,
 * Record of Work) — all four tools share this one route file because they
 * share one generic controller; see config/aiTools/ for the per-tool
 * prompts/schemas.
 */
const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const ctrl = require('../controllers/ai.controller');

const router = express.Router();

router.post('/generate', authenticate, requireRole('Teacher', 'Administrator'), asyncHandler(ctrl.generate));
router.get('/items', authenticate, requireRole('Teacher', 'Administrator'), asyncHandler(ctrl.listItems));
router.get('/items/:id', authenticate, requireRole('Teacher', 'Administrator'), asyncHandler(ctrl.getItem));
router.put('/items/:id', authenticate, requireRole('Teacher', 'Administrator'), asyncHandler(ctrl.updateItem));
router.delete('/items/:id', authenticate, requireRole('Teacher', 'Administrator'), asyncHandler(ctrl.deleteItem));

module.exports = router;
