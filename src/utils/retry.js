function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a transient async operation with exponential backoff.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{
 *   retries?: number,
 *   baseDelayMs?: number,
 *   factor?: number,
 *   maxDelayMs?: number,
 *   jitter?: boolean,
 *   shouldRetry?: (error: unknown, attempt: number) => boolean
 * }} options
 * @returns {Promise<T>}
 */
export async function withRetry(operation, options = {}) {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const factor = options.factor ?? 2;
  const maxDelayMs = options.maxDelayMs ?? Number.POSITIVE_INFINITY;
  const jitter = options.jitter ?? false;
  const shouldRetry =
    options.shouldRetry ??
    ((error) => {
      if (!(error instanceof Error)) return false;
      return true;
    });

  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < retries && shouldRetry(error, attempt);
      if (!canRetry) {
        throw error;
      }
      const exponentialDelay = baseDelayMs * factor ** attempt;
      const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
      const delayMs = jitter
        ? Math.max(1, Math.round(cappedDelay * (0.75 + Math.random() * 0.5)))
        : cappedDelay;
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Retry failed');
}

function isTransientStatus(status) {
  if (typeof status !== 'number' || !Number.isFinite(status)) return false;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

export function isTransientHttpError(error) {
  if (!(error instanceof Error)) return false;
  const status = /** @type {{ status?: unknown }} */ (error).status;
  if (isTransientStatus(status)) return true;

  const text = error.message.toLowerCase();
  return (
    text.includes('429') ||
    text.includes('408') ||
    text.includes('500') ||
    text.includes('502') ||
    text.includes('503') ||
    text.includes('504') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('network') ||
    text.includes('connection') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('fetch failed')
  );
}