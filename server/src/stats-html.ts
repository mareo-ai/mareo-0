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

export function table(items: [string, string][]): string {
  return `<table>${items
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('')}</table>`
}

export interface NavLink {
  href: string
  label: string
}

/** The shell every operations page is rendered into. */
export function page(title: string, nav: NavLink[], subtitle: string, generatedAt: Date, body: string): string {
  const links = nav.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join(' · ')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fcfcfd; --panel: #fff; --border: #e6e8ee; --border-soft: #f1f2f6;
  --text: #16181d; --muted: #6b7280; --faint: #9aa1ac;
  --accent: #2f5bea; --accent-soft: rgba(47, 91, 234, 0.12);
  --warn: #a86400; --warn-soft: rgba(168, 100, 0, 0.10);
  --good: #157347; --good-soft: rgba(21, 115, 71, 0.10);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1014; --panel: #15181e; --border: #262b34; --border-soft: #1e232b;
    --text: #edeff3; --muted: #98a0ad; --faint: #6f7885;
    --accent: #7c96ff; --accent-soft: rgba(124, 150, 255, 0.16);
    --warn: #e0a44a; --warn-soft: rgba(224, 164, 74, 0.12);
    --good: #57c98d; --good-soft: rgba(87, 201, 141, 0.12);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 24px 72px; background: var(--bg); color: var(--text);
  font: 14px/1.65 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-variant-numeric: tabular-nums;
}
.wrap { max-width: 1000px; margin: 0 auto; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; }
h1 { font-size: 21px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.window { font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 10px; }
.meta { color: var(--faint); font-size: 12px; margin: 6px 0 0; }
.status { margin: 18px 0 0; padding: 9px 14px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--border); background: var(--panel); display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.status.ok { border-color: color-mix(in srgb, var(--good) 35%, var(--border)); background: var(--good-soft); color: var(--good); }
.status.warn { border-color: color-mix(in srgb, var(--warn) 40%, var(--border)); background: var(--warn-soft); color: var(--warn); }
.status a { color: inherit; }
h2 { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: var(--muted); margin: 38px 0 12px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 12px; }
.kpi { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 14px 16px; display: grid; gap: 2px; }
.kpi-label { font-size: 12px; color: var(--muted); }
.kpi-value { font-size: 27px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.25; }
.kpi-note { font-size: 12px; color: var(--faint); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 10px; margin-top: 12px; }
.stat { border: 1px solid var(--border); border-radius: 9px; background: var(--panel); padding: 10px 13px; display: grid; gap: 1px; }
.stat-label { font-size: 12px; color: var(--muted); }
.stat-value { font-size: 17px; font-weight: 600; }
.stat.warn .stat-value { color: var(--warn); }
.trends { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; }
.trend { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 12px 14px 8px; }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.trend-total { font-size: 15px; font-weight: 600; }
.trend-days { display: flex; justify-content: space-between; font-size: 11px; color: var(--faint); margin-top: -4px; }
.spark { display: block; overflow: visible; }
.steps { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; }
.step { padding: 11px 16px; border-bottom: 1px solid var(--border-soft); display: grid; grid-template-columns: 1fr auto; gap: 2px 16px; align-items: baseline; }
.step:last-child { border-bottom: 0; }
.step-label { font-size: 13px; }
.step-value { font-size: 16px; font-weight: 600; text-align: right; }
.step-note { grid-column: 1 / -1; font-size: 12px; color: var(--faint); }
.mix { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; }
.mix-row { padding: 10px 16px; border-bottom: 1px solid var(--border-soft); display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; }
.mix-row:last-child { border-bottom: 0; }
.mix-label { font-size: 13px; }
.mix-value { font-size: 13px; color: var(--muted); text-align: right; }
.bar { grid-column: 1 / -1; height: 5px; border-radius: 3px; background: var(--border-soft); overflow: hidden; }
.bar span { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
.note { font-size: 12px; color: var(--faint); margin: 10px 0 0; line-height: 1.75; }
details { margin-top: 38px; border-top: 1px solid var(--border); padding-top: 12px; }
summary { cursor: pointer; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: var(--muted); }
.summary-hint { float: right; font-weight: 400; letter-spacing: 0; color: var(--faint); }
.health { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px 24px; margin: 14px 0 0; }
.health .row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; padding: 5px 0; border-bottom: 1px solid var(--border-soft); }
.health .row span:first-child { color: var(--muted); }
.health .row span:last-child { font-weight: 500; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 8px 14px; border-bottom: 1px solid var(--border-soft); font-size: 13px; }
tr:last-child th, tr:last-child td { border-bottom: 0; }
th { font-weight: 400; color: var(--muted); }
td { text-align: right; }
footer { margin-top: 44px; color: var(--faint); font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap; }
footer a { color: inherit; }
@media (max-width: 720px) {
  body { padding: 24px 16px 48px; }
  .kpi-value { font-size: 24px; }
  .trends, .health { grid-template-columns: 1fr; }
  .kpi, .trend, .step, .stat { min-width: 0; }
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <span class="window">${escapeHtml(subtitle)}</span>
  </header>
  <p class="meta">生成于 ${escapeHtml(generatedAt.toISOString())}（UTC）· 全部为聚合值，不含任何账号信息</p>
${body}
  <footer>
    数据来源：Mareo 网关的聚合统计。${links} · <a href="/">返回首页</a> · <a href="/privacy.html">隐私说明</a>
  </footer>
</div>
</body>
</html>
`
}
