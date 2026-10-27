// The picker's labels are a product surface, and the ids behind them are what
// billing and history key on. These tests pin both halves: names change, ids do
// not, and a launch never duplicates a section.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LONG_CONTEXT_TOKENS, catalogYaml, withCatalog } from '../src/model-catalog.js'

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

test('the OpenAI models accept images, so the read tool stops refusing them', () => {
  const yaml = catalogYaml(GATEWAY)
  for (const id of ['gpt-6-sol', 'gpt-6-astra']) {
    const start = yaml.indexOf(`id: ${id}`)
    assert.ok(start > 0)
    const entry = yaml.slice(start, yaml.indexOf('input:', start) + 40)
    assert.match(entry, /input: \[text, image\]/, `${id} 应声明图片输入`)
  }
})

test('the price cliff is printed on the card, not just in a document', () => {
  const yaml = catalogYaml(GATEWAY)
  const descriptions = yaml.split('\n').filter((line) => line.trimStart().startsWith('description:'))
  const openai = descriptions.filter((line) => line.includes('Mareo') || line.includes('计费'))
  assert.ok(openai.length >= 2)
  for (const line of descriptions.filter((entry) => /最强|编程/.test(entry))) {
    assert.match(line, /27 万|2 倍/, `模型卡应写明 2 倍计价：${line}`)
  }
})

test('compaction triggers below the price cliff, not at 80% of a 1M window', () => {
  const yaml = catalogYaml(GATEWAY)
  assert.match(yaml, /^compaction-basic:/m)
  const ratios = [...yaml.matchAll(/thresholdRatio: ([0-9.]+)/g)].map((match) => Number(match[1]))
  assert.equal(ratios.length, 3, '每个 OpenAI 模型各一条策略（Sol / Astra / Terra）')
  // 1.05M declared window × ratio must land under the cliff, or compaction can
  // never prevent the doubled bill.
  for (const ratio of ratios) {
    assert.ok(1_050_000 * ratio < LONG_CONTEXT_TOKENS, `阈值 ${ratio} 压不到 ${LONG_CONTEXT_TOKENS} 以下`)
  }
  assert.match(yaml, /retainTokens: 40000/, '逐字保留的历史每轮都会重新计费，必须收紧')
})

test('a second launch rewrites the compaction section instead of stacking it', () => {
  const once = withCatalog('', GATEWAY)
  assert.equal(withCatalog(once, GATEWAY), once)
  assert.equal((once.match(/^compaction-basic:/gm) ?? []).length, 1)
})
