import { AppearanceController } from "./js/appearance.js";
import {
  APPEARANCE_DEFAULTS,
  READER_LIMITS,
  RERENDER_DEBOUNCE_MS,
} from "./js/constants.js";
import { collectDom } from "./js/dom.js";
import { loadPdfDocument, renderPdfPage } from "./js/pdf-service.js";
import { buildRowIndex, selectClosestWordInRow } from "./js/row-index.js";
import { drawTriangle } from "./js/triangle-renderer.js";
import { clamp } from "./js/utils.js";

const dom = collectDom();
const overlayContext = dom.overlayCanvas.getContext("2d");
if (!overlayContext) {
  throw new Error("Unable to acquire overlay canvas context.");
}

const appearance = new AppearanceController({
  backgroundInput: dom.backgroundColorInput,
  themeInput: dom.themeColorInput,
});

const state = {
  pdfDoc: null,
  pageNumber: 1,
  wordIndex: 0,
  words: [],
  rowWordIndices: [],
  wordRowIndex: [],
  readingOrder: [],
  sequenceByWordIndex: [],
  transitionWeights: [],
  running: true,
  pageLoading: false,
  wpm: READER_LIMITS.defaultWpm,
  minWpm: READER_LIMITS.minWpm,
  maxWpm: READER_LIMITS.maxWpm,
  msPerWord: Math.round(60_000 / READER_LIMITS.defaultWpm),
  lastFrameTime: performance.now(),
  motion: {
    fromPosition: 0,
    toPosition: 0,
    elapsedMs: 0,
    durationMs: 0,
  },
  triangleSize: {
    width: 26,
    height: 20,
  },
};

let pageRenderToken = 0;
let rerenderTimer = null;

function setEmptyHint(message) {
  dom.emptyHint.textContent = message;
  dom.emptyHint.classList.remove("is-hidden");
}

function hideEmptyHint() {
  dom.emptyHint.classList.add("is-hidden");
}

function setPageStackVisible(visible) {
  dom.pageStack.style.display = visible ? "block" : "none";
}

function lerp(from, to, t) {
  return from + ((to - from) * t);
}

function wordCenter(word) {
  return {
    x: (word.x0 + word.x1) / 2,
    y: (word.y0 + word.y1) / 2,
  };
}

