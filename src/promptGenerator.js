import 'dotenv/config';
import { detectIntent } from './intentDetector.js';
import { getCompletion } from './llm/client.js';

const SAFE_SYSTEM_PROMPT = `You are an expert Cursor prompt engineer. Given the following developer context, generate a highly structured prompt that Cursor can execute perfectly. Use this exact template format:
--- START TEMPLATE ---
Environment: [stack description]
Goal: [what the developer is trying to do]
Context:
  - File: [filename]
  - Current logic: [what the file currently does]
  - Related files: [dependency list]
  - Browser research: [what docs/pages the dev was reading]
Instructions:
  - [specific step 1]
  - [specific step 2]
  - [specific step 3]
Constraints:
  - Follow existing code style
  - Do not break existing routes/functions
  - Use the existing patterns in the codebase
--- END TEMPLATE ---`;

const FEATURE_SYSTEM_PROMPT = `You are an expert product-minded Cursor prompt engineer. Given the following developer context, generate a highly structured prompt that proposes a meaningful new feature or major capability expansion (not just minor edits). Use this exact template format:
--- START TEMPLATE ---
Environment: [stack description]
Goal: [a high-impact feature objective]
Context:
  - File: [filename]
  - Current logic: [what the file currently does]
  - Related files: [dependency list]
  - Browser research: [what docs/pages the dev was reading]
Instructions:
  - [feature design step 1]
  - [implementation step 2]
  - [validation/rollout step 3]
Constraints:
  - Prioritize ambitious but coherent feature scope
  - Keep compatibility with existing routes/functions unless migration is explicit
  - Use existing code patterns as baseline, extending architecture when justified
--- END TEMPLATE ---`;

function normalizePromptTrack(track) {
  return track === 'feature' ? 'feature' : 'safe';
}

function fallbackPrompt(context, intent, track = 'safe') {
  const related = Object.values(context.dependencyMap ?? {})
    .flat()
    .slice(0, 6);
  const normalizedTrack = normalizePromptTrack(track);
  const isFeature = normalizedTrack === 'feature';
  const docsSummary = context.projectDocsContext?.summary ?? 'No project docs loaded.';
  const docsRefs = Array.isArray(context.projectDocsContext?.snippets)
    ? context.projectDocsContext.snippets
        .slice(0, 3)
        .map((item) => item.path)
        .join(', ')
    : 'None';

  return `--- START TEMPLATE ---
Environment: JavaScript (Node.js, ESM, OpenAI SDK)
Goal: ${intent}
Context:
  - File: ${context.file}
  - Current logic: ${context.analysis?.summary ?? 'No summary available'}
  - Related files: ${related.join(', ') || 'None detected'}
  - Browser research: ${context.browserContext?.query ?? 'No query available'} (lineCount=${context.lineCount ?? 'n/a'}, charCount=${context.charCount ?? 'n/a'})
  - Project docs: ${docsSummary} (refs: ${docsRefs})
  - Dependency risk: ${context.contextSignals?.dependencyContext?.dependencyRisk ?? 'n/a'}
  - Change signal: hotFile=${context.contextSignals?.changeContext?.isHotFile ?? false}, freq=${context.contextSignals?.changeContext?.changeFrequency ?? 0}
  - Project scope: ${context.projectProfileContext?.scopeMode ?? 'everything'} / risk=${context.projectProfileContext?.riskTolerance ?? 'balanced'}
Instructions:
  - ${
    isFeature
      ? 'Design and implement a high-impact feature addition based on this context.'
      : 'Update the target file with minimal, safe changes.'
  }
  - ${
    isFeature
      ? 'Introduce required architecture extensions and related module updates.'
      : 'Follow existing architecture and imports.'
  }
  - ${
    isFeature
      ? 'Add validation steps and tests for the new feature path.'
      : 'Validate behavior with a quick runtime check.'
  }
Constraints:
  - ${
    isFeature ? 'Prioritize meaningful feature scope over micro-edits' : 'Follow existing code style'
  }
  - ${
    isFeature
      ? 'Keep compatibility unless migration is explicitly documented'
      : 'Do not break existing routes/functions'
  }
  - Use existing patterns as baseline${isFeature ? ', extending architecture when justified' : ''}
--- END TEMPLATE ---`;
}

export async function generatePrompt(enrichedContext, options = {}) {
  const promptTrack = normalizePromptTrack(options.promptTrack);
  const intent =
    enrichedContext.intent ??
    (await detectIntent(
      enrichedContext.analysis,
      enrichedContext.browserContext,
      enrichedContext.recentChanges ?? [],
      enrichedContext.contextSignals ?? {},
      enrichedContext.projectProfileContext ?? {},
      enrichedContext.projectDocsContext ?? {}
    ));

  try {
    const prompt = await getCompletion({
      systemPrompt: promptTrack === 'feature' ? FEATURE_SYSTEM_PROMPT : SAFE_SYSTEM_PROMPT,
      userPrompt: `Developer context:\n${JSON.stringify(
        {
          ...enrichedContext,
          intent,
          promptTrack,
          summaryMetadata: {
            lineCount: enrichedContext.lineCount ?? null,
            charCount: enrichedContext.charCount ?? null,
            recentChangesCount: Array.isArray(enrichedContext.recentChanges)
              ? enrichedContext.recentChanges.length
              : 0,
          },
        },
        null,
        2
      )}`,
    });
    if (!prompt) return fallbackPrompt(enrichedContext, intent, promptTrack);
    return prompt.trim();
  } catch (err) {
    console.error(
      '[promptGenerator] Failed to generate prompt:',
      err instanceof Error ? err.message : err
    );
    return fallbackPrompt(enrichedContext, intent, promptTrack);
  }
}
