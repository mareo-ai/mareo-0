/**
 * Every model call a real Mareo client makes carries a session id; without one the
 * gateway now refuses the request and asks the user to upgrade. Tests act as that
 * client, so this wrapper supplies the header the way the app does, instead of every
 * test file remembering to.
 *
 * Append `?nosession=1` to a URL to opt one request out — that is how the test for
 * the refusal itself reaches the gateway without a session.
 */
const realFetch = globalThis.fetch

const MODEL_CALL = /\/(messages|chat\/completions|responses)(\?|$)/

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!MODEL_CALL.test(url) || url.includes('nosession=1')) return realFetch(input, init)
  // A request that carries its own `prompt_cache_key` is testing body-based
  // attribution; adding a header would answer the question for it.
  if (typeof init?.body === 'string' && init.body.includes('prompt_cache_key')) return realFetch(input, init)
  const headers = new Headers(init?.headers)
  if (!headers.has('x-deepseek-harness-session-id')) headers.set('x-deepseek-harness-session-id', 'test-session')
  return realFetch(input, { ...init, headers })
}) as typeof fetch
