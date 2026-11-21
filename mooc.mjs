#!/usr/bin/env node
// mooc-auto：中国大学MOOC / 学习通 单元测验自动答题 CLI
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readJson, writeJson, maskKey, readStdinLine, sleep } from './src/util.mjs';
import { connect, launch, sessionInfo } from './src/browser.mjs';
import { resolvePlatform } from './src/registry.mjs';
import { Pacer } from './src/pacer.mjs';
import { loadKeyDb, resolveByKey } from './src/keydb.mjs';
import { resolveApiKey, createClient, answerQuestions } from './src/llm.mjs';

const log = (m) => console.error(m);

const DEFAULTS = {
  cdpUrl: 'http://127.0.0.1:9222',
  platform: null,
  course: { courseId: 'NUIST-1206810807', tid: '1487847445', baseUrl: 'https://www.icourse163.org' },
  provider: 'deepseek',
  baseUrl: null,
  model: null,
  apiKey: null,
  pace: null,
  fastMs: 120,
  fastJitterMs: 80,
  slowMs: 1800,
  slowJitterMs: 400,
  probe: { clicks: 3, intervalMs: 150 },
  batchSize: 15,
  outDir: './out',
};

const HELP = `
mooc-auto — 中国大学MOOC / 学习通 单元测验自动答题

用法：
  node mooc.mjs <命令> [参数]

命令：
  doctor                        体检：调试端口、登录态、答案库、API Key
  launch                        用独立配置目录拉起浏览器（不碰你日常用的那个）
  list                          列出课程下的测验及得分/次数
  extract  --quiz <id|名称>      打开测验并抓取题目（--yes 才会点“开始测验”）
  answer   --in <题目.json>      调模型/答案库生成答案（--out 输出）
  probe    --quiz <id|名称>      仅探测是否存在并发限制（慕课）
  fill     --quiz <id|名称> --answers <答案.json>
                                按节奏填写（--pace auto|fast|slow，--submit 才交卷）
  run      --quiz <id|名称> [--yes] [--submit]
                                一条龙：抓题 → 答题 → 探测 → 填写 →（可选）交卷

答题与模型：
  --api-key <key> | --api-key-file <路径> | --api-key -（读 stdin）
  也支持环境变量 MOOC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY
  --provider deepseek|openai     默认 deepseek
  --base-url https://...         任意 OpenAI 兼容网关
  --model deepseek-chat
  --source auto|key|model        auto=先用内置答案库，缺的交给模型（默认）

节奏（关键）：
  --pace auto   慕课默认：先快速探测，触发并发限制才降速
  --pace fast   学习通默认：约 ${DEFAULTS.fastMs}ms/题
  --pace slow   强制慢速：约 ${DEFAULTS.slowMs}ms/题
  --fast-ms / --slow-ms          自定义毫秒数

其它：
  --cdp-url http://127.0.0.1:9222
  --platform icourse163|chaoxing
  --out-dir ./out               产物目录
  --dry-run                     只抓题+答题，不点击
  --no-probe                    跳过频控探测，直接按 pace 填
`;

function loadConfig(cli) {
  let cfg = structuredClone(DEFAULTS);
  const file = cli.config || (fs.existsSync('./config.json') ? './config.json' : null);
  if (file) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  cfg.course = { ...DEFAULTS.course, ...(cfg.course || {}) };
  const pick = (k) => (cli[k] !== undefined ? cli[k] : undefined);
  for (const k of ['cdpUrl', 'platform', 'provider', 'baseUrl', 'model', 'apiKey', 'pace', 'outDir']) {
    if (pick(k) !== undefined) cfg[k] = pick(k);
  }
  if (cli['fast-ms']) cfg.fastMs = Number(cli['fast-ms']);
  if (cli['slow-ms']) cfg.slowMs = Number(cli['slow-ms']);
  if (cli.batch) cfg.batchSize = Number(cli.batch);
  if (cli['course-id']) cfg.course.courseId = cli['course-id'];
  if (cli.tid) cfg.course.tid = cli.tid;
  return cfg;
}

function defaultPace(cfg, platform) {
  return cfg.pace || (platform.key === 'chaoxing' ? 'fast' : 'auto');
}

/** 允许用 config.selectors 覆盖平台选择器（学习通皮肤差异大） */
function withSelectors(platform, cfg) {
  if (cfg.selectors && Object.keys(cfg.selectors).length) {
    Object.assign(platform.SEL, cfg.selectors);
    log(`已应用 selectors 覆盖：${Object.keys(cfg.selectors).join(', ')}`);
  }
  return platform;
}

