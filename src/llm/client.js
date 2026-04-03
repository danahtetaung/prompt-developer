import 'dotenv/config';
import OpenAI from 'openai';
import { withRetry, isTransientHttpError } from '../utils/retry.js';

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';
const DEFAULT_ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-20241022';
const DEFAULT_OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';
let openAiClient = null;

function getProvider() {
  return (process.env.LLM_PROVIDER ?? DEFAULT_PROVIDER).toLowerCase();
}

function asTextMessageContent(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('\n')
      .trim();
  }
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} data */
function extractChatCompletionText(data) {
  const raw =
    data &&
    typeof data === 'object' &&
    Array.isArray(/** @type {{ choices?: unknown[] }} */ (data).choices)
      ? /** @type {{ choices: { message?: { content?: unknown } }[] }} */ (data)
          .choices[0]?.message?.content
      : undefined;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * @param {string} providerLabel
 * @param {Response} response
 * @param {string} bodyText
 * @returns {never}
 */
function throwProviderHttpError(providerLabel, response, bodyText) {
  const trimmed = bodyText.trim();
  const preview =
    trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
  const err = new Error(
    preview
      ? `${providerLabel} error ${response.status}: ${preview}`
      : `${providerLabel} error ${response.status}`
  );
  err.name = 'ProviderHttpError';
  /** @type {{ status?: number }} */ (err).status = response.status;
  throw err;
}

async function callOpenAI({ systemPrompt, userPrompt, responseJsonOnly }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (openAiClient === null) {
    openAiClient = new OpenAI({ apiKey });
  }
  const response = await openAiClient.chat.completions.create({
    model: DEFAULT_OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    ...(responseJsonOnly ? { response_format: { type: 'json_object' } } : {}),
  });
  return response.choices?.[0]?.message?.content?.trim() ?? '';
}

async function callOpenRouter({ systemPrompt, userPrompt, responseJsonOnly }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      ...(responseJsonOnly ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throwProviderHttpError('OpenRouter', response, bodyText);
  }

  const data = await response.json();
  return extractChatCompletionText(data);
}

// responseJsonOnly is ignored; Anthropic JSON constraints differ from OpenAI chat response_format.
async function callAnthropic({ systemPrompt, userPrompt }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throwProviderHttpError('Anthropic', response, bodyText);
  }

  const data = await response.json();
  return asTextMessageContent(data?.content);
}

/**
 * @param {{
 *   systemPrompt: string,
 *   userPrompt: string,
 *   responseJsonOnly?: boolean
 * }} args
 * @returns {Promise<string>}
 */
export async function getCompletion(args) {
  const provider = getProvider();

  return withRetry(
    async () => {
      if (provider === 'openrouter') {
        return callOpenRouter(args);
      }
      if (provider === 'anthropic' || provider === 'claude') {
        return callAnthropic(args);
      }
      if (provider !== 'openai') {
        console.warn(`[llm/client] Unknown provider "${provider}", falling back to OpenAI.`);
      }
      return callOpenAI(args);
    },
    {
      retries: 2,
      baseDelayMs: 300,
      shouldRetry: (error) => isTransientHttpError(error),
    }
  );
}

export function getLlmProvider() {
  return getProvider();
}