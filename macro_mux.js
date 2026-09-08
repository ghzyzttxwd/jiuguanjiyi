// Variable Archive Bridge v0.5.0 macro mux.
// Must load before index.js. It wraps registration of {{varArchiveContext}} so:
// - directory/list questions use the lightweight warm catalog
// - specific-detail questions keep the existing full cold-archive recall
// No MVU writes and no prompt-message insertion are performed here.

import { isDirectoryIntent, chooseArchiveMacroContext } from './macro_mux_core.js';

const VERSION = '0.5.0';
let patchedModern = false;
let patchedLegacy = false;
let attempts = 0;
let lastError = '';

function ctx() {
  try { return window.SillyTavern?.getContext?.() || window.parent?.SillyTavern?.getContext?.() || null; }
  catch { return null; }
}

function recentUserText() {
  try {
    const chat = ctx()?.chat || [];
    return chat.filter(m => m?.is_user).slice(-2).map(m => String(m?.mes || '')).join('\n');
  } catch {
    return '';
  }
}

function catalogContext() {
  try { return window.VariableArchiveBridgeWarmCatalog?.buildContextFromRecent?.() || ''; }
  catch { return ''; }
}

function wrapHandler(originalHandler) {
  if (typeof originalHandler !== 'function') return originalHandler;
  return function vabMuxedArchiveContext(...args) {
    const query = recentUserText();
    if (isDirectoryIntent(query)) {
      const catalog = catalogContext();
      if (catalog) return catalog;
    }
    const archive = originalHandler.apply(this, args);
    if (archive && typeof archive.then === 'function') {
      return archive.then(value => chooseArchiveMacroContext({ query, catalogContext: catalogContext(), archiveContext: value }));
    }
    return chooseArchiveMacroContext({ query, catalogContext: catalogContext(), archiveContext: archive });
  };
}

function patchModern(c) {
  const macros = c?.macros;
  if (!macros || typeof macros.register !== 'function' || macros.__VAB_MACRO_MUX__) return !!macros?.__VAB_MACRO_MUX__;
  const original = macros.register.bind(macros);
  macros.register = function vabMuxedRegister(name, config, ...rest) {
    if (name === 'varArchiveContext' && config && typeof config === 'object' && typeof config.handler === 'function') {
      config = { ...config, handler: wrapHandler(config.handler) };
    }
    return original(name, config, ...rest);
  };
  macros.__VAB_MACRO_MUX__ = true;
  patchedModern = true;
  return true;
}

function patchLegacy(c) {
  if (!c || typeof c.registerMacro !== 'function' || c.__VAB_LEGACY_MACRO_MUX__) return !!c?.__VAB_LEGACY_MACRO_MUX__;
  const original = c.registerMacro.bind(c);
  c.registerMacro = function vabMuxedLegacyRegister(name, handler, ...rest) {
    if (name === 'varArchiveContext' && typeof handler === 'function') handler = wrapHandler(handler);
    return original(name, handler, ...rest);
  };
  c.__VAB_LEGACY_MACRO_MUX__ = true;
  patchedLegacy = true;
  return true;
}

function install() {
  attempts += 1;
  try {
    const c = ctx();
    if (c) {
      patchModern(c);
      patchLegacy(c);
      if (patchedModern || patchedLegacy) return true;
    }
  } catch (error) {
    lastError = String(error?.message || error);
  }
  return false;
}

function start() {
  install();
  const delays = [0, 40, 120, 300, 700, 1500, 3000];
  for (const delay of delays) setTimeout(() => install(), delay);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

window.VariableArchiveBridgeMacroMux = {
  VERSION,
  install,
  getStatus: () => ({ patchedModern, patchedLegacy, attempts, lastError, readOnlyMvu: true, noPromptMessageInjection: true }),
};