function makePacer(cfg, platform, pace) {
  return new Pacer({
    mode: pace,
    fast: { delayMs: cfg.fastMs, jitterMs: cfg.fastJitterMs },
    slow: { delayMs: cfg.slowMs, jitterMs: cfg.slowJitterMs },
    onLog: log,
  });
}

async function ensureKey(cfg, cli) {
  if (cli['api-key'] === '-') {
    const v = await readStdinLine();
    return { key: v, source: '标准输入' };
  }
  return resolveApiKey({ flag: cli['api-key'], file: cli['api-key-file'], config: cfg });
}

function summarizeAnswer(questions, answers) {
  const rows = questions.map((q) => ({ i: q.i, type: q.type, stem: q.stem.slice(0, 40), answer: answers[q.i] ?? '' }));
  const missing = rows.filter((r) => !r.answer).map((r) => r.i);
  return { rows, missing };
}

/** 关键流程：抓题 → 生成答案 */
async function buildAnswers(cfg, cli, questions, { platform } = {}) {
  const source = cli.source || 'auto';
  const answers = {};
  const fromKey = [];
  const db = loadKeyDb(cli['key-db']);
  if (source !== 'model' && db.entries.length) {
    for (const q of questions) {
      const hit = resolveByKey(db, q);
      if (hit.answer) {
        answers[q.i] = hit.answer;
        fromKey.push(q.i);
      }
    }
    log(`答案库命中 ${fromKey.length}/${questions.length} 题`);
  }

  const need = questions.filter((q) => !answers[q.i]);
  if (source === 'key' && need.length) {
    log(`答案库未覆盖 ${need.length} 题（--source key 不再调用模型）`);
  }
  if (source !== 'key' && need.length) {
    const keyInfo = await ensureKey(cfg, cli);
    if (!keyInfo.key) {
      throw new Error(
        `还有 ${need.length} 题需要模型作答，但没有 API Key。\n` +
          `请用 --api-key/--api-key-file/--api-key - 传入，或设置环境变量\n` +
          `  DEEPSEEK_API_KEY / OPENAI_API_KEY / MOOC_API_KEY\n` +
          `也可加 --source key 只用内置答案库。`,
      );
    }
    log(`模型答题：provider=${cfg.provider} model=${cfg.model || '(默认)'} key=${maskKey(keyInfo.key)}（来源：${keyInfo.source}）`);
    const client = createClient({
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiKey: keyInfo.key,
      model: cfg.model,
      maxRetries: Number(cli.retries || 3),
    });
    const res = await answerQuestions({ questions: need, client, batchSize: cfg.batchSize, onLog: log });
    Object.assign(answers, res.answers);
    log(`模型作答 ${Object.keys(res.answers).length}/${need.length} 题（请求 ${res.calls} 次）`);
    if (res.unresolved.length) log(`⚠ 仍无法作答：第 ${res.unresolved.map((q) => q.i).join(', ')} 题`);
  }

  return { answers, fromKey, source };
}

function answersArray(questions, answers) {
  return questions.map((q) => answers[q.i]);
}

async function cmdDoctor(cfg, cli) {
  const report = { cdp: cfg.cdpUrl, ok: false };
  try {
    const { context, page } = await connect(cfg.cdpUrl);
    report.cdpOk = true;
    report.page = page.url();
    report.platform = resolvePlatform({ name: cfg.platform, url: page.url() }).label;
    report.session = await sessionInfo(context);
  } catch (e) {
    report.cdpError = e.message.split('\n')[0];
  }
  const db = loadKeyDb(cli['key-db']);
  report.keyDb = { file: db.file, entries: db.entries.length };
  const keyInfo = await ensureKey(cfg, cli);
  report.apiKey = { present: !!keyInfo.key, masked: maskKey(keyInfo.key), source: keyInfo.source };
  report.paceDefault = defaultPace(cfg, resolvePlatform({ name: cfg.platform, url: report.page }));
  report.ok = report.cdpOk && (report.session?.hasIcourse163 || report.session?.hasChaoxing);
  console.log(JSON.stringify(report, null, 2));
}

async function cmdLaunch(cfg, cli) {
  const r = await launch({
    cdpPort: Number(new URL(cfg.cdpUrl).port || 9222),
    profileDir: cli['profile-dir'],
    browserPath: cli['browser-path'],
    url: cli.url || `${cfg.course.baseUrl}/`,
  });
  log(`已启动浏览器：${r.exe}`);
  console.log(JSON.stringify(r, null, 2));
}

