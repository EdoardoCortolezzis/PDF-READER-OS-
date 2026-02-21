import { AppearanceController } from "./js/appearance.js";
import {
  APPEARANCE_DEFAULTS,
  READER_LIMITS,
  RERENDER_DEBOUNCE_MS,
} from "./js/constants.js";
import { collectDom } from "./js/dom.js";
import {
  addPdfHighlightAnnotation,
  loadPdfDocument,
  removePdfHighlightAnnotationAtPoint,
  renderPdfPage,
} from "./js/pdf-service.js";
import { buildRowIndex, selectClosestWordInRow } from "./js/row-index.js";
import { drawTriangle } from "./js/triangle-renderer.js";
import { clamp } from "./js/utils.js";
import {
  buildRectsForWordIndices,
  colorToRgba,
  flattenAnnotationRects,
  getWordIndicesForPositionRange,
  viewPointToPdfPoint,
  viewRectToPdfQuad,
} from "./js/annotations/geometry.js";
import {
  buildReadingOrder,
  computeTransitionWeights,
  computeTriangleSize,
  lerp,
  wordCenter,
} from "./js/reader/motion.js";
import {
  interactionModeLabel,
  INTERACTION_MODES,
  isNormalInteractionMode,
  resolveInteractionModeTransition,
} from "./js/state/interaction-mode.js";

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
  pdfBytes: null,
  savingFile: false,
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
  interactionMode: INTERACTION_MODES.NORMAL,
  highlightColorHex: "#fff176",
  highlightPersisting: false,
  overlayHighlightRects: [],
  activeSelection: {
    dragging: false,
    pointerId: null,
    startPosition: -1,
    endPosition: -1,
  },
  viewportInverseTransform: [1, 0, 0, 1, 0, 0],
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

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "Unknown error");
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
    : state.savingFile
      ? "Saving file"
    : state.pageLoading
      ? "Loading"
    : state.highlightPersisting
      ? "Applying edits"
      : state.running
        ? "Playing"
        : "Paused";

  const pageText = state.pdfDoc
    ? `Page ${state.pageNumber}/${state.pdfDoc.numPages}`
    : "No PDF loaded";

  const modeText = !state.pdfDoc
    ? ""
    : ` | ${interactionModeLabel(state.interactionMode)}`;
  dom.statusChip.textContent = `${mode}  |  ${pageText}${modeText}`;
  dom.statusChip.classList.toggle("is-playing", mode === "Playing");
  dom.statusChip.classList.toggle("is-paused", mode === "Paused");
}

