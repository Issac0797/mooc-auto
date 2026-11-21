// 把“答案”（字母串 / T / F）解析成页面上要点击的选项位置
export const CORRECT_RE = /(正确|对|√|是)/;
export const WRONG_RE = /(错误|错|×|否)/;

export function targetsFor(question, answer) {
  const opts = question.opts || [];
  if (!answer) return [];

  if (answer === 'T' || answer === 'F') {
    const iconCls = answer === 'T' ? 'u-icon-correct' : 'u-icon-wrong';
    const byIcon = opts.filter((o) => String(o.icon || '').includes(iconCls));
    if (byIcon.length === 1) return [byIcon[0].pos];
    // 兜底：选项文字写成“对/错”“正确/错误”的平台（如学习通）
    const re = answer === 'T' ? CORRECT_RE : WRONG_RE;
    const byText = opts.filter((o) => re.test(o.text || ''));
    if (byText.length === 1) return [byText[0].pos];
    return [];
  }

  const letters = [...new Set(String(answer).toUpperCase().match(/[A-H]/g) || [])].sort();
  return letters.filter((l) => opts.some((o) => String(o.pos).toUpperCase() === l));
}
