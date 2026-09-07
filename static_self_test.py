from pathlib import Path
import json, re, sys
root=Path(__file__).resolve().parent
src=(root/'index.js').read_text(encoding='utf-8')
manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
checks=[]
def check(name, cond):
    checks.append((name,bool(cond)))

def section(name,next_name=None):
    a=src.index(name)
    b=src.index(next_name,a+1) if next_name else len(src)
    return src[a:b]

check('manifest display_name', manifest.get('display_name')=='变量归档桥')
check('manifest version matches', manifest.get('version')=='0.1.1' and "const VERSION = '0.1.1'" in src)
check('no hard extension dependency', manifest.get('requires')==[])
check('auto archive default OFF', 'autoArchiveGlobal: false' in src)
check('memory mirror default OFF', 'memoryMirrorEnabled: false' in src)
check('IndexedDB archives store', "createObjectStore('archives'" in src)
check('IndexedDB snapshots store', "createObjectStore('snapshots'" in src)
check('MVU read API', 'mvu.getMvuData' in src)
check('MVU write API', 'mvu.replaceMvuData' in src)

snap=section('async function saveSnapshot','async function restoreSnapshot')
check('snapshot not skipped by busy lock', 'if (state.busy)' not in snap)
arc=section('async function archiveChild','async function restoreArchive')
idx_snap=arc.find('await saveSnapshot(')
idx_put=arc.find('await putArchive(record)')
idx_del=arc.find('deleteByPointer(newStat, pointer)')
idx_write=arc.find('await writeMvu(')
idx_verify=arc.find('hasByPointer(verify.statData, pointer)')
check('archive transaction ordering', -1 not in [idx_snap,idx_put,idx_del,idx_write,idx_verify] and idx_snap < idx_put < idx_del < idx_write < idx_verify)
check('schema rehydration verification', '自动补回' in arc and 'hasByPointer(verify.statData, pointer)' in arc)
rest=section('async function restoreArchive','async function togglePin')
check('restore snapshot before MVU write', rest.find("await saveSnapshot('before-archive-restore')") < rest.find('await writeMvu('))
check('restore prevents silent overwrite', '热变量中已经存在同名节点' in rest and 'confirm(' in rest)

auto=section('async function maybeAutoArchive','async function poll')
check('auto archive requires global switch', '!settings.autoArchiveGlobal' in auto)
check('auto archive respects zero target', 'if (targetCount <= 0) continue;' in auto)
check('auto archive one child per cycle', 'break; // one per cycle for safety' in auto)

macro=section('function registerMacro','// ---------- monitoring')
check('Macro Engine 2.0 registration', "c.macros.register('varArchiveContext'" in macro)
check('legacy macro fallback', "c.registerMacro('varArchiveContext'" in macro)
check('hot/cold duplicate suppression', 'if (isHot(record)) return -99999' in src)
check('MVU precedence in injected context', '若与当前MVU/stat_data冲突，以当前MVU为准' in src)

mem=section('async function ensureMemoryAdapter','// ---------- macro / relevance')
check('Memory Enhancement optional adapter', 'st-memory-enhancement/external-data-adapter.js' in mem)
check('memory duplicate mirror guard', 'record.mirroredToMemory' in mem and '未重复写入' in mem)
check('memory table insertion uses external adapter', "type: 'insert'" in mem and 'processJsonData' in mem)

check('Android CSS escape fallback', 'function cssEscape' in src and 'window.CSS?.escape' in src)
check('no external network fetch', not re.search(r'\bfetch\s*\(',src) and 'http://' not in src and 'https://' not in src)
check('diagnostic global exposed', 'window.VariableArchiveBridge = VAB' in src)

failed=[n for n,ok in checks if not ok]
for n,ok in checks:
    print(('[PASS] ' if ok else '[FAIL] ')+n)
print(f'\nTOTAL: {len(checks)-len(failed)}/{len(checks)} PASS')
if failed:
    print('FAILED:', ', '.join(failed))
    sys.exit(1)
