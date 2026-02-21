# PDF Triangle Reader

Simple Python desktop app that opens a PDF, renders pages, and moves a triangle pointer word by word at a configurable reading speed (WPM).

## Demo Video
[![Watch on YouTube](https://img.youtube.com/vi/5xONcDRI2Ho/hqdefault.jpg)](https://youtu.be/5xONcDRI2Ho)


## Project Structure

```text
.
|-- pdf_triangle_reader/
|   |-- __init__.py
|   |-- __main__.py
|   |-- app.py
|   |-- document.py
|   |-- playback.py
|   `-- text_layout.py
|-- tests/
|   |-- test_playback.py
|   `-- test_text_layout.py
|-- web/
|   |-- js/
|   |   |-- annotations/
|   |   |   `-- geometry.js
|   |   |-- reader/
|   |   |   `-- motion.js
|   |   |-- state/
|   |   |   `-- interaction-mode.js
|   |   |-- appearance.js
|   |   |-- constants.js
|   |   |-- dom.js
|   |   |-- pdf-service.js
|   |   |-- row-index.js
|   |   |-- triangle-renderer.js
|   |   `-- utils.js
|   |-- index.html
|   |-- main.js
|   `-- styles.css
|-- pdf_reader_triangle.py
|-- requirements.txt
|-- requirements-dev.txt
`-- pyproject.toml
```

## Requirements

- Python `3.10+`
- Tkinter available in your Python build
- Dependencies from `requirements.txt`

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Optional editable install:

```bash
pip install -e .
```

## Run Desktop App

```bash
python -m pdf_triangle_reader path/to/file.pdf 260
```

Legacy wrapper entrypoint:

```bash
python pdf_reader_triangle.py path/to/file.pdf 260
```

CLI options:

```bash
python -m pdf_triangle_reader path/to/file.pdf [wpm] [--start-page N] [--zoom Z]
```

## Run Web App

From repository root:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/web/
```

## Interaction Modes (Web)

- `Normal`: default mode; clicking a word moves the cursor there.
- `Highlight`: click-drag across words to create highlight annotations.
- `Erase`: click an existing highlight area to remove one annotation.

Mode behavior:

- Only one mode is active at a time.
- Clicking the currently active mode button returns to `Normal`.
- Mode switching is blocked while the app is loading/saving/applying annotation edits.

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

## Known Limitations

- Web mode uses CDN-hosted `pdfjs-dist` and `pdf-lib`; offline usage without cached assets is not supported.
- Highlight erase removes the first matching highlight under the pointer, not a full overlap set.
- The desktop and web front ends are separate implementations and can differ slightly in rendering/interaction details.

## Pre-Push Checks

```bash
python3 -m pytest -q
python3 -m compileall pdf_triangle_reader
# JavaScript syntax check used in this repo (no JS linter configured)
for f in $(rg --files web -g '*.js'); do node --check "$f"; done
```
