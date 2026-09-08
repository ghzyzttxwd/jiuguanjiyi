// Variable Archive Bridge v0.5.0 macro routing pure logic.
// Directory questions use the lightweight warm catalog; specific-detail questions keep full cold-archive recall.

const DIRECTORY_RE = /(哪些|有什么|有哪些|全部|所有|一共|清单|目录|列表|会什么|会哪些|认识哪些|拥有些什么|掌握哪些|学会哪些|去过哪些)/i;

export function isDirectoryIntent(text) {
  return DIRECTORY_RE.test(String(text || ''));
}

export function chooseArchiveMacroContext({ query = '', catalogContext = '', archiveContext = '' } = {}) {
  if (isDirectoryIntent(query) && String(catalogContext || '').trim()) return String(catalogContext);
  return String(archiveContext || '');
}