function updateHighlightControls() {
  const busy = state.pageLoading || state.highlightPersisting || state.savingFile;
  const canInteract = Boolean(state.pdfDoc) && !busy;
  dom.toggleHighlightModeButton.disabled = !canInteract;
  dom.toggleEraseModeButton.disabled = !canInteract;
  dom.highlightColorInput.disabled = !canInteract;

  const canSave = Boolean(state.pdfBytes) && !busy;
  dom.saveAnnotatedButton.disabled = !canSave;
  dom.saveAnnotatedButton.textContent = state.savingFile ? "Saving..." : "Save PDF";

  const highlightActive = state.interactionMode === INTERACTION_MODES.HIGHLIGHT;
  const eraseActive = state.interactionMode === INTERACTION_MODES.ERASE;
  dom.toggleHighlightModeButton.classList.toggle("is-active", highlightActive);
  dom.toggleEraseModeButton.classList.toggle("is-active", eraseActive);
  dom.toggleHighlightModeButton.setAttribute("aria-pressed", String(highlightActive));
  dom.toggleEraseModeButton.setAttribute("aria-pressed", String(eraseActive));
  dom.toggleHighlightModeButton.textContent = highlightActive
    ? "Highlight mode: on"
    : "Highlight mode";
  dom.pageStack.classList.toggle("highlight-mode-active", highlightActive);
  dom.pageStack.classList.toggle("erase-mode-active", eraseActive);
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

function buildSelectionOverlayRects() {
  if (!state.activeSelection.dragging) {
    return [];
  }

  const { startPosition, endPosition } = state.activeSelection;
  if (startPosition < 0 || endPosition < 0) {
    return [];
  }

  const wordIndices = getWordIndicesForPositionRange({
    readingOrder: state.readingOrder,
    startPosition,
    endPosition,
  });
  return buildRectsForWordIndices({
    wordIndices,
    words: state.words,
    wordRowIndex: state.wordRowIndex,
  }).map((rect) => ({
    ...rect,
    fillStyle: colorToRgba(state.highlightColorHex, 0.25),
    strokeStyle: colorToRgba(state.highlightColorHex, 0.7),
  }));
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
    highlightRects: state.overlayHighlightRects,
    selectionRects: buildSelectionOverlayRects(),
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

function getCurrentWordIndex() {
  if (!state.readingOrder.length) {
    return null;
  }

  return getWordIndexAtPosition(getLogicalPosition());
}

function getCurrentRowIndex() {
  if (!state.words.length || !state.rowWordIndices.length || !state.readingOrder.length) {
    return null;
  }

  const currentWordIndex = getCurrentWordIndex();
  if (currentWordIndex === null) {
    return null;
  }

  const currentRow = state.wordRowIndex[currentWordIndex];
  if (currentRow === undefined || currentRow < 0) {
    return null;
  }

  return currentRow;
}

function getCurrentWordCenterX() {
  const currentWordIndex = getCurrentWordIndex();
  if (currentWordIndex === null) {
    return null;
  }

  const word = state.words[currentWordIndex];
  if (!word) {
    return null;
  }

  return wordCenter(word).x;
}

function moveCursorToPosition(position) {
  if (!state.readingOrder.length) {
    return false;
  }

  const targetPosition = clamp(position, 0, state.readingOrder.length - 1);
  if (targetPosition === getLogicalPosition()) {
    return false;
  }

  setMotionToPosition(targetPosition);
  state.lastFrameTime = performance.now();
  redrawTriangle();
  return true;
}

function moveCursorToWordIndex(wordIndex) {
  const targetPosition = state.sequenceByWordIndex[wordIndex];
  if (targetPosition === undefined || targetPosition < 0) {
    return false;
  }

  return moveCursorToPosition(targetPosition);
}

function isAtReadingBoundary(deltaWords) {
  if (!state.readingOrder.length) {
    return false;
  }

  const currentPosition = getLogicalPosition();
  return deltaWords < 0
    ? currentPosition <= 0
    : currentPosition >= state.readingOrder.length - 1;
}

function isAtRowBoundary(deltaRows) {
  const currentRow = getCurrentRowIndex();
  if (currentRow === null) {
    return false;
  }

  return deltaRows < 0
    ? currentRow <= 0
    : currentRow >= state.rowWordIndices.length - 1;
}

function togglePlayback() {
  state.running = !state.running;
  state.lastFrameTime = performance.now();
  updatePlaybackButton();
  updateStatusChip();
}

function stepWord(delta) {
  if (!state.readingOrder.length) {
    return false;
  }

  return moveCursorToPosition(getLogicalPosition() + delta);
}

function moveRow(deltaRows) {
  if (!state.words.length || !state.rowWordIndices.length || !state.readingOrder.length) {
    return false;
  }

  const currentWordIndex = getCurrentWordIndex();
  const currentRow = getCurrentRowIndex();
  if (currentWordIndex === null || currentRow === null) {
    return false;
  }

  const targetRow = clamp(currentRow + deltaRows, 0, state.rowWordIndices.length - 1);
  if (targetRow === currentRow) {
    return false;
  }

  const targetWordIndex = selectClosestWordInRow({
    words: state.words,
    rowWordIndices: state.rowWordIndices,
    currentWordIndex,
    targetRowIndex: targetRow,
  });

  const targetPosition = state.sequenceByWordIndex[targetWordIndex];
  if (targetPosition === undefined || targetPosition < 0) {
    return false;
  }

  return moveCursorToPosition(targetPosition);
}

function resolveCursorPlacementPosition(cursorPlacement) {
  if (!state.readingOrder.length) {
    return 0;
  }

  const edge = cursorPlacement?.edge === "end" ? "end" : "start";
  const fallbackPosition = edge === "end"
    ? state.readingOrder.length - 1
    : 0;

  if (!state.rowWordIndices.length) {
    return fallbackPosition;
  }

  const rowIndex = edge === "end"
    ? state.rowWordIndices.length - 1
    : 0;
  const row = state.rowWordIndices[rowIndex] ?? [];
  if (!row.length) {
    return fallbackPosition;
  }

  let targetWordIndex = edge === "end"
    ? row[row.length - 1]
    : row[0];

  if (Number.isFinite(cursorPlacement?.preferredX)) {
    const preferredX = cursorPlacement.preferredX;
    targetWordIndex = row.reduce((bestIndex, candidateIndex) => {
      const candidateWord = state.words[candidateIndex];
      const bestWord = state.words[bestIndex];
      if (!candidateWord || !bestWord) {
        return bestIndex;
      }

      const candidateDistance = Math.abs(wordCenter(candidateWord).x - preferredX);
      const bestDistance = Math.abs(wordCenter(bestWord).x - preferredX);
      return candidateDistance < bestDistance ? candidateIndex : bestIndex;
    }, targetWordIndex);
  }

  const targetPosition = state.sequenceByWordIndex[targetWordIndex];
  if (targetPosition === undefined || targetPosition < 0) {
    return fallbackPosition;
  }

  return targetPosition;
}

function applyCursorPlacement(cursorPlacement) {
  if (!cursorPlacement || !state.readingOrder.length) {
    return;
  }

  setMotionToPosition(resolveCursorPlacementPosition(cursorPlacement));
}

function resetActiveSelection(releasePointerCapture = true) {
  const wasDragging = state.activeSelection.dragging;
  const pointerId = state.activeSelection.pointerId;

  state.activeSelection.dragging = false;
  state.activeSelection.pointerId = null;
  state.activeSelection.startPosition = -1;
  state.activeSelection.endPosition = -1;

  if (
    releasePointerCapture
    && wasDragging
    && pointerId !== null
    && dom.pdfCanvas.hasPointerCapture(pointerId)
  ) {
    dom.pdfCanvas.releasePointerCapture(pointerId);
  }
}

function setInteractionMode(mode) {
  if (state.pageLoading || state.highlightPersisting || state.savingFile) {
    updateHighlightControls();
    return;
  }

  const nextMode = resolveInteractionModeTransition({
    currentMode: state.interactionMode,
    requestedMode: mode,
    hasDocument: Boolean(state.pdfDoc),
  });

  if (nextMode === state.interactionMode) {
    updateHighlightControls();
    return;
  }

  state.interactionMode = nextMode;
  if (nextMode !== INTERACTION_MODES.HIGHLIGHT) {
    resetActiveSelection();
  }

  updateHighlightControls();
  updateStatusChip();
  redrawTriangle();
}

function getCanvasPointFromPointerEvent(event) {
  const bounds = dom.pdfCanvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    return null;
  }

  const x = ((event.clientX - bounds.left) * dom.pdfCanvas.width) / bounds.width;
  const y = ((event.clientY - bounds.top) * dom.pdfCanvas.height) / bounds.height;
  if (x < 0 || y < 0 || x > dom.pdfCanvas.width || y > dom.pdfCanvas.height) {
    return null;
  }

  return { x, y };
}

function findClosestWordIndexAtPoint(point) {
  if (!point || !state.words.length) {
    return null;
  }

  let bestWordIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = 0; index < state.words.length; index += 1) {
    const word = state.words[index];
    const dx = point.x < word.x0 ? word.x0 - point.x : point.x > word.x1 ? point.x - word.x1 : 0;
    const dy = point.y < word.y0 ? word.y0 - point.y : point.y > word.y1 ? point.y - word.y1 : 0;
    const score = dx + (dy * 1.2);

    if (score < bestScore) {
      bestScore = score;
      bestWordIndex = index;
    }
  }

  if (bestWordIndex < 0) {
    return null;
  }

  const threshold = Math.max(18, state.triangleSize.height * 1.25);
  return bestScore <= threshold ? bestWordIndex : null;
}

