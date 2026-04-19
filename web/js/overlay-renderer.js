import { drawDropDownBookmarkIndicator } from "./bookmark-renderer.js";
import { PACE_MODES } from "./state/pace-mode.js";
import { drawTriangleIndicator } from "./triangle-renderer.js";

function drawHighlightRects(context, rects, emphasizeStroke) {
  if (!rects.length) {
    return;
  }

  context.save();
  rects.forEach((rect) => {
    const width = Math.max(1, rect.x1 - rect.x0);
    const height = Math.max(1, rect.y1 - rect.y0);
    context.fillStyle = rect.fillStyle;
    context.fillRect(rect.x0, rect.y0, width, height);

    if (emphasizeStroke) {
      context.strokeStyle = rect.strokeStyle;
      context.lineWidth = 1;
      context.strokeRect(
        rect.x0 + 0.5,
        rect.y0 + 0.5,
        Math.max(0, width - 1),
        Math.max(0, height - 1)
      );
    }
  });
  context.restore();
}

function ensureRegionVisible({ viewerScroll, pageStack, y0, y1 }) {
  const contentHeight = pageStack.offsetHeight;
  const viewportHeight = viewerScroll.clientHeight;
  if (!contentHeight || viewportHeight <= 1 || contentHeight <= viewportHeight) {
    return;
  }

  const regionTop = pageStack.offsetTop + y0;
  const regionBottom = pageStack.offsetTop + y1;
  const currentTop = viewerScroll.scrollTop;
  const margin = Math.max(44, viewportHeight * 0.2);

  let targetTop = currentTop;
  if (regionTop < currentTop + margin) {
    targetTop = regionTop - margin;
  } else if (regionBottom > currentTop + viewportHeight - margin) {
    targetTop = regionBottom - viewportHeight + margin;
  } else {
    return;
  }

  const maxTop = contentHeight - viewportHeight;
  targetTop = Math.max(0, Math.min(targetTop, maxTop));
  viewerScroll.scrollTop = targetTop;
}

export function drawReadingOverlay({
  overlayContext,
  overlayCanvas,
  viewerScroll,
  pageStack,
  words,
  triangleSize,
  themeRgb,
  paceMode,
  indicatorMotion,
  wordRowIndex,
  rowBoundsByRow,
  highlightRects = [],
  selectionRects = [],
}) {
  overlayContext.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  drawHighlightRects(overlayContext, highlightRects, false);
  drawHighlightRects(overlayContext, selectionRects, true);

  if (!words.length || !indicatorMotion) {
    return;
  }

  const visibilityRegion = paceMode === PACE_MODES.DROPDOWN_BOOKMARK
    ? drawDropDownBookmarkIndicator({
      overlayContext,
      words,
      wordRowIndex,
      rowBoundsByRow,
      fromWordIndex: indicatorMotion.fromWordIndex,
      toWordIndex: indicatorMotion.toWordIndex,
      progress: indicatorMotion.progress,
    })
    : drawTriangleIndicator({
      overlayContext,
      pointer: indicatorMotion.pointer,
      triangleSize,
      themeRgb,
    });

  if (!visibilityRegion) {
    return;
  }

  ensureRegionVisible({
    viewerScroll,
    pageStack,
    y0: visibilityRegion.y0,
    y1: visibilityRegion.y1,
  });
}
