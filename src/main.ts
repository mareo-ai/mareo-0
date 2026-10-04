import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  checkToken,
  clearAccount,
  GATEWAY_URL,
  loadAccountSession,
  requestEmailCode,
  saveAccountSession,
  signInWithEmailCode,
  type AccountSession,
} from './account.js'
import { prepareAccountHome } from './account-home.js'
import { applyDefaultModel } from './model-default.js'
import { startDshRuntime, type DshRuntime } from './dsh-runtime.js'
import { squirrelActionFor, type SquirrelAction } from './squirrel.js'
import {
  fetchLatestRelease,
  isNewerVersion,
  isUpdateRequired,
  selectDownloadUrl,
  updatePromptCopy,
} from './update-check.js'
import { claimUpdatePrompt } from './update-prompt.js'
import { loadPreferences, savePreferences, type Preferences } from './preferences.js'
import { readSessionTitles, unreportedTitles } from './session-titles.js'
import { stripLocalPaths, Telemetry, type TelemetryEvent } from './telemetry.js'
import { SponsoredAdClient } from './sponsored-ad.js'
import { QuotaClient } from './quota.js'

let mainWindow: BrowserWindow | undefined
let sponsoredAd: SponsoredAdClient | undefined
let quotaClient: QuotaClient | undefined
let dshRuntime: DshRuntime | undefined
let shutdownComplete = false
// The signed-in account for the current run; used by the account bridge.
let currentAccount: AccountSession | undefined
// While the sign-in window is open there is no main window yet; the app must
// not quit merely because all (gate) windows closed on a successful sign-in.
let signInActive = false
// Anonymous operational statistics; undefined until preferences are loaded.
let telemetry: Telemetry | undefined
let preferences: Preferences | undefined
// Reported with a harness exit so a crash has a duration attached to it.
let dshStartedAt = 0

/** Anonymous event; a no-op when the user turned statistics off. */
function recordEvent(event: TelemetryEvent): void {
  telemetry?.record(event)
}

// Main-process failures are written to a log so a Windows user can send the
// stack back when something goes wrong inside the shell.
function logMainProcessError(kind: string, error: unknown): void {
  try {
    const logDirectory = path.join(app.getPath('userData'), 'logs')
    mkdirSync(logDirectory, { recursive: true })
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    appendFileSync(path.join(logDirectory, 'mareo-app.log'), `${new Date().toISOString()} ${kind} ${detail}\n`)
  } catch {
    // Logging must never replace the original failure.
  }
}

process.on('uncaughtException', (error) => {
  logMainProcessError('uncaughtException', error)
  const logFile = path.join(app.getPath('userData'), 'logs', 'mareo-app.log')
  const message = error instanceof Error ? error.message : String(error)
  if (app.isReady()) {
    dialog.showErrorBox('Mareo 遇到错误', `应用即将退出。\n\n${message}\n\n日志：${logFile}`)
  }
  app.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logMainProcessError('unhandledRejection', reason)
})

app.setName('Mareo')
// Keep existing installations' data independent of the display name.
// MAREO_USER_DATA lets a source run use a throwaway data directory, so local
// testing never touches the installed app's sessions or account.
const userDataOverride = process.env.MAREO_USER_DATA
app.setPath(
  'userData',
  userDataOverride && !app.isPackaged ? userDataOverride : path.join(app.getPath('appData'), 'Mareo'),
)

const squirrelAction = squirrelActionFor(process.argv)
if (squirrelAction !== undefined) {
  // Squirrel install/update/uninstall invocation: handle shortcuts and exit
  // without starting the app (otherwise the login window pops up mid-install).
  runSquirrelAction(squirrelAction)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    registerAccountBridge()
    registerContentBridges()
    await startMareo()
  }).catch(showFatalError)

  app.on('window-all-closed', () => {
    if (!signInActive) app.quit()
  })
  app.on('before-quit', (event) => {
    // Best effort: whatever is still queued goes out with the shutdown.
    void telemetry?.flush()
    if (shutdownComplete || !dshRuntime) return
    event.preventDefault()
    const runtime = dshRuntime
    dshRuntime = undefined
    runtime.stop().finally(() => {
      shutdownComplete = true
      app.quit()
    })
  })
}