function bytesToArrayBuffer(bytes) {
  return bytes.slice(0).buffer;
}

async function reloadPdfDocumentAtCurrentPage() {
  if (!state.pdfBytes) {
    return;
  }

  const arrayBuffer = bytesToArrayBuffer(state.pdfBytes);
  state.pdfDoc = await loadPdfDocument(arrayBuffer);
  await renderPage(state.pageNumber);
}

async function runHighlightMutation(task) {
  state.highlightPersisting = true;
  updateHighlightControls();
  updateStatusChip();

  try {
    await task();
  } finally {
    state.highlightPersisting = false;
    updateHighlightControls();
    updateStatusChip();
  }
}

async function persistRangeHighlight(rects, colorHex) {
  if (!state.pdfBytes || !rects.length) {
    return;
  }

  await runHighlightMutation(async () => {
    const quadPoints = rects.map((rect) => {
      return viewRectToPdfQuad(rect, state.viewportInverseTransform);
    });

    state.pdfBytes = await addPdfHighlightAnnotation({
      pdfBytes: state.pdfBytes,
      pageNumber: state.pageNumber,
      quadPoints,
      colorHex,
    });
    await reloadPdfDocumentAtCurrentPage();
  });
}

async function finalizeSelectionAsHighlight() {
  if (!state.activeSelection.dragging) {
    return;
  }

  const { startPosition, endPosition } = state.activeSelection;
  resetActiveSelection();
  redrawTriangle();

  if (startPosition < 0 || endPosition < 0) {
    return;
  }

  const wordIndices = getWordIndicesForPositionRange({
    readingOrder: state.readingOrder,
    startPosition,
    endPosition,
  });
  const rects = buildRectsForWordIndices({
    wordIndices,
    words: state.words,
    wordRowIndex: state.wordRowIndex,
  });
  if (!rects.length) {
    return;
  }

  try {
    await persistRangeHighlight(rects, state.highlightColorHex);
  } catch (error) {
    window.alert(`Unable to embed highlight annotation in PDF: ${getErrorMessage(error)}`);
  }
}

