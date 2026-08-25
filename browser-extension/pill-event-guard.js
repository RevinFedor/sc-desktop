(function exposeScPillEventGuard(root) {
  const GUARDED_POINTER_EVENTS = Object.freeze([
    'pointerdown', 'pointerup', 'pointercancel',
    'mousedown', 'mouseup', 'dblclick', 'auxclick',
    'touchstart', 'touchend',
  ]);

  function absorbOverlayGesture(event, button) {
    try {
      if (event.type === 'pointerdown' && event.pointerId != null && button?.setPointerCapture) {
        button.setPointerCapture(event.pointerId);
      }
    } catch (_) {}
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
  }

  function scInstallNoPlaybackClick(button, onClick) {
    if (!button?.addEventListener) throw new Error('button with addEventListener required');
    if (button.__scNoPlaybackClickInstalled) return button;
    button.__scNoPlaybackClickInstalled = true;

    for (const type of GUARDED_POINTER_EVENTS) {
      button.addEventListener(type, event => absorbOverlayGesture(event, button), {
        capture: true,
        passive: false,
      });
    }
    button.addEventListener('click', event => {
      absorbOverlayGesture(event, button);
      onClick?.(event);
    }, { capture: true, passive: false });
    return button;
  }

  root.scInstallNoPlaybackClick = scInstallNoPlaybackClick;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GUARDED_POINTER_EVENTS, scInstallNoPlaybackClick };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
