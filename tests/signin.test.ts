import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync('assets/signin.html', 'utf8')

function loginPage() {
  // Hidden follows the markup, so a field that ships hidden starts hidden.
  const hiddenByMarkup = new Set(
    [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]
      .filter(([tag]) => /\shidden[\s>/]/.test(tag))
      .map(([, id]) => id),
  )
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', textContent: '', className: '', disabled: false, hidden: hiddenByMarkup.has(id),
    focused: false, events: {} as Record<string, () => Promise<void> | void>,
    focus() { this.focused = true },
    addEventListener(event: string, callback: () => Promise<void> | void) { this.events[event] = callback },
  }]))
  let tick = () => {}
  const calls: string[] = []
  const invited: string[] = []
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: (id: string) => elements.get(id) },
    window: { mareo: {
      sendCode: async () => { calls.push('send'); return { ok: true } },
      emailSignIn: async (_email: string, _code: string, inviteCode: string) => {
        calls.push('email')
        invited.push(inviteCode ?? '')
        return { ok: false, error: '验证码不正确。' }
      },
      signIn: async () => { calls.push('token'); return { ok: true } },
    } },
    setInterval: (callback: () => void) => { tick = callback; return 1 },
    clearInterval: () => {},
  })
  return { element: (id: string) => elements.get(id)!, calls, invited, tick: () => tick() }
}

test('email validation, send status and countdown stay intact', async () => {
  const page = loginPage()
  await page.element('send-code').events.click()
  assert.deepEqual(page.calls, [])
  assert.equal(page.element('email-status').className, 'status error')
  page.element('email').value = 'preview@example.test'
  await page.element('send-code').events.click()
  assert.equal(page.element('send-code').disabled, true)
  assert.equal(page.element('email-status').className, 'status ok')
  page.tick()
  assert.equal(page.element('send-code').textContent, '重新发送（59s）')
  for (let i = 0; i < 59; i++) page.tick()
  assert.equal(page.element('send-code').disabled, false)
  assert.equal(page.element('send-code').textContent, '发送验证码')
})

test('email failures restore the primary action; token login keeps its flow', async () => {
  const page = loginPage()
  page.element('email').value = 'preview@example.test'
  page.element('code').value = '000000'
  await page.element('email-sign-in').events.click()
  assert.equal(page.element('email-status').textContent, '验证码不正确。')
  assert.equal(page.element('email-sign-in').disabled, false)
  await page.element('show-token').events.click()
  assert.equal(page.element('email-mode').hidden, true)
  assert.equal(page.element('token-mode').hidden, false)
  page.element('token').value = 'test-only-token'
  await page.element('token-sign-in').events.click()
  assert.equal(page.element('token-status').textContent, '登录成功，正在启动…')
  await page.element('show-email').events.click()
  assert.equal(page.element('email-mode').hidden, false)
  assert.equal(page.element('token-mode').hidden, true)
  assert.deepEqual(page.calls, ['email', 'token'])
})

test('both alternative sign-in actions are keyboard-accessible buttons', () => {
  for (const id of ['show-token', 'show-email']) {
    assert.match(html, new RegExp(`<button[^>]+id="${id}"[^>]+type="button"`))
  }
})

test('the invite code stays out of the way until it is asked for', async () => {
  const page = loginPage()
  // Hidden by default: most people arrive from a link, not carrying a code.
  assert.equal(page.element('invite-field').hidden, true)
  await page.element('show-invite').events.click()
  assert.equal(page.element('invite-field').hidden, false)
  assert.equal(page.element('show-invite').hidden, true)
})

test('a typed invite code reaches the sign-in call; an untouched field sends nothing', async () => {
  const page = loginPage()
  page.element('email').value = 'invitee@example.test'
  page.element('code').value = '123456'
  await page.element('email-sign-in').events.click()
  assert.deepEqual(page.invited, [''], '没有展开时不传邀请码')

  await page.element('show-invite').events.click()
  page.element('invite').value = ' abcd2345 '
  await page.element('email-sign-in').events.click()
  assert.deepEqual(page.invited, ['', 'abcd2345'], '填了邀请码就带上，且去掉首尾空格')
})