async function eraseHighlightAtPoint(point) {
  if (!state.pdfBytes) {
    return;
  }

  await runHighlightMutation(async () => {
    const pdfPoint = viewPointToPdfPoint(point, state.viewportInverseTransform);
    const removed = await removePdfHighlightAnnotationAtPoint({
      pdfBytes: state.pdfBytes,
      pageNumber: state.pageNumber,
      x: pdfPoint.x,
      y: pdfPoint.y,
    });

    if (!removed.pdfBytes) {
      return;
    }
    if (!removed.removed) {
      return;
    }

    state.pdfBytes = removed.pdfBytes;
    await reloadPdfDocumentAtCurrentPage();
  });
}

function handleCanvasPointerDown(event) {
  if (
    !state.pdfDoc
    || state.pageLoading
    || state.highlightPersisting
    || state.savingFile
    || event.button !== 0
  ) {
    return;
  }

  const point = getCanvasPointFromPointerEvent(event);
  if (!point) {
    return;
  }

  if (state.interactionMode === INTERACTION_MODES.ERASE) {
    event.preventDefault();
    void eraseHighlightAtPoint(point).catch((error) => {
      window.alert(`Unable to erase highlight annotation: ${getErrorMessage(error)}`);
    });
    return;
  }

  if (!state.words.length) {
    return;
  }

  const wordIndex = findClosestWordIndexAtPoint(point);
  if (wordIndex === null) {
    return;
  }

  if (isNormalInteractionMode(state.interactionMode)) {
    event.preventDefault();
    moveCursorToWordIndex(wordIndex);
    return;
  }

  if (state.interactionMode !== INTERACTION_MODES.HIGHLIGHT) {
    return;
  }

  const position = state.sequenceByWordIndex[wordIndex];
  if (position === undefined || position < 0) {
    return;
  }

  event.preventDefault();
  state.activeSelection.dragging = true;
  state.activeSelection.pointerId = event.pointerId;
  state.activeSelection.startPosition = position;
  state.activeSelection.endPosition = position;

  dom.pdfCanvas.setPointerCapture(event.pointerId);
  redrawTriangle();
}

