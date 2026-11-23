/**
 * Keeps keyboard focus inside a dialog when the focused control goes away: a chip or a saved
 * scheme deleted, a Default button that hides itself, Reset layout disabling itself. Focus then
 * moves to the nearest control before it (else after it) instead of falling to the page.
 */

import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

function usable(el: HTMLElement): boolean {
  return (
    el.isConnected &&
    !el.matches(':disabled') &&
    el.closest('[inert]') === null &&
    el.getClientRects().length > 0
  );
}

/** The dialog's controls in tab order (radios: only the checked one of a group). */
function controls(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) && usable(el),
  );
}

export function useFocusRescue(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    let last: HTMLElement | null = null;
    let before: HTMLElement[] = [];
    let after: HTMLElement[] = [];
    const onIn = (e: FocusEvent) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || t === root) return;
      last = t;
      const all = controls(root);
      const i = all.indexOf(t);
      before = i < 0 ? [] : all.slice(0, i).reverse();
      after = i < 0 ? [] : all.slice(i + 1);
    };
    // Focus left on purpose (a press on the page, another window): nothing to rescue.
    const onOut = (e: FocusEvent) => {
      const t = e.target;
      queueMicrotask(() => {
        if (last === t && usable(t as HTMLElement) && document.activeElement !== t) last = null;
      });
    };
    const check = () => {
      if (!last || usable(last)) return;
      const a = document.activeElement;
      if (a !== null && a !== document.body && a !== root && a !== last) return;
      (before.find(usable) ?? after.find(usable))?.focus();
    };
    const mo = new MutationObserver(check);
    mo.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'inert', 'hidden'],
    });
    root.addEventListener('focusin', onIn);
    root.addEventListener('focusout', onOut);
    return () => {
      mo.disconnect();
      root.removeEventListener('focusin', onIn);
      root.removeEventListener('focusout', onOut);
    };
  }, [ref, active]);
}
