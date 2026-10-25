// Sandboxed preload for the Mareo sign-in screen. It only exposes the three
// actions the page needs; validation and storage happen in the main process,
// so the renderer never talks to the gateway directly.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mareo', {
  signIn: (token) => ipcRenderer.invoke('mareo:sign-in', token),
  sendCode: (email) => ipcRenderer.invoke('mareo:send-code', email),
  emailSignIn: (email, code, inviteCode) => ipcRenderer.invoke('mareo:email-sign-in', email, code, inviteCode ?? ''),
})
