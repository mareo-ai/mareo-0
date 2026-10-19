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

/** A caption that is read by assistive tech but does not repeat the visible heading. */
export function tableCaption(text: string): string {
  return `<caption class="sr-only">${escapeHtml(text)}</caption>`
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
<meta name="theme-color" content="#fcfcfd" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1014" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: light dark;
  /* Ink & Paper: paper ground, ink text, one accent. See docs/design/themes/ink-and-paper.md */
  --bg: #f6f4ef; --panel: #ffffff; --border: #e3ded4; --border-strong: #cbc5b8; --border-soft: #eeeae2;
  --text: #171614; --muted: #5f5a52; --faint: #6f6a60;
  --accent: #1d5f5a; --accent-soft: rgba(29, 95, 90, 0.10);
  --warn: #8a4b00; --warn-soft: rgba(138, 75, 0, 0.09);
  --good: #1c6b43; --good-soft: rgba(28, 107, 67, 0.09);
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Songti SC", "Source Han Serif SC", Georgia, serif;
  --sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14130f; --panel: #1b1a16; --border: #2c2a24; --border-strong: #423e35; --border-soft: #24221d;
    --text: #f2efe8; --muted: #b3ada2; --faint: #9a948a;
    --accent: #7fc7bd; --accent-soft: rgba(127, 199, 189, 0.14);
    --warn: #e0a95e; --warn-soft: rgba(224, 169, 94, 0.12);
    --good: #74c79a; --good-soft: rgba(116, 199, 154, 0.12);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 48px 28px 80px; background: var(--bg); color: var(--text);
  font: 14.5px/1.7 var(--sans);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 960px; margin: 0 auto; }
.skip { position: absolute; left: -9999px; top: 0; padding: 8px 14px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 2px; z-index: 10; }
.skip:focus { left: 12px; top: 12px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* Masthead: a newspaper running head, not a dashboard navbar. */
header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 2px solid var(--border-strong); }
h1 { font-family: var(--serif); font-size: 30px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.15; margin: 6px 0 0; text-wrap: balance; }
.window { display: block; font-size: 11px; letter-spacing: 0.1em; color: var(--faint); }
.meta { color: var(--faint); font-size: 11.5px; margin: 8px 0 0; }
.masthead-side { text-align: right; }

/* The week in one sentence, set in serif, with a rule instead of a coloured box. */
.status { margin: 26px 0 0; padding: 0 0 0 14px; border-left: 2px solid var(--border-strong); font-family: var(--serif); font-size: 19px; line-height: 1.55; color: var(--text); }
.status.ok { border-left-color: var(--good); }
.status.warn { border-left-color: var(--warn); color: var(--text); }
.status .note { display: block; margin-top: 4px; font-family: var(--sans); font-size: 12.5px; color: var(--muted); }
.status a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }

/* Section labels: small caps with a rule that runs to the margin. */
h2 { display: flex; align-items: center; gap: 14px; font-family: var(--sans); font-size: 11px; font-weight: 600; letter-spacing: 0.14em; color: var(--muted); margin: 42px 0 16px; text-wrap: balance; }
h2::after { content: ""; flex: 1; height: 1px; background: var(--border); }

/* KPI strip: numbers in a row, divided by hairlines, no cards. */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 165px), 1fr)); border-top: 1px solid var(--border-strong); border-bottom: 1px solid var(--border); }
.kpi { padding: 16px 18px; display: grid; gap: 2px; }
.kpi + .kpi { border-left: 1px solid var(--border); }
.kpi-label { font-size: 11.5px; letter-spacing: 0.06em; color: var(--muted); }
.kpi-value { font-family: var(--serif); font-size: 40px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; }
.kpi-note { font-size: 12px; color: var(--faint); }

/* Secondary numbers: quieter, no boxes. */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap: 10px 26px; margin-top: 14px; }
.stat { display: grid; gap: 1px; padding: 4px 0; }
.stat-label { font-size: 11.5px; letter-spacing: 0.05em; color: var(--muted); }
.stat-value { font-family: var(--serif); font-size: 20px; font-weight: 600; }
.stat.warn .stat-value { color: var(--warn); }

