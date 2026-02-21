export function lerp(from, to, t) {
  return from + ((to - from) * t);
}

export function wordCenter(word) {
  return {
    x: (word.x0 + word.x1) / 2,
    y: (word.y0 + word.y1) / 2,
  };
}

export function buildReadingOrder(words, rowWordIndices) {
  const order = rowWordIndices.flat();
  if (order.length === words.length) {
    return order;
  }

  const seen = new Set(order);
  for (let index = 0; index < words.length; index += 1) {
    if (!seen.has(index)) {
      order.push(index);
    }
  }

  return order;
}

export function computeTriangleSize(words) {
  if (!words.length) {
    return {
      width: 26,
      height: 20,
    };
  }

  const heights = words
    .map((word) => Math.max(1, word.y1 - word.y0))
    .sort((left, right) => left - right);

  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 20;
  const triangleHeight = Math.max(18, medianHeight * 0.9);

  return {
    height: triangleHeight,
    width: Math.max(24, triangleHeight * 1.35),
  };
}

export function computeTransitionWeights({
  words,
  rowWordIndices,
  readingOrder,
  sequenceByWordIndex,
}) {
  const weights = new Array(Math.max(0, readingOrder.length - 1)).fill(1);
  if (!weights.length) {
    return weights;
  }

  rowWordIndices.forEach((row) => {
    if (row.length < 2) {
      return;
    }

    const segments = [];
    let totalDistance = 0;

    for (let index = 0; index < row.length - 1; index += 1) {
      const leftWordIndex = row[index];
      const rightWordIndex = row[index + 1];

      const leftPosition = sequenceByWordIndex[leftWordIndex];
      const rightPosition = sequenceByWordIndex[rightWordIndex];
      if (leftPosition === undefined || leftPosition < 0) {
        continue;
      }
      if (rightPosition !== leftPosition + 1) {
        continue;
      }

      const leftCenter = wordCenter(words[leftWordIndex]);
      const rightCenter = wordCenter(words[rightWordIndex]);
      const distance = Math.hypot(
        rightCenter.x - leftCenter.x,
        rightCenter.y - leftCenter.y
      );

      segments.push({
        position: leftPosition,
        distance,
      });
      totalDistance += distance;
    }

    if (!segments.length) {
      return;
    }

    if (totalDistance <= 0.001) {
      segments.forEach(({ position }) => {
        weights[position] = 1;
      });
      return;
    }

    const normalization = segments.length;
    segments.forEach(({ position, distance }) => {
      weights[position] = normalization * (distance / totalDistance);
    });
  });

  return weights;
}
