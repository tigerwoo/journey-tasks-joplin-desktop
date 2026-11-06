/** Make the existing desktop divider beside this panel visible and hittable.
 * Joplin's native handle overlaps its neighbour by 5px; a later iframe covers
 * that half unless the handle has a stacking level of its own.
 * This is a same-origin DOM enhancement, with no Electron/config access.
 */
export function installHostResizeGuide(view: Window = window): () => void {
  let host: Document;
  let frame: Element;
  try {
    if (!view.frameElement || view.parent === view) return () => {};
    frame = view.frameElement;
    host = frame.ownerDocument;
    if (!frame.matches('iframe.plugin-user-webview')) return () => {};
  } catch {
    // Isolated webviews and mobile own their layout outside this document.
    return () => {};
  }
  const hostWindow = host.defaultView;
  const layout = frame.closest('.resizableLayoutItem');
  if (!hostWindow || !layout) return () => {};
  const marker = 'data-journey-resize-guide';
  const token = frame.id;
  if (!token) return () => {};
  const style = host.createElement('style');
  style.setAttribute('data-journey-resize-styles', token);
  const paneSelector = `[data-journey-main-pane="${token}"]`;
  layout.setAttribute('data-journey-main-pane', token);
  style.textContent = `
    ${paneSelector} { min-width:400px !important; min-height:240px !important; }
    ${paneSelector} > div:first-child {
      min-width:calc(100% - 5px) !important; min-height:calc(100% - 5px) !important;
    }
    ${paneSelector} iframe.plugin-user-webview { width:100% !important; height:100% !important; }

    [${marker}] {
      width:12px !important; right:-6px !important;
      z-index:10 !important; pointer-events:auto !important;
    }
    [${marker}]::after {
      content:''; position:absolute; top:0; bottom:0; left:5px; width:2px;
      background:var(--joplin-divider-color, #9299a3);
    }
    [${marker}]:hover::after, [${marker}]:active::after {
      left:4px; width:4px; background:#00b6ea;
    }
  `;
  host.head.append(style);
  let marked = new Set<Element>();
  let scheduled = 0;
  const nativeHandle = (pane: Element): Element | undefined =>
    Array.from(pane.querySelectorAll<HTMLElement>('[style*="col-resize"]'))
      .find(handle => handle.style.position === 'absolute' && handle.closest('.resizableLayoutItem') === pane);
  const refresh = () => {
    scheduled = 0;
    const handles = new Set<Element>();
    let branch: Element | null = frame.closest('.resizableLayoutItem');
    while (branch) {
      const parent: Element | null = branch.parentElement?.closest('.resizableLayoutItem') ?? null;
      if (!parent) break;
      if (hostWindow.getComputedStyle(parent).flexDirection === 'row') {
        const siblings = Array.from(parent.children).filter(element =>
          element.matches('.resizableLayoutItem') && element.getClientRects().length > 0 &&
          hostWindow.getComputedStyle(element).display !== 'none');
        const index = siblings.indexOf(branch);
        if (index > 0) {
          const left = nativeHandle(siblings[index - 1]!);
          if (left) handles.add(left);
        }
        if (index >= 0 && index < siblings.length - 1) {
          const right = nativeHandle(branch);
          if (right) handles.add(right);
        }
        // Only the nearest row containing this panel owns its side borders.
        if (handles.size) break;
      }
      branch = parent;
    }
    for (const handle of marked) {
      if (!handles.has(handle) && handle.getAttribute(marker) === token) handle.removeAttribute(marker);
    }
    for (const handle of handles) {
      if (handle.getAttribute(marker) !== token) handle.setAttribute(marker, token);
    }
    marked = handles;
  };
  // Clamp the coordinates seen by Joplin's native resize handler as well as
  // the rendered size. Otherwise its saved layout can shrink behind the CSS
  // minimum, leaving an invisible dead zone when the user drags back out.
  let drag: { minX: number; maxX: number } | undefined;
  const forwarded = new WeakSet<Event>();
  const beginDrag = (event: MouseEvent) => {
    if (event.button !== 0 || !Array.from(marked).some(handle => handle.contains(event.target as Node))) return;
    const bounds = layout.getBoundingClientRect();
    const leftEdge = event.clientX < bounds.left + bounds.width / 2;
    drag = leftEdge
      ? { minX: -Infinity, maxX: event.clientX + Math.max(0, bounds.width - 400) }
      : { minX: event.clientX - Math.max(0, bounds.width - 400), maxX: Infinity };
  };
  const constrainDrag = (event: MouseEvent) => {
    if (!drag || forwarded.has(event)) return;
    const x = Math.min(drag.maxX, Math.max(drag.minX, event.clientX));
    if (event.type === 'mouseup') drag = undefined;
    if (x === event.clientX) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const HostMouseEvent = (hostWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    const replacement = new HostMouseEvent(event.type, {
      bubbles: true, cancelable: true, clientX: x, clientY: event.clientY,
      screenX: event.screenX + x - event.clientX, screenY: event.screenY,
      button: event.button, buttons: event.buttons,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    });
    forwarded.add(replacement);
    hostWindow.dispatchEvent(replacement);
  };
  hostWindow.addEventListener('mousedown', beginDrag, true);
  hostWindow.addEventListener('mousemove', constrainDrag, true);
  hostWindow.addEventListener('mouseup', constrainDrag, true);
  const observer = new MutationObserver(() => {
    if (!scheduled) scheduled = view.requestAnimationFrame(refresh);
  });
  // Layout moves, visibility changes and handle remounts can change ownership.
  observer.observe(host.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
  refresh();
  return () => {
    hostWindow.removeEventListener('mousedown', beginDrag, true);
    hostWindow.removeEventListener('mousemove', constrainDrag, true);
    hostWindow.removeEventListener('mouseup', constrainDrag, true);
    observer.disconnect();
    if (scheduled) view.cancelAnimationFrame(scheduled);
    for (const handle of marked) {
      if (handle.getAttribute(marker) === token) handle.removeAttribute(marker);
    }
    if (layout.getAttribute('data-journey-main-pane') === token) layout.removeAttribute('data-journey-main-pane');
    style.remove();
  };
}
