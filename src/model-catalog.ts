/**
 * What the model picker shows.
 *
 * Every model behind the gateway is presented under the Mareo name, with the
 * vendor reduced to a single initial: `Mareo-D-V41-Flash` is DeepSeek's
 * V4.1-Flash, `Mareo-O-6-Astra` is GPT-6-Astra. Two reasons: the picker is our
 * product surface, not a vendor list, and the underlying model id never moves —
 * billing and history key on the id, so a display rename must not touch it.
 *
 * Both sections are written into the account's settings, which is where the
 * engine reads provider configuration from:
 *
 *  - `llm-deepseek` supplies the catalogue because an explicit list *replaces*
 *    the installed one. That means every capability the default entry had must
 *    be restated, or the rename silently takes image input away.
 *  - `llm-pi-ai` mounts a second route for the OpenAI models. Its credentials
 *    are the account's own gateway token, so nothing here is a vendor key.
 *
 * The block is static, so it is written verbatim and replaced on each launch;
 * a section is never appended twice.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const SETTINGS_FILE = 'settings.yaml'

/**
 * The price cliff every OpenAI model charges past: above this many input tokens
 * the *whole* request bills at twice the input rate. Declared here because it
 * drives both the label and the compaction policy below.
 */
export const LONG_CONTEXT_TOKENS = 272_000

/** Sections this module owns; anything else in the file is left untouched. */
const OWNED_SECTIONS = ['llm-deepseek', 'llm-pi-ai', 'compaction-basic']

/** The catalog, in the order the picker shows it: cheap first, strongest last. */
export function catalogYaml(gatewayUrl: string): string {
  // Compaction's default trigger is 80% of the declared window — about 840K for
  // a 1.05M-token model — so an ordinary long session never compacts and then
  // silently pays double from 272K onward. These policies compact well below the
  // cliff instead, and keep far less history verbatim, because the retained
  // history is resent (and charged) on every turn.
  const compactionThresholdRatio = 0.22
  return `llm-deepseek:
  models:
    - id: deepseek-flash
      name: Mareo-D-V41-Flash
      contextWindow: 1000000
      inputModalities: [text, image]
      systemPromptUpdate: in-history
      toolUpdate: addition-only
    - id: deepseek-v4-pro
      name: Mareo-D-V4-Pro
      description: 更强的智能体编码与复杂推理，单价更高
      contextWindow: 1000000
llm-pi-ai:
  providers:
    mareo-openai:
      displayName: Mareo
      api: openai-responses
      baseURL: ${gatewayUrl}/openai/v1
      apiKeyEnv: MAREO_API_KEY
      models:
        - id: gpt-6-sol
          name: Mareo-O-6-Sol
          description: 复杂编程与多步任务；输入超 27 万 token 后整单按 2 倍计费，较贵
          contextWindow: 1050000
          maxTokens: 128000
          input: [text, image]
        - id: gpt-6-astra
          name: Mareo-O-6-Astra
          description: 最强推理；输入超 27 万 token 后整单按 2 倍计费，最贵
          contextWindow: 1050000
          maxTokens: 128000
          input: [text, image]
compaction-basic:
  modelPolicies:
    - provider: mareo-openai
      model: gpt-6-sol
      thresholdRatio: ${compactionThresholdRatio}
      retainTokens: 40000
    - provider: mareo-openai
      model: gpt-6-astra
      thresholdRatio: ${compactionThresholdRatio}
      retainTokens: 40000
`
}

/**
 * The document with our sections replaced, and every other section — including
 * the default model the engine stores under its own key — left as it was.
 */
export function withCatalog(document: string, gatewayUrl: string): string {
  const newline = document.includes('\r\n') ? '\r\n' : '\n'
  const kept: string[] = []
  let skipping = false
  for (const line of document.split(/\r?\n/)) {
    // A top-level key ends the previous section; indented lines belong to it.
    if (/^\S/.test(line)) skipping = OWNED_SECTIONS.some((name) => line.startsWith(`${name}:`))
    if (!skipping) kept.push(line)
  }
  const body = kept.join(newline).replace(/\s+$/, '')
  const block = catalogYaml(gatewayUrl).replace(/\n/g, newline)
  return `${body}${body === '' ? '' : newline + newline}${block}`
}

/**
 * Writes the catalogue into the account's settings before the engine starts, so
 * the first picker the user opens already shows Mareo names.
 */
export async function applyModelCatalog(dshHome: string, gatewayUrl: string): Promise<void> {
  const file = path.join(dshHome, SETTINGS_FILE)
  const current = await readFile(file, 'utf8').catch(() => '')
  const next = withCatalog(current, gatewayUrl)
  if (next === current) return
  await mkdir(path.dirname(file), { recursive: true })
  const staging = `${file}.tmp`
  await writeFile(staging, next, 'utf8')
  await rename(staging, file)
}
