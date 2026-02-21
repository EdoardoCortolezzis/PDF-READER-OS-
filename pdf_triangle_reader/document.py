"""PDF document loading and page rendering."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image

from .text_layout import RowIndex, WordBox, build_row_index


@dataclass(slots=True)
class RenderedPage:
    """Render result for a single page."""

    words: list[WordBox]
    row_index: RowIndex
    image: Image.Image
    width: int
    height: int


class PDFDocument:
    """Thin wrapper around a PyMuPDF document."""

    def __init__(self, pdf_path: str | Path):
        self.path = Path(pdf_path)
        self._doc = fitz.open(str(self.path))

    def __len__(self) -> int:
        return len(self._doc)

    def close(self) -> None:
        self._doc.close()

    def render_page(self, page_index: int, zoom: float) -> RenderedPage:
        page = self._doc[page_index]
        words = self._extract_words(page)
        row_index = build_row_index(words)

        matrix = fitz.Matrix(zoom, zoom)
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)

        return RenderedPage(
            words=words,
            row_index=row_index,
            image=image,
            width=pixmap.width,
            height=pixmap.height,
        )

    @staticmethod
    def _extract_words(page: fitz.Page) -> list[WordBox]:
        raw_words = page.get_text("words")
        raw_words.sort(key=lambda word: (word[1], word[0]))
        return [
            WordBox(
                text=word[4],
                x0=word[0],
                y0=word[1],
                x1=word[2],
                y1=word[3],
            )
            for word in raw_words
        ]
