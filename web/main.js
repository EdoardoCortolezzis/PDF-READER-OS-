import { AppearanceController } from "./js/appearance.js";
import {
  APPEARANCE_DEFAULTS,
  MAX_CATCH_UP_STEPS,
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
  running: true,
  pageLoading: false,
  wpm: READER_LIMITS.defaultWpm,
  minWpm: READER_LIMITS.minWpm,
  maxWpm: READER_LIMITS.maxWpm,
  msPerWord: Math.round(60_000 / READER_LIMITS.defaultWpm),
  nextWordDue: performance.now() + Math.round(60_000 / READER_LIMITS.defaultWpm),
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

function resetWordTimer() {
  state.nextWordDue = performance.now() + state.msPerWord;
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

  resetWordTimer();
  updateStatusChip();
}

function redrawTriangle() {
  drawTriangle({
    overlayContext,
    overlayCanvas: dom.overlayCanvas,
    viewerScroll: dom.viewerScroll,
    pageStack: dom.pageStack,
    words: state.words,
    wordIndex: state.wordIndex,
    themeRgb: appearance.state.themeRgb,
  });
  updateStatusChip();
}

function setWords(words) {
  state.words = words;
  state.wordIndex = 0;

  const rowIndex = buildRowIndex(words);
  state.rowWordIndices = rowIndex.rowWordIndices;
  state.wordRowIndex = rowIndex.wordRowIndex;
}

function togglePlayback() {
  state.running = !state.running;
  if (state.running) {
    resetWordTimer();
  }

  updatePlaybackButton();
  updateStatusChip();
}

function stepWord(delta) {
  if (!state.words.length) {
    return;
  }

  state.wordIndex = clamp(state.wordIndex + delta, 0, state.words.length - 1);
  redrawTriangle();
  resetWordTimer();
}

function moveRow(deltaRows) {
  if (!state.words.length || !state.rowWordIndices.length) {
    return;
  }

  const currentRow = state.wordRowIndex[state.wordIndex];
  if (currentRow === undefined || currentRow < 0) {
    return;
  }

  const targetRow = clamp(currentRow + deltaRows, 0, state.rowWordIndices.length - 1);
  if (targetRow === currentRow) {
    return;
  }

  state.wordIndex = selectClosestWordInRow({
    words: state.words,
    rowWordIndices: state.rowWordIndices,
    currentWordIndex: state.wordIndex,
    targetRowIndex: targetRow,
  });

  redrawTriangle();
  resetWordTimer();
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
    resetWordTimer();
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
  if (state.running && state.words.length && !state.pageLoading) {
    let steps = 0;

    while (now >= state.nextWordDue && steps < MAX_CATCH_UP_STEPS && state.running) {
      state.nextWordDue += state.msPerWord;
      steps += 1;

      if (state.wordIndex < state.words.length - 1) {
        state.wordIndex += 1;
        redrawTriangle();
        continue;
      }

      if (state.pdfDoc && state.pageNumber < state.pdfDoc.numPages) {
        void changePage(1);
        break;
      }

      state.running = false;
      updatePlaybackButton();
      updateStatusChip();
    }

    if (steps === MAX_CATCH_UP_STEPS && now >= state.nextWordDue) {
      resetWordTimer();
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
