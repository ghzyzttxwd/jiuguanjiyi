import assert from 'node:assert/strict';
import {
  analyzeRecallDelivery,
  collectPromptStrings,
  detectMacroPlacement,
  detectPromptKeyCollision,
  findLegacyOverlap,
  summarizeDeliveryDecision,
} from './recall_delivery_core.js';

const ranked = [
  { record: { id: 'a1', childKey: '凝血神剑', sourcePath: '/玩家/武学', pointer: '/玩家/武学/凝血神剑' } },
  { record: { id: 'a2', childKey: '不良人世界', sourcePath: '/世界档案', pointer: '/世界档案/不良人世界' } },
];

const promptSources = [
  { name: 'characterCard', value: { system_prompt: '保持世界一致性。' } },
  { name: 'chatCompletionSettings', value: { prompts: [{ content: '冷档案：{{ varArchiveContext }}' }] } },
];

const scan = collectPromptStrings(promptSources);
assert(scan.strings.some(x => x.text.includes('varArchiveContext')));
assert(scan.nodes > 0);

let placement = detectMacroPlacement(promptSources);
assert.equal(placement.confidence, 'strong');
assert.equal(placement.found, true);
assert(placement.strong.some(x => x.source === 'chatCompletionSettings'));

placement = detectMacroPlacement([
  { name: 'notes', value: { note: '插件名 varArchiveContext 只是说明文字' } },
]);
assert.equal(placement.confidence, 'weak');
assert.equal(placement.found, false);

placement = detectMacroPlacement([
  { name: 'notes', value: { note: '这里没有任何旧宏' } },
]);
assert.equal(placement.confidence, 'none');

const legacyText = [
  '<variable_archive_context>',
  '名称: 凝血神剑',
  '路径: /玩家/武学/凝血神剑',
  '</variable_archive_context>',
].join('\n');
const overlap = findLegacyOverlap(ranked, legacyText);
assert.equal(overlap.length, 1);
assert.equal(overlap[0].childKey, '凝血神剑');

assert.equal(detectPromptKeyCollision({ existingValue: '' }).collision, false);
assert.equal(detectPromptKeyCollision({ existingValue: '<variable_cold_archive_recall>旧</variable_cold_archive_recall>' }).collision, false);
assert.equal(detectPromptKeyCollision({ existingValue: 'foreign extension prompt' }).collision, true);
assert.equal(detectPromptKeyCollision({ existingValue: 'abc', lastOwnedValue: 'abc' }).collision, false);

const strongPlacement = detectMacroPlacement(promptSources);
let decision = analyzeRecallDelivery({
  ranked,
  legacyMacroEnabled: true,
  legacyMacroText: legacyText,
  macroPlacement: strongPlacement,
});
assert.equal(decision.mode, 'legacy-macro');
assert.equal(decision.shouldInject, false);
assert.equal(decision.overlapCount, 1);
assert(summarizeDeliveryDecision(decision).includes('沿用'));

decision = analyzeRecallDelivery({
  ranked,
  legacyMacroEnabled: true,
  legacyMacroText: legacyText,
  macroPlacement: { confidence: 'weak' },
});
assert.equal(decision.mode, 'auto-prompt');
assert.equal(decision.shouldInject, true);
assert(decision.reasons.some(x => x.includes('弱冲突')));

decision = analyzeRecallDelivery({
  ranked,
  legacyMacroEnabled: false,
  legacyMacroText: '',
  macroPlacement: { confidence: 'none' },
  memoryActive: true,
  skippedMirroredCount: 2,
});
assert.equal(decision.mode, 'auto-prompt');
assert(decision.reasons.some(x => x.includes('记忆增强')));

decision = analyzeRecallDelivery({
  ranked,
  promptCollision: true,
});
assert.equal(decision.mode, 'blocked-collision');
assert.equal(decision.shouldInject, false);

const cycle = {};
cycle.self = cycle;
const cycleScan = collectPromptStrings([{ name: 'cycle', value: cycle }], { maxScanNodes: 20, maxScanChars: 1000 });
assert(cycleScan.nodes <= 20);

const huge = 'x'.repeat(5000) + '{{varArchiveContext}}';
const capped = collectPromptStrings([{ name: 'huge', value: huge }], { maxScanChars: 1000 });
assert(capped.chars <= 1000);
assert.equal(capped.truncated, true);

console.log(JSON.stringify({
  ok: true,
  tests: 24,
  strongMatches: strongPlacement.strong.length,
  overlap: overlap.map(x => x.childKey),
  finalMode: decision.mode,
}));