async function cmdList(cfg, cli) {
  const { page } = await connect(cfg.cdpUrl);
  const platform = withSelectors(resolvePlatform({ name: cfg.platform, url: page.url() }), cfg);
  if (!platform.listQuizzes) throw new Error(`${platform.label} 暂不支持 list`);
  const rows = await platform.listQuizzes(page, cfg.course);
  console.log(JSON.stringify({ platform: platform.label, rows }, null, 2));
}

async function cmdExtract(cfg, cli) {
  const { page } = await connect(cfg.cdpUrl);
  const platform = withSelectors(resolvePlatform({ name: cfg.platform, url: page.url() }), cfg);
  const quiz = await platform.openQuiz(page, cfg.course, cli.quiz, { onLog: log });

  const existing = await page.evaluate(
    () => document.querySelectorAll('.u-questionItem, .questionLi, .TiMu').length,
  );
  if (!existing) {
    if (!cli.yes) {
      throw new Error(
        '测验尚未开始：点「开始测验」会启动 60 分钟计时并可能占用尝试次数。\n' +
          '确认要开始请加 --yes 重试（或先用 `probe` / `run --dry-run` 查看页面状态）。',
      );
    }
    const startState = await platform.startQuiz(page, { onLog: log });
    if (!startState.started) throw new Error(`未能开始测验：${startState.reason || '未知原因'}`);
  }

  const questions = await platform.extract(page);
  const out = cli.out || path.join(cfg.outDir, `questions-${quiz.id}.json`);
  writeJson(out, { platform: platform.key, quizId: quiz.id, url: page.url(), count: questions.length, questions });
  console.log(JSON.stringify({ quizId: quiz.id, count: questions.length, out }, null, 2));
}

async function cmdAnswer(cfg, cli) {
  if (!cli.in) throw new Error('需要 --in <题目.json>');
  const payload = readJson(cli.in);
  const questions = payload.questions || payload;
  const platform = resolvePlatform({ name: cfg.platform || payload.platform, url: payload.url });
  const { answers, source } = await buildAnswers(cfg, cli, questions, { platform });
  const out = cli.out || path.join(cfg.outDir, `answers-${payload.quizId || 'quiz'}.json`);
  writeJson(out, {
    quizId: payload.quizId ?? null,
    platform: platform.key,
    generatedAt: new Date().toISOString(),
    source,
    answers: questions.map((q) => ({ i: q.i, stem: q.stem, type: q.type, answer: answers[q.i] ?? '' })),
  });
  const { missing } = summarizeAnswer(questions, answers);
  console.log(JSON.stringify({ out, total: questions.length, missing }, null, 2));
}

async function cmdProbe(cfg, cli) {
  const { page } = await connect(cfg.cdpUrl);
  const platform = withSelectors(resolvePlatform({ name: cfg.platform, url: page.url() }), cfg);
  if (!cli.quiz && !/quiz\?id=/.test(page.url())) throw new Error('需要 --quiz <id|名称>');
  if (cli.quiz) await platform.openQuiz(page, cfg.course, cli.quiz);
  const r = platform.probeSpeed
    ? await platform.probeSpeed(page, cfg.probe)
    : { limited: false, skipped: true, reason: '该平台无需探测' };
  if (r.limited) await platform.dismissRateLimit(page).catch(() => {});
  console.log(JSON.stringify(r, null, 2));
}

async function cmdFill(cfg, cli) {
  if (!cli.answers) throw new Error('需要 --answers <答案.json>');
  const payload = readJson(cli.answers);
  const { page } = await connect(cfg.cdpUrl);
  const platform = withSelectors(resolvePlatform({ name: cfg.platform, url: page.url() }), cfg);
  if (cli.quiz) await platform.openQuiz(page, cfg.course, cli.quiz);
  const questions = await platform.extract(page);
  const list = payload.answers || payload;
  const answers = questions.map((q) => {
    const row = Array.isArray(list) ? list[q.i - 1] : list.find((x) => x.i === q.i);
    return typeof row === 'string' ? row : row?.answer ?? '';
  });
  if (answers.some((a) => !a)) throw new Error(`答案文件缺题：第 ${answers.map((a, k) => (a ? null : k + 1)).filter(Boolean).join(', ')} 题`);

  const pace = defaultPace(cfg, platform);
  const pacer = makePacer(cfg, platform, pace);
  log(`填写节奏：${pace}${pace === 'auto' ? '（先快后慢，触发限制才降速）' : ''}`);

  let probe = null;
  if (platform.key === 'icourse163' && !cli['no-probe'] && pace !== 'slow') {
    probe = await platform.probeSpeed(page, cfg.probe);
    if (probe.limited) {
      await platform.dismissRateLimit(page);
      pacer.escalate('探测阶段快速点击触发');
    } else {
      log(`探测通过：${probe.clicks} 次快速点击（${probe.ms}ms）未触发并发限制 → 保持快速`);
    }
  }

  const report = await platform.fill(page, questions, answers, { pacer, onLog: log });
  let submitResult = null;
  if (cli.submit) submitResult = await platform.submit(page, { onLog: log });
  console.log(JSON.stringify({ quiz: page.url(), probe, ...report, submit: submitResult }, null, 2));
}

