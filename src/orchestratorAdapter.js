import path from 'node:path';
import crypto from 'node:crypto';
import { buildContext } from './contextBuilder.js';
import { detectIntent } from './intentDetector.js';
import { generatePrompt } from './promptGenerator.js';
import { deliverPrompt, writeCursorRules } from './cursorDelivery.js';
import { notifyPromptReady } from './notify/index.js';
import { scorePromptPriority, shouldDeliverByPriority } from './promptPriority.js';
import { loadProjectDocsContext } from './projectDocsLoader.js';

const ROOT = path.resolve(process.cwd());

function assertProjectScoped(targetPath) {
  const absolute = path.resolve(targetPath);
  if (!absolute.startsWith(ROOT)) {
    throw new Error(`[orchestratorAdapter] Out-of-scope path: ${targetPath}`);
  }
  return absolute;
}

function shouldRequireApproval(reason) {
  return (
    process.env.HUMAN_APPROVAL_REQUIRED === 'true' &&
    (reason === 'webhook' || reason === 'external')
  );
}

function normalizeMode(mode) {
  if (mode === 'cursorrules' || mode === 'dual') return mode;
  if (mode === 'analysis' || mode === 'analysis-only') return 'analysis-only';
  if (mode === 'prompt-only' || mode === 'prompt') return 'prompt-only';
  if (mode === 'delivery-only' || mode === 'deliver-only') return 'delivery-only';
  return 'clipboard';
}

function normalizePromptTrack(track) {
  if (track === 'feature' || track === 'both') return track;
  return 'safe';
}

