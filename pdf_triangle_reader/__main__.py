from __future__ import annotations

import sys
from pathlib import Path

try:
    from .app import main
except ImportError:
    package_root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(package_root))
    from pdf_triangle_reader.app import main


if __name__ == "__main__":
    raise SystemExit(main())
