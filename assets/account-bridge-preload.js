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
