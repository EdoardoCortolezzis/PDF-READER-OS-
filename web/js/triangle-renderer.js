import { darkenRgb, lightenRgb } from "./utils.js";

export function drawTriangle({
  overlayContext,
  overlayCanvas,
  viewerScroll,
  pageStack,
  words,
  pointer,
  triangleSize,
  themeRgb,
}) {
  overlayContext.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!words.length || !pointer) {
    return;
  }

  const centerX = pointer.x;
  const top = pointer.y0;
  const triangleHeight = Math.max(18, triangleSize?.height ?? 20);
  const triangleWidth = Math.max(24, triangleSize?.width ?? 26);

  const glowWidth = triangleWidth * 1.35;
  const glowHeight = triangleHeight * 1.25;

  const edgeColor = darkenRgb(themeRgb, 0.52);
  const gradientStart = lightenRgb(themeRgb, 0.25);
  const gradientEnd = darkenRgb(themeRgb, 0.14);

  overlayContext.save();
  overlayContext.fillStyle = `rgba(${themeRgb.r}, ${themeRgb.g}, ${themeRgb.b}, 0.45)`;
  overlayContext.shadowColor = `rgba(${themeRgb.r}, ${themeRgb.g}, ${themeRgb.b}, 0.8)`;
  overlayContext.shadowBlur = 18;
  overlayContext.beginPath();
  overlayContext.moveTo(centerX, top + 1);
  overlayContext.lineTo(centerX - glowWidth / 2, top - glowHeight);
  overlayContext.lineTo(centerX + glowWidth / 2, top - glowHeight);
  overlayContext.closePath();
  overlayContext.fill();
  overlayContext.restore();

  const gradient = overlayContext.createLinearGradient(
    centerX,
    top - triangleHeight,
    centerX,
    top + 1
  );
  gradient.addColorStop(
    0,
    `rgba(${gradientStart.r}, ${gradientStart.g}, ${gradientStart.b}, 0.9)`
  );
  gradient.addColorStop(
    1,
    `rgba(${gradientEnd.r}, ${gradientEnd.g}, ${gradientEnd.b}, 0.96)`
  );

  overlayContext.fillStyle = gradient;
  overlayContext.strokeStyle = `rgba(${edgeColor.r}, ${edgeColor.g}, ${edgeColor.b}, 0.92)`;
  overlayContext.lineWidth = 2;
  overlayContext.lineJoin = "round";
  overlayContext.beginPath();
  overlayContext.moveTo(centerX, top - 2);
  overlayContext.lineTo(centerX - triangleWidth / 2, top - triangleHeight);
  overlayContext.lineTo(centerX + triangleWidth / 2, top - triangleHeight);
  overlayContext.closePath();
  overlayContext.fill();
  overlayContext.stroke();

  ensureWordVisible({
    viewerScroll,
    pageStack,
    y0: pointer.y0,
    y1: pointer.y1,
  });
}

function ensureWordVisible({ viewerScroll, pageStack, y0, y1 }) {
  const contentHeight = pageStack.offsetHeight;
  const viewportHeight = viewerScroll.clientHeight;
  if (!contentHeight || viewportHeight <= 1 || contentHeight <= viewportHeight) {
    return;
  }

  const wordTop = pageStack.offsetTop + y0;
  const wordBottom = pageStack.offsetTop + y1;
  const currentTop = viewerScroll.scrollTop;
  const margin = Math.max(44, viewportHeight * 0.2);

  let targetTop = currentTop;
  if (wordTop < currentTop + margin) {
    targetTop = wordTop - margin;
  } else if (wordBottom > currentTop + viewportHeight - margin) {
    targetTop = wordBottom - viewportHeight + margin;
  } else {
    return;
  }

  const maxTop = contentHeight - viewportHeight;
  targetTop = Math.max(0, Math.min(targetTop, maxTop));
  viewerScroll.scrollTop = targetTop;
}
