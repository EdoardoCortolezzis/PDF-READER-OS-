"""Playback speed and timing helpers."""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass(slots=True)
class SpeedController:
    """Controls WPM bounds and word-advance timing."""

    wpm: int = 260
    min_wpm: int = 60
    max_wpm: int = 1200
    next_word_due: float = field(init=False)

    def __post_init__(self) -> None:
        self.wpm = self._clamp(self.wpm)
        self.next_word_due = time.perf_counter() + self.interval_seconds

    @property
    def ms_per_word(self) -> int:
        return int(60_000 / self.wpm)

    @property
    def interval_seconds(self) -> float:
        return self.ms_per_word / 1000.0

    def set_speed(self, next_wpm: int) -> int:
        self.wpm = self._clamp(next_wpm)
        return self.wpm

    def reset_timer(self, now: float | None = None) -> None:
        if now is None:
            now = time.perf_counter()
        self.next_word_due = now + self.interval_seconds

    def consume_due_steps(self, now: float, max_steps: int = 20) -> int:
        """Advance internal deadline and return due word steps."""

        steps = 0
        interval = self.interval_seconds
        while now >= self.next_word_due and steps < max_steps:
            self.next_word_due += interval
            steps += 1

        if steps == max_steps and now >= self.next_word_due:
            self.reset_timer(now)

        return steps

    def _clamp(self, value: int) -> int:
        return max(self.min_wpm, min(self.max_wpm, int(value)))
