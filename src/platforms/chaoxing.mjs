// 学习通（超星/泛雅）适配器 —— 按 2026 版 mooc2 作业页真实结构实现
//
// 结构要点（mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork）：
//   .questionLi[typename][data=qid]
//     h3.mark_name                     题干（含 "N. (单选题)" 前缀）
//     div.answerBg[onclick=addChoice]  选项，点击切换；内含 span.num_option[data=A] 与 .answer_p
//     input#answertype<qid>            题型：0 单选 / 1 多选 / 3 判断
//     input#answer<qid>                已选答案，如 "A"、"AC"
//   提交：a.completeBtn[onclick=submitValidate()]；暂存：a[onclick=saveWork()]
export const key = 'chaoxing';
export const label = '学习通（超星/泛雅）';

export function match(url) {
  return /chaoxing\.com|edu\.cn|xuexitong|mooc1|mooc2/i.test(url || '');
}

export const SEL = {
  question: '.questionLi',
  stem: 'h3.mark_name',
  option: 'div.answerBg',
  letter: 'span.num_option',
  optionText: '.answer_p',
  submitBtn: 'a.completeBtn',
  saveBtn: 'a[onclick*="saveWork"]',
};

const clean = (s) =>
  String(s || '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 学习通一般没有“并发限制”弹窗，保留统一接口 */
export async function detectRateLimit(page) {
  return await page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    if (/并发限制|操作过于频繁|请求过于频繁|请稍后再试/.test(t)) return { limited: true };
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

/** 抓题：返回 [{i,type,stem,opts:[{pos,text,img}],qid,current}] */
export async function extract(page) {
  await page.waitForSelector(SEL.question, { timeout: 40000 });
  await page.waitForTimeout(1200);
  return await page.evaluate(() => {
    const clean = (s) =>
      String(s || '')
        .replace(/[\u200b-\u200f\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const qs = [...document.querySelectorAll('.questionLi')];
    return qs.map((q, i) => {
      const qid = q.getAttribute('data') || (q.id || '').replace('question', '');
      const typename = q.getAttribute('typename') || '';
      const stemEl = q.querySelector('h3.mark_name');
      let stem = clean(stemEl ? stemEl.innerText : '');
      stem = stem.replace(/^\d+[.、]\s*/, '').replace(/^\((单选题|多选题|判断题|填空题)\)\s*/, '');
      const opts = [...q.querySelectorAll('div.answerBg')].map((d) => {
        const num = d.querySelector('span.num_option, span.num_option_dx');
        const txt = d.querySelector('.answer_p');
        return {
          pos: clean(num?.getAttribute('data') || num?.innerText || ''),
          text: clean(txt?.innerText || ''),
          img: d.querySelectorAll('img').length,
        };
      });
      const ansType = document.querySelector('#answertype' + qid)?.value ?? '';
      const cur = document.querySelector('#answer' + qid)?.value ?? '';
      return { i: i + 1, type: typename, stem, opts, qid, ansType, current: cur };
    });
  });
}

/** 当前已选答案：{qid: "A"} */
export async function currentAnswers(page) {
  return await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.questionLi')].map((q) => {
        const qid = q.getAttribute('data') || (q.id || '').replace('question', '');
        return [qid, document.querySelector('#answer' + qid)?.value ?? ''];
      }),
    ),
  );
}

/**
 * 填写：点击式选项。只点需要变化的项，避免误开关；
 * 多选题会把多余的勾选取消掉；每题回读隐藏域校验。
 */
