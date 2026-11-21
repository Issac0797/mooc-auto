// 学习通（超星/泛雅 chaoxing）适配器
// 说明：学习通页面皮肤较多（作业、考试、章节测验结构不同），这里用启发式结构识别，
//      可通过 config.selectors 覆盖；默认节奏为 fast（该平台一般没有慕课那种点击频控）。
export const key = 'chaoxing';
export const label = '学习通（超星/泛雅）';

export function match(url) {
  return /chaoxing\.com|edu\.cn|xuexitong|mooc1/i.test(url || '');
}

export const SEL = {
  // 常见题目容器（多套皮肤）
  question: 'div.questionLi, div.TiMu, div.question-item, div[id^="question"], div[class*="questionLi"], div.mark_item',
  stem: '.Zy_TItle, .mark_name, .stem, .question-title, h3',
  option: 'ul.answerList li, .answerList li, .option, li',
  submit: 'a:has-text("提交"), button:has-text("提交"), a:has-text("交卷"), button:has-text("交卷")',
  doneText: '提交成功|已完成|本次得分|成绩',
};

/** 学习通一般没有“并发限制”弹窗，保留同样接口以兼容 */
export async function detectRateLimit(page) {
  return await page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    if (/并发限制|操作过于频繁|请求过于频繁|请稍后再试/.test(text)) return { limited: true };
    return { limited: false };
  });
}

export async function dismissRateLimit(page) {
  const cands = page.locator('a, button, span, div').filter({ hasText: /^\s*(确定|知道了|关闭)\s*$/ });
  const n = await cands.count();
  let last = -1;
  for (let i = 0; i < n; i++) if (await cands.nth(i).isVisible().catch(() => false)) last = i;
  if (last >= 0) await cands.nth(last).click({ force: true }).catch(() => {});
  return last >= 0;
}

/** 启发式抓题 */
export async function extract(page) {
  await page.waitForTimeout(800);
  const questions = await page.evaluate((S) => {
    const clean = (s) => String(s || '').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    const containers = [...document.querySelectorAll(S.question)].filter((el) =>
      el.querySelector('input[type=radio], input[type=checkbox]'),
    );
    return containers.map((el, i) => {
      const text = clean(el.innerText);
      const stemEl = el.querySelector(S.stem);
      let stem = clean(stemEl?.innerText) || text;
      const optEls = [...el.querySelectorAll(S.option)].filter((li) => li.querySelector('input[type=radio], input[type=checkbox]'));
      const opts = optEls.map((li, k) => {
        const input = li.querySelector('input');
        let t = clean(li.innerText);
        // 去掉可能的字母前缀，如 "A." "A、"
        t = t.replace(/^[A-H][.、,，)]\s*/, '').trim();
        return { pos: String.fromCharCode(65 + k), text: t, icon: '', inputType: input?.type || '' };
      });
      const type = /多选/.test(text) ? '多选' : /判断/.test(text) ? '判断' : '单选';
      // 题干尽量只取标题部分
      const idx = stem.indexOf('A.');
      if (idx > 10) stem = stem.slice(0, idx).trim();
      return { i: i + 1, type, stem, opts };
    });
  }, SEL);
  return questions.filter((q) => q.stem && q.opts.length >= 2);
}

/** 学习通不需要探测：直接按 fast 节奏填 */
export async function probeSpeed() {
  return { limited: false, skipped: true, reason: '学习通默认快速填写，不做频控探测' };
}

export async function fill(page, questions, answers, { pacer, onLog = () => {} } = {}) {
  const { targetsFor } = await import('../targets.mjs');
  const containers = page.locator(SEL.question).filter({ has: page.locator('input[type=radio], input[type=checkbox]') });
  const total = await containers.count();
  if (total !== answers.length) throw new Error(`题数不一致：页面 ${total}，答案 ${answers.length}`);

  const log = [];
  for (let i = 0; i < total; i++) {
    const q = questions[i];
    const targets = targetsFor(q, answers[i]);
    if (!targets.length) {
      log.push({ q: i + 1, answer: answers[i], ok: false, reason: '答案无法映射到选项' });
      continue;
    }
    const box = containers.nth(i);
    const lis = box.locator(SEL.option.split(',').map((s) => s.trim()).join(', ')).filter({ has: page.locator('input[type=radio], input[type=checkbox]') });
    for (const pos of targets) {
      const k = pos.toUpperCase().charCodeAt(0) - 65;
      const li = lis.nth(k);
      if (!(await li.count())) continue;
      const already = await li.locator('input').isChecked().catch(() => false);
      if (already) continue;
      await li.click({ force: true }).catch(async () => {
        await li.locator('input').click({ force: true }).catch(() => {});
      });
      await pacer.tick();
    }
    const picked = [];
    const n = await lis.count();
    for (let k = 0; k < n; k++) {
      if (await lis.nth(k).locator('input').isChecked().catch(() => false)) picked.push(String.fromCharCode(65 + k));
    }
    const ok = targets.every((t) => picked.includes(t));
    log.push({ q: i + 1, answer: answers[i], picked, ok });
  }
  const bad = log.filter((x) => !x.ok);
  return { total, ok: log.length - bad.length, bad, pacer: pacer.summary(), log };
}

export async function submit(page, { onLog = () => {} } = {}) {
  const btn = page.locator(SEL.submit).first();
  if (!(await btn.count())) return { score: null, error: '未找到提交按钮' };
  await btn.click({ force: true });
  onLog('已点击提交');
  await page.waitForTimeout(2500);
  // 确认弹窗
  for (let i = 0; i < 6; i++) {
    const ok = page.locator('a, button, span, div').filter({ hasText: /^\s*(确定|确认|提交)\s*$/ }).last();
    if (await ok.count() && (await ok.isVisible().catch(() => false))) {
      await ok.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2000);
      break;
    }
    await page.waitForTimeout(800);
  }
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/(本次得分|得分)[^\n]{0,40}/);
  return { score: m ? m[0] : null, url: page.url(), text: text.slice(-300) };
}

export async function listQuizzes(page) {
  const text = await page.evaluate(() => document.body.innerText);
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.filter((l) => /(作业|测验|考试)/.test(l) && l.length < 40).map((name) => ({ name }));
}

export async function openQuiz(page, cfg, target) {
  // 学习通通常需要从课程目录点进去，这里支持直接给出 URL 或名称点击
  if (/^https?:\/\//.test(String(target))) {
    await page.goto(String(target), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    return { id: String(target), url: page.url() };
  }
  const link = page.locator(`a:has-text("${target}"), span:has-text("${target}")`).first();
  if (await link.count()) {
    await link.click({ force: true });
    await page.waitForTimeout(3000);
    return { id: page.url(), url: page.url() };
  }
  throw new Error('学习通：请直接用 --quiz "<作业页面URL>" 指定目标页面');
}

export async function startQuiz(page) {
  const n = await page.locator(SEL.question).count();
  if (n > 0) return { started: true, alreadyRunning: true };
  const enter = page.locator('a, button, span').filter({ hasText: /(开始答题|开始作业|进入作业|开始考试|开始测验)/ }).first();
  if (await enter.count()) {
    await enter.click({ force: true });
    await page.waitForTimeout(3000);
  }
  return { started: (await page.locator(SEL.question).count()) > 0 };
}
