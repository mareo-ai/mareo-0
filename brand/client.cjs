const React = require('react')

function BrandMark({ size }) {
  return React.createElement("img", {
    src: logoUrl,
    alt: "Mareo",
    width: size,
    height: size,
    style: { display: "block", objectFit: "contain" },
  });
}

function BrandName() {
  return React.createElement(
    "span",
    {
      style: {
        display: "block",
        height: 24,
        fontSize: 16,
        fontWeight: 600,
        lineHeight: "24px",
        letterSpacing: "normal",
        textAlign: "left",
        whiteSpace: "nowrap",
      },
    },
    "Mareo",
  );
}

function Attribution() {
  return React.createElement('div', {
    style: {
      position: 'fixed', right: 16, bottom: 10, pointerEvents: 'none',
      fontSize: 10, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
      background: 'var(--dsw-alias-bg-base)', borderRadius: 4, padding: '0 4px',
    },
  }, 'Built on DeepSeek Harness')
}

function SponsoredAdSlot({ wide }) {
  const [ad, setAd] = React.useState(null)
  const [loaded, setLoaded] = React.useState(false)
  const card = React.useRef(null)

  React.useEffect(() => {
    let active = true
    window.__mareoSponsoredAd.get().then((value) => {
      if (active) setAd(value)
    }).catch(() => {})
    return () => { active = false }
  }, [])

  React.useEffect(() => {
    if (!ad || !loaded || !wide || !card.current) return
    let visible = false
    let timer
    const update = () => {
      clearTimeout(timer)
      if (visible && document.visibilityState === 'visible' && document.hasFocus()) {
        timer = setTimeout(() => {
          void window.__mareoSponsoredAd.impression(ad.id).catch(() => {})
        }, 1000)
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && entry.intersectionRatio >= 0.5
      update()
    }, { threshold: [0, 0.5] })
    observer.observe(card.current)
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [ad, loaded, wide])

  // The image loads while hidden; no empty card, skeleton or error is shown.
  if (!ad || !wide) return null
  return React.createElement('button', {
    ref: card, type: 'button',
    'aria-label': `广告 / Sponsored · ${ad.advertiser} · ${ad.title}`,
    onClick: () => { void window.__mareoSponsoredAd.click(ad.id).catch(() => {}) },
    style: {
      display: loaded ? 'flex' : 'none', flexDirection: 'column', gap: 8,
      width: '100%', minWidth: 0, margin: '4px 0 10px', padding: 10,
      textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit',
      background: 'var(--dsw-alias-bg-base, #fff)',
      border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)', borderRadius: 10,
    },
  },
  React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, '广告 / Sponsored'),
  React.createElement('img', {
    src: ad.image, alt: '', referrerPolicy: 'no-referrer', crossOrigin: 'anonymous',
    onLoad: () => setLoaded(true), onError: () => { setLoaded(false); setAd(null) },
    style: { width: '100%', height: 80, objectFit: 'cover', borderRadius: 6 },
  }),
  React.createElement('span', { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.4,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, ad.title),
  React.createElement('span', { style: { fontSize: 12, lineHeight: 1.5, opacity: 0.8,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, ad.description),
  React.createElement('span', { style: { fontSize: 12, opacity: 0.65, maxWidth: '100%',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ad.advertiser))
}

// "Account" settings page. The official settings shell owns navigation and
// layout; this page talks to the Mareo host through the __mareoAccount bridge
// (exposed by Electron's preload), never to the gateway directly.
const fieldStyle = {
  display: 'grid', gap: 6, maxWidth: 360,
  font: 'inherit', color: 'inherit', marginBottom: 14,
}
const inputStyle = {
  font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-base, #fff)',
  border: '1px solid var(--dsw-alias-border, #d0d5dd)', borderRadius: 8, padding: '8px 10px',
}
const buttonStyle = {
  font: 'inherit', cursor: 'pointer', borderRadius: 8, padding: '8px 16px',
  border: '1px solid transparent',
}

function AccountSection() {
  const [profile, setProfile] = React.useState(null)
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [telemetry, setTelemetry] = React.useState(null)

  React.useEffect(() => {
    if (!window.__mareoAccount) return
    window.__mareoAccount.getProfile().then((result) => {
      if (result.ok) {
        setProfile({ displayName: result.displayName, email: result.email })
        setName(result.displayName)
      }
    }).catch(() => {})
    if (window.__mareoTelemetry) {
      window.__mareoTelemetry.get().then((result) => {
        if (result.ok) setTelemetry(result.enabled)
      }).catch(() => {})
    }
  }, [])

  if (!window.__mareoAccount) {
    return React.createElement('div', null, '请在 Mareo 桌面应用中管理你的账户。')
  }
  if (profile === null) {
    return React.createElement('div', null, '加载中…')
  }

  const rename = async () => {
    setBusy(true)
    setNotice('')
    const result = await window.__mareoAccount.updateName(name)
    if (result.ok) {
      setProfile({ ...profile, displayName: result.displayName })
      setNotice('已保存')
    } else {
      setNotice('保存失败，请重试')
    }
    setBusy(false)
  }

  const signOut = async () => {
    setBusy(true)
    await window.__mareoAccount.signOut()
    // The host tears the session down and returns to the sign-in window.
  }

  const toggleTelemetry = async (enabled) => {
    setTelemetry(enabled)
    const result = await window.__mareoTelemetry.set(enabled)
    setNotice(result.ok ? '已保存' : '保存失败，请重试')
  }

  return React.createElement(
    'div',
    null,
    React.createElement('div', { style: fieldStyle },
      React.createElement('span', null, '邮箱'),
      React.createElement('div', { style: { opacity: 0.7 } }, profile.email || '—'),
    ),
    React.createElement('div', { style: fieldStyle },
      React.createElement('label', { htmlFor: 'mareo-account-name' }, '昵称'),
      React.createElement('input', {
        id: 'mareo-account-name',
        value: name,
        maxLength: 32,
        disabled: busy,
        style: inputStyle,
        onChange: (event) => setName(event.target.value),
      }),
    ),
    notice ? React.createElement('div', { style: { opacity: 0.8, marginBottom: 10 } }, notice) : null,
    React.createElement('div', { style: fieldStyle },
      React.createElement('label', { htmlFor: 'mareo-account-telemetry', style: { display: 'flex', gap: 8, alignItems: 'center' } },
        React.createElement('input', {
          id: 'mareo-account-telemetry',
          type: 'checkbox',
          checked: telemetry === true,
          disabled: telemetry === null,
          onChange: (event) => toggleTelemetry(event.target.checked),
        }),
        '发送匿名使用统计',
      ),
      React.createElement('span', { style: { opacity: 0.7, fontSize: 13, lineHeight: 1.7 } },
        '仅包含版本、平台、启动与登录结果、异常退出，不含任何对话内容。关闭后立即停止诊断统计上报。广告展示与点击统计独立记录，并关联你的用户 ID，不受此开关控制。',
      ),
    ),
    React.createElement('div', { style: { display: 'flex', gap: 10 } },
      React.createElement('button', {
        type: 'button',
        disabled: busy,
        style: { ...buttonStyle, background: 'var(--dsw-alias-accent, #3d6bfe)', color: '#fff' },
        onClick: rename,
      }, '保存昵称'),
      React.createElement('button', {
        type: 'button',
        disabled: busy,
        style: { ...buttonStyle, borderColor: 'var(--dsw-alias-border, #d0d5dd)', background: 'transparent' },
        onClick: signOut,
      }, '退出登录'),
    ),
  )
}

// The quota, in money. Two buckets: today's free allowance, which refills at
// 00:00 Beijing, and the Mareo Wallet behind it, which does not expire. The
// gateway sends both as micro-yuan, so the client renders amounts and never
// sees a token count, a model price or the settlement rate.
//
// Running out is a plain notice with no purchase entry: the wallet is topped up
// through the account surface, not from here.
const meterTrackStyle = {
  height: 6, borderRadius: 3, overflow: 'hidden',
  background: 'var(--dsw-alias-border-l3, #e4e7ec)',
}
const meterFillStyle = { height: '100%', background: 'var(--dsw-alias-accent, #3d6bfe)', borderRadius: 3 }

/** Micro-yuan as the user reads it: two decimals, and a minus in front of a debt. */
function yuan(micro) {
  const value = Math.abs(micro) / 1e6
  return (micro < 0 ? '-¥' : '¥') + value.toFixed(2)
}

function QuotaMeter({ wide }) {
  const [snapshot, setSnapshot] = React.useState(null)

  React.useEffect(() => {
    if (!window.__mareoQuota) return
    let active = true
    const refresh = () => {
      window.__mareoQuota.get().then((value) => {
        if (active) setSnapshot(value)
      }).catch(() => {})
    }
    refresh()
    // The gateway is the source of truth, so re-read it while the window is in
    // use rather than trying to track spending locally.
    const timer = setInterval(refresh, 30000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!wide || !snapshot || snapshot.quota.visible !== true) return null
  const meter = snapshot.quota
  const free = snapshot.free
  const exhausted = meter.exhausted === true
  const freeUsedPercent = free.limitMicro > 0
    ? Math.min(100, Math.round((free.usedMicro / free.limitMicro) * 100))
    : 100

  return React.createElement('div', {
    style: { display: 'grid', gap: 6, width: '100%', minWidth: 0, padding: '8px 2px 2px' },
  },
  React.createElement('div', {
    style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, lineHeight: '16px' },
  },
    React.createElement('span', { style: { opacity: 0.75 } }, '今日免费'),
    React.createElement('span', { style: { opacity: 0.75, whiteSpace: 'nowrap' } },
      yuan(free.remainingMicro) + ' / ' + yuan(free.limitMicro)),
  ),
  React.createElement('div', {
    style: meterTrackStyle, role: 'progressbar',
    'aria-valuenow': freeUsedPercent, 'aria-valuemin': 0, 'aria-valuemax': 100,
  },
    React.createElement('div', { style: { ...meterFillStyle, width: Math.max(2, freeUsedPercent) + '%' } })),
  React.createElement('div', {
    style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, lineHeight: '16px' },
  },
    React.createElement('span', { style: { opacity: 0.75 } }, 'Mareo 余额'),
    React.createElement('span', { style: { fontWeight: 500, whiteSpace: 'nowrap' } }, yuan(snapshot.wallet.balanceMicro)),
  ),
  React.createElement('div', {
    style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, lineHeight: '16px', opacity: 0.6 },
  },
    React.createElement('span', null, '可用合计'),
    React.createElement('span', { style: { whiteSpace: 'nowrap' } }, yuan(snapshot.total.remainingMicro)),
  ),
  exhausted
    ? React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, '额度已用完 · 获取更多额度')
    : null,
  exhausted
    ? React.createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, '免费额度北京时间 0 点后恢复。')
    : null)
}

/**
 * The sidebar footer holds both Mareo surfaces. They share one slot entry
 * because the slot is a single flex row — two registrations would sit side by
 * side and squeeze each other.
 */
function SidebarFooter(props) {
  return React.createElement('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%', minWidth: 0 },
  },
  React.createElement(QuotaMeter, props),
  React.createElement(SponsoredAdSlot, props))
}

exports.inject = ['slots']
exports.apply = (ctx) => {
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, BrandMark))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'mareo-attribution' }, Attribution))
  if (typeof window !== 'undefined' && (window.__mareoSponsoredAd || window.__mareoQuota)) {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'mareo-sidebar-footer',
    }, SidebarFooter))
  }
  if (typeof window !== 'undefined' && window.__mareoAccount) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'mareo-account',
      order: 90,
      label: () => '账户',
    }, AccountSection))
  }
}