/** Runs the Squirrel lifecycle command by delegating to Update.exe. */
function runSquirrelAction(action: SquirrelAction): void {
  if (action === 'quit') {
    app.quit()
    return
  }
  const updateExe = path.join(path.resolve(path.dirname(process.execPath), '..'), 'Update.exe')
  const executableName = path.basename(process.execPath)
  const args = action === 'create-shortcuts'
    ? ['--createShortcut', executableName]
    : ['--removeShortcut', executableName]
  const child = spawn(updateExe, args, { detached: true, stdio: 'ignore' })
  child.once('error', () => {
    // Nothing to recover here: Squirrel retries on the next install/update.
  })
  child.unref()
  setTimeout(() => app.quit(), 1_000)
}

/** DSH data directory; per-account homes live in its accounts/ subdirectory. */
function dshBasePath(): string {
  return path.join(app.getPath('userData'), 'dsh')
}

/**
 * A first successful launch is what tells us an install actually worked. It is
 * reported once per installation, and the marker is only written when the report
 * arrived so a failed send is retried on the next launch.
 */
async function reportFirstInstall(): Promise<void> {
  const marker = path.join(app.getPath('userData'), '.install-reported')
  if (telemetry === undefined || existsSync(marker)) return
  if (await telemetry.sendNow({ name: 'install_confirmed', detail: { arch: process.arch } })) {
    writeFileSync(marker, '')
  }
}

async function startMareo(): Promise<void> {
  const startedAt = Date.now()
  preferences = await loadPreferences(app.getPath('userData'))
  telemetry = new Telemetry({
    endpoint: `${GATEWAY_URL}/events`,
    version: app.getVersion(),
    // MAREO_TELEMETRY=off is a debugging escape hatch for the same switch.
    enabled: preferences.telemetry && process.env.MAREO_TELEMETRY !== 'off',
  })
  // Windows/Linux show Electron's default File/Edit/View menu bar; macOS keeps
  // its own system menu, so only the other platforms are cleared.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  if (!(await passesMinimumVersion())) {
    recordEvent({ name: 'launch', detail: { ok: false, stage: 'update-required' } })
    await telemetry.flush()
    app.quit()
    return
  }
  scheduleUpdateCheck()
  app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'app-icon.png'))
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  const account = await acquireAccountSession()
  if (!account) {
    recordEvent({ name: 'launch', detail: { ok: false, stage: 'signed-out' } })
    await telemetry.flush()
    app.quit()
    return
  }
  currentAccount = account
  telemetry.setToken(account.token)

  // Signed-in accounts always carry an id. Without it we must not fall back to
  // the shared DSH home, which still holds pre-isolation history.
  if (!account.accountId) {
    recordEvent({ name: 'launch', detail: { ok: false, stage: 'account-incomplete' } })
    await telemetry.flush()
    await dialog.showMessageBox({
      type: 'error',
      title: '登录信息不完整',
      message: '无法确认当前账户，Mareo 已退出以避免本地数据混用。',
      buttons: ['退出'],
    })
    app.quit()
    return
  }

  mainWindow = new BrowserWindow({
    title: 'Mareo',
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'assets', 'account-bridge-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow?.setTitle('Mareo')
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      // A fresh document gets fresh gateway state: the ad configured now, and
      // the quota that was spent while the previous document was open.
      sponsoredAd = new SponsoredAdClient(GATEWAY_URL, account.token, (url) => shell.openExternal(url))
      quotaClient = new QuotaClient(GATEWAY_URL, account.token)
    }
  })
  await mainWindow.loadFile(path.join(app.getAppPath(), 'assets', 'startup.html'))

  while (mainWindow && !mainWindow.isDestroyed()) {
    // The engine's own output; when a start fails this is the file to ask for.
    const engineLog = path.join(app.getPath('userData'), 'logs', 'mareo.log')
    try {
      const runtimeDirectory = app.isPackaged
        ? process.resourcesPath
        : path.join(app.getAppPath(), '.staging')
      const dshHome = await prepareAccountHome(dshBasePath(), account.accountId)
      // Pin the model before the engine reads its settings: the catalog's legacy
      // default is declared text-only, and image reading depends on this.
      await applyDefaultModel(dshHome)
      dshRuntime = await startDshRuntime({
        runtimeDirectory: path.join(runtimeDirectory, 'dsh-runtime'),
        nodeExecutable: path.join(runtimeDirectory, 'node-runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
        dshHome,
        workingDirectory: app.getPath('home'),
        logFile: engineLog,
        env: {
          // Model credentials come from the account, never from the user.
          DEEPSEEK_API_KEY: account.token,
          DEEPSEEK_BASE_URL: GATEWAY_URL,
          // The bundled web search calls the model API on its own; without this
          // it goes straight to DeepSeek with the account token, which that
          // endpoint does not accept — and nothing would be metered. The
          // provider appends `/messages`, so the base ends at `/anthropic/v1`.
          DEEPSEEK_SEARCH_BASE_URL: `${GATEWAY_URL}/anthropic/v1`,
        },
        onUnexpectedExit: (message, errorOutput) => showUnexpectedExit(message, errorOutput),
      })
      secureDshWindow(mainWindow, dshRuntime.origin)
      await mainWindow.loadURL(dshRuntime.url)
      dshStartedAt = Date.now()
      recordEvent({ name: 'launch', detail: { ok: true, ms: Date.now() - startedAt } })
      await telemetry.flush()
      await reportFirstInstall()
      void reportSessionTitles(dshHome)
      scheduleSessionTitleReport(dshHome)
      return
    } catch (error) {
      await dshRuntime?.stop()
      dshRuntime = undefined
      const detail = error instanceof Error ? error.message : String(error)
      recordEvent({ name: 'launch', detail: { ok: false, stage: 'harness', error: stripLocalPaths(detail) } })
      await telemetry.flush()
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Mareo 无法启动',
        message: '引擎启动失败。',
        detail: `${detail}\n\n引擎日志：${engineLog}`,
        buttons: ['重试', '退出'],
        defaultId: 0,
        cancelId: 1,
      })
      if (choice.response === 1) {
        app.quit()
        return
      }
    }
  }
}