.trends { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); gap: 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.trend { padding: 14px 16px; }
.trend + .trend { border-left: 1px solid var(--border); }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.trend-total { font-family: var(--serif); font-size: 18px; font-weight: 600; }
.trend-days { display: flex; justify-content: space-between; font-size: 11px; color: var(--faint); margin-top: -2px; }
.spark { display: block; overflow: visible; }

/* Funnel and the task mix: hairline lists, not cards. */
.steps, .mix { border-top: 1px solid var(--border-strong); }
.step, .mix-row { padding: 12px 2px; border-bottom: 1px solid var(--border-soft); }
.step { display: grid; grid-template-columns: 1fr auto; gap: 3px 18px; align-items: baseline; }
.step-label { font-size: 14.5px; }
.step-value { font-family: var(--serif); font-size: 20px; font-weight: 600; text-align: right; }
.step-note { grid-column: 1 / -1; font-size: 12px; color: var(--faint); }
.mix-row { display: grid; grid-template-columns: 1fr auto; gap: 6px 18px; align-items: baseline; }
.mix-label { font-size: 14.5px; }
.mix-value { font-size: 12.5px; color: var(--muted); text-align: right; }
.bar { grid-column: 1 / -1; height: 3px; background: var(--border-soft); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--accent); }

.note { font-size: 12.5px; color: var(--faint); margin: 12px 0 0; line-height: 1.75; }
.note b { color: var(--muted); font-weight: 600; }

/* Tables: hairline rules, numbers right, headers quiet. */
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border-soft); font-size: 13.5px; font-weight: 400; vertical-align: baseline; }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
td { white-space: nowrap; }
tr:first-child th { border-bottom: 1px solid var(--border-strong); font-size: 11.5px; letter-spacing: 0.05em; color: var(--muted); }
tbody tr:last-child th, tbody tr:last-child td, tr:last-child th, tr:last-child td { border-bottom: 0; }
th { color: var(--muted); }
td { text-align: left; }
.num { text-align: right; font-variant-numeric: tabular-nums; }

/* Health details: still collapsible, now on a hairline. */
details { margin-top: 42px; border-top: 1px solid var(--border-strong); padding-top: 12px; }
summary { cursor: pointer; font-size: 11.5px; font-weight: 600; letter-spacing: 0.1em; color: var(--muted); }
.summary-hint { float: right; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--faint); }
.health { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 4px 30px; margin: 16px 0 0; }
.health .row { display: flex; justify-content: space-between; gap: 14px; font-size: 13.5px; padding: 6px 0; border-bottom: 1px solid var(--border-soft); }
.health .row span:first-child { color: var(--muted); }
.health .row span:last-child { font-weight: 500; }

footer { margin-top: 52px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--faint); font-size: 12px; display: flex; gap: 16px; flex-wrap: wrap; }
footer a { color: inherit; }
@media (max-width: 720px) {
  body { padding: 28px 18px 56px; }
  h1 { font-size: 25px; }
  .kpi { padding: 14px 12px; }
  .kpi-value { font-size: 32px; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpi:nth-child(3) { border-left: 0; }
  .trends, .health { grid-template-columns: 1fr; }
  .trend + .trend { border-left: 0; border-top: 1px solid var(--border); }
  .masthead-side { text-align: left; }
}
</style>
</head>
<body>
<div class="wrap">
  <a class="skip" href="#main">跳到主要内容</a>
  <header>
    <div>
      <span class="window">Mareo · 运营</span>
      <h1>${escapeHtml(title)}</h1>
    </div>
    <div class="masthead-side">
      <span class="window">${escapeHtml(subtitle)}</span>
      <p class="meta">生成于 ${escapeHtml(generatedAt.toISOString())}（UTC）· 全部为聚合值</p>
    </div>
  </header>
  <main id="main">
${body}
  </main>
  <footer>
    数据来源：Mareo 网关的聚合统计。${links} · <a href="/">返回首页</a> · <a href="/privacy.html">隐私说明</a>
  </footer>
</div>
</body>
</html>
`
}