export async function fill(page, questions, answers, { pacer, onLog = () => {} } = {}) {
  const { targetsFor } = await import('../targets.mjs');
  const total = await page.locator(SEL.question).count();
  if (total !== answers.length) throw new Error(`题数不一致：页面 ${total}，答案 ${answers.length}`);

  const log = [];
  // 学习通：判断题存 "true"/"false"，其余存字母 "A".."E"
  const tokensOf = (raw) => {
    const s = String(raw || '').toLowerCase();
    if (s.includes('true')) return ['true'];
    if (s.includes('false')) return ['false'];
    return [...new Set(s.toUpperCase().match(/[A-H]/g) || [])].map((x) => x.toLowerCase()).sort();
  };

  for (let i = 0; i < total; i++) {
    const q = questions[i];
    const want = targetsFor(q, answers[i]).map((x) => String(x).toLowerCase());
    if (!want.length) {
      log.push({ q: i + 1, answer: answers[i], ok: false, reason: '答案无法映射到选项' });
      continue;
    }

    const curRaw = await page.evaluate((qid) => document.querySelector('#answer' + qid)?.value ?? '', q.qid);
    const cur = tokensOf(curRaw);

    const toAdd = want.filter((p) => !cur.includes(p));
    const toRemove = cur.filter((p) => !want.includes(p));

    for (const pos of [...toRemove, ...toAdd]) {
      const ok = await page.evaluate(
        ({ qid, letter }) => {
          const q = [...document.querySelectorAll('.questionLi')].find(
            (x) => (x.getAttribute('data') || '') === qid,
          );
          if (!q) return false;
          const div = [...q.querySelectorAll('div.answerBg')].find((d) => {
            const n = d.querySelector('span.num_option, span.num_option_dx');
            const v = (n?.getAttribute('data') || n?.innerText || '').trim().toLowerCase();
            return v === String(letter).toLowerCase();
          });
          if (!div) return false;
          div.click();
          return true;
        },
        { qid: q.qid, letter: pos },
      );
      if (!ok) throw new Error(`第 ${i + 1} 题找不到选项 ${pos}`);
      await pacer.tick();

      const hit = await detectRateLimit(page);
      if (hit.limited) {
        await dismissRateLimit(page);
        pacer.escalate('点击选项后弹窗');
        await page.waitForTimeout(pacer.current === 'slow' ? 6000 : 2500);
      }
    }

    const after = await page.evaluate((qid) => document.querySelector('#answer' + qid)?.value ?? '', q.qid);
    const got = tokensOf(after);
    const ok = want.length === got.length && want.every((p) => got.includes(p));
    log.push({ q: i + 1, type: q.type, answer: answers[i], picked: got.join(''), ok });
  }

  const bad = log.filter((x) => !x.ok);
  return { total, ok: log.length - bad.length, bad, pacer: pacer.summary(), log };
}

/** 探测：学习通默认 fast，不做频控探测 */
export async function probeSpeed() {
  return { limited: false, skipped: true, reason: '学习通默认快速填写，不做频控探测' };
}

/** 提交作业（a.completeBtn → submitValidate()，可能有二次确认） */
export async function submit(page, { onLog = () => {} } = {}) {
  const btn = page.locator(SEL.submitBtn).first();
  if (!(await btn.count())) return { score: null, error: '未找到提交按钮' };
  await btn.click({ force: true });
  onLog('已点击「提交」');
  await page.waitForTimeout(2500);

  for (let i = 0; i < 8; i++) {
    // 只在弹层里找“确定/确认”，避免误点页面顶部的“提交”
    const done = await page.evaluate(() => {
      const dlgSel = '[class*=layer], [class*=dialog], [class*=pop], [class*=modal], .layui-layer, #popok';
      const dlgs = [...document.querySelectorAll(dlgSel)].filter((d) => d.offsetParent !== null);
      for (const d of dlgs) {
        const btn = [...d.querySelectorAll('a,button,span,div')].find((e) => /^\s*(确定|确认|提交)\s*$/.test((e.innerText || '').trim()));
        if (btn) { btn.click(); return true; }
      }
      return false;
    });
    if (done) { onLog('已确认提交'); await page.waitForTimeout(2500); break; }
    await page.waitForTimeout(800);
  }

  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => (document.body.innerText || '').replace(/\n{2,}/g, '\n'));
  const m = text.match(/(提交成功|作业已提交|已提交|本次得分|得分)[^\n]{0,40}/);
  return { score: m ? m[0] : null, url: page.url(), tail: text.slice(-400) };
}

/* ---------- 以下为课程/作业定位辅助 ---------- */

export async function listQuizzes(page) {
  const text = await page.evaluate(() => document.body.innerText);
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((l) => l && /(测验|作业|考试)/.test(l) && l.length < 40)
    .map((name) => ({ name }));
}

/** --quiz 传作业页 URL（推荐）或课程页 URL */
export async function openQuiz(page, cfg, target, { onLog = () => {} } = {}) {
  const url = String(target);
  if (!/^https?:\/\//.test(url)) {
    throw new Error('学习通：请把作业页 URL 直接传给 --quiz（在作业列表点开那一条后，地址栏里 /mooc2/work/dowork?... 的地址）');
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  return { id: (url.match(/workId=(\d+)/) || [])[1] || url, url: page.url() };
}

export async function startQuiz(page) {
  const n = await page.locator(SEL.question).count();
  if (n > 0) return { started: true, alreadyRunning: true };
  const enter = page.locator('a, button, span').filter({ hasText: /(开始答题|开始作业|进入作业|继续作答)/ }).first();
  if (await enter.count()) {
    await enter.click({ force: true });
    await page.waitForTimeout(3000);
  }
  return { started: (await page.locator(SEL.question).count()) > 0 };
}