/**
 * Returns the account for this launch, showing the sign-in screen when no
 * valid account is stored. Returns undefined when the user quits.
 */async function acquireAccountSession(): Promise<AccountSession | undefined> {
  const stored = loadAccountSession()
  if (stored && stored.token) {
    const check = await checkToken(stored.token)
    if (check.valid) {
      // Refresh the account id (older stored sessions did not keep one).
      const account = { token: stored.token, accountId: check.accountId }
      if (account.accountId !== stored.accountId) saveAccountSession(account)
      return account
    }
    if (check.reason === 'invalid') {
      // A revoked token is no longer usable; fall through to sign-in.
      clearAccount()
    } else {
      // The gateway is unreachable right now: keep the stored session and let
      // the DSH boot flow surface the connection problem with its retry dialog.
      return stored
    }
  }
  return promptForSignIn()
}

function promptForSignIn(): Promise<AccountSession | undefined> {
  signInActive = true
  const handlers = ['mareo:sign-in', 'mareo:send-code', 'mareo:email-sign-in']
  return new Promise((resolve) => {
    let settled = false
    const settle = (account?: AccountSession): void => {
      if (settled) return
      settled = true
      // Closing the sign-in window without signing in is itself a funnel signal.
      if (account === undefined) recordEvent({ name: 'signin', detail: { result: 'cancelled' } })
      for (const name of handlers) ipcMain.removeHandler(name)
      if (!signInWindow.isDestroyed()) signInWindow.destroy()
      signInActive = false
      resolve(account)
    }

    const signInWindow = new BrowserWindow({
      title: '登录 Mareo',
      width: 440,
      height: 640,
      resizable: false,
      show: false,
      webPreferences: {
        preload: path.join(app.getAppPath(), 'assets', 'signin-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    signInWindow.on('closed', () => settle(undefined))
    signInWindow.once('ready-to-show', () => signInWindow.show())
    // The privacy notice links out; without this Electron would open a blank
    // in-app window instead of the browser.
    signInWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    const gatewayError = `无法连接 Mareo 服务（${GATEWAY_URL}），请稍后重试。`

    ipcMain.handle('mareo:sign-in', async (_event, rawToken: unknown) => {
      if (typeof rawToken !== 'string' || rawToken.trim() === '') {
        return { ok: false, error: '请输入访问令牌。' }
      }
      const token = rawToken.trim()
      const check = await checkToken(token)
      if (!check.valid) {
        recordEvent({ name: 'signin', detail: { result: check.reason === 'invalid' ? 'token-invalid' : 'unreachable', method: 'token' } })
        return {
          ok: false,
          error: check.reason === 'invalid' ? '该访问令牌无效，请联系管理员。' : gatewayError,
        }
      }
      const account = { token, accountId: check.accountId }
      saveAccountSession(account)
      recordEvent({ name: 'signin', detail: { result: 'ok', method: 'token' } })
      settle(account)
      return { ok: true }
    })

    ipcMain.handle('mareo:send-code', async (_event, rawEmail: unknown) => {
      if (typeof rawEmail !== 'string' || !rawEmail.includes('@')) {
        return { ok: false, error: '邮箱地址格式不正确。' }
      }
      const result = await requestEmailCode(rawEmail.trim())
      if (result.ok) {
        recordEvent({ name: 'signin', detail: { result: 'send-ok' } })
        return { ok: true }
      }
      recordEvent({ name: 'signin', detail: { result: `send-${result.reason}` } })
      const messages = {
        cooldown: '发送过于频繁，请 60 秒后再试。',
        'daily-limit': '该邮箱今日发送次数已达上限，请明天再试。',
        'invalid-email': '邮箱地址格式不正确。',
        'delivery-failed': '邮件发送失败，请稍后重试。',
        unreachable: gatewayError,
      }
      return { ok: false, error: messages[result.reason] }
    })

    ipcMain.handle('mareo:email-sign-in', async (_event, rawEmail: unknown, rawCode: unknown) => {
      if (typeof rawEmail !== 'string' || typeof rawCode !== 'string') {
        return { ok: false, error: '请输入邮箱和验证码。' }
      }
      const result = await signInWithEmailCode(rawEmail.trim(), rawCode.trim())
      if (!result.ok) {
        recordEvent({ name: 'signin', detail: { result: result.reason, method: 'email' } })
        const messages = {
          'no-code': '请先获取验证码。',
          expired: '验证码已过期，请重新获取。',
          'too-many-attempts': '尝试次数过多，请重新获取验证码。',
          'wrong-code': '验证码不正确。',
          'invalid-request': '请求有误，请重试。',
          unreachable: gatewayError,
        }
        return { ok: false, error: messages[result.reason] }
      }
      const account = { token: result.token, accountId: result.accountId }
      saveAccountSession(account)
      recordEvent({ name: 'signin', detail: { result: 'ok', method: 'email' } })
      settle(account)
      return { ok: true }
    })

    void signInWindow.loadFile(path.join(app.getAppPath(), 'assets', 'signin.html'))
  })
}

const UPDATE_MANIFEST_URL = process.env.MAREO_UPDATE_URL ?? 'https://mareo.cn/updates/latest.json'
const UPDATE_PROMPT_FILE = 'update-prompt.json'

/**
 * A release can declare a minimum supported version; a build below it may not be
 * used at all. This runs before the sign-in window and before DSH starts, so the
 * old build simply never comes up. Every lookup failure lets the app start: a
 * network problem at our end must never lock users out.
 */
async function passesMinimumVersion(): Promise<boolean> {
  if (!app.isPackaged || process.env.MAREO_UPDATE_CHECK === 'off') return true
  const manifest = await fetchLatestRelease(UPDATE_MANIFEST_URL)
  if (manifest === undefined || !isUpdateRequired(manifest, app.getVersion())) return true
  const downloadUrl = selectDownloadUrl(manifest)
  // Without a download for this platform there is nowhere to send the user, and
  // blocking would leave them stuck on an unusable app.
  if (downloadUrl === undefined) return true

  while (true) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: '请更新 Mareo',
      message: `当前版本 ${app.getVersion()} 已不受支持，请更新到 ${manifest.version} 后继续使用。`,
      detail: `${manifest.notes ?? '请下载并安装最新版本。'}\n\n下载页面已在浏览器中打开，安装完成后重新启动 Mareo。`,
      buttons: ['前往下载', '退出'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return false
    await shell.openExternal(downloadUrl)
  }
}

/** Local calendar day, so a reminder is not repeated after a quick restart. */
function localDateStamp(): string {
  const now = new Date()
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
}

/**
 * Re-checks the manifest every few hours: users keep the app open for days, and
 * a release published meanwhile has to be noticed without a restart. The prompt
 * itself is claimed at most once a day, so re-checking cannot turn into nagging.
 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 3600 * 1000
let updatePromptOpen = false

function scheduleUpdateCheck(delayMs = 10_000): void {
  if (!app.isPackaged || process.env.MAREO_UPDATE_CHECK === 'off') return
  setTimeout(() => {
    void notifyIfUpdateAvailable().finally(() => scheduleUpdateCheck(UPDATE_CHECK_INTERVAL_MS))
  }, delayMs)
}

async function notifyIfUpdateAvailable(): Promise<void> {
  // A prompt the user has not answered yet must not be replaced by a second one.
  if (updatePromptOpen) return
  const manifest = await fetchLatestRelease(UPDATE_MANIFEST_URL)
  if (manifest === undefined || !isNewerVersion(manifest.version, app.getVersion())) return
  const downloadUrl = selectDownloadUrl(manifest)
  if (downloadUrl === undefined) return
  const promptState = path.join(app.getPath('userData'), UPDATE_PROMPT_FILE)
  if (!(await claimUpdatePrompt(promptState, localDateStamp()))) return

  const options = {
    type: 'info' as const,
    ...updatePromptCopy(manifest, app.getVersion()),
    defaultId: 0,
    cancelId: 1,
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  updatePromptOpen = true
  try {
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (response === 0) void shell.openExternal(downloadUrl)
  } finally {
    updatePromptOpen = false
  }
}

function registerAccountBridge(): void {
  ipcMain.handle('mareo:telemetry:get', () => ({ ok: true, enabled: preferences?.telemetry ?? true }))
  ipcMain.handle('mareo:telemetry:set', async (_event, rawEnabled: unknown) => {
    if (typeof rawEnabled !== 'boolean' || preferences === undefined) return { ok: false }
    preferences = { ...preferences, telemetry: rawEnabled }
    telemetry?.setEnabled(rawEnabled && process.env.MAREO_TELEMETRY !== 'off')
    try {
      await savePreferences(app.getPath('userData'), preferences)
    } catch (error) {
      logMainProcessError('save-preferences', error)
      return { ok: false }
    }
    return { ok: true, enabled: preferences.telemetry }
  })
  ipcMain.handle('mareo:account:get', async () => {
    if (!currentAccount) return { ok: false, error: 'signed-out' }
    try {
      const response = await fetch(`${GATEWAY_URL}/me`, {
        headers: { authorization: `Bearer ${currentAccount.token}` },
        signal: AbortSignal.timeout(8_000),
      })
      if (response.status === 200) {
        const body = (await response.json()) as { displayName?: string; email?: string | null }
        return { ok: true, displayName: body.displayName ?? '', email: body.email ?? null }
      }
      return { ok: false, error: 'unauthorized' }
    } catch {
      return { ok: false, error: 'unreachable' }
    }
  })

  ipcMain.handle('mareo:account:update-name', async (_event, rawName: unknown) => {
    const displayName = typeof rawName === 'string' ? rawName.trim() : ''
    if (!currentAccount || displayName.length === 0 || displayName.length > 32) {
      return { ok: false, error: 'invalid-name' }
    }
    try {
      const response = await fetch(`${GATEWAY_URL}/account/name`, {
        method: 'POST',
        headers: { authorization: `Bearer ${currentAccount.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
        signal: AbortSignal.timeout(8_000),
      })
      if (response.status === 200) return { ok: true, displayName }
      return { ok: false, error: 'failed' }
    } catch {
      return { ok: false, error: 'unreachable' }
    }
  })

  ipcMain.handle('mareo:account:sign-out', async () => {
    if (currentAccount) {
      try {
        await fetch(`${GATEWAY_URL}/account/sign-out`, {
          method: 'POST',
          headers: { authorization: `Bearer ${currentAccount.token}` },
          signal: AbortSignal.timeout(8_000),
        })
      } catch {
        // Even if the network call fails, sign out locally.
      }
    }
    setTimeout(() => {
      void returnToSignIn()
    }, 0)
    return { ok: true }
  })
}

/** Tears down the running session and shows the sign-in window again. */
async function returnToSignIn(): Promise<void> {
  signInActive = true
  sponsoredAd = undefined
  quotaClient = undefined
  if (dshRuntime) {
    const runtime = dshRuntime
    dshRuntime = undefined
    await runtime.stop()
  }
  currentAccount = undefined
  clearAccount()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
  mainWindow = undefined
  await startMareo()
}

function secureDshWindow(window: BrowserWindow, allowedOrigin: string): void {
  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (new URL(navigationUrl).origin !== allowedOrigin) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        void shell.openExternal(target.toString())
      }
    } catch {
      // Invalid and unsupported links stay closed.
    }
    return { action: 'deny' }
  })
}

