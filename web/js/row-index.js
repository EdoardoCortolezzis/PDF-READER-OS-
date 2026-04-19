import { wordCenter } from "./reader/motion.js";

export function buildRowIndex(words) {
  const rowWordIndices = [];
  const wordRowIndex = new Array(words.length).fill(-1);

  if (!words.length) {
    return { rowWordIndices, wordRowIndex };
  }

  const rowCenters = [];
  const rowHeights = [];

  words.forEach((word, wordIndex) => {
    const centerY = (word.y0 + word.y1) / 2;
    const wordHeight = Math.max(1, word.y1 - word.y0);

    if (!rowWordIndices.length) {
      rowWordIndices.push([wordIndex]);
      rowCenters.push(centerY);
      rowHeights.push(wordHeight);
      wordRowIndex[wordIndex] = 0;
      return;
    }

    const activeRow = rowWordIndices.length - 1;
    const tolerance = Math.max(3, Math.min(wordHeight, rowHeights[activeRow]) * 0.7);

    if (Math.abs(centerY - rowCenters[activeRow]) <= tolerance) {
      const row = rowWordIndices[activeRow];
      row.push(wordIndex);

      const count = row.length;
      rowCenters[activeRow] = ((rowCenters[activeRow] * (count - 1)) + centerY) / count;
      rowHeights[activeRow] = ((rowHeights[activeRow] * (count - 1)) + wordHeight) / count;
      wordRowIndex[wordIndex] = activeRow;
      return;
    }

    rowWordIndices.push([wordIndex]);
    rowCenters.push(centerY);
    rowHeights.push(wordHeight);
    wordRowIndex[wordIndex] = rowWordIndices.length - 1;
  });

  rowWordIndices.forEach((row, rowIndex) => {
    row.sort((left, right) => words[left].x0 - words[right].x0);
    row.forEach((wordIndex) => {
      wordRowIndex[wordIndex] = rowIndex;
    });
  });

  return { rowWordIndices, wordRowIndex };
}

export function selectClosestWordInRow({
  words,
  rowWordIndices,
  currentWordIndex,
  targetRowIndex,
}) {
  const candidates = rowWordIndices[targetRowIndex] ?? [];
  if (!candidates.length) {
    return currentWordIndex;
  }

  const current = wordCenter(words[currentWordIndex]);

  return candidates.reduce((bestIndex, candidateIndex) => {
    const candidate = wordCenter(words[candidateIndex]);
    const best = wordCenter(words[bestIndex]);

    const candidateDistance =
      Math.abs(candidate.x - current.x) + Math.abs(candidate.y - current.y) * 0.15;
    const bestDistance = Math.abs(best.x - current.x) + Math.abs(best.y - current.y) * 0.15;

    return candidateDistance < bestDistance ? candidateIndex : bestIndex;
  }, candidates[0]);
}

export function buildRowBounds(words, rowWordIndices) {
  return rowWordIndices.map((row) => {
    if (!row.length) {
      return null;
    }

    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;

    row.forEach((wordIndex) => {
      const word = words[wordIndex];
      if (!word) {
        return;
      }

      x0 = Math.min(x0, word.x0);
      y0 = Math.min(y0, word.y0);
      x1 = Math.max(x1, word.x1);
      y1 = Math.max(y1, word.y1);
    });

    if (
      !Number.isFinite(x0)
      || !Number.isFinite(y0)
      || !Number.isFinite(x1)
      || !Number.isFinite(y1)
    ) {
      return null;
    }

    const lineHeight = Math.max(1, y1 - y0);
    const padX = Math.max(8, lineHeight * 0.45);
    const padY = Math.max(2, lineHeight * 0.1);

    return {
      x0: Math.max(0, x0 - padX),
      y0: y0 - padY,
      x1: x1 + padX,
      y1: y1 + padY,
    };
  });
}
