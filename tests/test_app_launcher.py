from pathlib import Path

from pdf_triangle_reader import app


def test_resolve_web_root_points_to_web_folder() -> None:
    web_root = app.resolve_web_root()
    assert web_root.name == "web"
    assert web_root.is_dir()


def test_main_prints_url_without_opening_browser(capsys) -> None:
    exit_code = app.main(["--print-url", "--no-open"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert captured.err == ""
    assert captured.out.strip().startswith("file://")
    assert captured.out.strip().endswith("/web/index.html")


def test_local_url_uses_loopback_for_wildcard_host() -> None:
    class FakeServer:
        server_address = ("0.0.0.0", 8123)

    assert app.local_url(FakeServer()) == "http://127.0.0.1:8123/index.html"


def test_local_url_uses_bound_host() -> None:
    class FakeServer:
        server_address = ("127.0.0.1", 9000)

    assert app.local_url(FakeServer()) == "http://127.0.0.1:9000/index.html"


def test_request_tracker_shutdown_updates_state() -> None:
    tracker = app._RequestTracker()
    assert tracker.request_count == 0
    assert tracker.shutdown_requested is False

    tracker.request_shutdown()

    assert tracker.request_count == 1
    assert tracker.shutdown_requested is True
    assert tracker.last_request_monotonic > 0


def test_main_fails_when_index_is_missing(monkeypatch, tmp_path: Path) -> None:
    missing_web_root = tmp_path / "web"
    missing_web_root.mkdir(parents=True)
    monkeypatch.setattr(app, "resolve_web_root", lambda: missing_web_root)

    exit_code = app.main(["--no-open"])
    assert exit_code == 1
