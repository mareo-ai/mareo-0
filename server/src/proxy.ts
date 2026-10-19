import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { TokenUsage } from './pricing.js'
import type { RequestKind } from './usage.js'

export interface ProxyConfig {
  upstreamBaseUrl: string
  apiKey: string
  /**
   * How the upstream expects the key. DeepSeek's Messages endpoint takes the
   * Anthropic `x-api-key` shape as a bearer token; OpenAI takes `Bearer`.
   */
  auth?: 'bearer'
  /** Strips this path prefix before appending to the upstream base. */
  stripPrefix?: string
  /**
   * Rejects a request before it is forwarded when the model cannot be priced.
   * Absent on the default upstream, where every model is priced by one table.
   */
  allowedModel?: (model: string | null) => boolean
}

/**
 * The harness asks its model for a session title once per session, using this
 * instruction. That call already flows through us, so the title — the label the
 * user sees in their own session list — can be recorded without an extra model
 * call, an extra request, or any client change.
 */
const TITLE_INSTRUCTION = /^(?:generate the session title|session title from this)/i
/** Title calls are one small message; agent turns carry MB of context. */
const TITLE_MAX_BODY_BYTES = 64 * 1024
/** A title is a short label; anything longer is a reply, not a title. */
const TITLE_MAX_CHARS = 200
/** The provider's server-side web search tool: present only on search calls. */
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305'

/**
 * Recognises the session-title call structurally, never by loose substring:
 *
 *  - the request is small (a title call is one short instruction plus the human
 *    messages; agent turns carry megabytes of context), and
 *  - one of its messages *starts with* the instruction. The harness sends it as
 *    a user message (`Generate the session title from this JSON array of human
 *    messages: …`) after a system message, so scanning only the first message
 *    would never match — and matching the phrase anywhere would classify a
 *    conversation that merely quotes it, which is how reply text once ended up
 *    stored as a "title".
 */
export function isTitleRequest(body: Buffer): boolean {
  if (body.length === 0 || body.length > TITLE_MAX_BODY_BYTES) return false
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { messages?: { content?: unknown }[] }
    return (parsed.messages ?? []).some((message) => {
      const text = messageText(message.content)
      return text !== undefined && TITLE_INSTRUCTION.test(text.trimStart())
    })
  } catch {
    return false
  }
}

/**
 * The text of one message. The OpenAI-shaped endpoint puts a string here; the
 * Messages endpoint this harness also speaks puts a list of content blocks, so
 * a title call would otherwise look like an ordinary chat turn.
 */
function messageText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter((block): block is { type?: unknown; text?: unknown } => typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
  return texts.length > 0 ? texts.join('') : undefined
}

/**
 * Whether this call is the auxiliary web search rather than a chat turn. The
 * path no longer answers that: the harness used to send search alone to the
 * Anthropic-shaped endpoint, and now sends chat and session titles there too.
 * What does answer it is the provider's own server tool — only the search call
 * carries it — so the classification follows the request's meaning instead of
 * where it happens to be routed.
 */
export function isSearchRequest(body: Buffer): boolean {
  if (body.length === 0 || body.length > TITLE_MAX_BODY_BYTES) return false
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { tools?: { type?: unknown }[] }
    return (parsed.tools ?? []).some((tool) => tool?.type === WEB_SEARCH_TOOL_TYPE)
  } catch {
    return false
  }
}

/**
 * Pulls the assistant text out of whatever we kept of the response: streamed
 * deltas or a plain JSON body. Only used for title calls, whose whole point is
 * that short piece of text.
 */
export function textFromResponseTail(text: string): string | undefined {
  let collected = ''
  const push = (value: unknown): void => {
    if (typeof value === 'string') collected += value
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    if (payload === '' || payload === '[DONE]') continue
    if (!payload.startsWith('{')) continue
    try {
      const json = JSON.parse(payload) as {
        choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[]
        delta?: { text?: unknown }
        content?: unknown
      }
      for (const choice of json.choices ?? []) {
        push(choice.delta?.content)
        push(choice.message?.content)
      }
      // The Messages endpoint streams `content_block_delta` frames carrying
      // `delta.text`, and answers in one body whose blocks carry `text`.
      push(json.delta?.text)
      push(messageText(json.content))
    } catch {
      // A frame we cannot parse is simply not part of the title.
    }
  }
  const title = collected.replace(/\s+/g, ' ').trim()
  // Longer than a label means we are looking at a reply, not a title: drop it
  // rather than store conversation text where only labels belong.
  if (title === '' || title.length > TITLE_MAX_CHARS) return undefined
  return title.slice(0, 120)
}

