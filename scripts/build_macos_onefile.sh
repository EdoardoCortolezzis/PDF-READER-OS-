#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="PDF Reading Pacer"
ENTRYPOINT="pdf_reading_pacer/__main__.py"
ICON_PNG="$ROOT_DIR/app_logo.png"
if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
else
  PYTHON_BIN="python3"
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This build script only supports macOS."
  exit 1
fi

if [[ ! -f "$ICON_PNG" ]]; then
  echo "Missing icon: $ICON_PNG"
  exit 1
fi

if ! "$PYTHON_BIN" -m pip show pyinstaller >/dev/null 2>&1; then
  echo "PyInstaller is not installed for $PYTHON_BIN."
  echo "Install with: $PYTHON_BIN -m pip install pyinstaller"
  exit 1
fi

export PYINSTALLER_CONFIG_DIR="$ROOT_DIR/.pyinstaller"
export PYTHONNOUSERSITE=1
mkdir -p "$PYINSTALLER_CONFIG_DIR"
echo "Using Python: $PYTHON_BIN"

"$PYTHON_BIN" -m PyInstaller \
  --noconfirm \
  --clean \
  --onedir \
  --windowed \
  --name "$APP_NAME" \
  --icon "$ICON_PNG" \
  --add-data "$ROOT_DIR/web:web" \
  "$ENTRYPOINT"

echo
echo "Build complete."
echo "Bundle directory:"
echo "  - dist/$APP_NAME"
echo "Double-click app wrapper:"
echo "  - dist/$APP_NAME.app"