function handleCanvasPointerMove(event) {
  if (
    !state.activeSelection.dragging
    || state.activeSelection.pointerId !== event.pointerId
  ) {
    return;
  }

  const point = getCanvasPointFromPointerEvent(event);
  if (!point) {
    return;
  }

  const wordIndex = findClosestWordIndexAtPoint(point);
  if (wordIndex === null) {
    return;
  }

  const nextPosition = state.sequenceByWordIndex[wordIndex];
  if (nextPosition === undefined || nextPosition < 0) {
    return;
  }

  if (nextPosition === state.activeSelection.endPosition) {
    return;
  }

  state.activeSelection.endPosition = nextPosition;
  redrawTriangle();
}

function handleCanvasPointerCancel(event) {
  if (
    !state.activeSelection.dragging
    || state.activeSelection.pointerId !== event.pointerId
  ) {
    return;
  }

  resetActiveSelection();
  redrawTriangle();
}

function handleCanvasPointerUp(event) {
  if (
    !state.activeSelection.dragging
    || state.activeSelection.pointerId !== event.pointerId
  ) {
    return;
  }

  void finalizeSelectionAsHighlight();
}

async function savePdfToOriginalFile() {
  if (!state.pdfBytes || state.savingFile) {
    return;
  }

  state.savingFile = true;
  updateHighlightControls();
  updateStatusChip();

  try {
    const sourceName = dom.fileName.textContent?.trim() || "";
    const baseName = sourceName.toLowerCase().endsWith(".pdf")
      ? sourceName.slice(0, -4)
      : "document";
    const downloadName = `${baseName}-annotated.pdf`;

    const blob = new Blob([state.pdfBytes], { type: "application/pdf" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = downloadName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1500);
  } finally {
    state.savingFile = false;
    updateHighlightControls();
    updateStatusChip();
  }
}

async function openPdfWithSystemPicker() {
  if (typeof window.showOpenFilePicker !== "function") {
    dom.fileInput.click();
    return;
  }

  try {
    const [selectedHandle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: "PDF documents",
        accept: { "application/pdf": [".pdf"] },
      }],
    });
    if (!selectedHandle) {
      return;
    }

    const file = await selectedHandle.getFile();
    const arrayBuffer = await file.arrayBuffer();
    dom.fileName.textContent = file.name;
    await loadPdfFromArrayBuffer(arrayBuffer);
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }
    throw error;
  }
}

async function renderPage(pageNumber, { cursorPlacement = null } = {}) {
  if (!state.pdfDoc) {
    return;
  }
  const targetPageNumber = clamp(pageNumber, 1, state.pdfDoc.numPages);
  if (targetPageNumber !== state.pageNumber) {
    state.pageNumber = targetPageNumber;
  }

  const renderToken = ++pageRenderToken;
  resetActiveSelection();
  state.pageLoading = true;
  updateHighlightControls();
  updateStatusChip();

  try {
    const rendered = await renderPdfPage({
      pdfDoc: state.pdfDoc,
      pageNumber: targetPageNumber,
      viewerWidth: dom.viewerScroll.clientWidth,
      pdfCanvas: dom.pdfCanvas,
      overlayCanvas: dom.overlayCanvas,
    });

    if (renderToken !== pageRenderToken) {
      return;
    }

    setWords(rendered.words);
    applyCursorPlacement(cursorPlacement);
    state.overlayHighlightRects = flattenAnnotationRects(
      rendered.existingHighlightAnnotations ?? []
    );
    state.viewportInverseTransform = rendered.viewportInverseTransform ?? [1, 0, 0, 1, 0, 0];
    dom.viewerScroll.scrollTop = 0;
    redrawTriangle();
    hideEmptyHint();
    setPageStackVisible(true);
  } catch (error) {
    setEmptyHint(`Failed to render page ${targetPageNumber}: ${getErrorMessage(error)}`);
    setPageStackVisible(false);
    setWords([]);
    state.overlayHighlightRects = [];
    redrawTriangle();
  } finally {
    if (renderToken === pageRenderToken) {
      state.pageLoading = false;
      updateStatusChip();
      updatePlaybackButton();
      updateHighlightControls();
    }
  }
}

