import { isTransientHttpError, withRetry } from '../utils/retry.js';

export async function sendWebhookNotification(payload) {
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) {
    return { sent: false, reason: 'NOTIFY_WEBHOOK_URL is not set' };
  }
  if (!payload || typeof payload !== 'object') {
    return { sent: false, reason: 'Invalid payload for notification' };
  }

  const retries = Number.parseInt(process.env.NOTIFY_RETRIES ?? '2', 10);
  const baseDelayMs = Number.parseInt(process.env.NOTIFY_BASE_DELAY_MS ?? '250', 10);
  const factor = Number.parseFloat(process.env.NOTIFY_BACKOFF_FACTOR ?? '2');
  const maxDelayMs = Number.parseInt(process.env.NOTIFY_MAX_DELAY_MS ?? '3000', 10);

  try {
    const response = await withRetry(
      async () => {
        const candidate = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!candidate.ok) {
          throw new Error(`Webhook returned status ${candidate.status}`);
        }
        return candidate;
      },
      {
        retries: Number.isFinite(retries) ? retries : 2,
        baseDelayMs: Number.isFinite(baseDelayMs) ? baseDelayMs : 250,
        factor: Number.isFinite(factor) ? factor : 2,
        maxDelayMs: Number.isFinite(maxDelayMs) ? maxDelayMs : 3000,
        jitter: true,
        shouldRetry: (error) => isTransientHttpError(error),
      }
    );

    if (!response.ok) return { sent: false, reason: `Webhook returned status ${response.status}` };

    return { sent: true };
  } catch (err) {
    console.warn(
      '[notify/webhookNotifier] Notification send failed:',
      err instanceof Error ? err.message : String(err)
    );
    return {
      sent: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
