// 通用工具：文本归一化、相似度、JSON 读写、答案规范化、日志
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 归一化题目/选项文本：去零宽字符、去标点空白、转小写 */
export function norm(s) {
  return String(s ?? '')
    .replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff]/g, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9()[\],;:?!.%+\-<>=/]/g, '')
    .toLowerCase();
}

/** 二元组 Jaccard 相似度，用于题干模糊匹配 */
export function similarity(a, b) {
  const grams = (s) => new Set(String(s).match(/../g) || []);
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / new Set([...A, ...B]).size;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/** 打码显示 API Key（绝不打印完整 key） */
export function maskKey(key) {
  if (!key) return '(未设置)';
  const k = String(key);
  if (k.length <= 10) return '****';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** 把模型/答案库返回的选择题答案规范成字母串，例如 "a,c" -> "AC" */
export function normalizeChoice(value, optionKeys) {
  const keys = optionKeys.map((k) => String(k).toUpperCase());
  const raw = Array.isArray(value) ? value.join('') : String(value ?? '');
  const letters = [...new Set((raw.toUpperCase().match(/[A-H]/g) || []))].sort();
  return letters.filter((l) => keys.includes(l)).join('');
}

/** 判断题答案规范：正确 -> T，错误 -> F */
export function normalizeJudge(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  if (/^(t|true|1|y|yes|正确|对|是|√)/.test(v)) return 'T';
  if (/^(f|false|0|n|no|错误|错|否|×|x)/.test(v)) return 'F';
  return '';
}

/** 在文本里抠出第一个 JSON 对象（兼容模型把 JSON 包在 ```json 里或前后带解释） */
export function extractJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 简易参数解析：--key value / --key=value / 布尔开关；同时生成 camelCase 别名 */
export function parseArgs(argv) {
  const out = { _: [] };
  const setVal = (k, v) => {
    out[k] = v;
    const camel = k.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
    if (camel !== k) out[camel] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) {
      setVal(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      setVal(key, next);
      i++;
    } else {
      setVal(key, true);
    }
  }
  return out;
}

/** 从 stdin 读一行（用于 --api-key - 避免写进 shell 历史） */
export async function readStdinLine() {
  return await new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        process.stdin.pause();
        process.stdin.off('data', onData);
        resolve(buf.slice(0, nl).trim());
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}
