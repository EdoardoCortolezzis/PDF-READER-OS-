function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing DOM element: #${id}`);
  }
  return element;
}

export function collectDom() {
  return {
    fileInput: requiredElement("pdf-file"),
    uploadTrigger: requiredElement("upload-trigger"),
    fileName: requiredElement("file-name"),
    backgroundColorInput: requiredElement("background-color"),
    themeColorInput: requiredElement("theme-color"),
    appearanceResetButton: requiredElement("appearance-reset"),
    speedSlider: requiredElement("speed-slider"),
    speedValue: requiredElement("speed-value"),
    paceModeSelect: requiredElement("pace-mode"),
    togglePlayButton: requiredElement("toggle-play"),
    toggleHighlightModeButton: requiredElement("toggle-highlight-mode"),
    toggleEraseModeButton: requiredElement("toggle-erase-mode"),
    highlightColorInput: requiredElement("highlight-color"),
    saveAnnotatedButton: requiredElement("save-annotated"),
    prevPageButton: requiredElement("prev-page"),
    nextPageButton: requiredElement("next-page"),
    pageNumberInput: requiredElement("page-number-input"),
    goToPageButton: requiredElement("go-to-page"),
    statusChip: requiredElement("status-chip"),
    viewerScroll: requiredElement("viewer-scroll"),
    pageStack: requiredElement("page-stack"),
    emptyHint: requiredElement("empty-hint"),
    pdfCanvas: requiredElement("pdf-canvas"),
    overlayCanvas: requiredElement("overlay-canvas"),
  };
}