export interface ProxyOutcome {
  status: number
  model: string | null
  promptChars: number
  completionChars: number
  latencyMs: number
  /** Tokens the provider reported, undefined when it reported none. */
  tokens?: TokenUsage
  /** Harness session id, when the client sent one. */
  sessionId?: string | null
  /** 'title' for the session-title call, 'search' for web search, 'chat' otherwise. */
  requestKind: RequestKind
  /** The generated title, for title calls only. */
  titleText?: string
}

/**
 * How much of the response tail we keep while looking for the usage block. The
 * block is the last thing the provider sends, in a streaming chunk or at the end
 * of a JSON body, so a bounded tail is enough — the reply itself is never kept.
 */
const USAGE_TAIL_BYTES = 256 * 1024

function numberFrom(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Extracts the provider's token usage from a response tail. Returns undefined
 * when there is no usage block, which callers must record as "missing" rather
 * than as zero — a request whose tokens we did not see must never look free.
 */
export function usageFromResponseText(text: string): TokenUsage | undefined {
  const marker = text.lastIndexOf('"usage"')
  if (marker < 0) return undefined
  const start = text.indexOf('{', marker)
  if (start < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end < 0) return undefined

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }

  // Responses API reports `input_tokens` / `output_tokens` like Anthropic does,
  // but puts cached tokens in `input_tokens_details` and reasoning in
  // `output_tokens_details`. Reading it as Anthropic would bill every cached
  // input token at the miss price — roughly ten times too much.
  const responsesInput = numberFrom(raw, 'input_tokens')
  const inputDetails = raw.input_tokens_details
  if (inputDetails !== undefined || raw.output_tokens_details !== undefined) {
    const cached =
      typeof inputDetails === 'object' && inputDetails !== null
        ? numberFrom(inputDetails as Record<string, unknown>, 'cached_tokens')
        : 0
    const outputDetails = raw.output_tokens_details
    const reasoning =
      typeof outputDetails === 'object' && outputDetails !== null
        ? numberFrom(outputDetails as Record<string, unknown>, 'reasoning_tokens')
        : 0
    const responsesOutput = numberFrom(raw, 'output_tokens')
    if (responsesInput === 0 && responsesOutput === 0) return undefined
    return {
      inputTokens: responsesInput,
      cacheHitTokens: cached,
      cacheMissTokens: Math.max(0, responsesInput - cached),
      outputTokens: responsesOutput,
      reasoningTokens: reasoning,
    }
  }

  // Anthropic-compatible responses — the shape the bundled web search uses —
  // report the cache counts *outside* `input_tokens`, so the total prompt is
  // the sum of the parts. Reading them as OpenAI fields would treat every
  // prompt token as a cache miss and bill it at ~50× the right price.
  const anthropicInput = numberFrom(raw, 'input_tokens')
  const cacheRead = numberFrom(raw, 'cache_read_input_tokens')
  const cacheWrite = numberFrom(raw, 'cache_creation_input_tokens')
  const anthropicOutput = numberFrom(raw, 'output_tokens')
  if (anthropicInput > 0 || cacheRead > 0 || cacheWrite > 0 || anthropicOutput > 0) {
    return {
      inputTokens: anthropicInput + cacheRead + cacheWrite,
      cacheHitTokens: cacheRead,
      // DeepSeek bills a cache write as a miss: it has no separate write price.
      cacheMissTokens: anthropicInput + cacheWrite,
      outputTokens: anthropicOutput,
      reasoningTokens: 0,
    }
  }

  const inputTokens = numberFrom(raw, 'prompt_tokens')
  const outputTokens = numberFrom(raw, 'completion_tokens')
  const cacheHitTokens = numberFrom(raw, 'prompt_cache_hit_tokens')
  // Older shapes report the cached count inside prompt_tokens_details.
  const details = raw.prompt_tokens_details
  const cachedFromDetails =
    typeof details === 'object' && details !== null ? numberFrom(details as Record<string, unknown>, 'cached_tokens') : 0
  const hit = cacheHitTokens > 0 ? cacheHitTokens : cachedFromDetails
  const miss = raw.prompt_cache_miss_tokens !== undefined ? numberFrom(raw, 'prompt_cache_miss_tokens') : Math.max(0, inputTokens - hit)
  const completionDetails = raw.completion_tokens_details
  const reasoningTokens =
    typeof completionDetails === 'object' && completionDetails !== null
      ? numberFrom(completionDetails as Record<string, unknown>, 'reasoning_tokens')
      : 0

  if (inputTokens === 0 && outputTokens === 0) return undefined
  return { inputTokens, cacheHitTokens: hit, cacheMissTokens: miss, outputTokens, reasoningTokens }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function modelFromBody(body: Buffer): string | null {
  if (body.length === 0) return null
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : null
  } catch {
    return null
  }
}

