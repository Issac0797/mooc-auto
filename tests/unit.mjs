// 单元自测：不联网、不碰浏览器
import assert from 'node:assert';
import { norm, normalizeChoice, normalizeJudge, extractJsonObject, parseArgs, maskKey } from '../src/util.mjs';
import { coerceAnswer } from '../src/llm.mjs';
import { targetsFor } from '../src/targets.mjs';
import { resolveByKey } from '../src/keydb.mjs';

let pass = 0;
const fails = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fails.push({ name, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`);
  }
}

const judgeIcon = {
  i: 1,
  type: '判断(1分)',
  stem: '测试判断题',
  opts: [
    { pos: 'A', text: '', icon: 'u-icon-wrong' },
    { pos: 'B', text: '', icon: 'u-icon-correct' },
  ],
};
const judgeText = {
  i: 2,
  type: '判断',
  stem: '学习通风格判断题',
  opts: [
    { pos: 'A', text: '对', icon: '' },
    { pos: 'B', text: '错', icon: '' },
  ],
};
const single = {
  i: 3,
  type: '单选(1分)',
  stem: '测试单选',
  opts: [
    { pos: 'A', text: '甲' },
    { pos: 'B', text: '乙' },
    { pos: 'C', text: '丙' },
  ],
};
const multi = {
  i: 4,
  type: '多选(2分)',
  stem: '测试多选',
  opts: [
    { pos: 'A', text: '甲' },
    { pos: 'B', text: '乙' },
    { pos: 'C', text: '丙' },
  ],
};

console.log('util');
t('norm 去零宽与标点', () => {
  assert.equal(norm('\u200b创新（方法） 单元'), '创新方法单元');
});
t('normalizeChoice 收字母并排序', () => {
  assert.equal(normalizeChoice('c,a', ['A', 'B', 'C']), 'AC');
  assert.equal(normalizeChoice(['A', 'C'], ['A', 'B', 'C']), 'AC');
  assert.equal(normalizeChoice('ACD', ['A', 'B', 'C']), 'AC');
});
t('normalizeJudge 识别中英文', () => {
  assert.equal(normalizeJudge('正确'), 'T');
  assert.equal(normalizeJudge('错误'), 'F');
  assert.equal(normalizeJudge('T'), 'T');
  assert.equal(normalizeJudge('false'), 'F');
});
t('extractJsonObject 兼容代码块', () => {
  assert.deepEqual(extractJsonObject('```json\n{"1":"A"}\n```'), { 1: 'A' });
  assert.deepEqual(extractJsonObject('好的：{"2":"T"} 完毕'), { 2: 'T' });
  assert.equal(extractJsonObject('没有 JSON'), null);
});
t('parseArgs 支持 = 与空格', () => {
  const a = parseArgs(['run', '--quiz', 'x', '--pace=slow', '--submit']);
  assert.equal(a._[0], 'run');
  assert.equal(a.quiz, 'x');
  assert.equal(a.pace, 'slow');
  assert.equal(a.submit, true);
});
t('maskKey 不泄露完整 key', () => {
  const masked = maskKey('sk-1234567890abcdef');
  assert.ok(!masked.includes('1234567890'), masked);
});

console.log('coerceAnswer');
t('单选字母', () => assert.equal(coerceAnswer(single, 'c'), 'C'));
t('单选选项文字', () => assert.equal(coerceAnswer(single, '丙'), 'C'));
t('多选数组', () => assert.equal(coerceAnswer(multi, ['a', 'c']), 'AC'));
t('判断题 T/F', () => assert.equal(coerceAnswer(judgeIcon, '正确'), 'T'));
t('判断题回字母 → 按图标换算', () => assert.equal(coerceAnswer(judgeIcon, 'B'), 'T'));
t('判断题回字母 → 按文字换算', () => assert.equal(coerceAnswer(judgeText, 'B'), 'F'));

console.log('targetsFor');
t('图标模式 正确=第2项', () => assert.deepEqual(targetsFor(judgeIcon, 'T'), ['B']));
t('图标模式 错误=第1项', () => assert.deepEqual(targetsFor(judgeIcon, 'F'), ['A']));
t('文字模式 对=第1项', () => assert.deepEqual(targetsFor(judgeText, 'T'), ['A']));
t('单选映射', () => assert.deepEqual(targetsFor(single, 'C'), ['C']));
t('多选映射', () => assert.deepEqual(targetsFor(multi, 'AC'), ['A', 'C']));
t('无解返回空', () => assert.deepEqual(targetsFor(multi, ''), []));

console.log('keydb');
t('按题干命中并用选项文字定位字母', () => {
  const db = {
    entries: [
      {
        q: '创新的核心是（ ）。',
        type: '单选题',
        answer: '创新思维',
        options: { A: '创新过程', B: '创新对象', C: '创新思维', D: '创新能力' },
        letters: ['C'],
        src: 'T',
      },
    ],
    byStem: new Map(),
  };
  db.byStem.set(norm('创新的核心是（ ）。'), db.entries[0]);
  const live = {
    i: 1,
    type: '单选(1分)',
    stem: '创新的核心是（　）。',
    opts: [
      { pos: 'A', text: '创新能力' },
      { pos: 'B', text: '创新思维' },
      { pos: 'C', text: '创新过程' },
      { pos: 'D', text: '创新对象' },
    ],
  };
  const r = resolveByKey(db, live);
  assert.equal(r.answer, 'B', '应把答案文字映射到当前选项顺序');
});

console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
  console.log(JSON.stringify(fails, null, 2));
  process.exit(1);
}
