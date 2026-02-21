export const INTERACTION_MODES = Object.freeze({
  NORMAL: "normal",
  HIGHLIGHT: "highlight",
  ERASE: "erase",
});

const VALID_MODES = new Set(Object.values(INTERACTION_MODES));

export function isValidInteractionMode(mode) {
  return VALID_MODES.has(mode);
}

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

  const normalizedMode = isValidInteractionMode(requestedMode)
    ? requestedMode
    : INTERACTION_MODES.NORMAL;

  // Clicking the same mode button exits back to normal mode.
  return currentMode === normalizedMode
    ? INTERACTION_MODES.NORMAL
    : normalizedMode;
}

export function interactionModeLabel(mode) {
  if (mode === INTERACTION_MODES.HIGHLIGHT) {
    return "Highlight mode";
  }
  if (mode === INTERACTION_MODES.ERASE) {
    return "Erase mode";
  }
  return "Normal mode";
}
