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
import {
  buildRowBounds,
  buildRowIndex,
  selectClosestWordInRow,
} from "./js/row-index.js";
import { drawReadingOverlay } from "./js/overlay-renderer.js";
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
import {
  normalizePaceMode,
  paceModeLabel,
  PACE_MODES,
} from "./js/state/pace-mode.js";

const dom = collectDom();
const overlayContext = dom.overlayCanvas.getContext("2d");
if (!overlayContext) {
  throw new Error("Unable to acquire overlay canvas context.");
}

const appearance = new AppearanceController({
  backgroundInput: dom.backgroundColorInput,
  themeInput: dom.themeColorInput,
});

const DEFAULT_VIEWPORT_INVERSE_TRANSFORM = [1, 0, 0, 1, 0, 0];
const NO_POSITION = -1;

const state = {
  pdfDoc: null,
  pdfBytes: null,
  savingFile: false,
  pageNumber: 1,
  words: [],
  rowWordIndices: [],
  rowBoundsByRow: [],
  wordRowIndex: [],
  readingOrder: [],
  sequenceByWordIndex: [],
  transitionWeights: [],
  running: true,
  pageLoading: false,
  interactionMode: INTERACTION_MODES.NORMAL,
  paceMode: PACE_MODES.TRIANGLE,
  highlightColorHex: "#fff176",
  highlightPersisting: false,
  overlayHighlightRects: [],
  activeSelection: {
    dragging: false,
    pointerId: null,
    startPosition: NO_POSITION,
    endPosition: NO_POSITION,
  },
  viewportInverseTransform: DEFAULT_VIEWPORT_INVERSE_TRANSFORM,
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
let launcherHeartbeatId = null;

const LAUNCHER_HEARTBEAT_PATH = "/__launcher_heartbeat";
const LAUNCHER_SHUTDOWN_PATH = "/__launcher_shutdown";
const LAUNCHER_HEARTBEAT_INTERVAL_MS = 2000;

function isLauncherManagedPage() {
  if (window.location.protocol !== "http:") {
    return false;
  }

  const host = window.location.hostname;
  return host === "127.0.0.1" || host === "localhost";
}

function sendLauncherSignal(path, keepalive = false) {
  if (!isLauncherManagedPage()) {
    return;
  }

  void fetch(path, {
    method: "POST",
    cache: "no-store",
    keepalive,
  }).catch(() => {});
}

function startLauncherHeartbeat() {
  if (!isLauncherManagedPage() || launcherHeartbeatId !== null) {
    return;
  }

  sendLauncherSignal(LAUNCHER_HEARTBEAT_PATH, true);
  launcherHeartbeatId = window.setInterval(() => {
    sendLauncherSignal(LAUNCHER_HEARTBEAT_PATH);
  }, LAUNCHER_HEARTBEAT_INTERVAL_MS);
}

function stopLauncherHeartbeat() {
  if (launcherHeartbeatId !== null) {
    clearInterval(launcherHeartbeatId);
    launcherHeartbeatId = null;
  }
  sendLauncherSignal(LAUNCHER_SHUTDOWN_PATH, true);
}

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

function alertError(prefix, error) {
  window.alert(`${prefix}: ${getErrorMessage(error)}`);
}

function runAsync(task, errorPrefix) {
  void task().catch((error) => {
    alertError(errorPrefix, error);
  });
}

function syncUi() {
  updateStatusChip();
  updatePlaybackButton();
  updateHighlightControls();
  updatePaceModeControls();
  updatePageNavigationControls();
}

function isBusy() {
  return state.pageLoading || state.highlightPersisting || state.savingFile;
}

function getPositionForWordIndex(wordIndex) {
  const position = state.sequenceByWordIndex[wordIndex];
  return position === undefined || position < 0 ? null : position;
}

function getRectsForPositionRange(startPosition, endPosition) {
  const wordIndices = getWordIndicesForPositionRange({
    readingOrder: state.readingOrder,
    startPosition,
    endPosition,
  });
  return buildRectsForWordIndices({
    wordIndices,
    words: state.words,
    wordRowIndex: state.wordRowIndex,
  });
}

function isSelectionPointerEvent(event) {
  return (
    state.activeSelection.dragging
    && state.activeSelection.pointerId === event.pointerId
  );
}

async function runWithUiFlag(flagName, task) {
  state[flagName] = true;
  syncUi();
  try {
    await task();
  } finally {
    state[flagName] = false;
    syncUi();
  }
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
          syncUi();
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
    }
  }

  return moved;
}

