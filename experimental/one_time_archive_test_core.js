import {
  byteSize,
  collectHotAnchorText,
  discoverContainers,
  escapePointerSegment,
  isProtectedPath,
  textMentionsKey,
} from './smart_host_core.js';

const PROTECTED_KEY = /(当前|玩家|主角|自己|本人|队伍|小队|同行|同伴|系统|状态|任务|主线|临时|current|player|protagonist|self|party|team|system|status|task|temporary)/i;
const TEST_KEY = /(测试|test|dummy|sample|垃圾节点|占位)/i;

function childPointer(containerPath, childKey) {
  const base = String(containerPath || '').replace(/\/$/, '');
  return `${base}/${escapePointerSegment(childKey)}`;
}

function isObjectNode(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Select exactly one low-risk existing hot node for the explicit one-time live test.
 * This selector intentionally bypasses only the normal capacity/idle thresholds.
 * It still keeps structural protections, hot-anchor/recent-mention protection,
 * object-only cold-data semantics, and a minimum container width.
 */
export function selectOneTimeArchiveTestCandidate({
  statData,
  recentText = '',
  minContainerChildren = 5,
} = {}) {
  if (!statData || typeof statData !== 'object' || Array.isArray(statData)) return null;

  const protectionText = [String(recentText || ''), collectHotAnchorText(statData)]
    .filter(Boolean)
    .join('\n');
  const minChildren = Math.max(3, Number(minContainerChildren) || 5);
  const containers = discoverContainers(statData, { maxDepth: 4 });
  const candidates = [];

  for (const container of containers) {
    if (container.count < minChildren) continue;
    for (const [key, value] of container.entries) {
      const keyText = String(key || '').trim();
      if (keyText.length < 2 || !isObjectNode(value)) continue;
      const pointer = childPointer(container.path, keyText);
      if (isProtectedPath(pointer) || PROTECTED_KEY.test(keyText)) continue;
      if (textMentionsKey(protectionText, keyText)) continue;

      candidates.push({
        containerPath: container.path,
        containerCount: container.count,
        key: keyText,
        pointer,
        size: byteSize(value),
        preferredTestNode: TEST_KEY.test(keyText),
      });
    }
  }

  candidates.sort((a, b) =>
    Number(b.preferredTestNode) - Number(a.preferredTestNode)
    || a.size - b.size
    || b.containerCount - a.containerCount
    || a.pointer.localeCompare(b.pointer)
  );

  return candidates[0] || null;
}
