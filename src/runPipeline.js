import { runPipeline } from './orchestratorAdapter.js';

const args = process.argv.slice(2);
const filePath = args.find((arg) => !arg.startsWith('--'));
const modeArg = args.find((arg) => arg.startsWith('--mode='))?.split('=')[1];
const promptTrackArg = args.find((arg) => arg.startsWith('--prompt-track='))?.split('=')[1];
const reasonArg =
  args.find((arg) => arg.startsWith('--reason='))?.split('=')[1] ?? 'external';
const approved = args.includes('--approved');
const allowedModes = new Set([
  'clipboard',
  'cursorrules',
  'dual',
  'analysis-only',
  'analysis',
  'prompt-only',
  'prompt',
  'delivery-only',
  'deliver-only',
]);
const allowedReasons = new Set(['external', 'webhook', 'file-change']);
const allowedTracks = new Set(['safe', 'feature', 'both']);

const executionPolicy = {
  dryRun: args.includes('--dry-run'),
  ignorePriority: args.includes('--ignore-priority'),
  notify: args.includes('--no-notify') ? false : undefined,
  deliver: args.includes('--no-deliver') ? false : undefined,
  rules: args.includes('--no-rules') ? false : undefined,
  prompt: args.includes('--no-prompt') ? false : undefined,
  intent: args.includes('--no-intent') ? false : undefined,
  analyze: args.includes('--no-analyze') ? false : undefined,
};
const hasPolicyOverride = Object.values(executionPolicy).some((value) => value !== undefined);

function printUsage() {
  console.error(
    'Usage: node src/runPipeline.js <filePath> [--mode=clipboard|cursorrules|dual|analysis-only|prompt-only|delivery-only] [--prompt-track=safe|feature|both] [--reason=external|webhook|file-change] [--approved] [--dry-run] [--ignore-priority] [--no-notify] [--no-deliver] [--no-rules]'
  );
}

if (!filePath) {
  printUsage();
  process.exit(1);
}

if (modeArg && !allowedModes.has(modeArg)) {
  console.error(
    `[runPipeline] Invalid mode "${modeArg}". Expected one of: ${[
      ...allowedModes,
    ].join(', ')}.`
  );
  printUsage();
  process.exit(1);
}

if (reasonArg && !allowedReasons.has(reasonArg)) {
  console.error(
    `[runPipeline] Invalid reason "${reasonArg}". Expected one of: ${[
      ...allowedReasons,
    ].join(', ')}.`
  );
  printUsage();
  process.exit(1);
}

if (promptTrackArg && !allowedTracks.has(promptTrackArg)) {
  console.error(
    `[runPipeline] Invalid prompt track "${promptTrackArg}". Expected one of: ${[
      ...allowedTracks,
    ].join(', ')}.`
  );
  printUsage();
  process.exit(1);
}

const result = await runPipeline({
  filePath,
  mode: modeArg ?? 'clipboard',
  reason: reasonArg,
  approved,
  deliveryContext: {
    ...(promptTrackArg ? { promptTrack: promptTrackArg } : {}),
    ...(hasPolicyOverride ? { executionPolicy } : {}),
  },
});

if (!result.ok) {
  process.exit(1);
}
