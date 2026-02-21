"""Tk desktop PDF triangle reader application."""

from __future__ import annotations

import argparse
import sys
import time
import tkinter as tk
from pathlib import Path
from typing import Optional, Sequence

from PIL import ImageTk

from .document import PDFDocument
from .playback import SpeedController
from .text_layout import WordBox, select_closest_word_in_row

COLORS = {
    "window_bg": "#DDE6F2",
    "glass_bg": "#F8FBFF",
    "glass_edge": "#BFD0E4",
    "canvas_bg": "#ECF2FA",
    "text_primary": "#1C2B43",
    "text_muted": "#4F637C",
    "accent": "#62C6FF",
    "triangle_fill": "#7DDBFF",
    "triangle_edge": "#228ECF",
    "triangle_glow": "#CFEFFF",
}

MAX_TICK_STEPS = 20
TICK_INTERVAL_MS = 10


class PDFTriangleReader:
    """Desktop reader that advances a triangle pointer word-by-word."""

    def __init__(
        self,
        pdf_path: str,
        start_page: int = 0,
        zoom: float = 2.0,
        wpm: int = 260,
    ):
        self.document = PDFDocument(pdf_path)
        self.zoom = zoom
        self.speed = SpeedController(wpm=wpm)

        self.page_index = max(0, min(start_page, len(self.document) - 1))
        self.word_index = 0
        self.words: list[WordBox] = []
        self.row_word_indices: list[list[int]] = []
        self.word_row_index: list[int] = []

        self.running = True
        self.closed = False
        self.after_id: Optional[str] = None

        self._setup_ui()
        self._bind_keys()
        self._load_page(self.page_index)

    def run(self) -> None:
        try:
            self._tick()
            self.root.mainloop()
        finally:
            self._on_close()

    def _setup_ui(self) -> None:
        self.root = tk.Tk()
        self.root.title("PDF Triangle Reader")
        self.root.geometry("1100x800")
        self.root.minsize(700, 500)
        self.root.configure(bg=COLORS["window_bg"])

        self.controls_frame = tk.Frame(
            self.root,
            bg=COLORS["window_bg"],
            padx=16,
            pady=14,
        )
        self.controls_frame.pack(fill="x")

        self.glass_bar = tk.Frame(
            self.controls_frame,
            bg=COLORS["glass_bg"],
            padx=14,
            pady=10,
            highlightthickness=1,
            highlightbackground=COLORS["glass_edge"],
            highlightcolor=COLORS["glass_edge"],
            bd=0,
        )
        self.glass_bar.pack(fill="x")
        self.glass_bar.grid_columnconfigure(1, weight=1)

        self.title_label = tk.Label(
            self.glass_bar,
            text="PDF Triangle Reader",
            fg=COLORS["text_primary"],
            bg=COLORS["glass_bg"],
            font=("Helvetica", 13, "bold"),
        )
        self.title_label.grid(row=0, column=0, sticky="w")

        self.speed_controls = tk.Frame(self.glass_bar, bg=COLORS["glass_bg"])
        self.speed_controls.grid(row=0, column=1, sticky="ew", padx=14)
        self.speed_controls.grid_columnconfigure(1, weight=1)

        self.speed_label = tk.Label(
            self.speed_controls,
            text="Speed",
            fg=COLORS["text_muted"],
            bg=COLORS["glass_bg"],
            font=("Helvetica", 10, "bold"),
        )
        self.speed_label.grid(row=0, column=0, sticky="w", padx=(0, 8))

        self.speed_var = tk.IntVar(value=self.speed.wpm)
        self.speed_slider = tk.Scale(
            self.speed_controls,
            from_=self.speed.min_wpm,
            to=self.speed.max_wpm,
            orient="horizontal",
            variable=self.speed_var,
            command=self._on_speed_slider,
            resolution=10,
            showvalue=False,
            length=340,
            bd=0,
            bg=COLORS["glass_bg"],
            fg=COLORS["text_muted"],
            troughcolor="#D6E4F4",
            highlightthickness=0,
            activebackground=COLORS["accent"],
            sliderrelief="flat",
        )
        self.speed_slider.grid(row=0, column=1, sticky="ew")

        self.speed_value_label = tk.Label(
            self.speed_controls,
            text=f"{self.speed.wpm} wpm",
            fg=COLORS["text_primary"],
            bg=COLORS["glass_bg"],
            font=("Helvetica", 10, "bold"),
            padx=8,
        )
        self.speed_value_label.grid(row=0, column=2, sticky="e", padx=(8, 0))

        self.status_chip = tk.Label(
            self.glass_bar,
            text="",
            fg=COLORS["text_muted"],
            bg="#EAF3FD",
            font=("Helvetica", 10, "bold"),
            padx=10,
            pady=4,
            highlightthickness=1,
            highlightbackground=COLORS["glass_edge"],
            highlightcolor=COLORS["glass_edge"],
            bd=0,
        )
        self.status_chip.grid(row=0, column=2, sticky="e")

        self.main_frame = tk.Frame(self.root, bg=COLORS["window_bg"])
        self.main_frame.pack(fill="both", expand=True, padx=16, pady=(0, 16))

        self.viewer_frame = tk.Frame(
            self.main_frame,
            bg=COLORS["glass_bg"],
            highlightthickness=1,
            highlightbackground=COLORS["glass_edge"],
            highlightcolor=COLORS["glass_edge"],
            bd=0,
        )
        self.viewer_frame.pack(fill="both", expand=True)

        self.canvas = tk.Canvas(
            self.viewer_frame,
            bg=COLORS["canvas_bg"],
            highlightthickness=0,
        )
        self.canvas.pack(side="left", fill="both", expand=True)

        self.v_scrollbar = tk.Scrollbar(
            self.viewer_frame,
            orient="vertical",
            command=self.canvas.yview,
            bg=COLORS["glass_bg"],
            troughcolor=COLORS["window_bg"],
            activebackground=COLORS["accent"],
            highlightthickness=0,
            bd=0,
            relief="flat",
        )
        self.v_scrollbar.pack(side="right", fill="y")
        self.canvas.configure(yscrollcommand=self.v_scrollbar.set)

        self.tk_img: ImageTk.PhotoImage | None = None
        self.tri_glow_id: int | None = None
        self.tri_id: int | None = None

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def _bind_keys(self) -> None:
        self.root.bind("<space>", lambda _: self._toggle())
        self.root.bind("<Escape>", lambda _: self._on_close())

        self.root.bind("<Right>", lambda _: self._step(+1))
        self.root.bind("<Left>", lambda _: self._step(-1))

        self.root.bind("<Up>", lambda _: self._move_row(-1))
        self.root.bind("<Down>", lambda _: self._move_row(+1))
        self.root.bind("<Shift-Up>", lambda _: self._change_speed(+20))
        self.root.bind("<Shift-Down>", lambda _: self._change_speed(-20))

        self.root.bind("<Next>", lambda _: self._change_page(+1))
        self.root.bind("<Prior>", lambda _: self._change_page(-1))

        self.canvas.bind_all("<MouseWheel>", self._on_mouse_wheel)
        self.canvas.bind_all("<Button-4>", lambda _: self.canvas.yview_scroll(-1, "units"))
        self.canvas.bind_all("<Button-5>", lambda _: self.canvas.yview_scroll(1, "units"))

    def _toggle(self) -> None:
        self.running = not self.running
        if self.running:
            self.speed.reset_timer()
        self._update_status_text()

    def _change_speed(self, delta_wpm: int) -> None:
        self._set_speed(self.speed.wpm + delta_wpm)

    def _set_speed(self, wpm: int, sync_slider: bool = True) -> None:
        self.speed.set_speed(wpm)

        if sync_slider and self.speed_var.get() != self.speed.wpm:
            self.speed_var.set(self.speed.wpm)

        self.speed_value_label.config(text=f"{self.speed.wpm} wpm")
        self.speed.reset_timer()
        self._update_status_text()

    def _on_speed_slider(self, value: str) -> None:
        try:
            self._set_speed(int(float(value)), sync_slider=False)
        except (TypeError, ValueError):
            return

    def _change_page(self, delta: int) -> None:
        next_index = self.page_index + delta
        if 0 <= next_index < len(self.document):
            self.page_index = next_index
            self._load_page(self.page_index)
            self.speed.reset_timer()

    def _step(self, delta: int) -> None:
        if not self.words:
            return

        self.word_index = max(0, min(self.word_index + delta, len(self.words) - 1))
        self._draw_triangle()
        self.speed.reset_timer()

    def _move_row(self, delta_rows: int) -> None:
        if (
            not self.words
            or not self.row_word_indices
            or self.word_index >= len(self.word_row_index)
        ):
            return

        current_row = self.word_row_index[self.word_index]
        if current_row < 0:
            return

        target_row = max(0, min(current_row + delta_rows, len(self.row_word_indices) - 1))
        if target_row == current_row:
            return

        self.word_index = select_closest_word_in_row(
            words=self.words,
            row_word_indices=self.row_word_indices,
            current_word_index=self.word_index,
            target_row_index=target_row,
        )
        self._draw_triangle()
        self.speed.reset_timer()

    def _load_page(self, page_index: int) -> None:
        rendered_page = self.document.render_page(page_index=page_index, zoom=self.zoom)

        self.words = rendered_page.words
        self.row_word_indices = rendered_page.row_index.row_word_indices
        self.word_row_index = rendered_page.row_index.word_row_index
        self.word_index = 0

        self.tk_img = ImageTk.PhotoImage(rendered_page.image)

        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor="nw", image=self.tk_img)
        self.canvas.config(scrollregion=(0, 0, rendered_page.width, rendered_page.height))
        self.canvas.yview_moveto(0.0)

        self.tri_glow_id = None
        self.tri_id = None

        self._draw_triangle()
        self._update_status_text()
        self.speed.reset_timer()

    def _update_status_text(self) -> None:
        word = self.words[self.word_index].text if self.words else ""
        preview = word if len(word) <= 32 else f"{word[:29]}..."
        mode = "Playing" if self.running else "Paused"
        self.status_chip.config(
            text=(
                f"{mode}  •  Page {self.page_index + 1}/{len(self.document)}"
                f"  •  {preview}"
            )
        )

    def _draw_triangle(self) -> None:
        if not self.words:
            self._update_status_text()
            return

        word = self.words[self.word_index]
        x0 = word.x0 * self.zoom
        y0 = word.y0 * self.zoom
        x1 = word.x1 * self.zoom
        y1 = word.y1 * self.zoom

        triangle_points, glow_points = self._triangle_points(x0, y0, x1, y1)

        self._draw_or_update_glow(glow_points)
        self._draw_or_update_triangle(triangle_points)

        self._ensure_word_visible(y0, y1)
        self._update_status_text()

    def _triangle_points(
        self,
        x0: float,
        y0: float,
        x1: float,
        y1: float,
    ) -> tuple[tuple[float, ...], tuple[float, ...]]:
        center_x = (x0 + x1) / 2
        top = y0
        tri_height = max(18, (y1 - y0) * 0.9)
        tri_width = max(22, (x1 - x0) * 0.7)

        triangle_points = (
            center_x,
            top - 2,
            center_x - (tri_width / 2),
            top - tri_height,
            center_x + (tri_width / 2),
            top - tri_height,
        )

        glow_width = tri_width * 1.35
        glow_height = tri_height * 1.22
        glow_points = (
            center_x,
            top + 1,
            center_x - (glow_width / 2),
            top - glow_height,
            center_x + (glow_width / 2),
            top - glow_height,
        )

        return triangle_points, glow_points

    def _draw_or_update_glow(self, points: tuple[float, ...]) -> None:
        if self.tri_glow_id is None:
            self.tri_glow_id = self.canvas.create_polygon(
                *points,
                fill=COLORS["triangle_glow"],
                outline="",
                stipple="gray50",
            )
            return

        self.canvas.coords(self.tri_glow_id, *points)

    def _draw_or_update_triangle(self, points: tuple[float, ...]) -> None:
        if self.tri_id is None:
            self.tri_id = self.canvas.create_polygon(
                *points,
                fill=COLORS["triangle_fill"],
                outline=COLORS["triangle_edge"],
                width=2,
                joinstyle="round",
            )
            return

        self.canvas.coords(self.tri_id, *points)

    def _ensure_word_visible(self, y0: float, y1: float) -> None:
        self.root.update_idletasks()

        content_height = self.tk_img.height() if self.tk_img else 0
        viewport_height = self.canvas.winfo_height()
        if content_height <= 0 or viewport_height <= 1 or content_height <= viewport_height:
            return

        current_top = self.canvas.yview()[0] * content_height
        margin = max(40.0, viewport_height * 0.2)

        if y0 < current_top + margin:
            target_top = y0 - margin
        elif y1 > current_top + viewport_height - margin:
            target_top = y1 - viewport_height + margin
        else:
            return

        max_top = content_height - viewport_height
        target_top = max(0.0, min(target_top, max_top))
        if max_top > 0:
            self.canvas.yview_moveto(target_top / content_height)

    def _on_mouse_wheel(self, event: tk.Event) -> None:
        if event.delta == 0:
            return
        direction = -1 if event.delta > 0 else 1
        self.canvas.yview_scroll(direction, "units")

    def _tick(self) -> None:
        if self.closed:
            return

        if self.running and self.words:
            now = time.perf_counter()
            steps = self.speed.consume_due_steps(now, max_steps=MAX_TICK_STEPS)
            for _ in range(steps):
                if self._advance_once():
                    break

        self.after_id = self.root.after(TICK_INTERVAL_MS, self._tick)

    def _advance_once(self) -> bool:
        if self.word_index < len(self.words) - 1:
            self.word_index += 1
            self._draw_triangle()
            return False

        if self.page_index < len(self.document) - 1:
            self.page_index += 1
            self._load_page(self.page_index)
            return True

        self.running = False
        self._update_status_text()
        return True

    def _on_close(self) -> None:
        if self.closed:
            return

        self.closed = True
        self.running = False

        if self.after_id is not None:
            try:
                self.root.after_cancel(self.after_id)
            except tk.TclError:
                pass
            self.after_id = None

        self.canvas.unbind_all("<MouseWheel>")
        self.canvas.unbind_all("<Button-4>")
        self.canvas.unbind_all("<Button-5>")

        self.document.close()

        try:
            self.root.quit()
            self.root.destroy()
        except tk.TclError:
            pass


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read a PDF with a moving triangle pointer word by word."
    )
    parser.add_argument("pdf_path", help="Path to the PDF file.")
    parser.add_argument(
        "wpm",
        nargs="?",
        default=260,
        type=int,
        help="Words per minute. Default: 260.",
    )
    parser.add_argument(
        "--start-page",
        default=1,
        type=int,
        help="1-based page number to start from. Default: 1.",
    )
    parser.add_argument(
        "--zoom",
        default=2.0,
        type=float,
        help="Render zoom factor. Default: 2.0.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    pdf_path = Path(args.pdf_path)

    if not pdf_path.exists():
        print(f"Error: PDF not found: {pdf_path}", file=sys.stderr)
        return 1

    reader = PDFTriangleReader(
        pdf_path=str(pdf_path),
        start_page=max(0, args.start_page - 1),
        zoom=args.zoom,
        wpm=args.wpm,
    )
    reader.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
