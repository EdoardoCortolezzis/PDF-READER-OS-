"""Text layout helpers for word navigation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


@dataclass(slots=True, frozen=True)
class WordBox:
    """A single word with PDF coordinate bounds."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(slots=True)
class RowIndex:
    """Mapping of words to visual rows."""

    row_word_indices: list[list[int]]
    word_row_index: list[int]

    @classmethod
    def empty(cls, word_count: int = 0) -> "RowIndex":
        return cls(row_word_indices=[], word_row_index=[-1] * word_count)


def build_row_index(words: Sequence[WordBox]) -> RowIndex:
    """Group words into visual rows using adaptive Y tolerance."""

    index = RowIndex.empty(word_count=len(words))
    if not words:
        return index

    row_centers: list[float] = []
    row_heights: list[float] = []

    for word_idx, word in enumerate(words):
        center_y = (word.y0 + word.y1) / 2.0
        word_height = max(1.0, word.y1 - word.y0)

        if not index.row_word_indices:
            index.row_word_indices.append([word_idx])
            row_centers.append(center_y)
            row_heights.append(word_height)
            index.word_row_index[word_idx] = 0
            continue

        active_row = len(index.row_word_indices) - 1
        tolerance = max(3.0, min(word_height, row_heights[active_row]) * 0.7)

        if abs(center_y - row_centers[active_row]) <= tolerance:
            row = index.row_word_indices[active_row]
            row.append(word_idx)

            count = len(row)
            row_centers[active_row] = ((row_centers[active_row] * (count - 1)) + center_y) / count
            row_heights[active_row] = ((row_heights[active_row] * (count - 1)) + word_height) / count
            index.word_row_index[word_idx] = active_row
            continue

        index.row_word_indices.append([word_idx])
        row_centers.append(center_y)
        row_heights.append(word_height)
        index.word_row_index[word_idx] = len(index.row_word_indices) - 1

    for row_idx, row in enumerate(index.row_word_indices):
        row.sort(key=lambda idx: words[idx].x0)
        for word_idx in row:
            index.word_row_index[word_idx] = row_idx

    return index


def select_closest_word_in_row(
    words: Sequence[WordBox],
    row_word_indices: Sequence[Sequence[int]],
    current_word_index: int,
    target_row_index: int,
) -> int:
    """Pick the closest word in the target row to preserve reading position."""

    candidates = row_word_indices[target_row_index]
    if not candidates:
        return current_word_index

    current_word = words[current_word_index]
    current_x, current_y = word_center(current_word)

    return min(
        candidates,
        key=lambda idx: _word_distance(words[idx], current_x, current_y),
    )


def word_center(word: WordBox) -> tuple[float, float]:
    return ((word.x0 + word.x1) / 2.0, (word.y0 + word.y1) / 2.0)


def _word_distance(word: WordBox, reference_x: float, reference_y: float) -> float:
    candidate_x, candidate_y = word_center(word)
    return abs(candidate_x - reference_x) + (abs(candidate_y - reference_y) * 0.15)
