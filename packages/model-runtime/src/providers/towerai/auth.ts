/**
 * TowerAI token refresh via headless browser (puppeteer-core).
 *
 * Adapted from the official TowerAI SDK (E:\workspace\GitRepository\TowerAI\src\auth.ts).
 * Lazily imports puppeteer-core so the dependency is optional — only servers that
 * opt into auto-refresh (TOWERAI_AUTO_REFRESH=1) need the package + a Chrome binary.
 *
 * Strategy:
 * 1. Launch Chrome (preferring the user's existing profile via userDataDir so the
 *    auth.js cookie is reused — usually no OA login is required).
 * 2. Navigate to ${baseUrl}/chat. If redirected to OA SSO, fill credentials.
 * 3. Read `Token` from `localStorage.getItem('token')`.
 * 4. Capture `X-lobe-chat-auth` from outgoing requests via CDP Network domain
 *    (the value is computed client-side and cannot be derived from Token alone).
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface TowerAITokens {
  authToken: string;
  token: string;
}

export interface RefreshOptions {
  baseUrl?: string;
  chromePath?: string;
  headless?: boolean;
  oaPassword?: string;
  oaUsername?: string;
  timeoutMs?: number;
  userDataDir?: string;
}

const DEFAULT_BASE_URL = 'https://tower-ai.yottastudios.com';
const REFRESH_COOLDOWN_MS = 30_000;

const CHROME_PATHS: Record<string, string[]> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

function findChrome(): string {
  return (CHROME_PATHS[platform()] ?? CHROME_PATHS.linux)[0];
}

let inflight: Promise<TowerAITokens> | null = null;
let lastFinishedAt = 0;

export function refreshTowerAITokens(options: RefreshOptions = {}): Promise<TowerAITokens> {
  if (inflight) return inflight;
  if (Date.now() - lastFinishedAt < REFRESH_COOLDOWN_MS) {
    return Promise.reject(
      new Error(
        `[TowerAI] refresh on cooldown (${REFRESH_COOLDOWN_MS}ms) — last attempt likely failed; check OA credentials or run the SDK refresher manually`,
      ),
    );
  }
  inflight = doRefresh(options).finally(() => {
    inflight = null;
    lastFinishedAt = Date.now();
  });
  return inflight;
}

async function doRefresh(options: RefreshOptions): Promise<TowerAITokens> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const chromePath = options.chromePath ?? process.env.TOWERAI_CHROME_PATH ?? findChrome();
  const userDataDir =
    options.userDataDir ??
    process.env.TOWERAI_CHROME_PROFILE ??
    join(homedir(), '.tower-ai-chrome');
  const oaUsername = options.oaUsername ?? process.env.TOWERAI_OA_USERNAME;
  const oaPassword = options.oaPassword ?? process.env.TOWERAI_OA_PASSWORD;
  const headless = options.headless ?? !!(oaUsername && oaPassword);

  let puppeteer: typeof import('puppeteer-core');
  try {
    puppeteer = (await import('puppeteer-core' as string)) as typeof import('puppeteer-core');
  } catch {
    throw new Error(
      '[TowerAI] auto-refresh requires puppeteer-core. Install it: pnpm add -w puppeteer-core',
    );
  }

  console.info(`[TowerAI] launching Chrome for token refresh (headless=${headless})`);
  const browser = await puppeteer.launch({
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions'],
    executablePath: chromePath,
    headless,
    userDataDir,
  });

  try {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    let captured = '';
    cdp.on('Network.requestWillBeSent', (params: any) => {
      const v = params.request.headers['X-lobe-chat-auth'] || params.request.headers['x-lobe-chat-auth'];
      if (typeof v === 'string' && v.length > 4) captured = v;
    });

    await page.goto(`${baseUrl}/chat`, { timeout: 30_000, waitUntil: 'networkidle2' });

    // If we landed on OA SSO and have credentials, log in.
    if (page.url().includes('oa.xinyoudi.com') && oaUsername && oaPassword) {
      await loginOA(page, oaUsername, oaPassword, baseUrl, timeoutMs);
    } else if (!page.url().startsWith(baseUrl)) {
      throw new Error(
        `[TowerAI] not logged in and no OA credentials. Set TOWERAI_OA_USERNAME / TOWERAI_OA_PASSWORD, or run with TOWERAI_AUTO_REFRESH=1 in headed mode once to log in manually. Stuck at: ${page.url()}`,
      );
    }

    // Wait briefly for the app to fire its initial chat-related requests so CDP
    // can observe X-lobe-chat-auth.
    await new Promise((r) => setTimeout(r, 3000));

    const token = (await page.evaluate(() => localStorage.getItem('token') ?? '')) as string;
    if (!token) {
      throw new Error(`[TowerAI] failed to read token from localStorage. URL: ${page.url()}`);
    }
    if (!captured) {
      // Some pages don't fire requests on idle; try to nudge by reloading once.
      await page.reload({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }

    console.info('[TowerAI] token refresh succeeded');
    return { authToken: captured, token };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function loginOA(
  page: any,
  username: string,
  password: string,
  baseUrl: string,
  timeoutMs: number,
) {
  console.info('[TowerAI] OA login page detected, filling credentials');
  await page.waitForSelector('input[name="email"], input[name="password"]', { timeout: 15_000 });
  const u = username.includes('@') ? username.split('@')[0] : username;
  await page.type('input[name="email"], input[type="text"]', u, { delay: 30 });
  await page.type('input[name="password"], input[type="password"]', password, { delay: 30 });
  await new Promise((r) => setTimeout(r, 500));
  const buttons = await page.$$('button');
  for (const b of buttons) {
    const t = (await page.evaluate((el: HTMLElement) => el.textContent?.trim(), b)) as string;
    if (t === '登录') {
      await b.click();
      break;
    }
  }
  await page.waitForFunction(
    (base: string) => window.location.href.startsWith(base),
    { timeout: timeoutMs },
    baseUrl,
  );
}
