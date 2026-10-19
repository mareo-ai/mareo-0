/**
 * The HTML all three operations pages share: escaping, the money and rate formats,
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
  return `<div class="scroll" tabindex="0" role="region" aria-label="数据表格，可横向滚动">${html}</div>`
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
  color-scheme:light dark;
  --bg:#fafafa; --panel:#fff; --panel-soft:#f4f5f7; --fg:#171717;
  --muted:#4d4d4d; --faint:#666; --edge:rgba(0,0,0,.08); --edge-strong:rgba(0,0,0,.14);
  --accent:#0072f5; --accent-soft:rgba(0,114,245,.08); --heat:0,114,245;
  --warn:#b4530a; --warn-soft:rgba(180,83,10,.08);
  --good:#067647; --good-soft:rgba(6,118,71,.08);
  --sans:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media(prefers-color-scheme:dark) {
  :root {
    --bg:#0a0a0a; --panel:#111; --panel-soft:#191919; --fg:#ededed;
    --muted:#a1a1a1; --faint:#8f8f8f; --edge:rgba(255,255,255,.10); --edge-strong:rgba(255,255,255,.18);
    --accent:#4d9fff; --accent-soft:rgba(77,159,255,.12); --heat:77,159,255;
    --warn:#f5b544; --warn-soft:rgba(245,181,68,.09);
    --good:#3ecf8e; --good-soft:rgba(62,207,142,.09);
  }
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 var(--sans); -webkit-font-smoothing:antialiased; font-variant-numeric:tabular-nums }
a { color:inherit }
a:focus-visible,.scroll:focus-visible { outline:2px solid var(--accent); outline-offset:4px }
.skip { position:absolute; left:-9999px; top:8px; padding:8px 16px; background:var(--panel); z-index:50 }
.skip:focus { left:12px }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0 }
.topbar { position:sticky; top:0; z-index:30; background:var(--panel); box-shadow:0 1px 0 var(--edge) }
.topbar-inner { max-width:1280px; margin:auto; padding:0 32px; display:flex; align-items:center; gap:40px; min-height:68px }
.brand { display:flex; gap:10px; align-items:center; text-decoration:none; font-size:18px; font-weight:650; letter-spacing:-.5px; white-space:nowrap }
.brand span { font-size:12px; font-weight:400; color:var(--faint); letter-spacing:0; padding-left:10px; border-left:1px solid var(--edge-strong) }
.tabs { display:flex; gap:24px; min-width:0; align-self:stretch; overflow-x:auto }
.tab { display:flex; align-items:center; padding:0 2px; text-decoration:none; white-space:nowrap; color:var(--muted); font-size:14px; border-bottom:2px solid transparent }
.tab:hover { color:var(--accent) }
.tab[aria-current="page"] { color:var(--accent); border-bottom-color:var(--accent); font-weight:600 }
.topbar-meta { margin-left:auto; font-size:12px; line-height:1.7; color:var(--faint); text-align:right; white-space:nowrap }
.topbar-meta b { font-weight:400; color:var(--muted) }
.wrap { max-width:1280px; margin:auto; padding:40px 32px 64px }
.page-head { margin-bottom:28px }
h1 { margin:0; font-size:30px; line-height:1.3; font-weight:650; letter-spacing:-1px }
.page-sub { margin:8px 0 0; color:var(--muted); font-size:14px }
h2 { margin:0 0 20px; font-size:17px; font-weight:600; letter-spacing:-.2px; line-height:1.5 }
h3 { margin:24px 0 10px; color:var(--faint); font-size:12px; font-weight:500 }
section { min-width:0; scroll-margin-top:90px }
.overview { margin-top:28px; margin-bottom:32px }
.panel { min-width:0; margin-top:24px; padding:24px; background:var(--panel); border-radius:12px; box-shadow:0 0 0 1px var(--edge) }
.panel>h2 { margin-bottom:20px }
.dashboard-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; align-items:start }
.dashboard-grid>.panel { margin-top:0 }
.status { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 12px; margin:0; padding:12px 16px; border-radius:8px; background:var(--good-soft); color:var(--fg); font-size:13px }
.status::before { content:""; flex:none; width:6px; height:6px; border-radius:50%; background:var(--good) }
.status.warn { background:var(--warn-soft) }
.status.warn::before { background:var(--warn) }
.status .note { margin:0 }
.status a { color:var(--accent); text-underline-offset:3px }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr)); gap:16px }
.kpi { min-width:0; display:flex; flex-direction:column; align-items:flex-start; gap:10px; padding:24px; border-radius:10px; background:var(--panel); box-shadow:0 0 0 1px var(--edge) }
.kpi-label { color:var(--muted); font-size:13px }
.kpi-value { font-size:36px; line-height:1.15; font-weight:600; letter-spacing:-1.2px; overflow-wrap:anywhere }
.kpi-note { color:var(--faint); font-size:12px; line-height:1.6 }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:24px; margin-top:16px }
.stat { min-width:0; display:grid; align-content:start; gap:6px }
.stat-label { color:var(--muted); font-size:13px }
.stat-value { font-size:23px; font-weight:550; letter-spacing:-.5px; overflow-wrap:anywhere }
.stat.warn .stat-value,.negative { color:var(--warn) }
.overview>.stats { display:flex; flex-wrap:wrap; gap:24px 48px; padding:20px 0 4px }
.overview>.stats .stat { display:flex; align-items:baseline; gap:12px }
.overview>.stats .stat-value { font-size:18px }
.finance .stats { grid-template-columns:repeat(2,minmax(0,1fr)); margin-top:12px; gap:20px }
.finance .stat:first-child:last-child { grid-column:1/-1 }
.finance .stat-value { font-size:25px }
.finance-group+.finance-group { margin-top:24px; padding-top:20px; border-top:1px solid var(--edge) }
.finance-group h3 { margin-top:0 }
.steps { border-radius:8px; background:var(--panel-soft); overflow:hidden }
.step { padding:14px 16px }
.step+.step { border-top:1px solid var(--edge) }
.step-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px }
.step-label { font-size:14px }
.step-value { font-size:20px; font-weight:600; white-space:nowrap }
.step-note { margin-top:4px; color:var(--faint); font-size:12px; overflow-wrap:anywhere }
.note { margin:14px 0 0; font-size:12px; line-height:1.8; color:var(--faint); overflow-wrap:anywhere }
.note b { color:var(--muted); font-weight:550 }
.note code { font:11px var(--mono) }
.mix { display:grid; grid-template-columns:1fr 1fr; gap:24px 40px }
.mix-row { display:grid; grid-template-columns:1fr auto; gap:10px 16px; align-content:start }
.mix-label { font-size:14px }
.mix-value { font-size:12px; color:var(--faint); text-align:right }
.bar { grid-column:1/-1; height:6px; border-radius:3px; background:var(--panel-soft); overflow:hidden }
.bar span { display:block; height:100%; background:var(--accent); border-radius:3px }
.scroll { overflow-x:auto; border-radius:8px; box-shadow:0 0 0 1px var(--edge); -webkit-overflow-scrolling:touch; scroll-margin-top:90px }
table { border-collapse:collapse; width:100%; background:var(--panel) }
th,td { padding:14px 16px; text-align:left; font-size:13px; vertical-align:middle; border-bottom:1px solid var(--edge) }
th { font-weight:450; color:var(--muted); overflow-wrap:anywhere }
th[scope="col"] { background:var(--panel-soft); color:var(--faint); font-size:12px; font-weight:500; white-space:nowrap }
.num { text-align:right }
td { white-space:nowrap }
tr:last-child th,tr:last-child td { border-bottom:0 }
tr:hover td,tr:hover th[scope="row"] { background-color:var(--panel-soft) }
.retention-table th[scope="row"] { white-space:nowrap }
.retention-cell { background:rgba(var(--heat),var(--heat-opacity,0)) }
tr:hover .retention-cell { background:rgba(var(--heat),var(--heat-opacity,0)) }
.badge { display:inline-block; padding:2px 8px; border-radius:5px; background:var(--panel-soft); color:var(--muted); font-size:11px; font-weight:450; white-space:nowrap }
.badge.good { background:var(--good-soft); color:var(--good) }
.depth-grid { display:grid; grid-template-columns:1fr 2fr; gap:32px }
.depth-grid>div+div { border-left:1px solid var(--edge); padding-left:32px }
.depth-grid h3 { margin-top:0 }
.health { display:grid; grid-template-columns:1fr 1fr; gap:0 32px; margin-top:24px }
.health .row { display:flex; justify-content:space-between; align-items:baseline; gap:20px; padding:12px 0; border-bottom:1px solid var(--edge); font-size:13px }
.health .row span:first-child { color:var(--muted) }
.health .row span:last-child { text-align:right; overflow-wrap:anywhere; min-width:0 }
.health .row:last-child { border-bottom:0 }
.health-kpis .kpi-value { font-size:28px; letter-spacing:-.8px }
.trends { display:grid; gap:20px }
.trend { padding:0 0 20px; border-bottom:1px solid var(--edge) }
.trend:last-child { padding-bottom:0; border:0 }
.trend-head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin-bottom:12px }
.trend-total { font-size:20px; font-weight:550 }
.trend-days { display:flex; justify-content:space-between; font-size:11px; color:var(--faint); margin-top:6px }
.spark { display:block; overflow:visible }
footer { max-width:1280px; padding:24px 32px 40px; margin:auto; display:flex; flex-wrap:wrap; gap:12px 24px; color:var(--faint); font-size:12px; border-top:1px solid var(--edge) }
footer span { flex:1; min-width:240px }
footer a { text-decoration:none }
footer a:hover { color:var(--accent); text-decoration:underline }
@media(max-width:1000px) {
  .topbar-inner { gap:24px }
  .topbar-meta { display:none }
  .dashboard-grid { grid-template-columns:1fr }
  .kpis { grid-template-columns:repeat(2,minmax(0,1fr)) }
  .kpis>.kpi:last-child:nth-child(odd) { grid-column:1/-1 }
}
@media(max-width:640px) {
  .topbar-inner { padding:12px 20px 0; gap:8px; flex-wrap:wrap }
  .brand { width:100%; font-size:16px }
  .tabs { width:100%; gap:24px; min-height:44px }
  .tab { font-size:13px }
  .wrap { padding:28px 20px 40px }
  h1 { font-size:26px }
  h2 { font-size:16px }
  .panel { padding:20px 16px; border-radius:10px }
  .kpis { gap:12px }
  .kpi { padding:18px 14px }
  .kpi-value { font-size:30px }
  .health-kpis .kpi-value { font-size:24px }
  .mix,.health,.depth-grid { grid-template-columns:1fr }
  .mix-row { gap:8px }
  .mix-value { font-size:11px }
  .depth-grid { gap:24px }
  .depth-grid>div+div { border-left:0; border-top:1px solid var(--edge); padding:20px 0 0 }
  th,td { padding:12px }
  .overview>.stats { gap:12px 24px }
  footer { padding:24px 20px }
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
