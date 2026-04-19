# PDF Reading Pacer

JavaScript-based PDF reader UI (`web/`) with a small Python launcher for local/dev usage and macOS packaging.

## Demo Video
[![Watch on YouTube](https://img.youtube.com/vi/5xONcDRI2Ho/hqdefault.jpg)](https://youtu.be/5xONcDRI2Ho)

## Project Structure

```text
.
|-- pdf_reading_pacer/
|   |-- __init__.py
|   |-- __main__.py
|   `-- app.py
|-- web/
|   |-- js/
|   |   |-- annotations/
|   |   |   `-- geometry.js
|   |   |-- reader/
|   |   |   `-- motion.js
|   |   |-- state/
|   |   |   |-- interaction-mode.js
|   |   |   `-- pace-mode.js
|   |   |-- appearance.js
|   |   |-- bookmark-renderer.js
|   |   |-- constants.js
|   |   |-- dom.js
|   |   |-- overlay-renderer.js
|   |   |-- pdf-service.js
|   |   |-- row-index.js
|   |   |-- triangle-renderer.js
|   |   `-- utils.js
|   |-- index.html
|   |-- main.js
|   `-- styles.css
|-- scripts/
|   `-- build_macos_onefile.sh
|-- tests/
|   `-- test_app_launcher.py
|-- pdf_reading_pacer.py
|-- requirements.txt
|-- requirements-dev.txt
`-- pyproject.toml
```

## Requirements

- Python `3.10+`

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

Optional editable install:

```bash
pip install -e .
```

## Run Launcher

Opens the JavaScript UI in your default browser.
The launcher starts a temporary local server (localhost) for the `web/` folder:

```bash
python -m pdf_reading_pacer
```

Closing the launched webpage/tab will stop the launcher process automatically.

Equivalent wrapper:

```bash
python pdf_reading_pacer.py
```

Options:

```bash
python -m pdf_reading_pacer --print-url --no-open
```

Advanced options:

```bash
python -m pdf_reading_pacer --host 127.0.0.1 --port 0 --idle-shutdown-seconds 120 --startup-timeout-seconds 20
```

## Run Web App via Local Server (optional)

From repository root:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/web/
```

## Build macOS Clickable App (Onedir)

Build with PyInstaller and custom icon from `app_logo.png`:

```bash
./scripts/build_macos_onefile.sh
```

Outputs:

```text
dist/PDF Reading Pacer
dist/PDF Reading Pacer.app
```

You can copy either output anywhere on your Mac:

- `dist/PDF Reading Pacer`: unpacked runtime bundle directory.
- `dist/PDF Reading Pacer.app`: app wrapper you can launch by double-clicking.

## Interaction Modes (Web)

- `Normal`: default mode; clicking a word moves the cursor there.
- `Highlight`: click-drag across words to create highlight annotations.
- `Erase`: click an existing highlight area to remove one annotation.

Mode behavior:

- Only one mode is active at a time.
- Clicking the currently active mode button returns to `Normal`.
- Mode switching is blocked while the app is loading/saving/applying annotation edits.

## Pace Markers (Web)

- `Sliding triangle`: existing word-following triangle marker.
- `Drop-down bookmark`: a horizontal bookmark bar that sits on the current text line and animates to the next line with a left tilt, right tilt, then settle.

Marker behavior:

- Pace marker selection is independent from interaction mode (`Normal` / `Highlight` / `Erase`).
- The selected pace marker is shown in the status chip while a PDF is loaded.

## Save Behavior (Web)

- `Save PDF` downloads a new file named `*-annotated.pdf`.
- Save does not modify the original source file in place.
- Embedded highlights/erasures are written into the downloaded PDF bytes.

## Controls

- `Space`: pause/resume playback
- `Left/Right`: move one word backward/forward
- `Up/Down`: move to previous/next text row
- `Shift+Up/Shift+Down`: increase/decrease speed
- `PageUp/PageDown`: previous/next page
- `Go to selected page`: type a page number in the playback panel and press the button (or hit `Enter`)

## Leave a star if you liked this and/or found this helpful :)

[![Star History Chart](https://api.star-history.com/svg?repos=EdoardoCortolezzis/PDF-READER-OS-&type=Date)](https://www.star-history.com/#EdoardoCortolezzis/PDF-READER-OS-&Date)
