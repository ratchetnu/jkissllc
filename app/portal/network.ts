export type RetryNotice = {
  attempt: number
  maxAttempts: number
  reason: 'network' | 'server'
  status?: number
}

export type FetchRetryOptions = {
  maxAttempts?: number
  allowMutationRetry?: boolean
  onRetry?: (notice: RetryNotice) => void
  fetcher?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const SAFE_METHOD = new Set(['GET', 'HEAD', 'OPTIONS'])

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 2_000)
  }
  return Math.min(250 * 2 ** (attempt - 1), 1_000)
}

/**
 * Retry a request only when its caller proves mutation retries are safe.
 *
 * Reads are safe by default. POST/PATCH/DELETE require `allowMutationRetry` because
 * a dropped response does not prove the server failed to write.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const fetcher = options.fetcher ?? fetch
  const sleep = options.sleep ?? wait
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 3))
  const method = (init.method ?? 'GET').toUpperCase()
  const mayRetry = SAFE_METHOD.has(method) || options.allowMutationRetry === true
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response | null = null
    try {
      response = await fetcher(input, init)
      if (!mayRetry || !RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) {
        return response
      }
      options.onRetry?.({ attempt, maxAttempts, reason: 'server', status: response.status })
    } catch (error) {
      lastError = error
      if (!mayRetry || attempt === maxAttempts) throw error
      options.onRetry?.({ attempt, maxAttempts, reason: 'network' })
    }
    await sleep(retryDelay(response, attempt))
  }

  throw lastError instanceof Error ? lastError : new Error('Request failed')
}
