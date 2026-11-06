// Example workflows ship in English (config.example.json). On the very first run, when
// settings.language is "fr", the bridge swaps their texts for the French ones of
// locales/examples.<lang>.json before writing config.json.
//
// Overlay format: { "<dot.path>": { "en": "<text in config.example.json>", "fr": "..." } }.
// A text is only replaced when it still equals the English one, so edits made in
// config.json before the first run are kept.

'use strict';

const fs = require('fs');
const path = require('path');

const SUPPORTED_LANGUAGES = ['en', 'fr'];

function normalizeLanguage(lang) {
  const l = String(lang ?? '').trim().toLowerCase().slice(0, 2);
  return SUPPORTED_LANGUAGES.includes(l) ? l : 'en';
}

function loadOverlay(lang, dir = path.join(__dirname, '..', 'locales')) {
  const file = path.join(dir, `examples.${lang}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// Walks "a.b.0.c" in obj; returns [parent, key] or null when the path does not exist.
function resolvePath(obj, dotPath) {
  const keys = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur === null || typeof cur !== 'object' || !(keys[i] in cur)) return null;
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (cur === null || typeof cur !== 'object' || !(last in cur)) return null;
  return [cur, last];
}

// Returns the number of texts replaced. Mutates seed.
function localizeExamples(seed, lang, overlay = undefined) {
  const l = normalizeLanguage(lang);
  if (l === 'en') return 0;
  const map = overlay === undefined ? loadOverlay(l) : overlay;
  if (!map) return 0;
  let replaced = 0;
  for (const [dotPath, texts] of Object.entries(map)) {
    if (dotPath.startsWith('_') || !texts || typeof texts[l] !== 'string') continue;
    const found = resolvePath(seed, dotPath);
    if (!found) continue;
    const [parent, key] = found;
    if (parent[key] === texts.en) {
      parent[key] = texts[l];
      replaced += 1;
    }
  }
  return replaced;
}

module.exports = { SUPPORTED_LANGUAGES, normalizeLanguage, loadOverlay, resolvePath, localizeExamples };