function sendUpstreamError(response: ServerResponse, message: string): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.statusCode = 502
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ error: message }))
}

/**
 * Forwards one request to the upstream (DeepSeek) API, swapping the caller's
 * bearer token for the gateway's own key, and streams the response through.
 * The returned outcome describes the exchange for usage accounting.
 */
export async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ProxyConfig,
): Promise<ProxyOutcome> {
  const started = Date.now()
  const body = await readBody(request)
  const model = modelFromBody(body)
  const sessionHeader = request.headers['x-deepseek-harness-session-id']
  const sessionId = typeof sessionHeader === 'string' && sessionHeader !== '' ? sessionHeader : null
  // Search has its own price profile, so it gets its own kind rather than hiding
  // in `chat` — and the request body, not the path, is what says which it is.
  const requestKind: RequestKind = isSearchRequest(body) ? 'search' : isTitleRequest(body) ? 'title' : 'chat'

  const requestPath = request.url ?? '/'
  const forwardedPath =
    config.stripPrefix !== undefined && requestPath.startsWith(config.stripPrefix)
      ? requestPath.slice(config.stripPrefix.length)
      : requestPath
  if (config.allowedModel !== undefined && !config.allowedModel(model)) {
    const message = `模型 ${model ?? '(未指定)'} 不在可售列表里。`
    if (!response.headersSent) {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'unpriced-model', message }))
    }
    return {
      status: 400,
      model,
      promptChars: 0,
      completionChars: 0,
      latencyMs: Date.now() - started,
      requestKind,
      sessionId,
    }
  }
  const upstreamUrl = new URL(forwardedPath.startsWith('/') ? forwardedPath : `/${forwardedPath}`, withTrailingSlash(config.upstreamBaseUrl)).toString()
  const forwardedHeaders: Record<string, string> = { authorization: `Bearer ${config.apiKey}` }
  const contentType = request.headers['content-type']
  if (contentType !== undefined) forwardedHeaders['content-type'] = String(contentType)
  const accept = request.headers['accept']
  if (accept !== undefined) forwardedHeaders.accept = String(accept)
  // Feature headers are part of the protocol, not decoration. The file API is
  // only reachable when `anthropic-beta` says so; dropping it upstream turned
  // every attachment upload into a 400 the client retried in a loop.
  for (const header of ['anthropic-beta', 'anthropic-version'] as const) {
    const value = request.headers[header]
    if (value !== undefined) forwardedHeaders[header] = String(value)
  }

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: forwardedHeaders,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
      redirect: 'manual',
    })
  } catch (error) {
    sendUpstreamError(response, `upstream unreachable: ${messageFrom(error)}`)
    return {
      status: 502,
      model,
      promptChars: body.length,
      completionChars: 0,
      latencyMs: Date.now() - started,
      requestKind,
    }
  }

  response.statusCode = upstream.status
  const upstreamType = upstream.headers.get('content-type')
  if (upstreamType !== null) response.setHeader('content-type', upstreamType)

  let completionChars = 0
  let tail = ''
  if (upstream.body === null) {
    response.end()
    return {
      status: upstream.status,
      model,
      promptChars: body.length,
      completionChars,
      latencyMs: Date.now() - started,
      sessionId,
      requestKind,
    }
  }

  await new Promise<void>((resolve) => {
    const onDone = (): void => resolve()
    response.once('finish', onDone)
    response.once('close', onDone)
    const stream = Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream)
    stream.on('data', (chunk: Buffer) => {
      completionChars += chunk.length
      // Keep only the tail: the usage block is last, and the body itself is not
      // ours to retain.
      tail = (tail + chunk.toString('utf8')).slice(-USAGE_TAIL_BYTES)
    })
    stream.on('error', () => response.destroy())
    stream.pipe(response)
  })

  return {
    status: upstream.status,
    model,
    promptChars: body.length,
    completionChars,
    latencyMs: Date.now() - started,
    tokens: upstream.status === 200 ? usageFromResponseText(tail) : undefined,
    sessionId,
    requestKind,
    titleText: requestKind === 'title' && upstream.status === 200 ? textFromResponseTail(tail) : undefined,
  }
}

function withTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
