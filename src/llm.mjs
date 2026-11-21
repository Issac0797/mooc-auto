// 模型答题：OpenAI 兼容 Chat Completions（DeepSeek / OpenAI / 任意兼容网关）
import fs from 'node:fs';
import { sleep, normalizeChoice, normalizeJudge, extractJsonObject, maskKey } from './util.mjs';

/** 解析 API Key：命令行 > 文件 > 环境变量 > 配置文件 */
export function resolveApiKey({ flag, file, config, env = process.env }) {
  if (flag) return { key: String(flag).trim(), source: '--api-key' };
  if (file) return { key: fs.readFileSync(file, 'utf8').trim(), source: `--api-key-file ${file}` };
  const envs = [
    ['MOOC_API_KEY', env.MOOC_API_KEY],
    ['DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY],
    ['OPENAI_API_KEY', env.OPENAI_API_KEY],
    ['OPENROUTER_API_KEY', env.OPENROUTER_API_KEY],
  ];
  const hit = envs.find(([, v]) => v && String(v).trim());
  if (hit) return { key: String(hit[1]).trim(), source: `环境变量 ${hit[0]}` };
  if (config?.apiKey) return { key: String(config.apiKey).trim(), source: '配置文件 apiKey' };
  return { key: null, source: null };
}

export const DEFAULT_PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

export function createClient({
  provider = 'deepseek',
  baseUrl,
  apiKey,
  model,
  temperature = 0,
  timeoutMs = 120000,
  maxRetries = 3,
}) {
  const preset = DEFAULT_PROVIDERS[provider] ?? DEFAULT_PROVIDERS.deepseek;
  const root = String(baseUrl || preset.baseUrl).replace(/\/+$/, '');
  const url = `${root}/chat/completions`;
  const useModel = model || preset.model;

  if (!apiKey) throw new Error('缺少 API Key');

  async function post(body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    url,
    model: useModel,
    provider,
    keyMask: maskKey(apiKey),
    /** 一次对话，返回文本内容；自动重试 429/5xx，兼容不支持 response_format 的网关 */
    async chat(messages, { json = true, onLog = () => {} } = {}) {
      let useJsonFormat = json;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const body = { model: useModel, messages, temperature, stream: false };
        if (useJsonFormat) body.response_format = { type: 'json_object' };
        try {
          const data = await post(body);
          const content = data?.choices?.[0]?.message?.content ?? '';
          return { content, usage: data?.usage ?? null };
        } catch (e) {
          if (e.status === 400 && useJsonFormat) {
            // 有些兼容网关不支持 response_format，降级重试
            useJsonFormat = false;
            onLog('网关不支持 response_format，已降级为纯文本 JSON 提示');
            continue;
          }
          const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || e.name === 'TimeoutError';
          if (!retryable || attempt === maxRetries) throw e;
          const wait = 1500 * attempt;
          onLog(`请求失败(${e.message.slice(0, 80)})，${wait}ms 后重试 ${attempt}/${maxRetries}`);
          await sleep(wait);
        }
      }
      throw new Error('模型请求失败');
    },
  };
}

const SYSTEM_PROMPT = [
  '你是中国大学MOOC（爱课程）单元测验的答题助手。用户会给出若干中文题目（单选/多选/判断）和选项。',
  '作答要求：',
  '1) 只输出一个 JSON 对象，键是题号（字符串，如 "1"），值是答案；不要输出任何解释或多余文字。',
  '2) 单选题：一个选项字母，例如 "C"。',
  '3) 多选题：选项字母按字母升序拼接，例如 "ABD"，不要分隔符。',
  '4) 判断题：正确填 "T"，错误填 "F"。',
  '5) 判断题的选项在页面上只显示 ✓/✗ 图标，不显示文字，请依据题干判断正误。',
].join('\n');

function toPayload(q) {
  return {
    id: q.i,
    type: String(q.type || '').replace(/[（(].*?[)）]/g, ''),
    stem: q.stem,
    options: (q.opts || []).map((o) => ({ key: o.pos, text: o.text || '(图标)' })),
  };
}

/** 把模型返回值强制转成合法答案；返回 '' 表示无效 */
export function coerceAnswer(q, value) {
  const isJudge = String(q.type || '').includes('判断');
  const keys = (q.opts || []).map((o) => o.pos);
  if (isJudge) {
    const j = normalizeJudge(value);
    if (j) return j;
    // 模型有时对判断题也回字母（如 "B"），按该选项的 ✓/✗ 图标或文字换算
    const letter = (String(value ?? '').toUpperCase().match(/[A-H]/) || [])[0];
    if (letter) {
      const opt = (q.opts || []).find((o) => String(o.pos).toUpperCase() === letter);
      if (opt?.icon) return String(opt.icon).includes('correct') ? 'T' : 'F';
      const byOptText = normalizeJudge(opt?.text || '');
      if (byOptText) return byOptText;
    }
    // 模型可能把选项文字返回回来（例如 "正确"）
    const byText = (q.opts || []).find((o) => o.text && normalizeJudge(o.text) === normalizeJudge(value));
    return byText ? 'T' : '';
  }
  let letters = normalizeChoice(value, keys);
  if (letters) return letters;
  // 模型可能返回选项文字而非字母
  const text = String(value ?? '');
  const hits = (q.opts || []).filter((o) => o.text && (text.includes(o.text) || o.text.includes(text)));
  if (hits.length) {
    letters = [...new Set(hits.map((h) => h.pos))].sort().join('');
  }
  return letters;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 批量让模型答题。
 * @returns {{answers: Record<number,string>, unresolved: object[], calls: number}}
 */
export async function answerQuestions({ questions, client, batchSize = 15, onLog = () => {} }) {
  const answers = {};
  const calls = { count: 0 };
  const pending = [...questions];

  for (const batch of chunk(pending, batchSize)) {
    onLog(`请模型作答：${batch.length} 题（第 ${batch[0].i}-${batch[batch.length - 1].i} 题）`);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ questions: batch.map(toPayload) }, null, 0) },
    ];
    const { content } = await client.chat(messages, { onLog });
    calls.count++;
    const obj = extractJsonObject(content);
    if (!obj) {
      onLog(`模型输出无法解析为 JSON，片段：${String(content).slice(0, 120).replace(/\s+/g, ' ')}`);
      continue;
    }
    for (const q of batch) {
      const raw = obj[String(q.i)] ?? obj[q.i];
      const ans = coerceAnswer(q, raw);
      if (ans) answers[q.i] = ans;
    }
  }

  // 逐题补答（模型漏答或格式不对时）
  let missing = questions.filter((q) => !answers[q.i]);
  for (const q of missing) {
    onLog(`补答第 ${q.i} 题`);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ questions: [toPayload(q)] }, null, 0) },
    ];
    try {
      const { content } = await client.chat(messages, { onLog });
      calls.count++;
      const obj = extractJsonObject(content);
      const raw = obj ? (obj[String(q.i)] ?? obj[q.i] ?? Object.values(obj)[0]) : null;
      const ans = coerceAnswer(q, raw);
      if (ans) answers[q.i] = ans;
    } catch (e) {
      onLog(`补答第 ${q.i} 题失败：${e.message.slice(0, 100)}`);
    }
  }

  const unresolved = questions.filter((q) => !answers[q.i]);
  return { answers, unresolved, calls: calls.count };
}