async function changePage(delta, { cursorPlacement = null } = {}) {
  if (!state.pdfDoc || state.pageLoading || state.highlightPersisting || state.savingFile) {
    return false;
  }

  const targetPage = clamp(
    state.pageNumber + delta,
    1,
    state.pdfDoc.numPages
  );

  if (targetPage === state.pageNumber) {
    return false;
  }

  state.pageNumber = targetPage;
  await renderPage(targetPage, { cursorPlacement });
  return true;
}

async function loadPdfFromArrayBuffer(arrayBuffer) {
  try {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) {
      throw new Error("The selected file is empty.");
    }

    state.pdfBytes = new Uint8Array(arrayBuffer.slice(0));
    state.savingFile = false;
    state.overlayHighlightRects = [];
    state.interactionMode = INTERACTION_MODES.NORMAL;
    resetActiveSelection();

    state.pageLoading = true;
    updateHighlightControls();
    updateStatusChip();

    state.pdfDoc = await loadPdfDocument(arrayBuffer);
    state.pageNumber = 1;
    state.running = true;
    setWords([]);

    updatePlaybackButton();
    await renderPage(state.pageNumber);
  } catch (error) {
    state.pdfDoc = null;
    state.pdfBytes = null;
    state.pageLoading = false;
    state.savingFile = false;
    setWords([]);
    state.overlayHighlightRects = [];
    state.interactionMode = INTERACTION_MODES.NORMAL;
    resetActiveSelection();

    redrawTriangle();
    setPageStackVisible(false);
    setEmptyHint(`Unable to load PDF. ${getErrorMessage(error)}`);

    updateStatusChip();
    updatePlaybackButton();
    updateHighlightControls();
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

async function moveCursorAcrossPageBoundary({ deltaPage, edge, preferredX = null }) {
  const cursorPlacement = {
    edge,
    preferredX: Number.isFinite(preferredX) ? preferredX : null,
  };

  await changePage(deltaPage, { cursorPlacement });
}

async function handleVerticalKey(event) {
  if (event.shiftKey) {
    setSpeed(state.wpm + (event.code === "ArrowUp" ? 20 : -20));
    return;
  }

  if (!isNormalInteractionMode(state.interactionMode)) {
    return;
  }

  const deltaRows = event.code === "ArrowUp" ? -1 : 1;
  if (moveRow(deltaRows) || !isAtRowBoundary(deltaRows)) {
    return;
  }

  const preferredX = getCurrentWordCenterX();
  await moveCursorAcrossPageBoundary({
    deltaPage: deltaRows > 0 ? 1 : -1,
    edge: deltaRows > 0 ? "start" : "end",
    preferredX,
  });
}

async function handleHorizontalKey(deltaWords) {
  if (!isNormalInteractionMode(state.interactionMode)) {
    return;
  }

  if (stepWord(deltaWords) || !isAtReadingBoundary(deltaWords)) {
    return;
  }

  await moveCursorAcrossPageBoundary({
    deltaPage: deltaWords > 0 ? 1 : -1,
    edge: deltaWords > 0 ? "start" : "end",
  });
}

function handleKeydown(event) {
  if (!state.pdfDoc || state.pageLoading || state.savingFile) {
    return;
  }

  if (
    state.interactionMode === INTERACTION_MODES.HIGHLIGHT
    && state.activeSelection.dragging
  ) {
    if (event.code.startsWith("Arrow")) {
      event.preventDefault();
    }
    return;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLInputElement && activeElement.type === "range") {
    return;
  }

  const basicHandlers = {
    Space: () => togglePlayback(),
    PageDown: () => {
      void changePage(1);
    },
    PageUp: () => {
      void changePage(-1);
    },
  };

  if (event.code === "ArrowUp" || event.code === "ArrowDown") {
    event.preventDefault();
    void handleVerticalKey(event);
    return;
  }

  if (event.code === "ArrowRight" || event.code === "ArrowLeft") {
    event.preventDefault();
    void handleHorizontalKey(event.code === "ArrowRight" ? 1 : -1);
    return;
  }

  const handler = basicHandlers[event.code];
  if (!handler) {
    return;
  }

  event.preventDefault();
  handler();
}

function cleanupOnUnload() {
  if (rerenderTimer !== null) {
    clearTimeout(rerenderTimer);
    rerenderTimer = null;
  }
  resetActiveSelection();
}

function bindEvents() {
  const eventController = new AbortController();
  const { signal } = eventController;
  const listen = (target, eventName, handler, options = {}) => {
    target.addEventListener(eventName, handler, {
      ...options,
      signal,
    });
  };

  listen(dom.uploadTrigger, "click", () => {
    void openPdfWithSystemPicker().catch((error) => {
      window.alert(`Unable to open PDF file: ${getErrorMessage(error)}`);
    });
  });

  listen(dom.backgroundColorInput, "input", (event) => {
    applyAppearance(event.target.value, appearance.state.themeHex);
  });

  listen(dom.themeColorInput, "input", (event) => {
    applyAppearance(appearance.state.backgroundHex, event.target.value);
  });

  listen(dom.appearanceResetButton, "click", () => {
    appearance.reset();
    if (state.words.length) {
      redrawTriangle();
    }
  });

  listen(dom.speedSlider, "input", (event) => {
    const nextWpm = Number(event.target.value);
    setSpeed(nextWpm, false);
  });

  listen(dom.togglePlayButton, "click", () => {
    if (!state.pdfDoc) {
      return;
    }
    togglePlayback();
  });

  listen(dom.toggleHighlightModeButton, "click", () => {
    setInteractionMode(INTERACTION_MODES.HIGHLIGHT);
  });

  listen(dom.toggleEraseModeButton, "click", () => {
    setInteractionMode(INTERACTION_MODES.ERASE);
  });

  listen(dom.highlightColorInput, "input", (event) => {
    state.highlightColorHex = event.target.value;
    if (state.activeSelection.dragging) {
      redrawTriangle();
    }
  });

  listen(dom.saveAnnotatedButton, "click", () => {
    void savePdfToOriginalFile().catch((error) => {
      window.alert(`Unable to save PDF file: ${getErrorMessage(error)}`);
    });
  });

  listen(dom.prevPageButton, "click", () => {
    void changePage(-1);
  });

  listen(dom.nextPageButton, "click", () => {
    void changePage(1);
  });

  listen(dom.fileInput, "change", (event) => {
    void onFileChanged(event);
  });

  listen(dom.pdfCanvas, "pointerdown", handleCanvasPointerDown);
  listen(dom.pdfCanvas, "pointermove", handleCanvasPointerMove);
  listen(dom.pdfCanvas, "pointerup", handleCanvasPointerUp);
  listen(dom.pdfCanvas, "pointercancel", handleCanvasPointerCancel);
  listen(dom.pdfCanvas, "lostpointercapture", () => {
    if (state.activeSelection.dragging) {
      resetActiveSelection(false);
      redrawTriangle();
    }
  });

  listen(window, "keydown", handleKeydown);
  listen(window, "resize", queuePageRerender);
  listen(window, "beforeunload", () => {
    cleanupOnUnload();
    eventController.abort();
  }, { once: true });
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
  dom.highlightColorInput.value = state.highlightColorHex;
  setSpeed(state.wpm);
  updatePlaybackButton();
  updateStatusChip();
  updateHighlightControls();
  bindEvents();
  window.requestAnimationFrame(tickFrame);
}

bootstrap();
