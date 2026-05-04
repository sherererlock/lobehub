/**
 * TowerAI token refresh via headless browser (puppeteer-core).
 *
 * Synced with the official TowerAI SDK (E:\workspace\GitRepository\TowerAI\src\auth.ts).
 * Lazily imports puppeteer-core so the dependency is optional — only servers that
 * opt into auto-refresh (TOWERAI_AUTO_REFRESH=1) need the package + a Chrome binary.
 *
 * Strategy:
 * 1. Launch Chrome (preferring the user's existing profile via userDataDir so the
 *    auth.js cookie is reused — usually no OA login is required).
 * 2. Navigate to ${baseUrl}/chat. If redirected to OA SSO or /next-auth/signin,
 *    fill credentials via the appropriate login flow.
 * 3. Read `Token` from `localStorage.getItem('token')`.
 * 4. Capture `X-lobe-chat-auth` from outgoing requests via CDP Network domain
 *    (the value is computed client-side and cannot be derived from Token alone).
 */
import { mkdir, writeFile } from 'node:fs/promises';
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
  /** Directory to persist token state for the helper server */
  persistToStateDir?: string;
  timeoutMs?: number;
  userDataDir?: string;
}

type TowerAIPageStage = 'app' | 'signin' | 'oa' | 'unknown';

const DEFAULT_BASE_URL = 'https://tower-ai.yottastudios.com';
const REFRESH_COOLDOWN_MS = 30_000;

const OA_EMAIL_SELECTORS = [
  'input[name="email"]',
  'input[placeholder="企业邮箱"]',
  'input[type="text"]',
] as const;

const OA_PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[placeholder="密码"]',
  'input[type="password"]',
] as const;

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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

export function classifyTowerAIPage(url: string, baseUrl: string): TowerAIPageStage {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (url.startsWith(`${normalizedBaseUrl}/chat`)) return 'app';
  if (url.includes('oa.xinyoudi.com')) return 'oa';
  if (url.startsWith(`${normalizedBaseUrl}/next-auth/signin`) || url.includes('/next-auth/signin'))
    return 'signin';
  if (url.startsWith(normalizedBaseUrl) && !url.includes('/next-auth/')) return 'app';
  return 'unknown';
}

async function findFirstElement(page: any, selectors: readonly string[]) {
  for (const selector of selectors) {
    const element = await page.$(selector);
    if (element) return element;
  }
  return null;
}

async function waitForUrlChange(page: any, currentUrl: string, timeoutMs: number) {
  if (timeoutMs <= 0) return;
  await page
    .waitForFunction(
      (prev: string) => window.location.href !== prev,
      { timeout: timeoutMs },
      currentUrl,
    )
    .catch(() => {});
}

function remainingTimeout(startedAt: number, totalTimeoutMs: number): number {
  return Math.max(1_000, totalTimeoutMs - (Date.now() - startedAt));
}

/**
 * Handle the OA SSO login page at oa.xinyoudi.com.
 */
async function handleOALogin(page: any, oaUsername: string, oaPassword: string): Promise<void> {
  console.info('[TowerAI] Detected OA login page, filling credentials...');

  await page.waitForFunction(
    (selectors: readonly string[]) => selectors.some((s: string) => !!document.querySelector(s)),
    { timeout: 15_000 },
    OA_EMAIL_SELECTORS,
  );

  // The OA form appends "@yottastudios.com" — only type the username part
  const username = oaUsername.includes('@') ? oaUsername.split('@')[0] : oaUsername;

  const emailInput = await findFirstElement(page, OA_EMAIL_SELECTORS);
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await emailInput.type(username, { delay: 30 });
  }

  const passwordInput = await findFirstElement(page, OA_PASSWORD_SELECTORS);
  if (passwordInput) {
    await passwordInput.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await passwordInput.type(oaPassword, { delay: 30 });
  }

  await new Promise((r) => setTimeout(r, 800));

  // Click the "登录" button
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate((el: HTMLElement) => el.textContent?.trim(), btn);
    if (text === '登录') {
      await btn.click();
      console.info('[TowerAI] Clicked 登录 button');
      return;
    }
  }
  console.warn('[TowerAI] 登录 button not found');
}

/**
 * On the /next-auth/signin page, find and click the OA tab/button to initiate SSO.
 */
async function clickTowerAISignIn(page: any): Promise<boolean> {
  await page.waitForSelector('button, .ant-btn, a', { timeout: 15_000 }).catch(() => {});

  // Try ant-tabs first (the signin page may have an OA tab)
  const tabs = await page.$$('.ant-tabs-tab');
  for (const tab of tabs) {
    const text = await page.evaluate((el: HTMLElement) => el.textContent?.trim() ?? '', tab);
    if (text.includes('OA')) {
      await tab.click();
      break;
    }
  }

  await new Promise((r) => setTimeout(r, 300));

  const panelButton = await page.$('.ant-tabs-tabpane-active button, .ant-tabs-tabpane-active a');
  if (panelButton) {
    await panelButton.click();
    console.info('[TowerAI] Clicked OA sign-in entry');
    return true;
  }

  // Fallback: scan all interactive elements
  const elements = await page.$$('button, a, div[role="button"], span');
  for (const el of elements) {
    const text = await page.evaluate((n: HTMLElement) => n.textContent?.trim() ?? '', el);
    if (text.includes('OA登录') || text.includes('OA')) {
      await el.click();
      console.info('[TowerAI] Clicked OA sign-in entry');
      return true;
    }
  }

  console.warn('[TowerAI] OA sign-in entry not found on current page');
  return false;
}

