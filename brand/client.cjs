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
  const [balance, setBalance] = React.useState(null)

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

  // The balance here is the same wallet the sidebar meter shows; a payment that
  // just landed refreshes both through the same hook.
  React.useEffect(() => {
    if (!window.__mareoQuota) return
    let active = true
    const refresh = () => {
      window.__mareoQuota.get().then((value) => {
        if (active && value) setBalance(value.wallet.balanceMicro)
      }).catch(() => {})
    }
    refresh()
    quotaRefreshHooks.add(refresh)
    return () => {
      active = false
      quotaRefreshHooks.delete(refresh)
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
      React.createElement('span', null, 'Mareo 余额'),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
        React.createElement('span', { style: { opacity: 0.8 } }, balance === null ? '—' : yuan(balance)),
        React.createElement('button', {
          type: 'button',
          style: { ...buttonStyle, padding: '4px 12px' },
          onClick: () => recharge.setOpen(true),
        }, '充值'),
      ),
    ),
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
// The visible recharge action and the Account section open the same panel.
const recharge = {
  open: false,
  listeners: new Set(),
  setOpen(next) {
    recharge.open = next
    recharge.listeners.forEach((listener) => listener(next))
  },
  subscribe(listener) {
    recharge.listeners.add(listener)
    return () => recharge.listeners.delete(listener)
  },
}

/** The meter re-reads the gateway; a payment that just landed should not wait 30s. */
const quotaRefreshHooks = new Set()
function refreshQuotaNow() {
  quotaRefreshHooks.forEach((hook) => hook())
}
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
    quotaRefreshHooks.add(refresh)
    return () => {
      active = false
      clearInterval(timer)
      quotaRefreshHooks.delete(refresh)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!wide || !snapshot || snapshot.quota.visible !== true) return null
  const meter = snapshot.quota
  const free = snapshot.free
  const exhausted = meter.exhausted === true
  const freeRemainingPercent = free.limitMicro > 0
    ? Math.min(100, Math.max(0, Math.round((free.remainingMicro / free.limitMicro) * 100)))
    : 0

  return React.createElement('button', {
    type: 'button',
    'aria-label': '查看额度并充值 Mareo 余额',
    onClick: () => recharge.setOpen(true),
    style: {
      display: 'grid', gap: 10, width: '100%', minWidth: 0, padding: 12,
      textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer',
      background: 'var(--dsw-alias-bg-base, #fff)',
      border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)', borderRadius: 10,
    },
  },
  React.createElement('span', {
    style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', fontSize: 12 },
  },
    React.createElement('span', { style: { opacity: 0.75 } }, '今日免费剩余'),
    // The free allowance is a ratio, not an amount: how generous it is stays an
    // operational decision, and a user who can read the money will notice every
    // change to it. The wallet below is the user's own money and stays exact.
    React.createElement('span', { style: { whiteSpace: 'nowrap', fontWeight: 600 } },
      freeRemainingPercent + '%'),
  ),
  React.createElement('span', {
    style: { ...meterTrackStyle, display: 'block' }, role: 'progressbar',
    'aria-label': '今日免费额度剩余',
    'aria-valuenow': freeRemainingPercent, 'aria-valuemin': 0, 'aria-valuemax': 100,
  },
    React.createElement('span', { style: { ...meterFillStyle, display: 'block', width: freeRemainingPercent + '%' } })),
  React.createElement('span', {
    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  },
    React.createElement('span', { style: { fontSize: 12, opacity: 0.75 } }, 'Mareo 余额'),
    React.createElement('span', { style: { fontSize: 17, fontWeight: 600, whiteSpace: 'nowrap' } },
      yuan(snapshot.wallet.balanceMicro)),
  ),
  React.createElement('span', {
    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12 },
  },
    // No total: it would let anyone subtract the wallet balance and recover the
    // free allowance's amount, which is exactly what the percentage hides.
    React.createElement('span', { style: { opacity: 0.65 } }, '每日 0 点重置'),
    React.createElement('span', {
      style: { color: 'var(--dsw-alias-accent, #3d6bfe)', fontWeight: 600, whiteSpace: 'nowrap' },
    }, '充值余额 →'),
  ),
  exhausted
    ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-accent, #3d6bfe)' } },
      '额度已用完 · 充值后继续使用')
    : null,
  exhausted
    ? React.createElement('span', { style: { fontSize: 12, opacity: 0.65 } }, '免费额度北京时间 0 点后恢复。')
    : null)
}


