// 自适应调速器：先快后慢
// - fast: 快速填写（学习通等无风控场景，或慕课探测后确认无限制）
// - slow: 慢速填写（慕课触发并发限制后）
// - auto: 从 fast 开始；一旦探测到并发限制，永久降级到 slow（本次会话内）
import { sleep } from './util.mjs';

export const PACES = {
  fast: { delayMs: 120, jitterMs: 80 },
  slow: { delayMs: 1800, jitterMs: 400 },
};

export class Pacer {
  constructor({ mode = 'auto', fast = PACES.fast, slow = PACES.slow, onLog = () => {} } = {}) {
    if (!['auto', 'fast', 'slow'].includes(mode)) throw new Error(`未知 pacing: ${mode}`);
    this.mode = mode;
    this.fast = fast;
    this.slow = slow;
    this.current = mode === 'slow' ? 'slow' : 'fast';
    this.rateLimitHits = 0;
    this.clicks = 0;
    this.onLog = onLog;
  }

  get profile() {
    return this.current === 'slow' ? this.slow : this.fast;
  }

  /** 每次点击之后的等待时间（带随机抖动，避免机械节奏） */
  get delay() {
    const { delayMs, jitterMs } = this.profile;
    return delayMs + Math.floor(Math.random() * (jitterMs + 1));
  }

  /** 点击过一次之后调用 */
  async tick() {
    this.clicks++;
    await sleep(this.delay);
  }

  /** 探测/填写时发现并发限制 */
  escalate(reason = '') {
    this.rateLimitHits++;
    if (this.mode === 'fast') {
      this.onLog(`⚠ 检测到并发限制（${reason || '站点风控'}），但当前指定 fast 模式，请改用 --pace auto`);
      return false;
    }
    if (this.current === 'slow') return false;
    this.current = 'slow';
    this.onLog(`⚠ 检测到并发限制${reason ? `（${reason}）` : ''} → 切换为慢速填写：${this.slow.delayMs}ms/题`);
    return true;
  }

  summary() {
    return {
      mode: this.mode,
      finalPace: this.current,
      rateLimitHits: this.rateLimitHits,
      clicks: this.clicks,
      delayMs: this.profile.delayMs,
    };
  }
}
