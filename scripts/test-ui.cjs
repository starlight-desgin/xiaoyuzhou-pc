// Exercise the packaged Windows client with its isolated sample account and seekable test track.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'dist', '小宇宙桌面版-' + version, '小宇宙.exe');
const env = { ...process.env, XYZ_TEST_RUN: 'ui-' + Date.now() };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [];

async function launch() {
  app = await electron.launch({ executablePath: exe, args: ['--demo'], env, timeout: 25000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#account-button.is-logged').waitFor();
}
async function quit() {
  const closed = app.waitForEvent('close', { timeout: 7000 });
  await page.evaluate(() => window.xyzDesktop.quit()).catch(() => {});
  await closed;
  app = null;
}
const route = name => page.locator('[data-route="' + name + '"]').click();
async function checkRoute(name) {
  assert.equal(await page.locator('.nav-item[aria-current=page]').getAttribute('data-route'), name);
}
async function drag(fraction) {
  const slider = page.locator('#progress');
  const box = await slider.boundingBox();
  assert.ok(box && box.width > 55 && box.height > 8, 'slider hit area');
  const point = n => box.x + 6 + (box.width - 12) * n;
  const y = box.y + box.height / 2;
  await page.mouse.move(point(Number(await slider.inputValue()) / 100), y);
  await page.mouse.down();
  await page.mouse.move(point(fraction), y, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(expected => {
    const audio = document.querySelector('audio');
    return !audio.seeking && Math.abs(audio.currentTime / audio.duration - expected) < .025;
  }, fraction);
}
async function playing(eid) {
  await page.waitForFunction(id => {
    const audio = document.querySelector('audio');
    return !audio.paused && audio.readyState >= 2 && audio.currentSrc.endsWith('episode=' + id);
  }, eid);
}
async function checkFit() {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
}
async function capture(name) {
  const directory = process.env.XYZ_UI_SCREENSHOTS;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name + '.png') });
}

(async () => {
  await launch();
  await checkRoute('listen');
  assert.equal(await page.locator('.history-row').count(), 0);
  await page.locator('#empty-discover').click();
  await page.locator('#discover-feed .media-title').first().click();
  assert.equal(await page.locator('audio').getAttribute('src'), null, 'reading does not start audio');
  await page.locator('#back-button').click();
  await page.locator('#discover-feed [data-action=play]').first().click();
  await playing(0);
  await checkRoute('discover');
  await drag(.4);
  await page.locator('#player-cover').click();
  await checkRoute('listen');
  assert.equal(await page.locator('#home-player-slot .player-bar').count(), 1);
  await drag(.44);
  await page.locator('#play-button').click();
  const firstPosition = await page.locator('audio').evaluate(a => a.currentTime);

  await route('subscriptions');
  await page.locator('#subscriptions-list .media-title').nth(1).click();
  await page.locator('#podcast-episodes .media-title').first().click();
  await page.locator('.episode-chapter-strip [data-seek-seconds="60"]').click();
  await playing(1);
  await page.waitForFunction(() => Math.abs(document.querySelector('audio').currentTime - 60) < 3);
  await page.locator('#back-button').click();
  await page.locator('#podcast-episodes .media-title').first().waitFor();
  await page.locator('#back-button').click();
  await page.locator('#subscriptions-list .media-title').first().waitFor();

  await page.keyboard.press('Control+k');
  assert.equal(await page.locator('#search-input').evaluate(e => e === document.activeElement), true);
  await page.locator('#search-input').fill('半拿铁');
  await page.keyboard.press('Enter');
  await page.locator('#search-results .media-title').nth(1).waitFor();
  await page.locator('[data-search-type=podcast]').click();
  await page.locator('#search-results .media-title').nth(1).waitFor();
  assert.equal(await page.locator('#search-results .media-title').first().textContent(), '半拿铁·周刊');

  await route('listen');
  await drag(.58);
  await page.locator('#speed-button').selectOption('1.25');
  await page.locator('.volume-menu summary').click();
  await page.locator('#volume-slider').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.locator('.volume-menu summary').click();
  assert.equal(await page.locator('audio').evaluate(a => a.volume), .01);
  const beforeHide = await page.locator('audio').evaluate(a => a.currentTime);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await page.waitForFunction(t => document.querySelector('audio').currentTime > t + .5, beforeHide);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.locator('#play-button').click();
  const secondPosition = await page.locator('audio').evaluate(a => a.currentTime);
  await quit();
  await launch();
  await page.waitForFunction(t => {
    const audio = document.querySelector('audio');
    return audio.readyState >= 1 && audio.paused && !audio.seeking && Math.abs(audio.currentTime - t) < .8;
  }, secondPosition);
  assert.equal(await page.locator('audio').evaluate(a => a.playbackRate), 1.25);
  assert.equal(await page.locator('audio').evaluate(a => a.volume), .01);
  assert.equal(await page.locator('.history-row').count(), 2);
  await page.locator('[data-history-eid="demo-e0"] .history-title').click();
  assert.ok(await page.locator('audio').evaluate(a => a.paused));
  await page.locator('#back-button').click();
  await page.locator('[data-history-eid="demo-e0"] [data-history-action=play]').click();
  await playing(0);
  await page.waitForFunction(t => Math.abs(document.querySelector('audio').currentTime - t) < 3, firstPosition);
  await page.locator('#play-button').click();
  await page.mouse.move(5, 5);
  await capture('收听页');
  await page.locator('#all-history').click();
  await checkRoute('history');
  await page.locator('[data-history-filter=completed]').click();
  assert.equal(await page.locator('.history-row').count(), 0);
  await page.locator('[data-history-filter=all]').click();
  assert.equal(await page.locator('.history-row').count(), 2);
  await page.locator('audio').evaluate(a => { a.currentTime = a.duration - .4; return a.play(); });
  await page.waitForFunction(() => document.querySelector('audio').ended);
  await page.locator('[data-history-filter=completed]').click();
  assert.equal(await page.locator('.history-row').count(), 1);
  await page.locator('[data-history-filter=unfinished]').click();
  assert.equal(await page.locator('[data-history-eid="demo-e1"]').count(), 1);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(610, 620));
  await route('listen'); await checkFit(); await drag(.6);
  await route('discover'); await checkFit(); await drag(.32);
  await route('settings');
  await page.locator('#native-host-status.is-ready').waitFor();
  await page.locator('[data-settings-tab=account]').click();
  assert.equal(await page.locator('.settings-save').isVisible(), false);
  await page.locator('[data-settings-tab=files]').click();
  assert.equal(await page.locator('.settings-save').isVisible(), true);
  await checkFit();
  await page.locator('#desktop-options-button').click();
  assert.equal(await page.locator('#desktop-close-to-tray').isChecked(), true);
  await page.locator('#desktop-options-dialog [data-close-dialog]').click();
  await page.locator('#desktop-options-button').click();
  await page.locator('#desktop-close-to-tray').uncheck();
  await page.waitForFunction(async () => !(await window.xyzDesktop.status()).settings.closeToTray);
  await page.locator('#desktop-options-dialog [data-close-dialog]').click();
  const closing = app.waitForEvent('close', { timeout: 7000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
  await closing;
  app = null;
  assert.deepEqual(errors, []);
  console.log('通过：浏览与播放分离、详情返回、跨集章节、搜索、两种进度条、倍速与音量、托盘续播、重启恢复、历史筛选、窄窗口和桌面设置');
})().catch(async error => {
  console.error(error, errors);
  if (page && !page.isClosed()) await capture('验证失败').catch(() => {});
  if (app) await quit().catch(() => app?.close().catch(() => {}));
  process.exitCode = 1;
});
