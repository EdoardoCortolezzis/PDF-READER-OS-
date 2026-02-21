from pdf_triangle_reader.text_layout import (
    WordBox,
    build_row_index,
    select_closest_word_in_row,
)


def test_build_row_index_groups_words_by_row() -> None:
    words = [
        WordBox(text="a", x0=0, y0=0, x1=10, y1=10),
        WordBox(text="b", x0=12, y0=0, x1=22, y1=10),
        WordBox(text="c", x0=1, y0=20, x1=9, y1=30),
        WordBox(text="d", x0=13, y0=20, x1=23, y1=30),
    ]

    index = build_row_index(words)

    assert index.row_word_indices == [[0, 1], [2, 3]]
    assert index.word_row_index == [0, 0, 1, 1]


def test_select_closest_word_in_target_row() -> None:
    words = [
        WordBox(text="a", x0=0, y0=0, x1=10, y1=10),
        WordBox(text="b", x0=12, y0=0, x1=22, y1=10),
        WordBox(text="c", x0=1, y0=20, x1=9, y1=30),
        WordBox(text="d", x0=15, y0=20, x1=25, y1=30),
    ]
    index = build_row_index(words)

    selected = select_closest_word_in_row(
        words=words,
        row_word_indices=index.row_word_indices,
        current_word_index=1,
        target_row_index=1,
    )

    assert selected == 3
