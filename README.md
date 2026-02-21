# PDF Triangle Reader

Simple Python desktop app that opens a PDF, renders pages, and moves a triangle pointer word by word at a configurable reading speed (WPM).

## Demo Video
[![Watch on YouTube](https://img.youtube.com/vi/jMo4RLw0WNY/hqdefault.jpg)](https://youtu.be/jMo4RLw0WNY)


## Project structure

```text
.
|-- pdf_triangle_reader/
|   |-- __init__.py
|   |-- __main__.py
|   |-- app.py
|   |-- document.py
|   |-- playback.py
|   `-- text_layout.py
|-- pdf_reader_triangle.py
|-- tests/
|   |-- test_playback.py
|   `-- test_text_layout.py
|-- web/
|   |-- js/
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
|-- requirements.txt
|-- requirements-dev.txt
|-- pyproject.toml
`-- README.md
```

## Requirements

- Python 3.10+
- Tkinter available in your Python installation
- Runtime dependencies in `requirements.txt`

## Setup

```bash
python -m venv .venv
source .venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
```

Optional (for local package install and CLI command):

```bash
pip install -e .
```

## Run

Legacy script entrypoint:

```bash
python pdf_reader_triangle.py path/to/file.pdf 260
```

Package entrypoint:

```bash
python -m pdf_triangle_reader path/to/file.pdf 260
```

If installed with `pip install -e .`:

```bash
pdf-triangle-reader path/to/file.pdf 260
```

## Development checks

```bash
python3 -m pytest -q
python3 -m compileall pdf_triangle_reader
```

## Liquid glass web UI

This repo now also includes a browser UI redesign in `web/` with:

- Static liquid-glass background with translucent UI panels
- User-selectable background and theme colors
- PDF.js page rendering in-browser
- The same core reader interactions (speed slider, play/pause, row navigation, page navigation)

Run it from the repository root:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/web/
```

Notes:

- Upload a PDF using the `Upload PDF` button to start reading.
- If you open the HTML directly as a `file://` URL, browser module/CORS restrictions can break loading.

## CLI options

```bash
python -m pdf_triangle_reader path/to/file.pdf [wpm] [--start-page N] [--zoom Z]
```

- `wpm`: optional positional value, default `260`
- `--start-page`: 1-based page number, default `1`
- `--zoom`: render zoom factor, default `2.0`

## Controls

- Appearance controls: choose background and theme colors, or reset
- Speed slider at top: set a constant triangle speed (WPM)
- `Space`: pause/resume
- `Left/Right`: move one word backward/forward
- `Up/Down`: move to the previous/next text row
- `Shift+Up/Shift+Down`: increase/decrease speed
- `PageUp/PageDown`: previous/next page
- `Mouse wheel`: scroll page
- `Esc`: exit

## Leava a star if you liked this and/or found this helpful :)

[![Star History Chart](https://api.star-history.com/svg?repos=EdoardoCortolezzis/PDF-READER-OS-&type=Date)](https://www.star-history.com/#EdoardoCortolezzis/PDF-READER-OS-&Date)
