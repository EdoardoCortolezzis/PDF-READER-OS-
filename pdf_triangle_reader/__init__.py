"""PDF Triangle Reader package."""

from .app import PDFTriangleReader, main
from .text_layout import WordBox

__all__ = ["PDFTriangleReader", "WordBox", "main"]
