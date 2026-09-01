/**
 * controllers/ai.controller.js — one generic controller for every tool
 * in the Teacher Toolbox. Tool-specific logic lives entirely in
 * config/aiTools/*, so this file never grows when a new tool is added.
 */
const db = require('../db');
const TOOLS = require('../config/aiTools');
const { ai } = require('../lib/geminiClient');

const GEMINI_MODEL = 'gemini-3.6-flash';

// Generic check against any top-level array property that declares
// minItems/maxItems in a tool's responseSchema (e.g. lessonDevelopment's
// exactly-4-phases rule). Returns a short human-readable message, or null
// if everything's within bounds.
function validateArrayLengths(schema, content) {
  const props = schema?.properties || {};
  for (const [key, propSchema] of Object.entries(props)) {
    if (propSchema.type !== 'array' || (propSchema.minItems == null && propSchema.maxItems == null)) continue;
    const len = Array.isArray(content?.[key]) ? content[key].length : 0;
    if (propSchema.minItems != null && len < propSchema.minItems) {
      return `"${key}" needs at least ${propSchema.minItems} item(s), got ${len}`;
    }
    if (propSchema.maxItems != null && len > propSchema.maxItems) {
      return `"${key}" allows at most ${propSchema.maxItems} item(s), got ${len}`;
    }
  }
  return null;
}

// POST /api/ai/generate
// Body: { toolType, params: {...}, save?: boolean (default true) }
async function generate(req, res) {
  const { toolType, params, save = true } = req.body || {};

  const tool = TOOLS[toolType];
  if (!tool) {
    return res.status(400).json({
      message: `Unknown tool_type "${toolType}". Valid values: ${Object.keys(TOOLS).join(', ')}`
    });
  }

  const missing = tool.requiredParams.filter((key) => !params?.[key]);
  if (missing.length) {
    return res.status(400).json({ message: `Missing required field(s): ${missing.join(', ')}` });
  }

  const prompt = tool.buildPrompt(params);

  let response;
  try {
    response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        // `responseSchema` (OpenAPI-3.0 subset) — NOT `responseJsonSchema`.
        // The installed SDK, @google/genai v0.14.0, only recognises
        // `responseSchema` when it builds the request body; a field named
        // `responseJsonSchema` isn't in that build list at all and is
        // silently dropped, so no schema was ever actually reaching
        // Gemini — the model was generating fully freeform JSON, which is
        // exactly why the Lesson Plan tool's lessonDevelopment array kept
        // coming back short/empty/differently-shaped. A prior fix here
        // assumed `responseSchema` ignores minItems/maxItems on arrays;
        // that's incorrect — Gemini's OpenAPI-subset schema does enforce
        // minItems/maxItems on `array` types, which is what the Lesson
        // Plan's exact-4-phases requirement (config/aiTools/lessonPlan.js)
        // relies on.
        responseSchema: tool.responseSchema
      }
    });
  } catch (err) {
    console.error(`[ai.generate] Gemini call failed for tool_type=${toolType}`, err);
    return res.status(502).json({ message: 'Generation failed. Please try again in a moment.' });
  }

  let content;
  try {
    content = JSON.parse(response.text);
  } catch (err) {
    console.error(`[ai.generate] Could not parse Gemini output for tool_type=${toolType}`, response.text);
    return res.status(502).json({ message: 'Unable to process content. Please check your connection and retry.' });
  }

  // Belt-and-suspenders: even with the schema now actually enforced,
  // validate any array field that declares minItems/maxItems before we
  // save or return it, so a malformed generation surfaces as a clear
  // error instead of silently saving/showing an empty table.
  const schemaError = validateArrayLengths(tool.responseSchema, content);
  if (schemaError) {
    console.error(`[ai.generate] Schema validation failed for tool_type=${toolType}: ${schemaError}`);
    return res.status(502).json({ message: `Generation did not match the expected format (${schemaError}). Please try again.` });
  }

  // save=false lets the frontend preview a generation before the teacher
  // commits it (e.g. "Regenerate" button) without writing throwaway rows.
  if (!save) {
    return res.json({ toolType, content, saved: false });
  }

  const teacherId = req.user.teacherId;
  if (!teacherId) {
    // Administrators are explicitly allowed by requireRole('Teacher',
    // 'Administrator') above, but ai_toolbox_items.teacher_id is
    // NOT NULL REFERENCES teachers(id) and Administrator accounts have
    // no teachers.id row — there's nowhere to save an admin-generated
    // item. Rather than blocking Administrators from the tool, degrade
    // to the same unsaved-preview shape save=false already returns.
    return res.json({
      toolType,
      content,
      saved: false,
      savedNote: 'Administrator accounts can generate and preview content, but it isn\'t saved to a teacher\'s records.'
    });
  }

  const { class: className, subject, term, year, topic, title } = params;

  const { rows } = await db.query(
    `INSERT INTO ai_toolbox_items
       (teacher_id, tool_type, title, class, subject, term, year, topic,
        input_params, content, model_used, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     RETURNING id, teacher_id AS "teacherId", tool_type AS "toolType", title,
               class, subject, term, year, topic, status, content,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      teacherId,
      toolType,
      title || `${tool.label} — ${topic || subject || className}`,
      className || null,
      subject || null,
      term || null,
      year ? Number(year) : null,
      topic || null,
      JSON.stringify(params),
      JSON.stringify(content),
      GEMINI_MODEL
    ]
  );

  res.status(201).json(rows[0]);
}

// GET /api/ai/items?toolType=&class=&subject=&term=&year=&status=
// Teachers see only their own items; Administrators can pass ?teacherId= to
// inspect a specific teacher's toolbox (e.g. for review/support).
async function listItems(req, res) {
  const { toolType, class: className, subject, term, year, status } = req.query;
  const teacherId = req.user.role === 'Administrator' && req.query.teacherId
    ? req.query.teacherId
    : req.user.teacherId;

  const conditions = ['teacher_id = $1'];
  const values = [teacherId];
  let i = 2;
  if (toolType) { conditions.push(`tool_type = $${i++}`); values.push(toolType); }
  if (className) { conditions.push(`class = $${i++}`); values.push(className); }
  if (subject) { conditions.push(`subject = $${i++}`); values.push(subject); }
  if (term) { conditions.push(`term = $${i++}`); values.push(term); }
  if (year) { conditions.push(`year = $${i++}`); values.push(Number(year)); }
  if (status) { conditions.push(`status = $${i++}`); values.push(status); }

  const { rows } = await db.query(
    `SELECT id, teacher_id AS "teacherId", tool_type AS "toolType", title,
            class, subject, term, year, topic, status,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM ai_toolbox_items
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values
  );
  res.json(rows);
}

