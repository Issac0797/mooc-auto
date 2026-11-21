// 离线答案库：按题干匹配历史整理好的答案（来源为公开的课程答案整理稿）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm, similarity, normalizeJudge } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.join(here, '..', 'data', 'keydb.json');

export function loadKeyDb(file = DEFAULT_DB) {
  if (!fs.existsSync(file)) return { entries: [], byStem: new Map(), file };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.items ?? [];
  const byStem = new Map();
  for (const e of entries) {
    if (!e || !e.q) continue;
    const k = norm(e.q);
    if (k && !byStem.has(k)) byStem.set(k, e);
  }
  return { entries, byStem, file };
}

function answerTexts(entry) {
  if (!entry?.answer) return [];
  return String(entry.answer)
    .split(/[#;；]/)
    .map((s) => norm(s))
    .filter(Boolean);
}

/** 用答案库解析一道题；返回字母串或 T/F，找不到返回 '' */
export function resolveByKey(db, question, { minSimilarity = 0.9 } = {}) {
  const k = norm(question.stem);
  let entry = db.byStem.get(k);
  if (!entry) {
    let best = null;
    let bestScore = 0;
    for (const cand of db.entries) {
      const s = similarity(k, norm(cand.q));
      if (s > bestScore) { bestScore = s; best = cand; }
    }
    if (best && bestScore >= minSimilarity) entry = best;
  }
  if (!entry) return { answer: '', entry: null, score: 0 };

  const isJudge = String(question.type || '').includes('判断');
  if (isJudge) {
    const fromText = normalizeJudge(entry.answer);
    if (fromText) return { answer: fromText, entry, score: 1 };
    const letter = (entry.letters || [])[0];
    const optText = letter && entry.options ? entry.options[letter] : '';
    const mapped = normalizeJudge(optText);
    return { answer: mapped, entry, score: mapped ? 1 : 0 };
  }

  const parts = answerTexts(entry);
  const picked = [];
  for (const p of parts) {
    const live =
      question.opts.find((o) => norm(o.text) === p) ||
      question.opts.find((o) => p && norm(o.text).includes(p) && p.length > 3);
    let pos = live?.pos;
    if (!pos && entry.options) {
      const hit = Object.entries(entry.options).find(([, v]) => norm(v) === p);
      if (hit) {
        const liveByPos = question.opts.find((o) => o.pos === hit[0]);
        pos = liveByPos?.pos;
      }
    }
    if (pos && !picked.includes(pos)) picked.push(pos);
  }
  return { answer: picked.sort().join(''), entry, score: picked.length ? 1 : 0 };
}