/** Only the signed-in DSH document may use the bridges below. */
function isDshSender(event: IpcMainInvokeEvent): boolean {
  if (!currentAccount || !mainWindow || mainWindow.isDestroyed() || !dshRuntime ||
      event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) return false
  try {
    return new URL(event.senderFrame.url).origin === dshRuntime.origin
  } catch { return false }
}

function registerContentBridges(): void {
  ipcMain.handle('mareo:ad:get', (event) => isDshSender(event) ? sponsoredAd?.load() ?? null : null)
  ipcMain.handle('mareo:ad:impression', (event, adId: unknown) => {
    if (isDshSender(event) && mainWindow?.isFocused() && !mainWindow.isMinimized()) sponsoredAd?.impression(adId)
  })
  ipcMain.handle('mareo:ad:click', (event, adId: unknown) => {
    if (!isDshSender(event) || !mainWindow?.isFocused()) return false
    return sponsoredAd?.click(adId) ?? false
  })
  // The quota meter is read-only for the user: it reports what the gateway says
  // and nothing else. Earning extra quota exists server-side, but has no
  // user-facing entry until a real provider is connected.
  ipcMain.handle('mareo:quota:get', (event) => isDshSender(event) ? quotaClient?.load() ?? null : null)
}

/**
 * Reports the session titles the engine stores locally. Only the title text is
 * read — no message bodies and no file paths — and each title is sent once. The
 * gateway already sees model-generated titles; this covers the fallback ones.
 */
