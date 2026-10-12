import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

interface SignModule {
  isMareoArtifact(file: string): boolean
  hasSigningCredentials(): boolean
  signMareoFile(file: string): void
}

const load = (): SignModule => require(path.resolve('scripts/sign-windows.cjs')) as SignModule

test('signs only the binaries Mareo owns', () => {
  const { isMareoArtifact } = load()
  assert.equal(isMareoArtifact('C:\\build\\Mareo-win32-x64\\Mareo.exe'), true)
  assert.equal(isMareoArtifact('out/make/squirrel.windows/x64/MareoSetup.exe'), true)
  // These arrive signed by their vendors and are packed unmodified; re-signing
  // them would only spend the annual signing quota.
  assert.equal(isMareoArtifact('C:\\build\\Mareo-win32-x64\\chrome_elf.dll'), false)
  assert.equal(isMareoArtifact('C:\\build\\Mareo-win32-x64\\resources\\node-runtime\\bin\\node.exe'), false)
  // postMake creates this copy after signing; a copy keeps the signature.
  assert.equal(isMareoArtifact('C:\\build\\Mareo-0.1.9-windows-x64-setup.exe'), false)
})

test('refuses to sign without credentials instead of shipping an unsigned build', () => {
  const module = load()
  const names = ['ACCESS_KEY', 'ACCESS_SECRET', 'SSLTRUS_CERT_CODE']
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    for (const name of names) delete process.env[name]
    assert.equal(module.hasSigningCredentials(), false)
    assert.throws(() => module.signMareoFile('/tmp/Mareo.exe'), /ACCESS_KEY/)
  } finally {
    for (const name of names) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