// The recharge panel: choose an amount, pay by scanning a QR code, watch the
// order until the gateway says the money arrived. The client never prices
// anything — it sends a tier id and shows what the gateway answers — and the
// polling stops as soon as the panel closes, so walking away costs nothing.
const panelCardStyle = {
  boxSizing: 'border-box', width: 380, maxWidth: 'calc(100vw - 32px)',
  background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', borderRadius: 14,
  padding: 24, boxShadow: '0 16px 48px rgba(0,0,0,0.18)', display: 'grid', gap: 20,
}
const tierButtonStyle = {
  flex: 1, minWidth: 0, padding: '12px 0', borderRadius: 8, cursor: 'pointer',
  font: 'inherit', fontSize: 14, color: 'inherit',
  border: '1px solid var(--dsw-alias-border, #d0d5dd)', background: 'transparent',
}
const chosenTierStyle = {
  ...tierButtonStyle, borderColor: 'var(--dsw-alias-accent, #3d6bfe)',
  color: 'var(--dsw-alias-accent, #3d6bfe)',
  background: 'color-mix(in srgb, var(--dsw-alias-accent, #3d6bfe) 7%, var(--dsw-alias-bg-base, #fff))',
  fontWeight: 600,
}
const primaryButtonStyle = {
  width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
  font: 'inherit', fontSize: 14, fontWeight: 600, background: 'var(--dsw-alias-accent, #3d6bfe)', color: '#fff',
}

