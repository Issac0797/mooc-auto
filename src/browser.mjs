// 浏览器连接：接管已开调试端口的浏览器，或自行拉起一个独立浏览器
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { sleep } from './util.mjs';

export const DEFAULT_CDP = 'http://127.0.0.1:9222';

async function wsEndpoint(cdpUrl) {
  const root = String(cdpUrl).replace(/\/+$/, '');
  let version;
  try {
    const res = await fetch(`${root}/json/version`, { signal: AbortSignal.timeout(2500) });
    version = await res.json();
  } catch {
    throw new Error(
      `连不上调试端点 ${root}。\n` +
        `请先启动带调试端口的浏览器，例如：\n` +
        `  mooc.mjs launch\n` +
        `或手动：msedge.exe --remote-debugging-port=9222 --user-data-dir=<独立目录>\n` +
        `注意：Chrome/Edge 136+ 在“默认用户数据目录”下会忽略该参数，必须使用独立目录。`,
    );
  }
  if (!version?.webSocketDebuggerUrl) throw new Error(`端点 ${root} 未返回 webSocketDebuggerUrl`);
  return version.webSocketDebuggerUrl;
}

/** 接管已运行的浏览器；返回 { browser, context, page } */
export async function connect(cdpUrl = DEFAULT_CDP) {
  const ws = await wsEndpoint(cdpUrl);
  const browser = await chromium.connectOverCDP(ws, { timeout: 15000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error('浏览器没有可用的上下文');
  const pages = context.pages();
  // 优先挑平台的课程页，其次任意 http 页面（跳过 file:// 等测试页）
  const httpPages = pages.filter((p) => /^https?:\/\//i.test(p.url()));
  const page =
    httpPages.find((p) => /learn\/(icourse163|chaoxing)|mooc1?\.|course\//i.test(p.url())) ??
    httpPages[0] ??
    pages[0];
  if (!page) throw new Error('浏览器没有打开的标签页，请先打开目标课程页面');
  await page.bringToFront();
  return { browser, context, page };
}

/** 用独立配置目录拉起浏览器（不碰你日常用的那个），首次需手动登录一次 */
export async function launch({ cdpPort = 9222, profileDir, browserPath, url, headed = true } = {}) {
  const exe =
    browserPath ||
    [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].find((p) => fs.existsSync(p));
  if (!exe) throw new Error('找不到 Edge/Chrome，请用 --browser-path 指定可执行文件');

  const dir = profileDir || `${process.cwd()}\\browser-profile`;
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ];
  if (url) args.push(url);

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const root = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${root}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { exe, profileDir: dir, cdp: root, pid: child.pid };
    } catch {
      /* 还没起来 */
    }
  }
  throw new Error('浏览器已拉起，但调试端口 40 秒内未就绪');
}

/** 该浏览器里是否已有平台登录态 */
export async function sessionInfo(context) {
  const cookies = await context.cookies().catch(() => []);
  const hasIcourse163 = cookies.some((c) => /icourse163\.org/.test(c.domain) && c.name === 'STUDY_SESS');
  // 学习通登录前也会有 JSESSIONID/fid，必须看真正的账号态 cookie
  const CX_KEYS = ['_uid', 'uf', 'p_auth_token', '_d', 'cx_p_token'];
  const hasChaoxing = cookies.some(
    (c) => /chaoxing\.com|edu\.cn/.test(c.domain) && CX_KEYS.includes(c.name) && String(c.value || '').length > 0,
  );
  return { cookieCount: cookies.length, hasIcourse163, hasChaoxing };
}

export async function screenshot(page, file) {
  if (!file) return null;
  fs.mkdirSync(requireDirname(file), { recursive: true });
  await page.screenshot({ path: file });
  return file;
}

/**
 * 稳健导航：SPA 只改 hash 时 page.goto 可能卡住，
 * 这里给 goto 加超时兜底，超时后改用 location.href 跳转，并可等待某个条件出现。
 */
export async function navigate(page, url, { waitFor, timeoutMs = 20000, onLog = () => {} } = {}) {
  const gotoP = page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    .then(() => 'ok')
    .catch((e) => {
      onLog(`goto 失败：${String(e.message || e).split('\n')[0]}`);
      return 'fail';
    });
  const raceP = Promise.race([gotoP, sleep(timeoutMs + 3000).then(() => 'timeout')]);
  const r = await raceP;
  if (r !== 'ok') {
    onLog(`导航 ${r === 'timeout' ? '超时' : '失败'}，改用 location.href 兜底`);
    await page.evaluate((u) => { window.location.href = u; }, url).catch(() => {});
    await sleep(1800);
  }
  if (waitFor) {
    await page.waitForFunction(waitFor, { timeout: timeoutMs }).catch(() => {});
  }
  return r;
}

function requireDirname(file) {
  const idx = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'));
  return idx > 0 ? file.slice(0, idx) : '.';
}
