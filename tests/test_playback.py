from pdf_triangle_reader.playback import SpeedController


def test_speed_controller_clamps_wpm() -> None:
    speed = SpeedController(wpm=2000)
    assert speed.wpm == speed.max_wpm

    speed.set_speed(20)
    assert speed.wpm == speed.min_wpm


def test_consume_due_steps_and_resets_when_backlogged() -> None:
    speed = SpeedController(wpm=260)

    start = 100.0
    speed.next_word_due = start
    steps = speed.consume_due_steps(now=start + (speed.interval_seconds * 3) - 1e-6)
    assert steps == 3

    speed.next_word_due = 0.0
    capped = speed.consume_due_steps(now=500.0, max_steps=2)
    assert capped == 2
    assert speed.next_word_due > 500.0
