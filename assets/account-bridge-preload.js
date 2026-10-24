// Preload for the window that hosts the DSH web UI. It exposes a tiny,
// namespaced account bridge that the DSH-side "Account" settings section uses.
// All gateway traffic happens in the main process, which holds the token; the
// renderer never sees credentials.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__mareoSponsoredAd', {
  get: () => ipcRenderer.invoke('mareo:ad:get'),
  impression: (adId) => ipcRenderer.invoke('mareo:ad:impression', adId),
  click: (adId) => ipcRenderer.invoke('mareo:ad:click', adId),
})

// The quota meter. Read-only: the renderer learns what is left in yuan — today's
// free allowance and the wallet behind it — and the gateway alone decides what
// anyone may spend.
contextBridge.exposeInMainWorld('__mareoQuota', {
  get: () => ipcRenderer.invoke('mareo:quota:get'),
})

// The invite code. Read-only: the gateway decides who earned what, and pays it
// only after the invited account has been used for a day.
contextBridge.exposeInMainWorld('__mareoInvite', {
  get: () => ipcRenderer.invoke('mareo:invite:get'),
})

// Recharge. The main process talks to the gateway and to the payment platform;
// the renderer gets an amount, an order state and a QR code to show.
contextBridge.exposeInMainWorld('__mareoPayment', {
  config: () => ipcRenderer.invoke('mareo:payment:config'),
  createOrder: (tier, channel) => ipcRenderer.invoke('mareo:payment:create', { tier, channel }),
  order: (orderId) => ipcRenderer.invoke('mareo:payment:order', orderId),
  orders: (limit) => ipcRenderer.invoke('mareo:payment:orders', limit),
})

contextBridge.exposeInMainWorld('__mareoAccount', {
  getProfile: () => ipcRenderer.invoke('mareo:account:get'),
  updateName: (displayName) => ipcRenderer.invoke('mareo:account:update-name', displayName),
  signOut: () => ipcRenderer.invoke('mareo:account:sign-out'),
})

// The anonymous-statistics switch lives in the same settings section.
contextBridge.exposeInMainWorld('__mareoTelemetry', {
  get: () => ipcRenderer.invoke('mareo:telemetry:get'),
  set: (enabled) => ipcRenderer.invoke('mareo:telemetry:set', enabled),
})