async function reportSessionTitles(dshHome: string): Promise<void> {
  if (telemetry === undefined) return
  const titles = await readSessionTitles(dshHome)
  if (titles.length === 0) return
  const statePath = path.join(app.getPath('userData'), 'reported-session-titles.json')
  for (const entry of await unreportedTitles(statePath, titles)) {
    telemetry.record({ name: 'session_title', detail: { sessionId: entry.sessionId, title: entry.title } })
  }
}

/** Titles appear as sessions are created, so look again while the app runs. */
function scheduleSessionTitleReport(dshHome: string): void {
  const timer = setInterval(() => void reportSessionTitles(dshHome), 30 * 60 * 1000)
  timer.unref()
}

function showUnexpectedExit(message: string, errorOutput = ''): void {
  dshRuntime = undefined
  recordEvent({
    name: 'harness_exit',
    detail: {
      reason: stripLocalPaths(message),
      ms: dshStartedAt === 0 ? 0 : Date.now() - dshStartedAt,
      // Already stripped of paths and tokens by the runtime; empty when DSH died
      // without saying anything.
      ...(errorOutput === '' ? {} : { tail: errorOutput }),
    },
  })
  if (!mainWindow || mainWindow.isDestroyed()) return
  void dialog
    .showMessageBox(mainWindow, {
      type: 'error',
      title: 'Mareo 已停止',
      message: '引擎意外退出，需要重新启动。',
      detail: `日志文件：${path.join(app.getPath('userData'), 'logs', 'mareo.log')}`,
      buttons: ['退出'],
    })
    .then(() => app.quit())
}

function showFatalError(error: unknown): void {
  dialog.showErrorBox('Mareo 无法启动', error instanceof Error ? error.message : String(error))
  app.quit()
}
