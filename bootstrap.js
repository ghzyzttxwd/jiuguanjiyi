// Variable Archive Bridge v0.1.2 bootstrap
// Fixes SillyTavern inline-drawer double-toggle on some mobile builds.

import './index.js';

(function installVabDrawerFix() {
    if (window.__VAB_DRAWER_FIX_INSTALLED__) return;
    window.__VAB_DRAWER_FIX_INSTALLED__ = true;

    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const toggle = target.closest('#vab-settings .inline-drawer-toggle');
        if (!toggle) return;

        // The core v0.1.1 panel used SillyTavern's inline-drawer class AND bound
        // its own anonymous click handler. On builds with native drawer handling,
        // one tap can therefore toggle twice and appear to do nothing.
        // Capture the tap before either handler and perform exactly one toggle.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const drawer = toggle.closest('.inline-drawer');
        const content = drawer?.querySelector('.inline-drawer-content');
        if (!content) return;

        const computedHidden = getComputedStyle(content).display === 'none';
        const inlineHidden = content.style.display === 'none';
        const isHidden = inlineHidden || computedHidden;

        content.style.display = isHidden ? 'block' : 'none';

        const icon = toggle.querySelector('.inline-drawer-icon');
        if (icon) {
            icon.classList.toggle('down', !isHidden);
            icon.classList.toggle('up', isHidden);
        }

        if (isHidden) {
            // Refresh immediately when opening so MVU status is current.
            Promise.resolve(window.VariableArchiveBridge?.refreshCurrent?.()).catch(console.warn);
        }
    }, true);
})();