function getIndicatorMotion() {
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
    fromWordIndex,
    toWordIndex,
    progress,
    pointer: {
      x: lerp(fromCenter.x, toCenter.x, progress),
      y0: lerp(fromWord.y0, toWord.y0, progress),
      y1: lerp(fromWord.y1, toWord.y1, progress),
    },
  };
}

function updatePlaybackButton() {
  dom.togglePlayButton.textContent = state.running ? "Pause" : "Resume";
}

function updatePageNavigationControls() {
  const hasDocument = Boolean(state.pdfDoc);
  const busy = isBusy();

  dom.pageNumberInput.disabled = !hasDocument || busy;
  dom.goToPageButton.disabled = !hasDocument || busy;
  dom.prevPageButton.disabled = !hasDocument || busy || state.pageNumber <= 1;
  dom.nextPageButton.disabled = !hasDocument || busy || state.pageNumber >= state.pdfDoc.numPages;

  if (!hasDocument) {
    dom.pageNumberInput.value = "";
    dom.pageNumberInput.removeAttribute("max");
    dom.pageNumberInput.placeholder = "Page #";
    return;
  }

  dom.pageNumberInput.max = String(state.pdfDoc.numPages);
  dom.pageNumberInput.placeholder = `1-${state.pdfDoc.numPages}`;

  if (document.activeElement !== dom.pageNumberInput) {
    dom.pageNumberInput.value = String(state.pageNumber);
  }
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
    : ` | ${interactionModeLabel(state.interactionMode)} | ${paceModeLabel(state.paceMode)}`;
  dom.statusChip.textContent = `${mode}  |  ${pageText}${modeText}`;
  dom.statusChip.classList.toggle("is-playing", mode === "Playing");
  dom.statusChip.classList.toggle("is-paused", mode === "Paused");
}

