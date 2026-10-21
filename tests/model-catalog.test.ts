// The picker's labels are a product surface, and the ids behind them are what
// billing and history key on. These tests pin both halves: names change, ids do
// not, and a launch never duplicates a section.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogYaml, withCatalog } from '../src/model-catalog.js'

const GATEWAY = 'https://api.svc.mareo.cn'

test('every model is named Mareo-<vendor initial>-<model>', () => {
  const yaml = catalogYaml(GATEWAY)
  assert.match(yaml, /name: Mareo-D-V41-Flash/)
  assert.match(yaml, /name: Mareo-D-V4-Pro/)
  assert.match(yaml, /name: Mareo-O-6-Sol/)
  assert.match(yaml, /name: Mareo-O-6-Astra/)
  // Only the labels are checked: `api: openai-responses` is a protocol name.
  const labels = yaml.split('\n').filter((line) => line.trimStart().startsWith('name:'))
  assert.ok(labels.length >= 4)
  for (const label of labels) {
    assert.equal(/deepseek|gpt|openai|anthropic/i.test(label), false, `展示名里不应出现厂商名：${label}`)
  }
})

test('the ids stay the ids, so billing and history keep working', () => {
  const yaml = catalogYaml(GATEWAY)
  for (const id of ['deepseek-flash', 'deepseek-v4-pro', 'gpt-6-sol', 'gpt-6-astra']) {
    assert.match(yaml, new RegExp(`id: ${id}`))
  }
  assert.equal(/Mareo-[A-Z]-[^ ]*\n\s+id:/.test(yaml), false, '展示名不能被当成 id')
})

test('the DeepSeek entry keeps the capabilities the default had', () => {
  // An explicit catalogue replaces the installed one, so dropping image input
  // here would silently break attachments without any test noticing.
  const yaml = catalogYaml(GATEWAY)
  const flash = yaml.slice(yaml.indexOf('id: deepseek-flash'))
  const entry = flash.slice(0, flash.indexOf('id: deepseek-v4-pro'))
  assert.match(entry, /inputModalities: \[text, image\]/)
  assert.match(entry, /systemPromptUpdate: in-history/)
  assert.match(entry, /toolUpdate: addition-only/)
})

test('the OpenAI route talks to our gateway with the account token', () => {
  const yaml = catalogYaml(GATEWAY)
  assert.match(yaml, /api: openai-responses/)
  assert.match(yaml, new RegExp(`baseURL: ${GATEWAY}/openai/v1`))
  assert.match(yaml, /apiKeyEnv: MAREO_API_KEY/)
  assert.equal(/sk-[A-Za-z0-9]/.test(yaml), false, '客户端不应出现任何厂商密钥')
})

test('other sections survive and ours are never duplicated', () => {
  const before = ['agent-default-model:', '  provider: deepseek-official', '  model: deepseek-flash', ''].join('\n')
  const once = withCatalog(before, GATEWAY)
  assert.match(once, /agent-default-model:/, '默认模型设置必须保留')
  assert.equal((once.match(/^llm-deepseek:/gm) ?? []).length, 1)
  assert.equal((once.match(/^llm-pi-ai:/gm) ?? []).length, 1)

  // A second launch rewrites the same file instead of appending another copy.
  const twice = withCatalog(once, GATEWAY)
  assert.equal(twice, once)
})

test('a stale section from an older launch is replaced, not stacked', () => {
  const stale = ['llm-pi-ai:', '  providers:', '    old-route:', '      api: openai-completions', ''].join('\n')
  const next = withCatalog(stale, GATEWAY)
  assert.equal(/old-route/.test(next), false)
  assert.match(next, /mareo-openai:/)
})

test('an empty settings file still produces a valid document', () => {
  const yaml = withCatalog('', GATEWAY)
  assert.match(yaml, /^llm-deepseek:/)
  assert.equal(yaml.includes('\n\n\n'), false)
})
