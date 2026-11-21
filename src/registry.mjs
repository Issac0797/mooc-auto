// 平台适配器注册表：按 URL / 显式参数选择
import * as icourse163 from './platforms/icourse163.mjs';
import * as chaoxing from './platforms/chaoxing.mjs';

export const PLATFORMS = { icourse163, chaoxing };

export function resolvePlatform({ name, url } = {}) {
  if (name) {
    const p = PLATFORMS[name];
    if (!p) throw new Error(`未知平台 "${name}"，可选：${Object.keys(PLATFORMS).join(', ')}`);
    return p;
  }
  const probe = url || '';
  if (icourse163.match(probe)) return icourse163;
  if (chaoxing.match(probe)) return chaoxing;
  // 默认按慕课处理（课程页最常见）
  return icourse163;
}
