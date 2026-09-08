// Variable Archive Bridge v0.4.1 bootstrap
// Universal MVU archive + recall + hot-state governance + self-update for variable cards.

import './index.js';
import './mvu_recovery.js';
import './hot_archive_reconcile.js';
import './smart_scan.js';
import './production_auto.js';
import './hot_state_governor.js';
import './self_update.js';

(function installVabDrawerFix() {
    if (window.__VAB_DRAWER_FIX_INSTALLED__) return;
    window.__VAB_DRAWER_FIX_INSTALLED__ = true;

    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const toggle = target.closest('#vab-settings .inline-drawer-toggle, #vab-governor-settings .inline-drawer-toggle');
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
            if (toggle.closest('#vab-governor-settings')) {
                Promise.resolve(window.VariableArchiveBridgeHotStateGovernor?.refresh?.()).catch(console.warn);
            } else {
                Promise.resolve(window.VariableArchiveBridgeMvuRecovery?.recover?.()).catch(console.warn);
                Promise.resolve(window.VariableArchiveBridgeSelfUpdate?.check?.()).catch(console.warn);
            }
        }
    }, true);
})();
