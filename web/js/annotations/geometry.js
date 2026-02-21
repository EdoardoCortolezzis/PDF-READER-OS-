import { clamp, hexToRgb } from "../utils.js";

const FALLBACK_HIGHLIGHT_RGB = { r: 255, g: 241, b: 118 };

export function colorToRgba(hexColor, alpha) {
  const rgb = hexToRgb(hexColor) ?? FALLBACK_HIGHLIGHT_RGB;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;
}

export function getWordIndicesForPositionRange({
  readingOrder,
  startPosition,
  endPosition,
}) {
  if (!readingOrder.length) {
    return [];
  }

  const minPosition = clamp(
    Math.min(startPosition, endPosition),
    0,
    readingOrder.length - 1
  );
  const maxPosition = clamp(
    Math.max(startPosition, endPosition),
    0,
    readingOrder.length - 1
  );

  const selectedWordIndices = [];
  for (let position = minPosition; position <= maxPosition; position += 1) {
    const wordIndex = readingOrder[position];
    if (wordIndex !== undefined) {
      selectedWordIndices.push(wordIndex);
    }
  }

  return selectedWordIndices;
}

export function buildRectsForWordIndices({
  wordIndices,
  words,
  wordRowIndex,
}) {
  if (!wordIndices.length || !words.length) {
    return [];
  }

  const rowMap = new Map();
  wordIndices.forEach((wordIndex) => {
    const rowIndex = wordRowIndex[wordIndex];
    if (rowIndex === undefined || rowIndex < 0) {
      return;
    }

    const list = rowMap.get(rowIndex) ?? [];
    list.push(wordIndex);
    rowMap.set(rowIndex, list);
  });

  const rowEntries = [...rowMap.entries()].sort((left, right) => left[0] - right[0]);
  const rects = [];

  rowEntries.forEach(([, rowWordIndices]) => {
    const sorted = [...rowWordIndices].sort((left, right) => {
      const leftWord = words[left];
      const rightWord = words[right];
      if (!leftWord || !rightWord) {
        return left - right;
      }
      return leftWord.x0 - rightWord.x0;
    });

    let activeRect = null;
    sorted.forEach((wordIndex) => {
      const word = words[wordIndex];
      if (!word) {
        return;
      }

      if (!activeRect) {
        activeRect = {
          x0: word.x0,
          y0: word.y0,
          x1: word.x1,
          y1: word.y1,
        };
        return;
      }

      const rowHeight = Math.max(1, activeRect.y1 - activeRect.y0, word.y1 - word.y0);
      const mergeGap = Math.max(8, rowHeight * 0.75);
      if (word.x0 <= activeRect.x1 + mergeGap) {
        activeRect.x1 = Math.max(activeRect.x1, word.x1);
        activeRect.y0 = Math.min(activeRect.y0, word.y0);
        activeRect.y1 = Math.max(activeRect.y1, word.y1);
        return;
      }

      rects.push(activeRect);
      activeRect = {
        x0: word.x0,
        y0: word.y0,
        x1: word.x1,
        y1: word.y1,
      };
    });

    if (activeRect) {
      rects.push(activeRect);
    }
  });

  return rects;
}

export function flattenAnnotationRects(annotations) {
  const rects = [];

  annotations.forEach((annotation) => {
    if (!annotation || !Array.isArray(annotation.rects)) {
      return;
    }

    annotation.rects.forEach((rect) => {
      if (!rect) {
        return;
      }

      rects.push({
        ...rect,
        fillStyle: annotation.fillStyle,
        strokeStyle: annotation.strokeStyle,
      });
    });
  });

  return rects;
}

function applyAffineTransform(matrix, x, y) {
  return {
    x: (matrix[0] * x) + (matrix[2] * y) + matrix[4],
    y: (matrix[1] * x) + (matrix[3] * y) + matrix[5],
  };
}

function normalizePdfQuad(points) {
  const sortedByY = [...points].sort((left, right) => right.y - left.y);
  const top = sortedByY.slice(0, 2).sort((left, right) => left.x - right.x);
  const bottom = sortedByY.slice(2).sort((left, right) => left.x - right.x);

  const topLeft = top[0] ?? points[0];
  const topRight = top[1] ?? points[1];
  const bottomLeft = bottom[0] ?? points[2];
  const bottomRight = bottom[1] ?? points[3];

  return [
    topLeft.x,
    topLeft.y,
    topRight.x,
    topRight.y,
    bottomLeft.x,
    bottomLeft.y,
    bottomRight.x,
    bottomRight.y,
  ];
}

export function viewRectToPdfQuad(rect, viewportInverseTransform) {
  const topLeft = applyAffineTransform(viewportInverseTransform, rect.x0, rect.y0);
  const topRight = applyAffineTransform(viewportInverseTransform, rect.x1, rect.y0);
  const bottomLeft = applyAffineTransform(viewportInverseTransform, rect.x0, rect.y1);
  const bottomRight = applyAffineTransform(viewportInverseTransform, rect.x1, rect.y1);
  return normalizePdfQuad([topLeft, topRight, bottomLeft, bottomRight]);
}

export function viewPointToPdfPoint(point, viewportInverseTransform) {
  return applyAffineTransform(viewportInverseTransform, point.x, point.y);
}
