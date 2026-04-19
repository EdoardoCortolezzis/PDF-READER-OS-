"""Launch the JavaScript web UI in the user's default browser."""

from __future__ import annotations

import argparse
import contextlib
import subprocess
import sys
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional, Sequence

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 0
IDLE_SHUTDOWN_SECONDS = 12.0
STARTUP_REQUEST_TIMEOUT_SECONDS = 20.0
HEARTBEAT_PATH = "/__launcher_heartbeat"
SHUTDOWN_PATH = "/__launcher_shutdown"


class _RequestTracker:
    def __init__(self) -> None:
        self.request_count = 0
        self.last_request_monotonic = 0.0
        self.shutdown_requested = False

    def touch(self) -> None:
        self.request_count += 1
        self.last_request_monotonic = time.monotonic()

    def request_shutdown(self) -> None:
        self.touch()
        self.shutdown_requested = True


def resolve_web_root() -> Path:
    if getattr(sys, "frozen", False):
        bundle_root = Path(getattr(sys, "_MEIPASS", Path.cwd()))
        return bundle_root / "web"
    return Path(__file__).resolve().parent.parent / "web"

def start_static_server(
    web_root: Path,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
) -> tuple[ThreadingHTTPServer, _RequestTracker]:
    tracker = _RequestTracker()

    class _QuietHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_root), **kwargs)

        def _is_control_path(self) -> bool:
            return self.path in {HEARTBEAT_PATH, SHUTDOWN_PATH}

        def _consume_request_body(self) -> None:
            raw_length = self.headers.get("Content-Length", "0")
            try:
                content_length = max(0, int(raw_length))
            except (TypeError, ValueError):
                content_length = 0
            if content_length > 0:
                self.rfile.read(content_length)

        def _respond_control_path(self) -> None:
            if self.path == SHUTDOWN_PATH:
                tracker.request_shutdown()
            else:
                tracker.touch()
            self.send_response(204)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            if self._is_control_path():
                self._respond_control_path()
                return
            tracker.touch()
            return super().do_GET()

        def do_HEAD(self):  # noqa: N802
            if self._is_control_path():
                self._respond_control_path()
                return
            tracker.touch()
            return super().do_HEAD()

        def do_POST(self):  # noqa: N802
            if self._is_control_path():
                self._consume_request_body()
                self._respond_control_path()
                return
            self.send_error(404, "Not Found")

        def log_message(self, _format: str, *_args) -> None:
            return

    return ThreadingHTTPServer((host, port), _QuietHandler), tracker


def local_url(server: ThreadingHTTPServer) -> str:
    host, port = server.server_address[:2]
    if host in {"0.0.0.0", "::"}:
        host = DEFAULT_HOST
    return f"http://{host}:{port}/index.html"


def launch_url(url: str) -> bool:
    if sys.platform == "darwin":
        try:
            subprocess.Popen(
                ["open", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except OSError:
            pass

    try:
        return bool(webbrowser.open_new_tab(url))
    except webbrowser.Error:
        return False


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Launch PDF Reading Pacer JavaScript UI."
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Do not open the browser automatically.",
    )
    parser.add_argument(
        "--print-url",
        action="store_true",
        help="Print the resolved UI URL.",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"Local host for the temporary web server. Default: {DEFAULT_HOST}.",
    )
    parser.add_argument(
        "--port",
        default=DEFAULT_PORT,
        type=int,
        help="Local port for the temporary web server. Default: random free port.",
    )
    parser.add_argument(
        "--idle-shutdown-seconds",
        default=IDLE_SHUTDOWN_SECONDS,
        type=float,
        help=(
            "Stop the temporary web server after this many idle seconds "
            "following at least one request."
        ),
    )
    parser.add_argument(
        "--startup-timeout-seconds",
        default=STARTUP_REQUEST_TIMEOUT_SECONDS,
        type=float,
        help=(
            "Stop the temporary web server if no browser request arrives "
            "within this many seconds."
        ),
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)

    web_root = resolve_web_root()
    index_path = web_root / "index.html"
    if not index_path.is_file():
        print(
            f"Error: missing UI entrypoint at {index_path}",
            file=sys.stderr,
        )
        return 1

    if args.no_open:
        if args.print_url:
            print(index_path.resolve().as_uri())
        return 0

    try:
        server, tracker = start_static_server(
            web_root=web_root,
            host=args.host,
            port=args.port,
        )
    except OSError as error:
        print(f"Error: unable to start local web server: {error}", file=sys.stderr)
        return 1

    ui_url = local_url(server)

    if args.print_url:
        print(ui_url)

    launched = launch_url(ui_url)
    if not launched:
        print("Could not open browser automatically.", file=sys.stderr)
        print(ui_url, file=sys.stderr)

    server.timeout = 0.5
    startup_deadline = time.monotonic() + max(0.0, args.startup_timeout_seconds)
    try:
        while True:
            server.handle_request()
            now = time.monotonic()
            if tracker.request_count == 0:
                if now >= startup_deadline:
                    break
                continue
            if tracker.shutdown_requested:
                break
            idle_seconds = now - tracker.last_request_monotonic
            if idle_seconds >= max(0.0, args.idle_shutdown_seconds):
                break
    except KeyboardInterrupt:
        pass
    finally:
        with contextlib.suppress(OSError):
            server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