function toBooleanOrDefault(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function defaultPolicyForMode(mode) {
  switch (mode) {
    case 'analysis-only':
      return {
        analyze: true,
        intent: true,
        prompt: false,
        deliver: false,
        rules: false,
        notify: false,
      };
    case 'prompt-only':
      return {
        analyze: true,
        intent: true,
        prompt: true,
        deliver: false,
        rules: false,
        notify: false,
      };
    case 'delivery-only':
      return {
        analyze: true,
        intent: true,
        prompt: false,
        deliver: true,
        rules: false,
        notify: true,
      };
    case 'cursorrules':
      return {
        analyze: true,
        intent: true,
        prompt: false,
        deliver: false,
        rules: true,
        notify: true,
      };
    case 'dual':
      return {
        analyze: true,
        intent: true,
        prompt: true,
        deliver: true,
        rules: true,
        notify: true,
      };
    default:
      return {
        analyze: true,
        intent: true,
        prompt: true,
        deliver: true,
        rules: false,
        notify: true,
      };
  }
}

function normalizeExecutionPolicy(mode, deliveryContext = {}) {
  const base = defaultPolicyForMode(mode);
  const incoming = deliveryContext.executionPolicy ?? {};
  return {
    version: 1,
    analyze: toBooleanOrDefault(incoming.analyze, base.analyze),
    intent: toBooleanOrDefault(incoming.intent, base.intent),
    prompt: toBooleanOrDefault(incoming.prompt, base.prompt),
    deliver: toBooleanOrDefault(incoming.deliver, base.deliver),
    rules: toBooleanOrDefault(incoming.rules, base.rules),
    notify: toBooleanOrDefault(incoming.notify, base.notify),
    dryRun: toBooleanOrDefault(incoming.dryRun, false),
    ignorePriority: toBooleanOrDefault(incoming.ignorePriority, false),
    failFast: toBooleanOrDefault(incoming.failFast, false),
  };
}

function buildStageStatuses() {
  return {
    docs: { status: 'pending' },
    analyze: { status: 'pending' },
    intent: { status: 'pending' },
    prompt: { status: 'pending' },
    rules: { status: 'pending' },
    deliver: { status: 'pending' },
    notify: { status: 'pending' },
  };
}

function markStage(stageStatuses, stage, status, reason = null) {
  stageStatuses[stage] = reason ? { status, reason } : { status };
}

const STAGE_ORDER = ['docs', 'analyze', 'intent', 'prompt', 'rules', 'deliver', 'notify'];
const ORCHESTRATOR_VERBOSE_STAGES =
  (process.env.ORCHESTRATOR_VERBOSE_STAGES ?? 'false').toLowerCase() === 'true';

function resolveExecutionPlan(mode, policy, shouldDeliver) {
  return {
    analyze: Boolean(policy.analyze),
    intent: Boolean(policy.intent),
    prompt: Boolean(policy.prompt && shouldDeliver),
    rules: Boolean(policy.rules && shouldDeliver),
    deliver: Boolean(policy.deliver && shouldDeliver),
    notify: Boolean(policy.notify && shouldDeliver && !policy.dryRun),
    mode,
    shouldDeliver,
  };
}

function buildStageResult({ ok = true, skipped = false, reason = null, output = null, error = null }) {
  return { ok, skipped, reason, output, error };
}

function markStageFromResult(stageStatuses, stage, stageResult) {
  if (stageResult.ok && !stageResult.skipped) {
    markStage(stageStatuses, stage, 'ran');
    return;
  }
  if (stageResult.skipped) {
    markStage(stageStatuses, stage, 'skipped', stageResult.reason ?? 'skipped');
    return;
  }
  markStage(stageStatuses, stage, 'error', stageResult.reason ?? 'stage-error');
}

function logStage(stage, runId, stageResult, durationMs) {
  if (!ORCHESTRATOR_VERBOSE_STAGES) return;
  console.log(
    JSON.stringify({
      event: 'pipeline_stage',
      runId,
      stage,
      durationMs,
      ...stageResult,
    })
  );
}

function summarizeExecution(stageStatuses) {
  const summary = { ran: 0, skipped: 0, errored: 0 };
  for (const stage of STAGE_ORDER) {
    const status = stageStatuses?.[stage]?.status;
    if (status === 'ran') summary.ran += 1;
    else if (status === 'skipped') summary.skipped += 1;
    else if (status === 'error') summary.errored += 1;
  }
  return summary;
}

export async function runPipeline({
  filePath,
  mode = 'clipboard',
  reason = 'file-change',
  approved = false,
  deliveryContext = {},
}) {
  const runId = crypto.randomUUID();
  const effectiveMode = normalizeMode(mode);
  const effectivePromptTrack = normalizePromptTrack(
    deliveryContext.promptTrack ?? process.env.PROMPT_TRACK ?? 'safe'
  );
  const executionPolicy = normalizeExecutionPolicy(effectiveMode, deliveryContext);
  const scopedFilePath = assertProjectScoped(filePath);
  const stageStatuses = buildStageStatuses();

  if (shouldRequireApproval(reason) && !approved) {
    const executionSummary = summarizeExecution(stageStatuses);
    return {
      ok: false,
      skipped: true,
      reason: 'human-approval-required',
      filePath: scopedFilePath,
      mode: effectiveMode,
      executionMode: effectiveMode,
      executionPolicy,
      runId,
      stageStatuses,
      stageErrors: {},
      executionSummary,
      aborted: false,
      abortStage: null,
    };
  }

  const executionStart = Date.now();
  const stages = {};
  const stageErrors = {};
  const logBase = {
    event: 'pipeline_run',
    runId,
    filePath: scopedFilePath,
    mode: effectiveMode,
    executionMode: effectiveMode,
    policyVersion: executionPolicy.version,
    reason,
    ...(deliveryContext.fullscanRunId
      ? { fullscanRunId: deliveryContext.fullscanRunId }
      : {}),
  };

  try {
    let context = null;
    let intent = '';
    let enrichedContext = null;
    /** @type {{score: number, reason: string, factors: string[]}} */
    let priority = { score: 0, reason: 'not-computed', factors: [] };
    let priorityRank =
      typeof deliveryContext.priorityRank === 'number' ? deliveryContext.priorityRank : 1;
    let shouldDeliver = false;
    let aborted = false;
    let abortStage = null;
    let projectDocsContext = null;

    const docsStart = Date.now();
    projectDocsContext = loadProjectDocsContext({
      targetFilePath: scopedFilePath,
      required:
        typeof deliveryContext?.projectDocsRequired === 'boolean'
          ? deliveryContext.projectDocsRequired
          : undefined,
      docsDirName:
        typeof deliveryContext?.projectDocsDir === 'string'
          ? deliveryContext.projectDocsDir
          : undefined,
      enabled:
        typeof deliveryContext?.projectDocsEnabled === 'boolean'
          ? deliveryContext.projectDocsEnabled
          : undefined,
    });
    stages.docsMs = Date.now() - docsStart;
    const docsLoaded = Boolean(projectDocsContext?.loaded);
    const docsRequired = Boolean(projectDocsContext?.required);
    const docsResult =
      docsLoaded || !docsRequired
        ? buildStageResult({
            ok: true,
            skipped: !docsLoaded,
            reason: docsLoaded ? null : 'projectdocs-not-loaded',
            output: projectDocsContext,
          })
        : buildStageResult({
            ok: false,
            reason: 'projectdocs-required-missing',
            error: 'projectdocs is required but no readable docs were loaded',
          });
    markStageFromResult(stageStatuses, 'docs', docsResult);
    logStage('docs', runId, docsResult, stages.docsMs);
    if (!docsResult.ok) {
      return {
        ok: false,
        skipped: true,
        reason: 'projectdocs-required-missing',
        runId,
        executionMode: effectiveMode,
        executionPolicy,
        stageStatuses,
        stageErrors: { docs: 'projectdocs-required-missing' },
        executionSummary: summarizeExecution(stageStatuses),
        aborted: false,
        abortStage: null,
      };
    }

    if (!executionPolicy.analyze) {
      markStage(stageStatuses, 'analyze', 'skipped', 'policy-disabled');
      const executionSummary = summarizeExecution(stageStatuses);
      return {
        ok: false,
        skipped: true,
        reason: 'analysis-disabled-by-policy',
        runId,
        executionMode: effectiveMode,
        executionPolicy,
        stageStatuses,
        stageErrors: {},
        executionSummary,
        aborted: false,
        abortStage: null,
      };
    }

    const analyzeStart = Date.now();
    console.log(`🧠 analyzing: ${scopedFilePath}`);
    context = await buildContext(scopedFilePath, { projectDocsContext });
    stages.analyzeMs = Date.now() - analyzeStart;
    const analyzeResult = context
      ? buildStageResult({ ok: true, output: context })
      : buildStageResult({
          ok: false,
          reason: 'context-build-failed',
          error: 'Context build returned null',
        });
    markStageFromResult(stageStatuses, 'analyze', analyzeResult);
    logStage('analyze', runId, analyzeResult, stages.analyzeMs);
    if (!context) {
      const executionSummary = summarizeExecution(stageStatuses);
      return {
        ok: false,
        skipped: true,
        reason: 'context-build-failed',
        runId,
        executionMode: effectiveMode,
        executionPolicy,
        stageStatuses,
        stageErrors: { analyze: 'context-build-failed' },
        executionSummary,
        aborted: false,
        abortStage: null,
      };
    }

    if (executionPolicy.intent) {
      const intentStart = Date.now();
      console.log(`🎯 detecting intent: ${context.file}`);
      intent = await detectIntent(
        context.analysis,
        context.browserContext,
        context.recentChanges ?? [],
        context.contextSignals ?? {},
        context.projectProfileContext ?? {},
        context.projectDocsContext ?? {}
      );
      stages.intentMs = Date.now() - intentStart;
      const intentResult = buildStageResult({ ok: true, output: intent });
      markStageFromResult(stageStatuses, 'intent', intentResult);
      logStage('intent', runId, intentResult, stages.intentMs);
    } else {
      stages.intentMs = 0;
      const intentResult = buildStageResult({
        ok: true,
        skipped: true,
        reason: 'policy-disabled',
      });
      markStageFromResult(stageStatuses, 'intent', intentResult);
      logStage('intent', runId, intentResult, stages.intentMs);
      intent = 'Intent detection skipped by execution policy.';
    }

    enrichedContext = { ...context, intent };
    priority = scorePromptPriority({
      filePath: context.fullPath,
      analysis: context.analysis,
      intent,
      recentChanges: context.recentChanges,
    });
    shouldDeliver =
      executionPolicy.ignorePriority ||
      shouldDeliverByPriority(
        { score: priority.score, rank: priorityRank },
        {
          topN:
            typeof deliveryContext.priorityTopN === 'number'
              ? deliveryContext.priorityTopN
              : null,
          minScore:
            typeof deliveryContext.priorityMinScore === 'number'
              ? deliveryContext.priorityMinScore
              : null,
        }
      );
    const executionPlan = resolveExecutionPlan(effectiveMode, executionPolicy, shouldDeliver);

    /** @type {Array<'safe'|'feature'>} */
    const tracksToGenerate =
      effectivePromptTrack === 'both' ? ['safe', 'feature'] : [effectivePromptTrack];
    const generatedPrompts = {};
    const deliveredTracks = [];

    if (!executionPlan.prompt) {
      stages.promptMs = 0;
      const promptResult = buildStageResult({
        ok: true,
        skipped: true,
        reason: shouldDeliver ? 'policy-disabled' : 'priority-gated',
      });
      markStageFromResult(stageStatuses, 'prompt', promptResult);
      logStage('prompt', runId, promptResult, stages.promptMs);
      if (!shouldDeliver) {
        console.log(
          `[orchestratorAdapter] Skipping delivery for ${context.file} due to priority controls.`
        );
      }
    } else {
      const promptStart = Date.now();
      console.log(`✍️ generating prompt: ${context.file}`);
      for (const track of tracksToGenerate) {
        generatedPrompts[track] = await generatePrompt(enrichedContext, { promptTrack: track });
      }
      stages.promptMs = Date.now() - promptStart;
      const promptResult = buildStageResult({ ok: true, output: generatedPrompts });
      markStageFromResult(stageStatuses, 'prompt', promptResult);
      logStage('prompt', runId, promptResult, stages.promptMs);
    }

    if (executionPlan.rules) {
      const rulesStart = Date.now();
      if (!executionPolicy.dryRun) {
        writeCursorRules(enrichedContext);
      }
      stages.rulesMs = Date.now() - rulesStart;
      const rulesResult = executionPolicy.dryRun
        ? buildStageResult({ ok: true, skipped: true, reason: 'dry-run' })
        : buildStageResult({ ok: true });
      markStageFromResult(stageStatuses, 'rules', rulesResult);
      logStage('rules', runId, rulesResult, stages.rulesMs);
    } else {
      stages.rulesMs = 0;
      const rulesResult = buildStageResult({
        ok: true,
        skipped: true,
        reason: shouldDeliver ? 'policy-disabled' : 'priority-gated',
      });
      markStageFromResult(stageStatuses, 'rules', rulesResult);
      logStage('rules', runId, rulesResult, stages.rulesMs);
    }

    const deliveryStart = Date.now();
    if (executionPlan.deliver) {
      if (effectiveMode === 'delivery-only') {
        for (const track of tracksToGenerate) {
          const prebuilt =
            typeof deliveryContext?.prebuiltPrompts?.[track] === 'string'
              ? deliveryContext.prebuiltPrompts[track]
              : typeof deliveryContext?.prebuiltPrompt === 'string'
                ? deliveryContext.prebuiltPrompt
                : null;
          if (!prebuilt) {
            stageErrors.deliver = 'missing-prebuilt-prompt';
            continue;
          }
          if (!executionPolicy.dryRun) {
            await deliverPrompt(prebuilt, {
              mode: 'clipboard',
              sourceFile: context.fullPath,
              intent,
              priorityScore: priority.score,
              priorityReason: priority.reason,
              ...deliveryContext,
              promptTrack: track,
            });
          }
          deliveredTracks.push(track);
        }
      } else {
        for (const track of tracksToGenerate) {
          const prompt = generatedPrompts[track];
          if (typeof prompt !== 'string' || !prompt.trim()) continue;
          if (!executionPolicy.dryRun) {
            await deliverPrompt(prompt, {
              mode: effectiveMode === 'dual' ? 'dual' : 'clipboard',
              sourceFile: context.fullPath,
              intent,
              priorityScore: priority.score,
              priorityReason: priority.reason,
              ...deliveryContext,
              promptTrack: track,
            });
          }
          deliveredTracks.push(track);
        }
      }
      if (effectiveMode === 'dual') {
        console.log(
          `📋 delivered (dual): ${context.file} [tracks=${deliveredTracks.join(',') || 'none'}]`
        );
      } else if (effectiveMode === 'cursorrules') {
        console.log(`📋 delivered (cursorrules): ${context.file}`);
      } else if (effectiveMode === 'delivery-only') {
        console.log(
          `📋 delivered (delivery-only): ${context.file} [tracks=${deliveredTracks.join(',') || 'none'}]`
        );
      } else {
        console.log(
          `📋 delivered (clipboard): ${context.file} [tracks=${deliveredTracks.join(',') || 'none'}]`
        );
      }
      let deliverResult = buildStageResult({ ok: true });
      if (executionPolicy.dryRun) {
        deliverResult = buildStageResult({ ok: true, skipped: true, reason: 'dry-run' });
      } else if (effectiveMode === 'delivery-only' && deliveredTracks.length === 0) {
        deliverResult = buildStageResult({
          ok: false,
          reason: 'missing-prebuilt-prompt',
          error: 'No prebuilt prompt provided for delivery-only mode',
        });
      }
      markStageFromResult(stageStatuses, 'deliver', deliverResult);
      logStage('deliver', runId, deliverResult, Date.now() - deliveryStart);
      if (!deliverResult.ok) {
        stageErrors.deliver = deliverResult.reason ?? 'delivery-failed';
        if (executionPolicy.failFast) {
          aborted = true;
          abortStage = 'deliver';
        }
      }
    } else {
      const deliverResult = buildStageResult({
        ok: true,
        skipped: true,
        reason: shouldDeliver ? 'policy-disabled' : 'priority-gated',
      });
      markStageFromResult(stageStatuses, 'deliver', deliverResult);
      logStage('deliver', runId, deliverResult, Date.now() - deliveryStart);
    }
    stages.deliveryMs = Date.now() - deliveryStart;

    if (aborted) {
      const executionSummary = summarizeExecution(stageStatuses);
      const result = {
        ok: false,
        runId,
        mode: effectiveMode,
        executionMode: effectiveMode,
        executionPolicy,
        aborted: true,
        abortStage,
        stageStatuses,
        stageErrors,
        executionSummary,
        stages,
        durationMs: Date.now() - executionStart,
      };
      console.log(JSON.stringify({ ...logBase, ...result }));
      return result;
    }

    const notifyStart = Date.now();
    if (executionPlan.notify) {
      await notifyPromptReady({
        file: context.file,
        fullPath: context.fullPath,
        mode: effectiveMode,
        reason,
      });
      const notifyResult = buildStageResult({ ok: true });
      markStageFromResult(stageStatuses, 'notify', notifyResult);
      logStage('notify', runId, notifyResult, Date.now() - notifyStart);
    } else {
      const notifyResult = buildStageResult({
        ok: true,
        skipped: true,
        reason: executionPolicy.dryRun ? 'dry-run' : shouldDeliver ? 'policy-disabled' : 'priority-gated',
      });
      markStageFromResult(stageStatuses, 'notify', notifyResult);
      logStage('notify', runId, notifyResult, Date.now() - notifyStart);
    }
    stages.notifyMs = Date.now() - notifyStart;

    const executionSummary = summarizeExecution(stageStatuses);
    const result = {
      ok: true,
      runId,
      file: context.file,
      mode: effectiveMode,
      executionMode: effectiveMode,
      executionPolicy,
      delivered: shouldDeliver && executionPolicy.deliver && !executionPolicy.dryRun,
      promptTrack: effectivePromptTrack,
      deliveredTracks,
      priorityScore: priority.score,
      priorityReason: priority.reason,
      priorityRank,
      priorityFactors: priority.factors,
      stages,
      stageStatuses,
      stageErrors,
      executionSummary,
      aborted,
      abortStage,
      durationMs: Date.now() - executionStart,
    };
    console.log(JSON.stringify({ ...logBase, ...result }));
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[orchestratorAdapter] Pipeline run failed:', error);
    console.log(
      JSON.stringify({
        ...logBase,
        ok: false,
        error,
        stages,
        stageStatuses,
        stageErrors,
        executionSummary: summarizeExecution(stageStatuses),
        durationMs: Date.now() - executionStart,
      })
    );
    return {
      ok: false,
      runId,
      error,
      executionMode: effectiveMode,
      executionPolicy,
      stageStatuses,
      stageErrors,
      executionSummary: summarizeExecution(stageStatuses),
      aborted: false,
      abortStage: null,
    };
  }
}
