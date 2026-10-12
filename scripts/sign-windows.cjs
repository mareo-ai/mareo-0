// Windows code signing through the sslTrus remote signing service.
//
// The certificate has no UKey: its private key lives in the vendor's HSM, so
// signing means calling their CLI, which uploads a hash and returns a signature.
//
// Two callers use this module:
//   - `@electron/windows-sign`, once per PE file it finds while packaging. Only
//     `Mareo.exe` matters there: packing rewrites its resources (icon, version
//     info), which invalidates the signature Electron shipped, and a file whose
//     signature no longer matches is worse than an unsigned one.
//   - forge's `postMake` hook, for the Squirrel installer the user downloads.
//
// Everything else is deliberately skipped: the Electron DLLs and the bundled
// `node.exe` are copied unmodified, so they keep the signatures their vendors
// shipped, and re-signing them would only spend the annual signing quota.
//
// Credentials arrive through the environment — `ACCESS_KEY` and `ACCESS_SECRET`
// as the CLI itself reads them, plus `SSLTRUS_CERT_CODE` to pick the
// certificate. Secrets stay out of argv and out of the build log.
const { execFileSync } = require('node:child_process')

const REQUIRED_ENV = ['ACCESS_KEY', 'ACCESS_SECRET', 'SSLTRUS_CERT_CODE']

/** The binaries Mareo owns: the app entry point and the Squirrel installer. */
function isMareoArtifact(file) {
  return /(^|[\\/])Mareo(Setup)?\.exe$/i.test(file)
}

/** CI installs the CLI outside PATH, where a Microsoft `signtool` also lives. */
function signToolPath() {
  return process.env.SSLTRUS_SIGNTOOL || (process.platform === 'win32' ? 'signtool.exe' : 'signtool')
}

/** Whether this machine can sign at all; callers that may skip unsigned ask first. */
function hasSigningCredentials() {
  return REQUIRED_ENV.every((name) => (process.env[name] ?? '') !== '')
}

/** Sign one file in place, or throw: a silently unsigned installer costs trust. */
function signMareoFile(file) {
  if (!hasSigningCredentials()) {
    throw new Error('Windows signing needs ACCESS_KEY, ACCESS_SECRET and SSLTRUS_CERT_CODE in the environment')
  }

  execFileSync(
    signToolPath(),
    [
      'sign',
      '--cert-code',
      process.env.SSLTRUS_CERT_CODE,
      '--file',
      file,
      // Overwrite the input, clearing the signature the packager invalidated
      // before adding ours: nesting a new signature over a broken one still
      // makes Windows complain about the file.
      '--override=true',
      '--nest=false',
      '--desc',
      'Mareo',
      '--url',
      'https://mareo.cn',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
}

/**
 * The hook `@electron/windows-sign` calls, one file at a time. Skipping is
 * logged rather than silent, so a build log shows exactly what was signed.
 */
module.exports = async function signWindowsArtifact(file) {
  if (!isMareoArtifact(file)) {
    console.log(`skipping ${file} (not a Mareo binary; vendor signature kept)`)
    return
  }
  signMareoFile(file)
  console.log(`signed ${file}`)
}

module.exports.isMareoArtifact = isMareoArtifact
module.exports.hasSigningCredentials = hasSigningCredentials
module.exports.signMareoFile = signMareoFile
