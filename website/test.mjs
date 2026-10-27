import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('index.html', import.meta.url), 'utf8');

function downloadFallback() {
  const match = script.match(/const downloadFallback = (\{[\s\S]*?\});/);
  return match ? Function(`return (${match[1]});`)() : {};
}

async function openPage({ saved, storageBlocked = false, manifest, offline = false } = {}) {
  const buttons = ['zh-CN', 'en'].map(language => ({
    dataset: { language }, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(_event, callback) { this.click = callback; },
  }));
  const meta = {}, languageGroup = { hidden: true };
  const links = { 'download-link': { hidden: true }, 'download-link-windows': { hidden: true } };
  const pendings = { 'download-pending': { hidden: false }, 'download-pending-windows': { hidden: false } };
  const document = {
    documentElement: { lang: 'zh-CN' },
    querySelectorAll: selector => {
      if (selector === '[data-language]') return buttons;
      const [, kind, platform] = selector.match(/\[data-(download|pending)="(macos|windows)"\]/);
      const suffix = platform === 'macos' ? '' : '-windows';
      return kind === 'download'
        ? [links[`download-link${suffix}`]]
        : [pendings[`download-pending${suffix}`]];
    },
    querySelector: selector => (selector === '.languages' ? languageGroup : meta),
  };
  const storage = new Map(saved ? [['mareo-site-language', saved]] : []);
  vm.runInNewContext(script, {
    document,
    localStorage: {
      getItem(key) { if (storageBlocked) throw Error('blocked'); return storage.get(key); },
      setItem(key, value) { if (storageBlocked) throw Error('blocked'); storage.set(key, value); },
    },
    fetch: async () => {
      if (offline) throw new Error('offline');
      return { ok: true, json: async () => manifest };
    },
  });
  // applyDownloads resolves asynchronously once the manifest has been read.
  await new Promise(resolve => setTimeout(resolve, 0));
  return { document, buttons, meta, storage, languageGroup, links, pendings };
}

test('Chinese default, accessible language toggle and remembered English', async () => {
  const page = await openPage({ manifest: { version: '0.1.0' } });
  assert.equal(page.document.documentElement.lang, 'zh-CN');
  assert.equal(page.languageGroup.hidden, false);
  page.buttons[1].click();
  assert.equal(page.document.documentElement.lang, 'en');
  assert.match(page.document.title, /free AI work assistant/);
  assert.match(page.meta.content, /independent desktop/);
  assert.equal(page.buttons[1].attributes['aria-pressed'], 'true');
  assert.equal(page.buttons[0].attributes['aria-pressed'], 'false');
  assert.equal(page.storage.get('mareo-site-language'), 'en');

  const remembered = await openPage({ saved: 'en', manifest: { version: '0.1.0' } });
  assert.equal(remembered.document.documentElement.lang, 'en');

  page.buttons[0].click();
  assert.equal(page.document.documentElement.lang, 'zh-CN');
});

test('Invalid preferences and unavailable storage do not break the page', async () => {
  const invalid = await openPage({ saved: 'invalid', manifest: { version: '0.1.0' } });
  assert.equal(invalid.document.documentElement.lang, 'zh-CN');

  const page = await openPage({ storageBlocked: true, manifest: { version: '0.1.0' } });
  page.buttons[1].click();
  assert.equal(page.document.documentElement.lang, 'en');
});

test('Downloads follow the published manifest per platform', async () => {
  const page = await openPage({
    manifest: {
      version: '0.1.1',
      downloads: {
        macos: 'https://mareo-downloads.oss-cn-hangzhou.aliyuncs.com/Mareo-0.1.1-macos-arm64.dmg',
        windows: 'https://mareo-downloads.oss-cn-hangzhou.aliyuncs.com/Mareo-0.1.1-windows-x64-setup.exe',
      },
    },
  });
  assert.equal(page.links['download-link'].href, 'https://mareo-downloads.oss-cn-hangzhou.aliyuncs.com/Mareo-0.1.1-macos-arm64.dmg');
  assert.equal(page.links['download-link-windows'].href, 'https://mareo-downloads.oss-cn-hangzhou.aliyuncs.com/Mareo-0.1.1-windows-x64-setup.exe');
  assert.equal(page.links['download-link'].hidden, false);
  assert.equal(page.links['download-link-windows'].hidden, false);
  assert.equal(page.pendings['download-pending'].hidden, true);
  assert.equal(page.pendings['download-pending-windows'].hidden, true);
});