// GET /api/ai/items/:id — full content included (list view omits it to
// keep the list payload light; the detail view needs the full body).
async function getItem(req, res) {
  const { rows } = await db.query(
    `SELECT id, teacher_id AS "teacherId", tool_type AS "toolType", title,
            class, subject, term, year, topic, status, input_params AS "inputParams",
            content, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM ai_toolbox_items WHERE id = $1`,
    [req.params.id]
  );
  const item = rows[0];
  if (!item) return res.status(404).json({ message: 'Not found.' });

  const isOwner = item.teacherId === req.user.teacherId;
  if (!isOwner && req.user.role !== 'Administrator') {
    return res.status(403).json({ message: 'You do not have permission to view this item.' });
  }
  res.json(item);
}

// PUT /api/ai/items/:id — teacher edits the AI output before finalising,
// or updates status (draft -> final -> archived).
// Body: { title?, content?, status? }
async function updateItem(req, res) {
  const existing = await db.query('SELECT teacher_id FROM ai_toolbox_items WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.status(404).json({ message: 'Not found.' });

  const isOwner = existing.rows[0].teacher_id === req.user.teacherId;
  if (!isOwner && req.user.role !== 'Administrator') {
    return res.status(403).json({ message: 'You do not have permission to edit this item.' });
  }

  const body = req.body || {};
  const has = (name) => Object.prototype.hasOwnProperty.call(body, name);

  const { rows } = await db.query(
    `UPDATE ai_toolbox_items SET
       title   = CASE WHEN $2 THEN $3 ELSE title END,
       content = CASE WHEN $4 THEN $5::jsonb ELSE content END,
       status  = CASE WHEN $6 THEN $7 ELSE status END,
       updated_at = now()
     WHERE id = $1
     RETURNING id, teacher_id AS "teacherId", tool_type AS "toolType", title,
               class, subject, term, year, topic, status, content,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      req.params.id,
      has('title'), body.title || null,
      has('content'), has('content') ? JSON.stringify(body.content) : null,
      has('status'), body.status || null
    ]
  );
  res.json(rows[0]);
}

// DELETE /api/ai/items/:id
async function deleteItem(req, res) {
  const existing = await db.query('SELECT teacher_id FROM ai_toolbox_items WHERE id = $1', [req.params.id]);
  if (!existing.rows.length) return res.status(404).json({ message: 'Not found.' });

  const isOwner = existing.rows[0].teacher_id === req.user.teacherId;
  if (!isOwner && req.user.role !== 'Administrator') {
    return res.status(403).json({ message: 'You do not have permission to delete this item.' });
  }

  await db.query('DELETE FROM ai_toolbox_items WHERE id = $1', [req.params.id]);
  res.json({ message: 'Deleted.' });
}

module.exports = { generate, listItems, getItem, updateItem, deleteItem };
