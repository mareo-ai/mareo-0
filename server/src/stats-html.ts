/**
 * The HTML both operations pages share: escaping, the money and rate formats,
 * the two card shapes, and the shell (tokens, rhythm, navigation). Keeping it in
 * one place is what makes a third page look like it belongs.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Micro-yuan as a person reads it. */
export function money(micro: number): string {
  return (micro < 0 ? '-¥' : '¥') + (Math.abs(micro) / 1e6).toFixed(2)
}

export function percent(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`
}

export function kpi(label: string, value: string, note: string): string {
  return `<div class="kpi"><span class="kpi-label">${escapeHtml(label)}</span>` +
    `<strong class="kpi-value">${escapeHtml(value)}</strong>` +
    `<span class="kpi-note">${escapeHtml(note)}</span></div>`
}

export function stat(label: string, value: string, tone = ''): string {
  return `<div class="stat${tone === '' ? '' : ' ' + tone}"><span class="stat-label">${escapeHtml(label)}</span>` +
    `<span class="stat-value">${escapeHtml(value)}</span></div>`
}

/** Wraps a table so a narrow screen scrolls it instead of clipping columns. */
export function scroll(html: string): string {
  return `<div class="scroll">${html}</div>`
}

/** A caption that is read by assistive tech but does not repeat the visible heading. */
export function tableCaption(text: string): string {
  return `<caption class="sr-only">${escapeHtml(text)}</caption>`
}

export function table(items: [string, string][]): string {
  return `<table>${items
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('')}</table>`
}

export type PageId = 'ceo' | 'users' | 'health'

const PAGES: { id: PageId; href: string; label: string; title: string; sub: string }[] = [
  { id: 'ceo', href: '/stats/', label: '经营看板', title: '经营看板', sub: '今天多少人在用、增长卡在哪、钱回没回本、用户拿它做什么' },
  { id: 'users', href: '/stats/users/', label: '用户与留存', title: '用户与留存', sub: '谁在回来、用得多深、哪些账号用得最重' },
  { id: 'health', href: '/stats/health/', label: '工程健康', title: '工程健康', sub: '启动率、异常退出、模型成功率、延迟、版本分布' },
]

/**
 * The shell every operations page is rendered into: a sticky bar with the three
 * pages and the generation time, then a page head, then the body. The navigation
 * is at the top on purpose — a reader should never have to scroll to find the
 * other pages.
 */
export function page(current: PageId, window: string, generatedAt: Date, body: string): string {
  const meta = PAGES.find((entry) => entry.id === current)!
  const tabs = PAGES.map((entry) => `<a class="tab" href="${entry.href}"${entry.id === current ? ' aria-current="page"' : ''}>${escapeHtml(entry.label)}</a>`).join('')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(meta.title)} · Mareo 运营</title>
<style>
:root {
  color-scheme: light dark;
  /* Tokens follow the Vercel-style reference: edges are shadows, not borders;
     one link-blue accent; a strict 4/8/12/16/32 spacing scale. */
  --bg: #fafafa; --panel: #ffffff; --panel-soft: #fafafa;
  --fg: #171717; --muted: #4d4d4d; --faint: #666666;
  --edge: rgba(0, 0, 0, 0.08); --edge-strong: rgba(0, 0, 0, 0.14);
  --accent: #0072f5; --accent-soft: rgba(0, 114, 245, 0.10);
  --warn: #b4530a; --warn-soft: rgba(180, 83, 10, 0.09);
  --good: #067647; --good-soft: rgba(6, 118, 71, 0.09);
  --sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0a; --panel: #111111; --panel-soft: #151515;
    --fg: #ededed; --muted: #a1a1a1; --faint: #8f8f8f;
    --edge: rgba(255, 255, 255, 0.10); --edge-strong: rgba(255, 255, 255, 0.18);
    --accent: #4d9fff; --accent-soft: rgba(77, 159, 255, 0.14);
    --warn: #f5b544; --warn-soft: rgba(245, 181, 68, 0.12);
    --good: #3ecf8e; --good-soft: rgba(62, 207, 142, 0.12);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}
a { color: inherit; }
.skip { position: absolute; left: -9999px; top: 8px; padding: 8px 14px; background: var(--panel); border-radius: 6px; box-shadow: 0 0 0 1px var(--edge-strong); z-index: 50; font-size: 13px; }
.skip:focus { left: 12px; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* ---- top bar: product, tabs, and when this page was generated ---- */
.topbar { position: sticky; top: 0; z-index: 30; background: var(--bg); box-shadow: 0 -1px 0 0 var(--edge) inset, 0 1px 0 0 var(--edge); }
.topbar-inner { max-width: 1080px; margin: 0 auto; padding: 0 24px; display: flex; align-items: center; gap: 24px; min-height: 52px; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; text-decoration: none; letter-spacing: -0.01em; white-space: nowrap; }
.brand span { color: var(--faint); font-weight: 400; }
.tabs { display: flex; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tab { display: inline-block; padding: 6px 10px; border-radius: 6px; font-size: 13.5px; color: var(--muted); text-decoration: none; white-space: nowrap; }
.tab:hover { background: var(--panel-soft); color: var(--fg); }
.tab[aria-current="page"] { background: var(--panel); color: var(--fg); box-shadow: 0 0 0 1px var(--edge); font-weight: 500; }
.topbar-meta { font-size: 12px; color: var(--faint); text-align: right; white-space: nowrap; }
.topbar-meta b { color: var(--muted); font-weight: 500; }

/* ---- page head ---- */
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.25; }
.page-sub { margin: 6px 0 0; font-size: 13px; color: var(--muted); }
.page-actions { display: flex; gap: 8px; align-items: center; }

/* ---- verdict: one line, typed as a status ---- */
.status { display: flex; align-items: baseline; gap: 10px; margin: 24px 0 0; padding: 12px 14px; border-radius: 8px; background: var(--panel); box-shadow: 0 0 0 1px var(--edge); font-size: 13.5px; color: var(--fg); }
.status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--good); transform: translateY(-1px); }
.status.warn::before { background: var(--warn); }
.status.ok::before { background: var(--good); }
.status .note { margin: 0; color: var(--muted); font-size: 12.5px; }
.status a { color: var(--accent); text-decoration: none; }
.status a:hover { text-decoration: underline; }

/* ---- sections ---- */
h2 { margin: 40px 0 12px; font-size: 13px; font-weight: 600; letter-spacing: 0; color: var(--fg); display: flex; align-items: baseline; gap: 10px; }
h2 .hint { font-size: 12px; font-weight: 400; color: var(--faint); }

/* ---- metric cards ---- */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px; }
.kpi { background: var(--panel); border-radius: 8px; padding: 14px 16px; box-shadow: 0 0 0 1px var(--edge); display: grid; gap: 4px; }
.kpi-label { font-size: 12.5px; color: var(--muted); }
.kpi-value { font-size: 28px; font-weight: 600; letter-spacing: -0.03em; line-height: 1.15; }
.kpi-note { font-size: 12px; color: var(--faint); }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 8px 24px; background: var(--panel); border-radius: 8px; padding: 14px 16px; box-shadow: 0 0 0 1px var(--edge); margin-top: 12px; }
.stat { display: grid; gap: 2px; }
.stat-label { font-size: 12px; color: var(--muted); }
.stat-value { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
.stat.warn .stat-value { color: var(--warn); }

.trends { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
.trend { background: var(--panel); border-radius: 8px; padding: 14px 16px 10px; box-shadow: 0 0 0 1px var(--edge); }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.trend-total { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.trend-days { display: flex; justify-content: space-between; font-size: 11px; color: var(--faint); margin-top: 2px; }
.spark { display: block; overflow: visible; }

/* ---- funnel / mix: rows on a card ---- */
.steps, .mix { background: var(--panel); border-radius: 8px; box-shadow: 0 0 0 1px var(--edge); overflow: hidden; }
.step, .mix-row { padding: 11px 16px; border-bottom: 1px solid var(--edge); }
.steps > :last-child, .mix > :last-child { border-bottom: 0; }
.step { display: grid; grid-template-columns: 1fr auto; gap: 2px 16px; align-items: baseline; }
.step-label { font-size: 13.5px; }
.step-value { font-size: 15px; font-weight: 600; text-align: right; letter-spacing: -0.01em; }
.step-note { grid-column: 1 / -1; font-size: 12px; color: var(--faint); }
.mix-row { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; align-items: baseline; }
.mix-label { font-size: 13.5px; }
.mix-value { font-size: 12px; color: var(--faint); text-align: right; }
.bar { grid-column: 1 / -1; height: 4px; border-radius: 2px; background: var(--edge); overflow: hidden; }
.bar span { display: block; height: 100%; border-radius: 2px; background: var(--accent); }

.note { font-size: 12.5px; color: var(--faint); margin: 12px 0 0; line-height: 1.6; }
.note b { color: var(--muted); font-weight: 600; }
.note code { font-family: var(--mono); font-size: 11.5px; }

/* ---- tables ---- */
table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 8px; box-shadow: 0 0 0 1px var(--edge); overflow: hidden; }
th, td { padding: 10px 16px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--edge); vertical-align: baseline; }
tr:last-child th, tr:last-child td { border-bottom: 0; }
thead th, tr:first-child th { color: var(--faint); font-weight: 500; font-size: 12px; }
th { color: var(--muted); font-weight: 400; }
td { white-space: nowrap; }
.num { text-align: right; font-variant-numeric: tabular-nums; }

/* ---- details ---- */
details { margin-top: 32px; background: var(--panel); border-radius: 8px; box-shadow: 0 0 0 1px var(--edge); padding: 0 16px 14px; }
summary { cursor: pointer; padding: 12px 0; font-size: 13px; font-weight: 500; color: var(--fg); list-style: none; display: flex; justify-content: space-between; gap: 12px; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "▸ "; color: var(--faint); }
details[open] summary::before { content: "▾ "; }
.summary-hint { font-weight: 400; color: var(--faint); font-size: 12px; }
.health { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 0 28px; margin: 4px 0 0; }
.health .row { display: flex; justify-content: space-between; gap: 14px; font-size: 13px; padding: 7px 0; border-bottom: 1px solid var(--edge); }
.health .row:last-child { border-bottom: 0; }
.health .row span:first-child { color: var(--muted); }
.health .row span:last-child { font-weight: 500; }

footer { max-width: 1080px; margin: 0 auto; padding: 20px 24px 48px; color: var(--faint); font-size: 12px; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
footer a { text-decoration: none; }
footer a:hover { text-decoration: underline; }

@media (max-width: 720px) {
  .topbar-inner { padding: 0 16px; gap: 12px; min-height: 48px; }
  .topbar-meta { display: none; }
  .wrap { padding: 24px 16px 48px; }
  h1 { font-size: 20px; }
  .kpi-value { font-size: 24px; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .trends, .health { grid-template-columns: 1fr; }
  th, td { padding: 9px 12px; }
}
</style>
</head>
<body>
<a class="skip" href="#main">跳到主要内容</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/stats/">Mareo <span>运营</span></a>
    <nav class="tabs" aria-label="运营页面">${tabs}</nav>
    <div class="topbar-meta">${escapeHtml(window)}<br><b>${escapeHtml(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC</b></div>
  </div>
</header>
<main id="main" class="wrap">
  <div class="page-head">
    <div>
      <h1>${escapeHtml(meta.title)}</h1>
      <p class="page-sub">${escapeHtml(meta.sub)}</p>
    </div>
  </div>
${body}
</main>
<footer>
  <span>数据来源：Mareo 网关的聚合统计 · 全部为聚合值，不含任何账号信息</span>
  <a href="/">返回首页</a>
  <a href="/privacy.html">隐私说明</a>
</footer>
</body>
</html>
`
}
