import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_STORAGE_KEY,
} from "./constants.js";
import {
  darkenRgb,
  hexToRgb,
  lightenRgb,
  mixRgb,
  rgbToCss,
} from "./utils.js";

export class AppearanceController {
  constructor({ backgroundInput, themeInput }) {
    this.backgroundInput = backgroundInput;
    this.themeInput = themeInput;

    this.state = {
      backgroundHex: APPEARANCE_DEFAULTS.backgroundHex,
      themeHex: APPEARANCE_DEFAULTS.themeHex,
      themeRgb: hexToRgb(APPEARANCE_DEFAULTS.themeHex),
    };
  }

  loadSaved() {
    try {
      const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const backgroundHex = String(parsed.backgroundHex ?? "");
      const themeHex = String(parsed.themeHex ?? "");
      if (!hexToRgb(backgroundHex) || !hexToRgb(themeHex)) {
        return null;
      }

      return { backgroundHex, themeHex };
    } catch {
      return null;
    }
  }

  apply(backgroundHex, themeHex, persist = true) {
    const nextBackgroundHex = hexToRgb(backgroundHex)
      ? backgroundHex
      : this.state.backgroundHex;
    const nextThemeHex = hexToRgb(themeHex) ? themeHex : this.state.themeHex;

    const backgroundRgb = hexToRgb(nextBackgroundHex);
    const themeRgb = hexToRgb(nextThemeHex);
    if (!backgroundRgb || !themeRgb) {
      return this.state;
    }

    const rootStyle = document.documentElement.style;

    const bgDeep = darkenRgb(backgroundRgb, 0.62);
    const bgMid = darkenRgb(backgroundRgb, 0.42);
    const bgSoft = mixRgb(darkenRgb(backgroundRgb, 0.22), themeRgb, 0.14);
    const sliderAccent = lightenRgb(themeRgb, 0.08);

    rootStyle.setProperty("--bg-deep", rgbToCss(bgDeep));
    rootStyle.setProperty("--bg-mid", rgbToCss(bgMid));
    rootStyle.setProperty("--bg-soft", rgbToCss(bgSoft));
    rootStyle.setProperty("--theme-rgb", `${themeRgb.r}, ${themeRgb.g}, ${themeRgb.b}`);
    rootStyle.setProperty("--slider-accent", rgbToCss(sliderAccent));

    this.state = {
      backgroundHex: nextBackgroundHex,
      themeHex: nextThemeHex,
      themeRgb,
    };

    this.backgroundInput.value = nextBackgroundHex;
    this.themeInput.value = nextThemeHex;

    if (persist) {
      this.persist();
    }

    return this.state;
  }

  reset() {
    return this.apply(APPEARANCE_DEFAULTS.backgroundHex, APPEARANCE_DEFAULTS.themeHex);
  }

  persist() {
    try {
      localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify({
          backgroundHex: this.state.backgroundHex,
          themeHex: this.state.themeHex,
        })
      );
    } catch {
      // Ignore storage errors (private mode or quota issues).
    }
  }
}