function buildReadingOrder(words, rowWordIndices) {
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

function computeTriangleSize(words) {
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

function computeTransitionWeights({
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

function getWordIndexAtPosition(position) {
  if (!state.readingOrder.length) {
    return 0;
  }

  const safePosition = clamp(position, 0, state.readingOrder.length - 1);
  return state.readingOrder[safePosition];
}

function getLogicalPosition() {
  if (
    state.motion.fromPosition === state.motion.toPosition
    || state.motion.durationMs <= 0
  ) {
    return state.motion.fromPosition;
  }

  const progress = clamp(state.motion.elapsedMs / state.motion.durationMs, 0, 1);
  return progress >= 0.5 ? state.motion.toPosition : state.motion.fromPosition;
}

function syncWordIndexFromMotion() {
  state.wordIndex = getWordIndexAtPosition(getLogicalPosition());
}

function transitionDurationMs(position) {
  const weight = state.transitionWeights[position] ?? 1;
  return Math.max(1, weight * state.msPerWord);
}

function setMotionToPosition(position) {
  const maxPosition = Math.max(0, state.readingOrder.length - 1);
  const clamped = clamp(position, 0, maxPosition);

  state.motion.fromPosition = clamped;
  state.motion.toPosition = clamped;
  state.motion.elapsedMs = 0;
  state.motion.durationMs = 0;

  syncWordIndexFromMotion();
}

function refreshActiveTransitionForCurrentSpeed() {
  if (state.motion.fromPosition === state.motion.toPosition) {
    return;
  }

  const previousDuration = state.motion.durationMs;
  const progress = previousDuration > 0
    ? clamp(state.motion.elapsedMs / previousDuration, 0, 1)
    : 0;

  const duration = transitionDurationMs(state.motion.fromPosition);
  state.motion.durationMs = duration;
  state.motion.elapsedMs = duration * progress;
}

function startNextTransition() {
  if (state.motion.fromPosition >= state.readingOrder.length - 1) {
    return false;
  }

  state.motion.toPosition = state.motion.fromPosition + 1;
  state.motion.elapsedMs = 0;
  state.motion.durationMs = transitionDurationMs(state.motion.fromPosition);
  return true;
}

function completeTransition() {
  state.motion.fromPosition = state.motion.toPosition;
  state.motion.elapsedMs = 0;
  state.motion.durationMs = 0;
  syncWordIndexFromMotion();
}

function maybeAdvancePageAfterEnd() {
  if (!state.pdfDoc || state.pageLoading || state.pageNumber >= state.pdfDoc.numPages) {
    return false;
  }

  void changePage(1);
  return true;
}

function advanceMotion(deltaMs) {
  let remainingMs = deltaMs;
  let moved = false;

  while (
    remainingMs > 0
    && state.running
    && state.words.length
    && !state.pageLoading
  ) {
    if (state.motion.fromPosition === state.motion.toPosition) {
      if (!startNextTransition()) {
        if (!maybeAdvancePageAfterEnd()) {
          state.running = false;
          updatePlaybackButton();
          updateStatusChip();
        }
        break;
      }
    }

    const segmentRemainingMs = Math.max(
      0,
      state.motion.durationMs - state.motion.elapsedMs
    );

    if (segmentRemainingMs <= 0.001) {
      completeTransition();
      continue;
    }

    const consumedMs = Math.min(segmentRemainingMs, remainingMs);
    state.motion.elapsedMs += consumedMs;
    remainingMs -= consumedMs;
    moved = true;

    if (state.motion.elapsedMs >= state.motion.durationMs - 0.001) {
      completeTransition();
    } else {
      syncWordIndexFromMotion();
    }
  }

  return moved;
}

function getPointerState() {
  if (!state.words.length || !state.readingOrder.length) {
    return null;
  }

  const fromWordIndex = getWordIndexAtPosition(state.motion.fromPosition);
  const toWordIndex = getWordIndexAtPosition(state.motion.toPosition);
  const fromWord = state.words[fromWordIndex];
  const toWord = state.words[toWordIndex] ?? fromWord;
  if (!fromWord || !toWord) {
    return null;
  }

  const progress = (
    state.motion.fromPosition === state.motion.toPosition
    || state.motion.durationMs <= 0
  )
    ? 0
    : clamp(state.motion.elapsedMs / state.motion.durationMs, 0, 1);

  const fromCenter = wordCenter(fromWord);
  const toCenter = wordCenter(toWord);

  return {
    x: lerp(fromCenter.x, toCenter.x, progress),
    y0: lerp(fromWord.y0, toWord.y0, progress),
    y1: lerp(fromWord.y1, toWord.y1, progress),
  };
}

function updatePlaybackButton() {
  if (!state.pdfDoc) {
    dom.togglePlayButton.textContent = "Pause";
    return;
  }

  dom.togglePlayButton.textContent = state.running ? "Pause" : "Resume";
}

function updateStatusChip() {
  const mode = !state.pdfDoc
    ? "Idle"
    : state.pageLoading
      ? "Loading"
      : state.running
        ? "Playing"
        : "Paused";

  const pageText = state.pdfDoc
    ? `Page ${state.pageNumber}/${state.pdfDoc.numPages}`
    : "No PDF loaded";

  dom.statusChip.textContent = `${mode}  |  ${pageText}`;
  dom.statusChip.classList.toggle("is-playing", mode === "Playing");
  dom.statusChip.classList.toggle("is-paused", mode === "Paused");
}

function setSpeed(nextWpm, syncSlider = true) {
  const clamped = clamp(Number(nextWpm), state.minWpm, state.maxWpm);
  const rounded = Math.round(clamped / 10) * 10;

  if (rounded === state.wpm) {
    if (syncSlider && Number(dom.speedSlider.value) !== rounded) {
      dom.speedSlider.value = String(rounded);
    }
    return;
  }

  state.wpm = rounded;
  state.msPerWord = Math.round(60_000 / rounded);
  dom.speedValue.textContent = `${rounded} wpm`;

  if (syncSlider && Number(dom.speedSlider.value) !== rounded) {
    dom.speedSlider.value = String(rounded);
  }

  refreshActiveTransitionForCurrentSpeed();
  state.lastFrameTime = performance.now();
  updateStatusChip();
}

function redrawTriangle() {
  drawTriangle({
    overlayContext,
    overlayCanvas: dom.overlayCanvas,
    viewerScroll: dom.viewerScroll,
    pageStack: dom.pageStack,
    words: state.words,
    pointer: getPointerState(),
    triangleSize: state.triangleSize,
    themeRgb: appearance.state.themeRgb,
  });
}

function setWords(words) {
  state.words = words;

  const rowIndex = buildRowIndex(words);
  state.rowWordIndices = rowIndex.rowWordIndices;
  state.wordRowIndex = rowIndex.wordRowIndex;

  state.readingOrder = buildReadingOrder(words, state.rowWordIndices);
  state.sequenceByWordIndex = new Array(words.length).fill(-1);
  state.readingOrder.forEach((wordIndex, position) => {
    state.sequenceByWordIndex[wordIndex] = position;
  });
  state.transitionWeights = computeTransitionWeights({
    words,
    rowWordIndices: state.rowWordIndices,
    readingOrder: state.readingOrder,
    sequenceByWordIndex: state.sequenceByWordIndex,
  });
  state.triangleSize = computeTriangleSize(words);

  if (state.readingOrder.length) {
    setMotionToPosition(0);
    return;
  }

  state.wordIndex = 0;
  state.motion.fromPosition = 0;
  state.motion.toPosition = 0;
  state.motion.elapsedMs = 0;
  state.motion.durationMs = 0;
}

function togglePlayback() {
  state.running = !state.running;
  state.lastFrameTime = performance.now();
  updatePlaybackButton();
  updateStatusChip();
}

function stepWord(delta) {
  if (!state.readingOrder.length) {
    return;
  }

  const targetPosition = clamp(
    getLogicalPosition() + delta,
    0,
    state.readingOrder.length - 1
  );
  setMotionToPosition(targetPosition);
  state.lastFrameTime = performance.now();
  redrawTriangle();
}

function moveRow(deltaRows) {
  if (!state.words.length || !state.rowWordIndices.length || !state.readingOrder.length) {
    return;
  }

  const currentWordIndex = getWordIndexAtPosition(getLogicalPosition());
  const currentRow = state.wordRowIndex[currentWordIndex];
  if (currentRow === undefined || currentRow < 0) {
    return;
  }

  const targetRow = clamp(currentRow + deltaRows, 0, state.rowWordIndices.length - 1);
  if (targetRow === currentRow) {
    return;
  }

  const targetWordIndex = selectClosestWordInRow({
    words: state.words,
    rowWordIndices: state.rowWordIndices,
    currentWordIndex,
    targetRowIndex: targetRow,
  });

  const targetPosition = state.sequenceByWordIndex[targetWordIndex];
  if (targetPosition === undefined || targetPosition < 0) {
    return;
  }

  setMotionToPosition(targetPosition);
  state.lastFrameTime = performance.now();
  redrawTriangle();
}

async function renderPage(pageNumber) {
  if (!state.pdfDoc) {
    return;
  }

  const renderToken = ++pageRenderToken;
  state.pageLoading = true;
  updateStatusChip();

  try {
    const rendered = await renderPdfPage({
      pdfDoc: state.pdfDoc,
      pageNumber,
      viewerWidth: dom.viewerScroll.clientWidth,
      pdfCanvas: dom.pdfCanvas,
      overlayCanvas: dom.overlayCanvas,
    });

    if (renderToken !== pageRenderToken) {
      return;
    }

    setWords(rendered.words);
    dom.viewerScroll.scrollTop = 0;
    redrawTriangle();
    hideEmptyHint();
    setPageStackVisible(true);
  } catch (error) {
    setEmptyHint(`Failed to render page ${pageNumber}: ${error.message}`);
    setPageStackVisible(false);
    setWords([]);
    redrawTriangle();
  } finally {
    if (renderToken === pageRenderToken) {
      state.pageLoading = false;
      updateStatusChip();
      updatePlaybackButton();
    }
  }
}

async function changePage(delta) {
  if (!state.pdfDoc || state.pageLoading) {
    return;
  }

  const targetPage = clamp(
    state.pageNumber + delta,
    1,
    state.pdfDoc.numPages
  );

  if (targetPage === state.pageNumber) {
    return;
  }

  state.pageNumber = targetPage;
  await renderPage(targetPage);
}

async function loadPdfFromArrayBuffer(arrayBuffer) {
  try {
    state.pageLoading = true;
    updateStatusChip();

    state.pdfDoc = await loadPdfDocument(arrayBuffer);
    state.pageNumber = 1;
    state.running = true;
    setWords([]);

    updatePlaybackButton();
    await renderPage(state.pageNumber);
  } catch (error) {
    state.pdfDoc = null;
    state.pageLoading = false;
    setWords([]);

    redrawTriangle();
    setPageStackVisible(false);
    setEmptyHint(`Unable to load PDF. ${error.message}`);

    updateStatusChip();
    updatePlaybackButton();
  }
}

function queuePageRerender() {
  if (!state.pdfDoc) {
    return;
  }

  if (rerenderTimer !== null) {
    clearTimeout(rerenderTimer);
  }

  rerenderTimer = window.setTimeout(() => {
    void renderPage(state.pageNumber);
    rerenderTimer = null;
  }, RERENDER_DEBOUNCE_MS);
}

async function onFileChanged(event) {
  const file = event.target.files?.[0];
  if (!file) {
    dom.fileName.textContent = "No file selected";
    return;
  }

  dom.fileName.textContent = file.name;
  const arrayBuffer = await file.arrayBuffer();
  await loadPdfFromArrayBuffer(arrayBuffer);
}

function applyAppearance(backgroundHex, themeHex, persist = true) {
  appearance.apply(backgroundHex, themeHex, persist);
  if (state.words.length) {
    redrawTriangle();
  }
}

function handleVerticalKey(event) {
  if (event.shiftKey) {
    setSpeed(state.wpm + (event.code === "ArrowUp" ? 20 : -20));
    return;
  }

  moveRow(event.code === "ArrowUp" ? -1 : 1);
}

function handleKeydown(event) {
  if (!state.pdfDoc || state.pageLoading) {
    return;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLInputElement && activeElement.type === "range") {
    return;
  }

  const basicHandlers = {
    Space: () => togglePlayback(),
    ArrowRight: () => stepWord(1),
    ArrowLeft: () => stepWord(-1),
    PageDown: () => {
      void changePage(1);
    },
    PageUp: () => {
      void changePage(-1);
    },
  };

  if (event.code === "ArrowUp" || event.code === "ArrowDown") {
    event.preventDefault();
    handleVerticalKey(event);
    return;
  }

  const handler = basicHandlers[event.code];
  if (!handler) {
    return;
  }

  event.preventDefault();
  handler();
}

function bindEvents() {
  dom.uploadTrigger.addEventListener("click", () => {
    dom.fileInput.click();
  });

  dom.backgroundColorInput.addEventListener("input", (event) => {
    applyAppearance(event.target.value, appearance.state.themeHex);
  });

  dom.themeColorInput.addEventListener("input", (event) => {
    applyAppearance(appearance.state.backgroundHex, event.target.value);
  });

  dom.appearanceResetButton.addEventListener("click", () => {
    applyAppearance(
      APPEARANCE_DEFAULTS.backgroundHex,
      APPEARANCE_DEFAULTS.themeHex
    );
  });

  dom.speedSlider.addEventListener("input", (event) => {
    const nextWpm = Number(event.target.value);
    setSpeed(nextWpm, false);
  });

  dom.togglePlayButton.addEventListener("click", () => {
    if (!state.pdfDoc) {
      return;
    }
    togglePlayback();
  });

  dom.prevPageButton.addEventListener("click", () => {
    void changePage(-1);
  });

  dom.nextPageButton.addEventListener("click", () => {
    void changePage(1);
  });

  dom.fileInput.addEventListener("change", (event) => {
    void onFileChanged(event);
  });

  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("resize", queuePageRerender);
}

function tickFrame(now) {
  const deltaMs = Math.max(0, now - state.lastFrameTime);
  state.lastFrameTime = now;

  if (state.running && state.words.length && !state.pageLoading) {
    const moved = advanceMotion(deltaMs);
    if (moved) {
      redrawTriangle();
    }
  }

  window.requestAnimationFrame(tickFrame);
}

function bootstrap() {
  const savedAppearance = appearance.loadSaved();
  if (savedAppearance) {
    applyAppearance(savedAppearance.backgroundHex, savedAppearance.themeHex, false);
  } else {
    applyAppearance(
      APPEARANCE_DEFAULTS.backgroundHex,
      APPEARANCE_DEFAULTS.themeHex,
      false
    );
  }

  setPageStackVisible(false);
  setSpeed(state.wpm);
  updatePlaybackButton();
  updateStatusChip();
  bindEvents();
  window.requestAnimationFrame(tickFrame);
}

bootstrap();
