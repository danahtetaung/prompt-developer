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
Reasoning Context:
  - [architecture and codebase reasoning signals]
Evidence Context:
  - [retrieved docs with confidence and quality]
Grounding Policy:
  - [how to treat evidence-backed vs assumption-backed claims]
Instructions:
  - [specific step 1]
  - [specific step 2]
  - [specific step 3]
Evidence-backed recommendations:
  - [claim + evidence note]
Assumptions needing verification:
  - [assumption + how to verify]
Uncertainty/conflicts:
  - [any mismatch or missing evidence]
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
Reasoning Context:
  - [architecture and codebase reasoning signals]
Evidence Context:
  - [retrieved docs with confidence and quality]
Grounding Policy:
  - [how to treat evidence-backed vs assumption-backed claims]
Instructions:
  - [feature design step 1]
  - [implementation step 2]
  - [validation/rollout step 3]
Evidence-backed recommendations:
  - [claim + evidence note]
Assumptions needing verification:
  - [assumption + how to verify]
Uncertainty/conflicts:
  - [any mismatch or missing evidence]
Constraints:
  - Prioritize ambitious but coherent feature scope
  - Keep compatibility with existing routes/functions unless migration is explicit
  - Use existing code patterns as baseline, extending architecture when justified
--- END TEMPLATE ---`;

function normalizePromptTrack(track) {
  return track === 'feature' ? 'feature' : 'safe';
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function buildGroundingPolicy(browserContext = {}) {
  const confidence = clampNumber(browserContext?.confidence, 0, 1, 0);
  const quality = browserContext?.quality === 'high-signal' ? 'high-signal' : 'low-signal';
  const evidenceFirst = quality === 'high-signal' && confidence >= 0.6;

  return {
    quality,
    confidence,
    evidenceFirst,
    factualClaimPolicy: evidenceFirst
      ? 'Use retrieved evidence as primary source for API behavior and signatures.'
      : 'Use conservative reasoning and mark API-level claims as assumptions unless clearly evidenced.',
    assumptionsPolicy: evidenceFirst
      ? 'Label any non-evidence claim explicitly as an assumption.'
      : 'Prefer verification steps over definitive API claims.',
    expectedOutputSections: [
      'Evidence-backed recommendations',
      'Assumptions needing verification',
      'Uncertainty/conflicts',
    ],
  };
}

function buildPromptPayload(enrichedContext, intent, promptTrack) {
  const browserContext = enrichedContext?.browserContext ?? {};
  const retrievalMeta = browserContext?.retrieval ?? {};
  const groundingPolicy = buildGroundingPolicy(browserContext);

  return {
    promptTrack,
    intent,
    summaryMetadata: {
      lineCount: enrichedContext.lineCount ?? null,
      charCount: enrichedContext.charCount ?? null,
      recentChangesCount: Array.isArray(enrichedContext.recentChanges)
        ? enrichedContext.recentChanges.length
        : 0,
    },
    reasoningContext: {
      file: enrichedContext.file,
      fullPath: enrichedContext.fullPath,
      analysis: enrichedContext.analysis,
      contextSignals: enrichedContext.contextSignals ?? {},
      projectProfileContext: enrichedContext.projectProfileContext ?? {},
      projectDocsContext: enrichedContext.projectDocsContext ?? {},
      dependencyMap: enrichedContext.dependencyMap ?? {},
      recentChanges: enrichedContext.recentChanges ?? [],
    },
    evidenceContext: {
      query: browserContext.query ?? '',
      relevantDocs: browserContext.relevantDocs ?? '',
      topics: browserContext.topics ?? [],
      confidence: browserContext.confidence ?? 0,
      quality: browserContext.quality ?? 'low-signal',
      retrieval: {
        provider: retrievalMeta.provider ?? 'none',
        status: retrievalMeta.status ?? 'unknown',
        selectedCount: retrievalMeta.selectedCount ?? 0,
        lowConfidence: retrievalMeta.lowConfidence ?? true,
        ranked: Array.isArray(retrievalMeta.ranked)
          ? retrievalMeta.ranked.slice(0, 3).map((item) => ({
              title: item?.title ?? '',
              url: item?.url ?? '',
              domain: item?.domain ?? '',
              ranking: item?.ranking ?? {},
            }))
          : [],
      },
    },
    groundingPolicy,
  };
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
Reasoning Context:
  - Architecture signals: ${context.contextSignals?.contextDigest ?? 'No digest available'}
  - Complexity: ${context.contextSignals?.complexityContext?.level ?? 'unknown'}
Evidence Context:
  - Query: ${context.browserContext?.query ?? 'No query available'}
  - Docs: ${context.browserContext?.relevantDocs ?? 'No docs context available'}
  - Quality/confidence: ${context.browserContext?.quality ?? 'low-signal'} / ${context.browserContext?.confidence ?? 0}
Grounding Policy:
  - ${
    context.browserContext?.quality === 'high-signal' &&
    (context.browserContext?.confidence ?? 0) >= 0.6
      ? 'Use retrieved evidence as primary source for factual API claims.'
      : 'Use conservative reasoning and label uncertain claims as assumptions.'
  }
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
Evidence-backed recommendations:
  - List at least two recommendations tied to retrieved evidence (or state no high-confidence evidence).
Assumptions needing verification:
  - List assumptions and how to verify each.
Uncertainty/conflicts:
  - Note any conflicts between code context and retrieved docs.
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
  const services = options.services ?? {};
  const completion = services.getCompletion ?? getCompletion;
  const detectIntentService = services.detectIntent ?? detectIntent;
  const intent =
    enrichedContext.intent ??
    (await detectIntentService(
      enrichedContext.analysis,
      enrichedContext.browserContext,
      enrichedContext.recentChanges ?? [],
      enrichedContext.contextSignals ?? {},
      enrichedContext.projectProfileContext ?? {},
      enrichedContext.projectDocsContext ?? {}
    ));

  try {
    const promptPayload = buildPromptPayload(enrichedContext, intent, promptTrack);
    const prompt = await completion({
      systemPrompt: promptTrack === 'feature' ? FEATURE_SYSTEM_PROMPT : SAFE_SYSTEM_PROMPT,
      userPrompt: `Developer context:\n${JSON.stringify(promptPayload, null, 2)}`,
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

export { buildGroundingPolicy, buildPromptPayload };
