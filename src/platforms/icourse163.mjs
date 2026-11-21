// 中国大学MOOC（icourse163）适配器
import { navigate } from '../browser.mjs';
import { targetsFor } from '../targets.mjs';

export const key = 'icourse163';
export const label = '中国大学MOOC（爱课程）';

export function match(url) {
  return /icourse163\.org/i.test(url || '');
}

export const DEFAULT_COURSE = { courseId: 'NUIST-1206810807', tid: '1487847445', baseUrl: 'https://www.icourse163.org' };

export const SEL = {
  question: '.u-questionItem',
  type: '.j-qacate',
  stem: '.j-richTxt',
  optionPos: '.optionPos',
  optionCnt: '.optionCnt',
  submit: '.j-submitBtn',
  pledgeInput: '#agreeCheck',
  pledgeLabel: 'label.j-agreeCt',
  startBtn: 'a.j-startBtn',
  row: '.j-titleBox',
  rowName: 'h4.j-name',
  rowBtn: 'a.j-quizBtn',
};

const QUIZ_URL = (cfg, id) =>
  `${cfg.baseUrl}/learn/${cfg.courseId}?tid=${cfg.tid}#/learn/quiz?id=${id}`;
const LIST_URL = (cfg) => `${cfg.baseUrl}/learn/${cfg.courseId}?tid=${cfg.tid}#/learn/testlist`;

/** 检测“并发限制”弹窗（慕课的反刷题风控） */
export async function detectRateLimit(page) {
  return await page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    if (!/并发限制/.test(text)) return { limited: false };
    return { limited: true, text: '并发限制，请稍后再试' };
  });
}

/** 关掉“并发限制”弹窗（点最后一个可见的“确定”） */
export async function dismissRateLimit(page) {
  const cands = page.locator('a, button, span, div, p').filter({ hasText: /^\s*确定\s*$/ });
  const n = await cands.count();
  let lastVisible = -1;
  for (let i = 0; i < n; i++) {
    if (await cands.nth(i).isVisible().catch(() => false)) lastVisible = i;
  }
  if (lastVisible >= 0) await cands.nth(lastVisible).click({ force: true }).catch(() => {});
  return lastVisible >= 0;
}

export async function listQuizzes(page, cfg, { onLog = () => {} } = {}) {
  await navigate(page, LIST_URL(cfg), {
    onLog,
    waitFor: () => document.querySelectorAll('.j-titleBox').length > 0,
  });
  await page.waitForTimeout(1200);
  return await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.j-titleBox')];
    return rows.map((r) => {
      const name = (r.querySelector('h4.j-name')?.innerText || '').trim();
      const text = (r.innerText || '').replace(/\s+/g, ' ');
      const deadline = (text.match(/截止时间：\s*([\d/]+\s*[\d:]*)/) || [])[1] || '';
      const score = (text.match(/测验得分：\s*([\d.]+)分/) || [])[1] || '';
      const attempts = (text.match(/有效提交次数：\s*(\d+)/) || [])[1] || '';
      return { name, deadline, score, attempts, text: text.slice(0, 120) };
    }).filter((r) => r.name);
  });
}

/** 打开某个测验（支持 id 或名称片段），返回 { id, url } */
export async function openQuiz(page, cfg, target, { onLog = () => {} } = {}) {
  if (/^\d+$/.test(String(target))) {
    const url = QUIZ_URL(cfg, target);
    await navigate(page, url, { onLog, waitFor: () => document.querySelectorAll('.u-questionItem, #agreeCheck, .j-submitBtn').length > 0 });
    await page.waitForTimeout(1200);
    return { id: String(target), url };
  }
  await navigate(page, LIST_URL(cfg), { onLog, waitFor: () => document.querySelectorAll('.j-titleBox').length > 0 });
  await page.waitForTimeout(1000);
  const row = page.locator(SEL.row).filter({ hasText: target }).first();
  if (!(await row.count())) {
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('h4.j-name')].map((n) => n.innerText.trim()).filter(Boolean),
    );
    throw new Error(`找不到测验「${target}」。现有：${names.join(' | ')}`);
  }
  await row.locator(SEL.rowBtn).first().click({ force: true });
  await page.waitForTimeout(2500);
  const id = (page.url().match(/quiz\?id=(\d+)/) || [])[1];
  if (!id) throw new Error('点击后未能进入测验页面');
  return { id, url: page.url() };
}

