import 'dotenv/config';
import { getCompletion } from './llm/client.js';

export async function detectIntent(
  fileAnalysis,
  browserContext,
  recentChanges,
  contextSignals = {},
  projectProfileContext = {},
  projectDocsContext = {}
) {
  try {
    const prompt = `Based on the following context, what is the developer trying to accomplish? Be specific. Return a single clear sentence.

File analysis: ${JSON.stringify(fileAnalysis)}
Browser context: ${JSON.stringify(browserContext)}
Recent changes: ${JSON.stringify(recentChanges)}
Context signals: ${JSON.stringify(contextSignals)}
Project profile: ${JSON.stringify(projectProfileContext)}
Project docs context: ${JSON.stringify(projectDocsContext)}`;
    const intent = (
      await getCompletion({
        systemPrompt: 'Return one clear sentence only.',
        userPrompt: prompt,
      })
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!intent) {
      return 'The developer is trying to update this feature based on recent code and documentation context.';
    }
    return intent;
  } catch (err) {
    console.error(
      '[intentDetector] Failed to detect intent:',
      err instanceof Error ? err.message : err
    );
    return 'The developer is likely implementing or refining behavior in this part of the codebase.';
  }
}