test('A platform without a manifest entry keeps its coming-soon note', async () => {
  const page = await openPage({
    manifest: { version: '0.1.1', downloads: { macos: 'https://mareo-downloads.oss-cn-hangzhou.aliyuncs.com/mac.dmg' } },
  });
  assert.equal(page.links['download-link'].hidden, false);
  assert.equal(page.links['download-link-windows'].hidden, true);
  assert.equal(page.pendings['download-pending-windows'].hidden, false);
});

test('An unreachable manifest falls back to the built-in links', async () => {
  const fallback = downloadFallback();
  const page = await openPage({ offline: true });
  assert.equal(page.links['download-link'].href, fallback.macos);
  assert.equal(page.links['download-link-windows'].href, fallback.windows);
  assert.equal(page.links['download-link'].hidden, false);
  assert.equal(page.links['download-link-windows'].hidden, false);
});

test('Hero includes both platform downloads, core promise and the real screenshot', () => {
  const hero = html.split('<section class="hero wrap"')[1].split('</section>')[0];
  assert.match(hero, /data-download="macos"/);
  assert.match(hero, /data-download="windows"/);
  assert.match(hero, /当前免费/);
  assert.match(hero, /Free\s+today\./);
  assert.doesNotMatch(html, /不限量|额度上限|Unlimited use|No limits on usage/);
  assert.match(hero, /读取你的文件，调用工具、运行命令，把任务一步步做完/);
  assert.match(hero, /id="download"/);
  assert.equal((html.match(/data-download=/g) ?? []).length, 2);
  assert.doesNotMatch(html, /download-panel|download-title|download-version/);
  assert.match(hero, /能做表格和 PPT/);
  assert.match(hero, /assets\/mareo-workspace.png/);
});

test('Static assets and fragment links resolve within the standalone directory', () => {
  const pages = ['index.html', 'privacy.html', 'privacy-en.html'];
  for (const page of pages) {
    const contents = readFileSync(new URL(page, import.meta.url), 'utf8');
    for (const [, reference] of contents.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (reference === '#') continue;
      if (reference.startsWith('#')) assert(contents.includes(`id="${reference.slice(1)}"`), reference);
      else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(reference)) continue;
      else assert(existsSync(new URL(reference.split('?')[0].split('#')[0], import.meta.url)), reference);
    }
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /<html lang="zh-CN">/);
});

test('Particles are decorative, bounded and pause when the document is hidden', () => {
  const particles = [];
  let paused;
  let onVisibilityChange;
  const document = {
    hidden: true,
    querySelector: () => ({
      append: particle => particles.push(particle),
      classList: { toggle: (_name, value) => { paused = value; } },
    }),
    createElement: () => ({ style: {} }),
    addEventListener: (name, callback) => {
      assert.equal(name, 'visibilitychange');
      onVisibilityChange = callback;
    },
  };
  vm.runInNewContext(readFileSync(new URL('motion.js', import.meta.url), 'utf8'), { document });
  assert.equal(particles.length, 16);
  assert.equal(paused, true);
  document.hidden = false;
  onVisibilityChange();
  assert.equal(paused, false);
  document.hidden = true;
  onVisibilityChange();
  assert.equal(paused, true);
  assert.match(html, /class="hero-particles" aria-hidden="true"/);
  const css = readFileSync(new URL('styles.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*\.hero-particles \{ display:none \}/);
  assert.match(css, /nth-child\(n\+9\) \{ display:none \}/);
});

test('Privacy pages distinguish diagnostics from saved titles in both languages', () => {
  const chinese = readFileSync(new URL('privacy.html', import.meta.url), 'utf8');
  const english = readFileSync(new URL('privacy-en.html', import.meta.url), 'utf8');
  assert.match(chinese, /上述诊断事件不包含/);
  assert.match(chinese, /文字或敏感信息/);
  assert.match(english, /These diagnostic events do not contain/);
  assert.match(english, /text or sensitive information from your first message/);
  assert.match(chinese, /href="privacy-en.html"/);
  assert.match(english, /href="privacy.html"/);
  assert.match(english, /are not anonymous/);
  assert.match(english, /180 days/);
  assert.match(html, /href="privacy-en.html"/);
});

test('The page view beacon sends a path and nothing else', () => {
  assert.match(script, /api\.svc\.mareo\.cn\/site-view/);
  const beacon = script.slice(script.indexOf('function countPageView'));
  assert.match(beacon, /VIEW_COUNTER_URL/);
  assert.match(beacon, /sendBeacon/);
  // The payload carries the path and nothing that could identify a visitor.
  assert.match(beacon, /JSON\.stringify\(\{\s*path/);
  assert.equal(/document\.cookie|localStorage|sessionStorage/.test(beacon), false);
  assert.equal(/userAgent|devicePixelRatio|screen\./.test(beacon), false);
});
