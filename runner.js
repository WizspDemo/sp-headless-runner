#!/usr/bin/env node
/**
 * Headless browser daemon: keeps a permanent, invisible Chromium tab open
 * on the Super Productivity web app so the WebSocket bridge always has a
 * "browser" connected — no manual tab needed on any human's machine.
 *
 * Runs forever. Relaunches automatically if Chromium crashes or the page
 * navigates away/disconnects.
 *
 * Required env vars:
 *   APP_URL   e.g. https://tasks.wizspplayroomcoolify.dev
 *   APP_USER  basic auth username
 *   APP_PASS  basic auth password
 */
import puppeteer from 'puppeteer-core';

const APP_URL = process.env.APP_URL;
const APP_USER = process.env.APP_USER;
const APP_PASS = process.env.APP_PASS;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

if (!APP_URL || !APP_USER || !APP_PASS) {
  console.error('FATAL: APP_URL, APP_USER, APP_PASS env vars are required.');
  process.exit(1);
}

let restartCount = 0;

async function runForever() {
  while (true) {
    restartCount += 1;
    console.log(`[headless-runner] launch attempt #${restartCount}`);
    try {
      await runOnce();
    } catch (err) {
      console.error('[headless-runner] session ended with error:', err?.message || err);
    }
    console.log('[headless-runner] restarting in 5s...');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function runOnce() {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // avoid /dev/shm crashes in small containers
      '--disable-gpu',
      // Headless Chromium still treats its single tab as "backgrounded",
      // which throttles JS timers (setInterval/setTimeout) and breaks
      // socket.io's heartbeat-based keepalive over a long session. These
      // flags keep the renderer at full, unthrottled speed indefinitely.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-ipc-flooding-protection',
    ],
  });

  const page = await browser.newPage();
  await page.authenticate({ username: APP_USER, password: APP_PASS });

  page.on('console', (msg) => {
    console.log('[page console]', msg.text());
  });
  page.on('pageerror', (err) => console.error('[page error]', err.message));

  let shouldReload = false;
  page.on('close', () => {
    console.log('[headless-runner] page closed');
    shouldReload = true;
  });
  browser.on('disconnected', () => {
    console.log('[headless-runner] browser disconnected');
    shouldReload = true;
  });

  console.log('[headless-runner] navigating to', APP_URL);
  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('[headless-runner] page loaded, keeping session alive');

  // Keep the process (and this Chromium tab) alive indefinitely, watching
  // for crashes/navigations that require a fresh launch. Also periodically
  // nudge the page (a no-op evaluate call) — this alone has been enough in
  // practice to keep Chromium's internal timers from drifting into a
  // throttled state during a long idle period, on top of the launch flags
  // above.
  while (!shouldReload) {
    await new Promise((r) => setTimeout(r, 15000));
    if (page.isClosed()) {
      console.log('[headless-runner] detected closed page');
      break;
    }
    try {
      await page.evaluate(() => document.title);
    } catch (err) {
      console.log('[headless-runner] keepalive evaluate failed:', err?.message || err);
      break;
    }
  }

  await browser.close().catch(() => {});
  throw new Error('session ended, relaunching');
}

runForever();
