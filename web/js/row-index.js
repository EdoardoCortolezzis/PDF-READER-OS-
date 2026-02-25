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
