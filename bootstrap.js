// Variable Archive Bridge v0.2.1 bootstrap
// Stable core + hot-presence reconciliation + smart path scanner + automatic memory lifecycle.

import './index.js';
import './hot_archive_reconcile.js';
import './smart_scan.js';
import './production_auto.js';

(function installVabDrawerFix() {
    if (window.__VAB_DRAWER_FIX_INSTALLED__) return;
    window.__VAB_DRAWER_FIX_INSTALLED__ = true;

    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const toggle = target.closest('#vab-settings .inline-drawer-toggle');
        if (!toggle) return;

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
            Promise.resolve(window.VariableArchiveBridge?.refreshCurrent?.()).catch(console.warn);
        }
    }, true);
})();