function RechargePanel() {
  const [open, setOpen] = React.useState(recharge.open)
  const [config, setConfig] = React.useState(null)
  const [tier, setTier] = React.useState('t30')
  const [channel, setChannel] = React.useState(null)
  const [order, setOrder] = React.useState(null)
  const [phase, setPhase] = React.useState('choose')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    recharge.subscribe((next) => {
      setOpen(next)
      if (!next) {
        setPhase('choose')
        setOrder(null)
        setNotice('')
      }
    })
  }, [])

  React.useEffect(() => {
    if (!open || !window.__mareoPayment) return
    let active = true
    window.__mareoPayment.config().then((value) => {
      if (!active || !value) return
      setConfig(value)
      if (value.channels.length > 0) setChannel((current) => current || value.channels[0])
      if (!value.tiers.some((entry) => entry.tier === tier) && value.tiers.length > 0) setTier(value.tiers[0].tier)
    }).catch(() => {})
    return () => { active = false }
  }, [open])

  // While an order is pending, ask the gateway about it. The gateway itself asks
  // the platform when a notification is missing, so a lost callback still lands.
  React.useEffect(() => {
    if (!open || phase !== 'pay' || !order || !window.__mareoPayment) return
    let active = true
    const timer = setInterval(() => {
      window.__mareoPayment.order(order.orderId).then((value) => {
        if (!active || !value) return
        if (value.status === 'paid') {
          setOrder(value)
          setPhase('done')
          refreshQuotaNow()
        } else if (value.status === 'cancelled' || value.status === 'failed') {
          setOrder(value)
          setPhase('choose')
          setNotice('二维码已过期，请重新生成')
        }
      }).catch(() => {})
    }, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [open, phase, order?.orderId])

  const start = async () => {
    if (!window.__mareoPayment || channel === null) return
    setBusy(true)
    setNotice('')
    const result = await window.__mareoPayment.createOrder(tier, channel)
    setBusy(false)
    if (!result.ok) {
      setNotice(result.error)
      return
    }
    setOrder(result.order)
    setPhase('pay')
  }

  if (!open) return null

  const close = () => recharge.setOpen(false)
  const tiers = config?.tiers ?? []
  const amountOf = (id) => {
    const entry = tiers.find((item) => item.tier === id)
    return entry ? yuan(entry.amountMicro) : ''
  }
  const remaining = order ? Math.max(0, Math.floor((Date.parse(order.expiresAt) - Date.now()) / 1000)) : 0
  const clock = `${String(Math.floor(remaining / 3600)).padStart(1, '0')}:${String(Math.floor((remaining % 3600) / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`

  return React.createElement('div', {
    style: {
      position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'rgba(16,24,40,0.45)',
    },
    onClick: (event) => { if (event.target === event.currentTarget) close() },
  },
  React.createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'mareo-recharge-title', style: panelCardStyle },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      React.createElement('strong', { id: 'mareo-recharge-title', style: { fontSize: 17 } }, '充值 Mareo 余额'),
      React.createElement('button', {
        type: 'button', 'aria-label': '关闭充值',
        style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 18, opacity: 0.65 },
        onClick: close,
      }, '\u2715'),
    ),

    phase === 'choose'
      ? React.createElement('div', { style: { display: 'grid', gap: 18 } },
        React.createElement('div', { style: { display: 'grid', gap: 8 } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, '选择充值金额'),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            ...tiers.map((entry) => React.createElement('button', {
              key: entry.tier,
              type: 'button',
              'aria-pressed': entry.tier === tier,
              style: entry.tier === tier ? chosenTierStyle : tierButtonStyle,
              onClick: () => setTier(entry.tier),
            }, yuan(entry.amountMicro), entry.tier === tier ? ' ✓' : '')))),
        channel === null
          ? null
          : React.createElement('div', { style: { display: 'grid', gap: 8 } },
            React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, '支付方式'),
            config?.channels.length === 1
              ? React.createElement('span', { style: { fontSize: 13, opacity: 0.8 } },
                channel === 'alipay' ? '支付宝' : '微信支付')
              : React.createElement('div', { style: { display: 'flex', gap: 8 } },
                ...(config?.channels ?? []).map((id) => React.createElement('button', {
                  key: id,
                  type: 'button',
                  'aria-pressed': id === channel,
                  style: id === channel ? chosenTierStyle : tierButtonStyle,
                  onClick: () => setChannel(id),
                }, id === 'alipay' ? '支付宝' : '微信支付')))),
        React.createElement('button', {
          type: 'button', disabled: busy || channel === null || tiers.length === 0, style: primaryButtonStyle, onClick: start,
        }, busy ? '正在发起…' : channel === null ? '选择支付方式' :
          '使用' + (channel === 'alipay' ? '支付宝' : '微信') + '支付 ' + amountOf(tier)),
        notice ? React.createElement('div', { role: 'alert', style: { fontSize: 12, color: 'var(--dsw-alias-accent, #3d6bfe)' } }, notice) : null,
        React.createElement('div', { style: { fontSize: 12, opacity: 0.65, lineHeight: 1.7 } },
          '先扣今日免费额度，用完再扣余额；余额长期有效。'),
      )
      : null,

    phase === 'pay' && order
      ? React.createElement('div', { style: { display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center' } },
        React.createElement('div', { style: { fontSize: 13 } },
          '请用' + (order.channel === 'alipay' ? '支付宝' : '微信') + '扫码支付'),
        React.createElement('div', { style: { fontSize: 24, fontWeight: 600 } }, yuan(order.amountMicro)),
        // The gateway renders a 240px SVG. Give it its own quiet zone; never overlay the amount on the code.
        React.createElement('div', {
          style: {
            boxSizing: 'border-box', width: 266, maxWidth: '100%', minHeight: 266,
            padding: 12, background: '#fff', border: '1px solid var(--dsw-alias-border-l3, #d0d5dd)',
            borderRadius: 10, lineHeight: 0, overflow: 'hidden',
          },
          dangerouslySetInnerHTML: { __html: order.qrSvg || '' },
        }),
        React.createElement('div', { role: 'status', style: { fontSize: 13, opacity: 0.8 } }, '等待支付确认…'),
        React.createElement('div', { style: { fontSize: 12, opacity: 0.65 } }, '二维码剩余有效时间 ' + clock),
        React.createElement('button', {
          type: 'button', disabled: busy,
          style: {
            padding: '4px 8px', border: 'none', background: 'transparent', cursor: 'pointer',
            font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-accent, #3d6bfe)',
          },
          onClick: start,
        }, '重新生成'),
        notice ? React.createElement('div', { role: 'alert', style: { fontSize: 12 } }, notice) : null,
      )
      : null,

    phase === 'done' && order
      ? React.createElement('div', { style: { display: 'grid', gap: 8, justifyItems: 'center', padding: '8px 0' } },
        React.createElement('div', { style: { fontSize: 22 } }, '\u2713'),
        React.createElement('div', { style: { fontSize: 15, fontWeight: 600 } }, '已到账 ' + yuan(order.amountMicro)),
        React.createElement('button', { type: 'button', style: { ...primaryButtonStyle, width: 'auto', padding: '6px 20px' }, onClick: close }, '完成'),
      )
      : null,
  ))
}

function RechargeOverlay() {
  return React.createElement(RechargePanel)
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
  if (typeof window !== 'undefined' && window.__mareoPayment) {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'mareo-recharge' }, RechargeOverlay))
  }
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