/** 勾选诚信承诺并开始测验 */
export async function startQuiz(page, { onLog = () => {} } = {}) {
  const already = await page.locator(SEL.question).count();
  if (already > 0) return { started: true, alreadyRunning: true };

  const hasPledge = await page.locator(SEL.pledgeInput).count();
  if (!hasPledge && !(await page.locator(SEL.startBtn).count())) {
    return { started: false, reason: '不是测验开始页（可能已在作答或已交卷）' };
  }
  for (let i = 0; i < 8 && hasPledge; i++) {
    const checked = await page.evaluate(() => document.querySelector('#agreeCheck')?.checked ?? null);
    if (checked === true) break;
    await page.locator(SEL.pledgeLabel).first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(700);
  }
  onLog('已勾选学术诚信承诺，点击「开始测验」');
  for (let i = 0; i < 5; i++) {
    if ((await page.locator(SEL.question).count()) > 0) break;
    await page.locator(SEL.startBtn).first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  const n = await page.locator(SEL.question).count();
  return { started: n > 0, count: n };
}

/** 抓取题目 */
export async function extract(page) {
  await page.waitForSelector(SEL.question, { timeout: 30000 });
  return await page.evaluate((S) => {
    const clean = (s) =>
      String(s || '')
        .replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return [...document.querySelectorAll(S.question)].map((q, i) => {
      const type = clean(q.querySelector(S.type)?.innerText).replace(/\s+/g, '');
      const stem = clean(q.querySelector(S.stem)?.innerText);
      const opts = [...q.querySelectorAll('li')].map((li) => {
        const cnt = li.querySelector(S.optionCnt);
        const span = cnt ? cnt.querySelector('span') : null;
        return {
          pos: clean(li.querySelector(S.optionPos)?.innerText).replace('.', ''),
          text: clean(cnt?.innerText),
          icon: span ? String(span.className) : '',
          inputType: li.querySelector('input')?.type || '',
        };
      });
      return { i: i + 1, type, stem, opts };
    });
  }, SEL);
}

/**
 * 快速探测：连续快速点前面几题，观察是否弹“并发限制”。
 * 返回 { limited, ms, clicks }；探测过的题会被 run 流程随后覆盖。
 */
export async function probeSpeed(page, { clicks = 3, intervalMs = 150 } = {}) {
  // 只挑单选题探测：多选题点错会残留脏选项
  const radioIdx = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.u-questionItem').forEach((q, i) => {
      const inputs = [...q.querySelectorAll('li input')];
      if (inputs.length && inputs.every((x) => x.type === 'radio')) out.push(i);
    });
    return out;
  });
  const targets = radioIdx.slice(0, Math.max(1, clicks));
  if (!targets.length) return { limited: false, skipped: true, clicks: 0 };

  const started = Date.now();
  for (const idx of targets) {
    await page.evaluate((i) => {
      const li = document.querySelectorAll('.u-questionItem')[i]?.querySelectorAll('li')?.[0];
      li?.querySelector('input')?.click();
    }, idx);
    await page.waitForTimeout(intervalMs);
  }
  const hit = await detectRateLimit(page);
  return { limited: hit.limited, clicks: targets.length, ms: Date.now() - started, intervalMs };
}

/**
 * 慢速/快速填写。pacer 决定节奏；一旦出现并发限制会升级为慢速并重试当前选项。
 */
