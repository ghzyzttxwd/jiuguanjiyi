export function normalizeVersion(version) {
  return String(version ?? '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0)
    .slice(0, 3)
    .concat([0, 0, 0])
    .slice(0, 3);
}

export function compareVersions(a, b) {
  const av = normalizeVersion(a);
  const bv = normalizeVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

export function hasNewerVersion(currentVersion, latestVersion) {
  return compareVersions(latestVersion, currentVersion) > 0;
}

export function chooseUpdatePath({ remoteNewer, updateOk, backendIsUpToDate, isAndroid }) {
  if (!remoteNewer) return 'none';
  if (updateOk && backendIsUpToDate === false) return 'reload';
  if (isAndroid) return 'force-switch';
  return 'manual-fallback';
}
