import 'dotenv/config';
import { getCompletion } from './llm/client.js';

function makeFallbackQuery(filePath, fileAnalysis) {
  const purpose =
    typeof fileAnalysis?.purpose === 'string' ? fileAnalysis.purpose : 'file behavior';
  const imports = Array.isArray(fileAnalysis?.imports)
    ? fileAnalysis.imports.filter((item) => typeof item === 'string').slice(0, 2)
    : [];
  const importHint = imports.length > 0 ? ` ${imports.join(' ')}` : '';
  return `${filePath} ${purpose}${importHint} API reference`;
}

export async function getBrowserContext(filePath, fileAnalysis) {
  const timestamp = new Date().toISOString();

  try {
    const prompt = `Given this file context: ${fileAnalysis?.summary ?? 'No summary available.'}. What specific technical documentation or API reference would a developer need? Return a single concise search query.`;
    const text = await getCompletion({
      systemPrompt: 'Return only a concise search query.',
      userPrompt: prompt,
    });
    const query = text.trim() || makeFallbackQuery(filePath, fileAnalysis);

    return {
      query,
      relevantDocs: 'MVP: external docs fetch not enabled yet.',
      timestamp,
    };
  } catch (err) {
    console.error(
      `[browserIntelligence] getBrowserContext failed for ${filePath}:`,
      err instanceof Error ? err.message : err
    );

    return {
      query: makeFallbackQuery(filePath, fileAnalysis),
      relevantDocs: 'MVP: external docs fetch not enabled yet.',
      timestamp,
    };
  }
}