async function cmdRun(cfg, cli) {
  if (!cli.quiz) throw new Error('需要 --quiz <id|名称>');
  if (!cli['dry-run'] && !cli.yes) {
    throw new Error('`run` 会真实开始测验并填写。确认后加 --yes（只预演用 --dry-run）。');
  }
  const { page } = await connect(cfg.cdpUrl);
  const platform = withSelectors(resolvePlatform({ name: cfg.platform, url: page.url() }), cfg);
  log(`平台：${platform.label}`);

  const quiz = await platform.openQuiz(page, cfg.course, cli.quiz, { onLog: log });
  log(`测验：${quiz.id}`);

  if (!cli['dry-run']) {
    const startState = await platform.startQuiz(page, { onLog: log });
    if (!startState.started) {
      throw new Error(`未能开始测验（${startState.reason || '未知原因'}）。已交卷或页面结构变化？`);
    }
  }

  let questions = [];
  try {
    questions = await platform.extract(page);
  } catch (e) {
    if (!cli['dry-run']) throw e;
    const pageText = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 200));
    console.log(JSON.stringify({ dryRun: true, quizId: quiz.id, started: false, reason: e.message.split('\n')[0], pageText }, null, 2));
    return;
  }
  log(`抓取到 ${questions.length} 题`);
  if (!questions.length) throw new Error('没有抓到题目，请确认页面已进入答题状态');

  const { answers, source } = await buildAnswers(cfg, cli, questions, { platform });
  const outDir = cfg.outDir;
  writeJson(path.join(outDir, `questions-${quiz.id}.json`), { platform: platform.key, quizId: quiz.id, questions });
  writeJson(path.join(outDir, `answers-${quiz.id}.json`), {
    quizId: quiz.id,
    platform: platform.key,
    source,
    generatedAt: new Date().toISOString(),
    answers: questions.map((q) => ({ i: q.i, stem: q.stem, type: q.type, answer: answers[q.i] ?? '' })),
  });

  const { missing } = summarizeAnswer(questions, answers);
  if (missing.length) log(`⚠ 有 ${missing.length} 题没有答案：第 ${missing.join(', ')} 题（这些题会跳过）`);

  if (cli['dry-run']) {
    console.log(JSON.stringify({ dryRun: true, quizId: quiz.id, total: questions.length, missing, source }, null, 2));
    return;
  }

  const pace = defaultPace(cfg, platform);
  const pacer = makePacer(cfg, platform, pace);
  log(`节奏：${pace}`);

  let probe = null;
  if (platform.key === 'icourse163' && !cli['no-probe'] && pace !== 'slow') {
    probe = await platform.probeSpeed(page, cfg.probe);
    if (probe.limited) {
      await platform.dismissRateLimit(page);
      pacer.escalate('探测阶段快速点击触发');
    } else {
      log(`探测通过：${probe.clicks} 次快速点击内未触发限制 → 快速填写`);
    }
  }

  const report = await platform.fill(page, questions, answersArray(questions, answers), { pacer, onLog: log });
  let submitResult = null;
  if (cli.submit) submitResult = await platform.submit(page, { onLog: log });

  console.log(
    JSON.stringify(
      { quizId: quiz.id, probe, filled: report.ok, bad: report.bad, pacer: report.pacer, submit: submitResult },
      null,
      2,
    ),
  );
}

const COMMANDS = {
  doctor: cmdDoctor,
  launch: cmdLaunch,
  list: cmdList,
  extract: cmdExtract,
  answer: cmdAnswer,
  probe: cmdProbe,
  fill: cmdFill,
  run: cmdRun,
};

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const cmd = cli._[0];
  if (!cmd || cli.help || cmd === 'help') {
    console.log(HELP);
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`未知命令：${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }
  const cfg = loadConfig(cli);
  try {
    await fn(cfg, cli);
    // CDP 连接会挂住事件循环，命令结束后显式退出（先确保 stdout 刷完）
    await new Promise((r) => process.stdout.write('', r));
    process.exit(0);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
}

main();
