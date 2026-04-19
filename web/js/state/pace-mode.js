export const PACE_MODES = Object.freeze({
  TRIANGLE: "triangle",
  DROPDOWN_BOOKMARK: "drop-down-bookmark",
});

const PACE_MODE_LABELS = Object.freeze({
  [PACE_MODES.TRIANGLE]: "Sliding triangle",
  [PACE_MODES.DROPDOWN_BOOKMARK]: "Drop-down bookmark",
});

export function normalizePaceMode(mode) {
  return PACE_MODE_LABELS[mode]
    ? mode
    : PACE_MODES.TRIANGLE;
}

export function paceModeLabel(mode) {
  return PACE_MODE_LABELS[mode] ?? PACE_MODE_LABELS[PACE_MODES.TRIANGLE];
}
