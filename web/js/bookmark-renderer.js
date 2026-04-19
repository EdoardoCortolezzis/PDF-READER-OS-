import { lerp, wordCenter } from "./reader/motion.js";
import { clamp } from "./utils.js";

const COVERED_LINE_COUNT = 3;

function easeInOutSine(value) {
  const t = clamp(value, 0, 1);
  return -((Math.cos(Math.PI * t) - 1) / 2);
}

function smoothTransitionProgress(value) {
  const t = clamp(value, 0, 1);
  // Keep mostly linear motion (triangle-like) while softening the endpoints.
  return lerp(t, easeInOutSine(t), 0.4);
}

function drawRoundedRect(context, x, y, width, height, radius) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.arcTo(x + width, y, x + width, y + safeRadius, safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.arcTo(x + width, y + height, x + width - safeRadius, y + height, safeRadius);
  context.lineTo(x + safeRadius, y + height);
  context.arcTo(x, y + height, x, y + height - safeRadius, safeRadius);
  context.lineTo(x, y + safeRadius);
  context.arcTo(x, y, x + safeRadius, y, safeRadius);
  context.closePath();
}

function resolveRowIndex(wordIndex, wordRowIndex) {
  const rowIndex = wordRowIndex[wordIndex];
  return rowIndex === undefined || rowIndex < 0 ? null : rowIndex;
}

function rowCenterY(rowBounds) {
  return (rowBounds.y0 + rowBounds.y1) / 2;
}

function resolveLinePitch(rowBoundsByRow, rowIndex, fallbackLineHeight) {
  if (rowIndex === null) {
    return Math.max(14, fallbackLineHeight * 1.35);
  }

  const currentRow = rowBoundsByRow[rowIndex];
  if (!currentRow) {
    return Math.max(14, fallbackLineHeight * 1.35);
  }

  const candidates = [];
  const currentCenter = rowCenterY(currentRow);
  const nextRow = rowBoundsByRow[rowIndex + 1];
  const previousRow = rowBoundsByRow[rowIndex - 1];

  if (nextRow) {
    candidates.push(Math.abs(rowCenterY(nextRow) - currentCenter));
  }
  if (previousRow) {
    candidates.push(Math.abs(currentCenter - rowCenterY(previousRow)));
  }

  const finiteCandidates = candidates.filter((value) => Number.isFinite(value) && value > 0.1);
  if (!finiteCandidates.length) {
    return Math.max(14, fallbackLineHeight * 1.35);
  }

  return finiteCandidates.reduce((sum, value) => sum + value, 0) / finiteCandidates.length;
}

function resolveLineGeometry({
  words,
  wordIndex,
  rowIndex,
  rowBoundsByRow,
}) {
  if (rowIndex !== null) {
    const rowBounds = rowBoundsByRow[rowIndex];
    if (rowBounds) {
      const lineHeight = Math.max(12, rowBounds.y1 - rowBounds.y0);
      return {
        centerX: (rowBounds.x0 + rowBounds.x1) / 2,
        centerY: (rowBounds.y0 + rowBounds.y1) / 2,
        width: Math.max(28, rowBounds.x1 - rowBounds.x0),
        height: lineHeight,
        top: rowBounds.y0,
        bottom: rowBounds.y1,
        linePitch: resolveLinePitch(rowBoundsByRow, rowIndex, lineHeight),
      };
    }
  }

  const word = words[wordIndex];
  if (!word) {
    return null;
  }

  const center = wordCenter(word);
  const wordHeight = Math.max(1, word.y1 - word.y0);
  const lineHeight = Math.max(12, wordHeight * 1.2);
  return {
    centerX: center.x,
    centerY: center.y,
    width: Math.max(48, (word.x1 - word.x0) + wordHeight * 2),
    height: lineHeight,
    top: center.y - lineHeight / 2,
    bottom: center.y + lineHeight / 2,
    linePitch: Math.max(14, lineHeight * 1.35),
  };
}

export function drawDropDownBookmarkIndicator({
  overlayContext,
  words,
  wordRowIndex,
  rowBoundsByRow,
  fromWordIndex,
  toWordIndex,
  progress,
}) {
  if (!words.length) {
    return null;
  }

  const safeToWordIndex = toWordIndex ?? fromWordIndex;
  const fromRowIndex = resolveRowIndex(fromWordIndex, wordRowIndex);
  const toRowIndex = resolveRowIndex(safeToWordIndex, wordRowIndex);

  const fromGeometry = resolveLineGeometry({
    words,
    wordIndex: fromWordIndex,
    rowIndex: fromRowIndex,
    rowBoundsByRow,
  });
  const toGeometry = resolveLineGeometry({
    words,
    wordIndex: safeToWordIndex,
    rowIndex: toRowIndex,
    rowBoundsByRow,
  });

  if (!fromGeometry || !toGeometry) {
    return null;
  }

  const isLineTransition = fromRowIndex !== null
    && toRowIndex !== null
    && fromRowIndex !== toRowIndex;

  const clampedProgress = clamp(progress, 0, 1);
  const transitionProgress = isLineTransition
    ? smoothTransitionProgress(clampedProgress)
    : 0;

  const centerX = lerp(fromGeometry.centerX, toGeometry.centerX, transitionProgress);
  const width = lerp(fromGeometry.width, toGeometry.width, transitionProgress);
  const lineBottom = lerp(fromGeometry.bottom, toGeometry.bottom, transitionProgress);
  const lineHeight = lerp(fromGeometry.height, toGeometry.height, transitionProgress);
  const linePitch = lerp(fromGeometry.linePitch, toGeometry.linePitch, transitionProgress);

  const barWidth = Math.max(40, width);
  // Keep the rectangle entirely below the active row and cover at least the next 3 lines.
  const clearanceBelowActiveLine = Math.max(3, lineHeight * 0.22);
  const barHeight = Math.max(
    linePitch * COVERED_LINE_COUNT,
    lineHeight * (COVERED_LINE_COUNT + 0.35)
  );
  const topY = lineBottom + clearanceBelowActiveLine;
  const centerY = topY + (barHeight / 2);
  const radius = Math.min(8, barHeight * 0.08);

  drawRoundedRect(
    overlayContext,
    centerX - (barWidth / 2),
    centerY - (barHeight / 2),
    barWidth,
    barHeight,
    radius
  );
  overlayContext.fillStyle = "rgba(0, 0, 0, 1)";
  overlayContext.fill();

  return {
    y0: centerY - barHeight / 2,
    y1: centerY + barHeight / 2,
  };
}
