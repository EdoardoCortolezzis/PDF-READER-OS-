export const INTERACTION_MODES = Object.freeze({
  NORMAL: "normal",
  HIGHLIGHT: "highlight",
  ERASE: "erase",
});

const MODE_LABELS = Object.freeze({
  [INTERACTION_MODES.NORMAL]: "Normal mode",
  [INTERACTION_MODES.HIGHLIGHT]: "Highlight mode",
  [INTERACTION_MODES.ERASE]: "Erase mode",
});

export function isNormalInteractionMode(mode) {
  return mode === INTERACTION_MODES.NORMAL;
}

export function resolveInteractionModeTransition({
  currentMode,
  requestedMode,
  hasDocument,
}) {
  if (!hasDocument) {
    return INTERACTION_MODES.NORMAL;
  }

  const normalizedMode = MODE_LABELS[requestedMode]
    ? requestedMode
    : INTERACTION_MODES.NORMAL;

  // Clicking the same mode button exits back to normal mode.
  return currentMode === normalizedMode
    ? INTERACTION_MODES.NORMAL
    : normalizedMode;
}

export function interactionModeLabel(mode) {
  return MODE_LABELS[mode] ?? MODE_LABELS[INTERACTION_MODES.NORMAL];
}