export async function fill(page, questions, answers, { pacer, onLog = () => {} } = {}) {
  const total = await page.locator(SEL.question).count();
  if (total !== answers.length) throw new Error(`题数不一致：页面 ${total}，答案 ${answers.length}`);

  const metaOf = async (i) =>
    await page.evaluate((idx) => {
      const q = document.querySelectorAll('.u-questionItem')[idx];
      return [...q.querySelectorAll('li')].map((li, k) => {
        const cnt = li.querySelector('.optionCnt');
        const sp = cnt ? cnt.querySelector('span') : null;
        return {
          k,
          pos: (li.querySelector('.optionPos')?.innerText || '').trim().replace('.', ''),
          icon: sp ? String(sp.className) : '',
          text: (cnt?.innerText || '').trim(),
          checked: !!li.querySelector('input:checked'),
        };
      });
    }, i);

  const clickOption = async (i, k) =>
    await page.evaluate(
      ({ idx, kk }) => {
        const input = document.querySelectorAll('.u-questionItem')[idx]?.querySelectorAll('li')[kk]?.querySelector('input');
        if (!input) return false;
        input.click();
        return true;
      },
      { idx: i, kk: k },
    );

  const log = [];
  for (let i = 0; i < total; i++) {
    const ans = answers[i];
    const targets = targetsFor(questions[i], ans);
    if (!targets.length) {
      log.push({ q: i + 1, answer: ans, ok: false, reason: '答案无法映射到选项' });
      continue;
    }
    let meta = await metaOf(i);
    const want = targets.map((pos) => meta.find((m) => m.pos === pos)?.k).filter((k) => k !== undefined);

    for (const k of want) {
      meta = await metaOf(i);
      if (meta[k].checked) continue;
      await clickOption(i, k);
      await pacer.tick();

      const hit = await detectRateLimit(page);
      if (hit.limited) {
        await dismissRateLimit(page);
        pacer.escalate('点击选项后弹窗');
        await page.waitForTimeout(pacer.current === 'slow' ? 6000 : 2500);
        meta = await metaOf(i);
        if (!meta[k].checked) {
          await clickOption(i, k);
          await pacer.tick();
        }
      }
    }

    // 多选题防脏：把不在目标里的勾选取消掉
    const isMulti = await page.evaluate(
      (idx) => [...document.querySelectorAll('.u-questionItem')[idx].querySelectorAll('li input')].some((x) => x.type === 'checkbox'),
      i,
    );
    if (isMulti) {
      meta = await metaOf(i);
      for (const m of meta.filter((x) => x.checked && !want.includes(x.k))) {
        await clickOption(i, m.k);
        await pacer.tick();
      }
    }

    meta = await metaOf(i);
    const has = meta.filter((m) => m.checked).map((m) => m.pos);
    const ok = want.length === has.length && want.every((k) => meta[k].checked);
    log.push({ q: i + 1, answer: ans, picked: has, ok });
  }

  const bad = log.filter((x) => !x.ok);
  return { total, ok: log.length - bad.length, bad, pacer: pacer.summary(), log };
}

/** 交卷并读取得分 */
export async function submit(page, { onLog = () => {} } = {}) {
  const bodyText = async () => await page.evaluate(() => document.body.innerText);
  const clickExact = async (text) => {
    const cands = page.locator('a, button, span, div, p').filter({ hasText: new RegExp('^\\s*' + text + '\\s*$') });
    const n = await cands.count();
    let last = -1;
    for (let i = 0; i < n; i++) if (await cands.nth(i).isVisible().catch(() => false)) last = i;
    if (last >= 0) { await cands.nth(last).click({ force: true, timeout: 5000 }).catch(() => {}); return true; }
    return false;
  };

  await page.locator(SEL.submit).first().click({ force: true });
  await page.waitForTimeout(1800);
  onLog('已点击「提交答案」');

  for (let i = 0; i < 50; i++) {
    const t = await bodyText();
    if (/确定要提交|不可修改/.test(t)) {
      await clickExact('确定');
      onLog('已确认提交');
      await page.waitForTimeout(2500);
      continue;
    }
    if (/并发限制/.test(t)) {
      await dismissRateLimit(page);
      onLog('交卷时遇到并发限制，等待后重试');
      await page.waitForTimeout(4000);
      await page.locator(SEL.submit).first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(2000);
      continue;
    }
    if (/本次得分为|提交成功|再做一次/.test(t)) break;
    await page.waitForTimeout(900);
  }
  const t = await bodyText();
  const m = t.match(/本次得分为[^\n]{0,60}/);
  return { score: m ? m[0] : null, url: page.url() };
}
