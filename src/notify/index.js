import { sendWebhookNotification } from './webhookNotifier.js';

/**
 * Dispatches a prompt-ready notification and logs delivery status.
 * @param {{ file?: string, fullPath?: string, mode?: string, reason?: string }} event
 */
export async function notifyPromptReady(event) {
  const safeEvent = event && typeof event === 'object' ? event : {};
  const payload = {
    type: 'prompt_ready',
    timestamp: new Date().toISOString(),
    ...safeEvent,
  };

  const webhookResult = await sendWebhookNotification(payload);
  if (!webhookResult.sent) {
    console.log(
      `[notify] Prompt ready for ${safeEvent.file ?? 'unknown file'} (webhook skipped: ${webhookResult.reason})`
    );
  } else {
    console.log(
      `[notify] Prompt ready event sent for ${safeEvent.file ?? 'unknown file'}.`
    );
  }
}
