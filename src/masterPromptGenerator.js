import { getCompletion } from './llm/client.js';

function resolveMasterPromptCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5;
  if (parsed <= 4) return 4;
  return 5;
}

function toCandidates(summary, count) {
  const prompts = Array.isArray(summary?.prompts) ? summary.prompts : [];
  const ranked = prompts
    .filter((item) => item && item.ok !== false)
    .sort((a, b) => (b.priorityScore ?? -1) - (a.priorityScore ?? -1));
  return ranked.slice(0, count);
}

function normalizeTrack(track) {
  return track === 'feature' ? 'feature' : 'safe';
}

function buildFallbackMasterPrompt(fullscanRunId, candidates, track = 'safe') {
  const normalizedTrack = normalizeTrack(track);
  const titlePrefix = normalizedTrack === 'feature' ? 'Feature Master Prompts' : 'Safe Master Prompts';
  if (candidates.length === 0) {
    return `# ${titlePrefix} (${fullscanRunId})\n\nNo eligible prompts were available for this run.`;
  }

  const lines = candidates.map((item, index) => {
    const file = item.file ?? 'unknown-file';
    const score = item.priorityScore ?? 'n/a';
    const reason = item.priorityReason ?? 'No priority reason provided';
    return `${index + 1}. Focus on \`${file}\` (priority=${score}): ${reason}. ${
      normalizedTrack === 'feature'
        ? 'Convert this into a high-impact new capability with rollout milestones.'
        : 'Convert this into a low-risk implementation initiative with validation milestones.'
    }`;
  });

  return `# ${titlePrefix} (${fullscanRunId})\n\n## Top Priorities\n${lines.join('\n')}\n`;
}

/**
 * @param {{
 *   fullscanRunId: string,
 *   summary: any,
 *   track?: 'safe' | 'feature',
 *   maxCount?: number,
 *   services?: { getCompletion?: typeof getCompletion }
 * }} input
 */
export async function generateMasterPrompts(input) {
  const track = normalizeTrack(input.track);
  const count = resolveMasterPromptCount(input.maxCount ?? 5);
  const candidates = toCandidates(input.summary, count);
  const selectedFiles = candidates.map((item) => item.file).filter(Boolean);
  const completion = input.services?.getCompletion ?? getCompletion;

  if (candidates.length === 0) {
    return {
      source: 'fallback',
      count: 0,
      track,
      selectedFiles: [],
      content: buildFallbackMasterPrompt(input.fullscanRunId, candidates, track),
    };
  }

  try {
    const titlePrefix = track === 'feature' ? 'Feature Master Prompts' : 'Safe Master Prompts';
    const response = await completion({
      systemPrompt:
        track === 'feature'
          ? 'You generate a concise ranked markdown list of bold new-feature master prompts for a repository scan.'
          : 'You generate a concise ranked markdown list of safe implementation master prompts for a repository scan.',
      userPrompt: `Generate exactly ${candidates.length} ${track} master prompts for fullscan run ${
        input.fullscanRunId
      }. Return markdown starting with "# ${titlePrefix} (${input.fullscanRunId})".\n\n${JSON.stringify(
        candidates,
        null,
        2
      )}`,
    });
    const text = typeof response === 'string' ? response.trim() : '';
    if (text) {
      return {
        source: 'llm',
        count: candidates.length,
        track,
        selectedFiles,
        content: text,
      };
    }
  } catch (err) {
    console.warn(
      '[masterPromptGenerator] Falling back to deterministic master prompts:',
      err instanceof Error ? err.message : err
    );
  }

  return {
    source: 'fallback',
    count: candidates.length,
    track,
    selectedFiles,
    content: buildFallbackMasterPrompt(input.fullscanRunId, candidates, track),
  };
}

export { resolveMasterPromptCount };
