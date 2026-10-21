import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compareVersions } from './update-check.js'

/**
 * The newest runtime that has run against this machine's DSH state.
 *
 * A session log's event vocabulary only grows, and DSH refuses to interpret a
 * log holding an event type it does not know, so a build older than the one that
 * wrote a session can never open it. Stamping the runtime at every launch lets
 * that older build warn before a session fails, and keep warning until it is
 * upgraded: the unreadable sessions stay on disk.
 */
export interface HarnessStamp {
  appVersion: string
  dshVersion: string
}

export function harnessStampPath(userDataPath: string): string {
  return path.join(userDataPath, 'harness.json')
}

/** Never throws: a missing or malformed stamp reads as a first run. */
export async function loadHarnessStamp(userDataPath: string): Promise<HarnessStamp | undefined> {
  try {
    const raw = JSON.parse(await readFile(harnessStampPath(userDataPath), 'utf8')) as Record<string, unknown>
    const { appVersion, dshVersion } = raw
    if (typeof appVersion !== 'string' || typeof dshVersion !== 'string') return undefined
    return { appVersion, dshVersion }
  } catch {
    return undefined
  }
}

/**
 * Records the running runtime and returns the newest runtime known to have run
 * here. Each version only moves forward, so a downgraded launch neither erases
 * what a newer one wrote nor silences the warning it triggers.
 *
 * A failed write is swallowed: the stamp is advice for the next launch, and it
 * must never keep this one from starting.
 */
export async function rememberHarness(userDataPath: string, current: HarnessStamp): Promise<HarnessStamp> {
  const recorded = await loadHarnessStamp(userDataPath)
  if (recorded === undefined) {
    await writeStamp(userDataPath, current)
    return { ...current }
  }

  const newest: HarnessStamp = {
    appVersion: newerVersion(recorded.appVersion, current.appVersion),
    dshVersion: newerVersion(recorded.dshVersion, current.dshVersion),
  }
  if (newest.appVersion !== recorded.appVersion || newest.dshVersion !== recorded.dshVersion) {
    await writeStamp(userDataPath, newest)
  }
  return newest
}

/**
 * True when this build bundles an older DSH than one that already ran here. Only
 * DSH decides whether a log can be read, so an older Mareo on the same DSH
 * carries no risk of unreadable sessions.
 */
export function isHarnessDowngrade(newest: HarnessStamp, current: HarnessStamp): boolean {
  return compareVersions(newest.dshVersion, current.dshVersion) > 0
}

function newerVersion(recorded: string, current: string): string {
  return compareVersions(recorded, current) > 0 ? recorded : current
}

async function writeStamp(userDataPath: string, stamp: HarnessStamp): Promise<void> {
  try {
    await writeFile(harnessStampPath(userDataPath), `${JSON.stringify(stamp, null, 2)}\n`)
  } catch {
    // An unwritable userData directory has already failed loudly elsewhere.
  }
}