function updateHighlightControls() {
  const busy = isBusy();
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

function updatePaceModeControls() {
  dom.paceModeSelect.value = state.paceMode;
  dom.paceModeSelect.disabled = state.pageLoading;
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
  syncUi();
}

function setPaceMode(nextMode, syncSelect = true) {
  const normalized = normalizePaceMode(nextMode);

  if (normalized === state.paceMode) {
    if (syncSelect && dom.paceModeSelect.value !== normalized) {
      dom.paceModeSelect.value = normalized;
    }
    return;
  }

  state.paceMode = normalized;
  if (syncSelect && dom.paceModeSelect.value !== normalized) {
    dom.paceModeSelect.value = normalized;
  }

  redrawOverlay();
  syncUi();
}

function buildSelectionOverlayRects() {
  if (!state.activeSelection.dragging) {
    return [];
  }

  const { startPosition, endPosition } = state.activeSelection;
  if (startPosition === NO_POSITION || endPosition === NO_POSITION) {
    return [];
  }

  return getRectsForPositionRange(startPosition, endPosition).map((rect) => ({
    ...rect,
    fillStyle: colorToRgba(state.highlightColorHex, 0.25),
    strokeStyle: colorToRgba(state.highlightColorHex, 0.7),
  }));
}

function redrawOverlay() {
  drawReadingOverlay({
    overlayContext,
    overlayCanvas: dom.overlayCanvas,
    viewerScroll: dom.viewerScroll,
    pageStack: dom.pageStack,
    words: state.words,
    paceMode: state.paceMode,
    indicatorMotion: getIndicatorMotion(),
    wordRowIndex: state.wordRowIndex,
    rowBoundsByRow: state.rowBoundsByRow,
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
  state.rowBoundsByRow = buildRowBounds(words, state.rowWordIndices);

  state.readingOrder = buildReadingOrder(words, state.rowWordIndices);
  state.sequenceByWordIndex = new Array(words.length).fill(NO_POSITION);
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
  setMotionToPosition(0);
}

function resetInteractionState() {
  state.interactionMode = INTERACTION_MODES.NORMAL;
  state.overlayHighlightRects = [];
  resetActiveSelection();
}

function getCurrentWordIndex() {
  return state.readingOrder.length
    ? getWordIndexAtPosition(getLogicalPosition())
    : null;
}

function getCurrentRowIndex() {
  const currentWordIndex = getCurrentWordIndex();
  if (currentWordIndex === null) {
    return null;
  }

  const currentRow = state.wordRowIndex[currentWordIndex];
  return currentRow === undefined || currentRow < 0 ? null : currentRow;
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
  redrawOverlay();
  return true;
}

function moveCursorToWordIndex(wordIndex) {
  const targetPosition = getPositionForWordIndex(wordIndex);
  if (targetPosition === null) {
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
  syncUi();
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

  const targetPosition = getPositionForWordIndex(targetWordIndex);
  if (targetPosition === null) {
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

  const targetPosition = getPositionForWordIndex(targetWordIndex);
  if (targetPosition === null) {
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
  state.activeSelection.startPosition = NO_POSITION;
  state.activeSelection.endPosition = NO_POSITION;

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
  if (isBusy()) {
    syncUi();
    return;
  }

  const nextMode = resolveInteractionModeTransition({
    currentMode: state.interactionMode,
    requestedMode: mode,
    hasDocument: Boolean(state.pdfDoc),
  });

  if (nextMode === state.interactionMode) {
    syncUi();
    return;
  }

  state.interactionMode = nextMode;
  if (nextMode !== INTERACTION_MODES.HIGHLIGHT) {
    resetActiveSelection();
  }

  syncUi();
  redrawOverlay();
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

async function reloadPdfDocumentAtCurrentPage() {
  if (!state.pdfBytes) {
    return;
  }

  state.pdfDoc = await loadPdfDocument(state.pdfBytes.slice(0).buffer);
  await renderPage(state.pageNumber);
}

async function persistRangeHighlight(rects, colorHex) {
  if (!state.pdfBytes || !rects.length) {
    return;
  }

  await runWithUiFlag("highlightPersisting", async () => {
    const quadPoints = rects.map((rect) => viewRectToPdfQuad(rect, state.viewportInverseTransform));

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
  redrawOverlay();

  if (startPosition === NO_POSITION || endPosition === NO_POSITION) {
    return;
  }

  const rects = getRectsForPositionRange(startPosition, endPosition);
  if (!rects.length) {
    return;
  }

  try {
    await persistRangeHighlight(rects, state.highlightColorHex);
  } catch (error) {
    alertError("Unable to embed highlight annotation in PDF", error);
  }
}

async function eraseHighlightAtPoint(point) {
  if (!state.pdfBytes) {
    return;
  }

  await runWithUiFlag("highlightPersisting", async () => {
    const pdfPoint = viewPointToPdfPoint(point, state.viewportInverseTransform);
    const removed = await removePdfHighlightAnnotationAtPoint({
      pdfBytes: state.pdfBytes,
      pageNumber: state.pageNumber,
      x: pdfPoint.x,
      y: pdfPoint.y,
    });

    if (!removed.pdfBytes || !removed.removed) {
      return;
    }

    state.pdfBytes = removed.pdfBytes;
    await reloadPdfDocumentAtCurrentPage();
  });
}

function handleCanvasPointerDown(event) {
  if (
    !state.pdfDoc
    || isBusy()
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
    runAsync(
      () => eraseHighlightAtPoint(point),
      "Unable to erase highlight annotation"
    );
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

  const position = getPositionForWordIndex(wordIndex);
  if (position === null) {
    return;
  }

  event.preventDefault();
  state.activeSelection.dragging = true;
  state.activeSelection.pointerId = event.pointerId;
  state.activeSelection.startPosition = position;
  state.activeSelection.endPosition = position;

  dom.pdfCanvas.setPointerCapture(event.pointerId);
  redrawOverlay();
}

function handleCanvasPointerMove(event) {
  if (!isSelectionPointerEvent(event)) {
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

  const nextPosition = getPositionForWordIndex(wordIndex);
  if (nextPosition === null) {
    return;
  }

  if (nextPosition === state.activeSelection.endPosition) {
    return;
  }

  state.activeSelection.endPosition = nextPosition;
  redrawOverlay();
}

function handleCanvasPointerCancel(event) {
  if (!isSelectionPointerEvent(event)) {
    return;
  }

  resetActiveSelection();
  redrawOverlay();
}

function handleCanvasPointerUp(event) {
  if (!isSelectionPointerEvent(event)) {
    return;
  }

  void finalizeSelectionAsHighlight();
}

async function savePdfToOriginalFile() {
  if (!state.pdfBytes || state.savingFile) {
    return;
  }

  await runWithUiFlag("savingFile", async () => {
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
  });
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
  syncUi();

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
    state.viewportInverseTransform =
      rendered.viewportInverseTransform ?? DEFAULT_VIEWPORT_INVERSE_TRANSFORM;
    dom.viewerScroll.scrollTop = 0;
    redrawOverlay();
    hideEmptyHint();
    setPageStackVisible(true);
  } catch (error) {
    setEmptyHint(`Failed to render page ${targetPageNumber}: ${getErrorMessage(error)}`);
    setPageStackVisible(false);
    setWords([]);
    state.overlayHighlightRects = [];
    redrawOverlay();
  } finally {
    if (renderToken === pageRenderToken) {
      state.pageLoading = false;
      syncUi();
    }
  }
}

async function goToPage(pageNumber, { cursorPlacement = null } = {}) {
  if (!state.pdfDoc || isBusy()) {
    return false;
  }

  const targetPage = clamp(pageNumber, 1, state.pdfDoc.numPages);

  if (targetPage === state.pageNumber) {
    return false;
  }

  state.pageNumber = targetPage;
  await renderPage(targetPage, { cursorPlacement });
  return true;
}

async function changePage(delta, { cursorPlacement = null } = {}) {
  if (!state.pdfDoc) {
    return false;
  }

  return goToPage(state.pageNumber + delta, { cursorPlacement });
}

async function goToSelectedPage() {
  if (!state.pdfDoc || isBusy()) {
    return false;
  }

  const rawValue = dom.pageNumberInput.value.trim();
  if (!rawValue) {
    dom.pageNumberInput.value = String(state.pageNumber);
    return false;
  }
  const selectedPage = /^\d+$/.test(rawValue)
    ? Number.parseInt(rawValue, 10)
    : Number.NaN;
  if (!Number.isInteger(selectedPage) || selectedPage < 1) {
    window.alert(`Enter a valid page number between 1 and ${state.pdfDoc.numPages}.`);
    dom.pageNumberInput.focus();
    dom.pageNumberInput.select();
    return false;
  }

  const changed = await goToPage(selectedPage);
  dom.pageNumberInput.value = String(state.pageNumber);
  return changed;
}

async function loadPdfFromArrayBuffer(arrayBuffer) {
  try {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) {
      throw new Error("The selected file is empty.");
    }

    state.pdfBytes = new Uint8Array(arrayBuffer.slice(0));
    state.savingFile = false;
    resetInteractionState();

    state.pageLoading = true;
    syncUi();

    state.pdfDoc = await loadPdfDocument(arrayBuffer);
    state.pageNumber = 1;
    state.running = true;
    setWords([]);

    syncUi();
    await renderPage(state.pageNumber);
  } catch (error) {
    state.pdfDoc = null;
    state.pdfBytes = null;
    state.pageLoading = false;
    state.savingFile = false;
    setWords([]);
    resetInteractionState();

    redrawOverlay();
    setPageStackVisible(false);
    setEmptyHint(`Unable to load PDF. ${getErrorMessage(error)}`);

    syncUi();
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
    redrawOverlay();
  }
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

  const currentWordIndex = getCurrentWordIndex();
  const currentWord = currentWordIndex === null ? null : state.words[currentWordIndex];
  const preferredX = currentWord ? wordCenter(currentWord).x : null;
  await changePage(deltaRows > 0 ? 1 : -1, {
    cursorPlacement: {
      edge: deltaRows > 0 ? "start" : "end",
      preferredX: Number.isFinite(preferredX) ? preferredX : null,
    },
  });
}

async function handleHorizontalKey(deltaWords) {
  if (!isNormalInteractionMode(state.interactionMode)) {
    return;
  }

  if (stepWord(deltaWords) || !isAtReadingBoundary(deltaWords)) {
    return;
  }

  await changePage(deltaWords > 0 ? 1 : -1, {
    cursorPlacement: {
      edge: deltaWords > 0 ? "start" : "end",
      preferredX: null,
    },
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
  if (
    activeElement instanceof HTMLInputElement
    || activeElement instanceof HTMLTextAreaElement
    || activeElement instanceof HTMLSelectElement
    || activeElement?.isContentEditable
  ) {
    return;
  }

  switch (event.code) {
    case "ArrowUp":
    case "ArrowDown":
      event.preventDefault();
      void handleVerticalKey(event);
      break;
    case "ArrowRight":
    case "ArrowLeft":
      event.preventDefault();
      void handleHorizontalKey(event.code === "ArrowRight" ? 1 : -1);
      break;
    case "Space":
      event.preventDefault();
      togglePlayback();
      break;
    case "PageDown":
      event.preventDefault();
      void changePage(1);
      break;
    case "PageUp":
      event.preventDefault();
      void changePage(-1);
      break;
    default:
      break;
  }
}

function cleanupOnUnload() {
  if (rerenderTimer !== null) {
    clearTimeout(rerenderTimer);
    rerenderTimer = null;
  }
  stopLauncherHeartbeat();
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
  const listenAsync = (target, eventName, task, errorPrefix, options = {}) => {
    listen(target, eventName, (event) => {
      runAsync(() => task(event), errorPrefix);
    }, options);
  };

  listenAsync(
    dom.uploadTrigger,
    "click",
    () => openPdfWithSystemPicker(),
    "Unable to open PDF file"
  );

  listen(dom.backgroundColorInput, "input", (event) => {
    applyAppearance(event.target.value, appearance.state.themeHex);
  });

  listen(dom.themeColorInput, "input", (event) => {
    applyAppearance(appearance.state.backgroundHex, event.target.value);
  });

  listen(dom.appearanceResetButton, "click", () => {
    appearance.reset();
    if (state.words.length) {
      redrawOverlay();
    }
  });

  listen(dom.speedSlider, "input", (event) => {
    const nextWpm = Number(event.target.value);
    setSpeed(nextWpm, false);
  });

  listen(dom.paceModeSelect, "change", (event) => {
    setPaceMode(event.target.value, false);
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
      redrawOverlay();
    }
  });

  listenAsync(
    dom.saveAnnotatedButton,
    "click",
    () => savePdfToOriginalFile(),
    "Unable to save PDF file"
  );

  listen(dom.prevPageButton, "click", () => {
    void changePage(-1);
  });

  listen(dom.nextPageButton, "click", () => {
    void changePage(1);
  });

  listen(dom.goToPageButton, "click", () => {
    void goToSelectedPage();
  });

  listen(dom.pageNumberInput, "keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void goToSelectedPage();
  });

  listen(dom.pageNumberInput, "blur", () => {
    if (!state.pdfDoc) {
      return;
    }
    dom.pageNumberInput.value = String(state.pageNumber);
  });

  listenAsync(dom.fileInput, "change", onFileChanged, "Unable to load PDF file");

  listen(dom.pdfCanvas, "pointerdown", handleCanvasPointerDown);
  listen(dom.pdfCanvas, "pointermove", handleCanvasPointerMove);
  listen(dom.pdfCanvas, "pointerup", handleCanvasPointerUp);
  listen(dom.pdfCanvas, "pointercancel", handleCanvasPointerCancel);
  listen(dom.pdfCanvas, "lostpointercapture", () => {
    if (state.activeSelection.dragging) {
      resetActiveSelection(false);
      redrawOverlay();
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
      redrawOverlay();
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
  dom.paceModeSelect.value = state.paceMode;
  setSpeed(state.wpm);
  syncUi();
  startLauncherHeartbeat();
  bindEvents();
  window.requestAnimationFrame(tickFrame);
}

bootstrap();
