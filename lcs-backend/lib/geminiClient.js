/**
 * lib/geminiClient.js — thin wrapper around @google/genai so the SDK is
 * configured in exactly one place.
 */
const { GoogleGenAI } = require('@google/genai');

if (!process.env.GEMINI_API_KEY) {
  console.error('[gemini] GEMINI_API_KEY is not set. AI Toolbox routes will fail.');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

module.exports = { ai };
