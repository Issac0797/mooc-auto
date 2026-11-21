// 离线端到端：用本地夹具页面验证 extract / fill / 回读校验（不联网）
// 依赖：已有一个开启调试端口的浏览器（node mooc.mjs launch）
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import * as ic from '../src/platforms/icourse163.mjs';
import { Pacer } from '../src/pacer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';

const v = await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
const browser = await chromium.connectOverCDP(v.webSocketDebuggerUrl);
const context = browser.contexts()[0];
const page = await context.newPage();
const fileUrl = 'file:///' + path.join(here, 'fixture-quiz.html').replace(/\\/g, '/');
await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });

let pass = 0;
const fails = [];
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fails.push({ name, error: e.message }); console.log(`  ✗ ${name}: ${e.message.split('\n')[0]}`); }
};

console.log('extract');
const questions = await ic.extract(page);
check('抓到 3 题', () => assert.equal(questions.length, 3));
check('题干正确', () => assert.ok(questions[0].stem.includes('创新的核心')));
check('选项字母 A/B/C', () => assert.deepEqual(questions[0].opts.map((o) => o.pos), ['A', 'B', 'C']));
check('判断题图标被识别', () => {
  assert.ok(questions[2].opts[0].icon.includes('u-icon-wrong'));
  assert.ok(questions[2].opts[1].icon.includes('u-icon-correct'));
});

console.log('fill（含多选纠错与判断题图标）');
const pacer = new Pacer({ mode: 'fast', onLog: () => {} });
const answers = ['B', 'AC', 'T']; // 单选B、多选A+C、判断“正确”
const report = await ic.fill(page, questions, answers, { pacer, onLog: () => {} });
check('全部填写成功', () => assert.deepEqual(report.bad, [], JSON.stringify(report.bad)));
check('填写 3 题', () => assert.equal(report.ok, 3));

console.log('回读页面真实勾选状态');
const state = await page.evaluate(() => ({
  q1: [...document.querySelectorAll('.u-questionItem')[0].querySelectorAll('input')].map((i) => i.checked),
  q2: [...document.querySelectorAll('.u-questionItem')[1].querySelectorAll('input')].map((i) => i.checked),
  q3: [...document.querySelectorAll('.u-questionItem')[2].querySelectorAll('input')].map((i) => i.checked),
}));
check('单选=B', () => assert.deepEqual(state.q1, [false, true, false]));
check('多选=A+C（先点的脏选项 A 被保留、B 未选）', () => assert.deepEqual(state.q2, [true, false, true]));
check('判断=第二项（✓）', () => assert.deepEqual(state.q3, [false, true]));

await page.close();
console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
  console.log(JSON.stringify(fails, null, 2));
  process.exit(1);
}
process.exit(0);