/**
 * Persist token state to a JSON file for the helper server to read.
 */
async function persistToStateDir(
  stateDir: string,
  token: string,
  authToken: string,
  baseUrl: string,
) {
  const filePath = join(stateDir, 'state.json');
  try {
    await mkdir(stateDir, { recursive: true });
    const data = {
      authToken,
      baseUrl,
      lastRefresh: new Date().toISOString(),
      source: 'browser',
      token,
    };
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.info(`[TowerAI] persisted tokens to ${filePath}`);
  } catch (e) {
    console.warn(`[TowerAI] failed to persist tokens to ${filePath}:`, (e as Error).message);
  }
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
  // Support both TOWERAI_* (legacy) and TOWER_AI_* (SDK) env var names
  const userDataDir =
    options.userDataDir ??
    process.env.TOWERAI_CHROME_PROFILE ??
    process.env.TOWER_AI_CHROME_PROFILE ??
    join(homedir(), '.tower-ai-chrome');
  const oaUsername =
    options.oaUsername ?? process.env.TOWERAI_OA_USERNAME ?? process.env.TOWER_AI_OA_USERNAME;
  const oaPassword =
    options.oaPassword ?? process.env.TOWERAI_OA_PASSWORD ?? process.env.TOWER_AI_OA_PASSWORD;
  const headless = options.headless ?? !!(oaUsername && oaPassword);

  let puppeteer: any;
  try {
    puppeteer = await import('puppeteer-core' as string);
  } catch {
    throw new Error(
      '[TowerAI] auto-refresh requires puppeteer-core. Install it: pnpm add -w puppeteer-core',
    );
  }

  console.info(`[TowerAI] launching Chrome for token refresh (headless=${headless})`);
  const browser = await puppeteer.launch({
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1280,900',
    ],
    executablePath: chromePath,
    headless,
    userDataDir,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    let captured = '';
    cdp.on('Network.requestWillBeSent', (params: any) => {
      const v =
        params.request.headers['X-lobe-chat-auth'] || params.request.headers['x-lobe-chat-auth'];
      if (typeof v === 'string' && v.length > 4) captured = v;
    });

    await page.goto(`${baseUrl}/chat`, { timeout: 30_000, waitUntil: 'networkidle2' });

    let url = page.url();
    let stage = classifyTowerAIPage(url, baseUrl);

    // Handle login if needed — loop-based flow matching the SDK
    if (stage !== 'app') {
      const startedAt = Date.now();
      console.info(`[TowerAI] login required, current stage: ${stage}`);

      while (stage !== 'app') {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`[TowerAI] timed out waiting for login flow. URL: ${page.url()}`);
        }

        url = page.url();
        stage = classifyTowerAIPage(url, baseUrl);

        if (stage === 'signin') {
          console.info('[TowerAI] on next-auth sign-in page, initiating OA login...');
          await clickTowerAISignIn(page);
          await waitForUrlChange(
            page,
            url,
            Math.min(5_000, remainingTimeout(startedAt, timeoutMs)),
          );
        } else if (stage === 'oa' && oaUsername && oaPassword) {
          await handleOALogin(page, oaUsername, oaPassword);
          console.info('[TowerAI] waiting for SSO redirect...');
          await page.waitForFunction(
            (base: string) => window.location.href.startsWith(base),
            { timeout: remainingTimeout(startedAt, timeoutMs) },
            normalizeBaseUrl(baseUrl),
          );
        } else if (stage === 'oa') {
          console.info('[TowerAI] please log in manually in the browser window...');
          await page.waitForFunction(
            (base: string) => window.location.href.startsWith(base),
            { timeout: remainingTimeout(startedAt, timeoutMs) },
            normalizeBaseUrl(baseUrl),
          );
        } else {
          await waitForUrlChange(
            page,
            url,
            Math.min(5_000, remainingTimeout(startedAt, timeoutMs)),
          );
        }

        await new Promise((r) => setTimeout(r, 800));
        url = page.url();
        stage = classifyTowerAIPage(url, baseUrl);
      }

      console.info('[TowerAI] login complete, waiting for app to initialize...');
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      console.info('[TowerAI] already logged in, waiting for requests...');
      await new Promise((r) => setTimeout(r, 3000));
    }

    const token = (await page.evaluate(() => localStorage.getItem('token') ?? '')) as string;
    if (!token) {
      throw new Error(`[TowerAI] failed to read token from localStorage. URL: ${page.url()}`);
    }

    // If CDP didn't capture X-lobe-chat-auth, try reloading
    if (!captured) {
      await page.reload({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }

    console.info(
      `[TowerAI] token refresh succeeded (token=${token.length} chars, authToken=${captured.length} chars)`,
    );

    // Persist to state dir if configured
    const stateDir = options.persistToStateDir ?? process.env.TOWERAI_STATE_DIR;
    if (stateDir) {
      await persistToStateDir(stateDir, token, captured, baseUrl);
    }

    return { authToken: captured, token };
  } finally {
    await browser.close().catch(() => {});
  }
}
