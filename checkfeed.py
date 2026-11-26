#!/usr/bin/env python3
"""
OBS Overlay Manager — Feed Health TUI
Fixed checklist with green/red dots, scrolling MediaMTX log below.

Run:  python3 checkfeed.py
Keys: q/ESC = quit, r = refresh now
"""
import subprocess
import time
import os
import stat
import sys
import select
import threading
from pathlib import Path
from dataclasses import dataclass
from typing import Callable, Tuple, Optional

from rich.console import Console
from rich.layout import Layout
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.live import Live
from rich.align import Align

# ─── Config ─────────────────────────────────────────────────────────────────
TESTFEED_DIR = Path(__file__).parent / "testfeed"
LOG_PATHS = [Path("/tmp/mediamtx.log"), TESTFEED_DIR / "mediamtx.log"]
CAM_DEVICE = "/dev/v4l/by-id/usb-Elgato_Cam_Link_4K_0004FC2E0A000-video-index0"
EXPECTED_CAM_RES = (1280, 720)
EXPECTED_TEST_RES = (854, 480)
REFRESH_SECONDS = 5

# ─── Probes ─────────────────────────────────────────────────────────────────
@dataclass
class Check:
    name: str
    desc: str
    probe: Callable[[], Tuple[bool, str]]
    ok: bool = False
    detail: str = ""

def _pgrep(pattern: str, flag: str = "-x") -> str:
    r = subprocess.run(["pgrep", flag, pattern], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""

def probe_mediamtx():
    pids = _pgrep("mediamtx")
    return (True, f"PID {pids.split()[0]}") if pids else (False, "not running")

def probe_port(port: int):
    r = subprocess.run(["ss", "-ltn"], capture_output=True, text=True)
    if r.returncode == 0 and f":{port} " in r.stdout:
        return True, f"listening :{port}"
    return False, f":{port} not listening"

def probe_rtsp(url: str, expected):
    cmd = ["ffprobe", "-v", "error", "-rtsp_transport", "tcp",
           "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", url]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=6)
    except subprocess.TimeoutExpired:
        return False, "ffprobe timed out"
    if r.returncode != 0 or not r.stdout.strip():
        return False, f"no stream: {(r.stderr or 'refused').strip()[:50]}"
    nums, codec = [], ""
    for p in (x.strip() for x in r.stdout.strip().split(",")):
        try:
            nums.append(int(p))
        except ValueError:
            codec = p
    if len(nums) < 2:
        return False, f"parse err: {r.stdout.strip()}"
    w, h = nums[0], nums[1]
    if (w, h) == expected:
        return True, f"{codec} {w}x{h}"
    return False, f"{codec} {w}x{h} (want {expected[0]}x{expected[1]})"

def probe_v4l2():
    if not os.path.exists(CAM_DEVICE):
        return False, "device not found"
    try:
        if not stat.S_ISCHR(os.stat(CAM_DEVICE).st_mode):
            return False, "not a char device"
    except OSError:
        return False, "stat failed"
    r = subprocess.run(["fuser", CAM_DEVICE], capture_output=True, text=True)
    holders = r.stdout.strip().split() if r.stdout.strip() else []
    if holders:
        enc = _pgrep("ffmpeg.*cam", flag="-af")
        enc_pids = {l.split()[0] for l in enc.splitlines() if "v4l2" in l}
        if enc_pids & set(holders):
            return True, f"held by encoder ({next(iter(enc_pids))})"
        return False, f"busy by PID {holders}"
    return True, "free"

def probe_usb():
    r = subprocess.run(["lsusb", "-d", "0fd9:0066"], capture_output=True, text=True)
    return (True, "Cam Link 4K") if r.returncode == 0 and r.stdout.strip() else (False, "not found")

def probe_obs():
    pids = _pgrep("obs", flag="-f")
    return (True, "running") if pids else (False, "not running")

def probe_encoder():
    r = subprocess.run(["pgrep", "-af", "ffmpeg.*cam"], capture_output=True, text=True)
    lines = [l for l in r.stdout.splitlines() if "v4l2" in l and "cam" in l]
    return (True, f"PID {lines[0].split()[0]}") if lines else (False, "idle")

def probe_log():
    for path in LOG_PATHS:
        try:
            content = Path(path).read_text()[-2000:]
        except FileNotFoundError:
            continue
        issues = []
        if "Device or resource busy" in content: issues.append("Device busy")
        if "Input/output error" in content:       issues.append("I/O error")
        if "RTP packets are too big" in content:  issues.append("RTP oversize")
        if "invalid FU-A" in content or "RTP packets lost" in content:
            issues.append("RTP corrupt")
        return (False, ", ".join(issues)) if issues else (True, "clean")
    return False, "no log found"

CHECKS = [
    Check("MediaMTX", "server process", probe_mediamtx),
    Check("RTSP :8554", "RTSP listener", lambda: probe_port(8554)),
    Check("WebRTC :8889", "WHEP listener", lambda: probe_port(8889)),
    Check("Cam stream", "rtsp /cam → 1280x720", lambda: probe_rtsp("rtsp://127.0.0.1:8554/cam", EXPECTED_CAM_RES)),
    Check("Test stream", "rtsp /test → 854x480", lambda: probe_rtsp("rtsp://127.0.0.1:8554/test", EXPECTED_TEST_RES)),
    Check("V4L2 device", "Cam Link node free/held", probe_v4l2),
    Check("USB device", "Elgato on bus", probe_usb),
    Check("OBS", "Studio running", probe_obs),
    Check("Cam encoder", "ffmpeg publishing /cam", probe_encoder),
    Check("MediaMTX log", "no recent errors", probe_log),
]

# ─── Log tailer ─────────────────────────────────────────────────────────────
class LogTailer:
    def __init__(self, paths, max_lines=300):
        self.paths = paths
        self.max_lines = max_lines
        self.lines: list[str] = []
        self._stop = False
        self._thread = None
        self._positions = {p: 0 for p in paths}
        self._active = paths[0]

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop = True
        if self._thread:
            self._thread.join(timeout=1)

    def _resolve(self):
        for p in self.paths:
            if p.exists():
                if p != self._active:
                    self._active = p
                    self._positions[p] = 0
                return p
        return None

    def _run(self):
        while not self._stop:
            path = self._resolve()
            if path:
                try:
                    with open(path) as f:
                        f.seek(self._positions[path])
                        data = f.read()
                        self._positions[path] = f.tell()
                    if data:
                        for ln in data.splitlines():
                            ln = ln.strip()
                            if ln:
                                self.lines.append(ln)
                        if len(self.lines) > self.max_lines:
                            self.lines = self.lines[-self.max_lines:]
                except OSError:
                    pass
            time.sleep(0.4)

# ─── TUI ────────────────────────────────────────────────────────────────────
class FeedTUI:
    def __init__(self):
        self.console = Console()
        self.tail = LogTailer(LOG_PATHS)
        self.running = True
        self.last_refresh = 0
        self.layout = Layout()
        self.layout.split_column(
            Layout(name="title", size=1),
            Layout(name="checklist", size=len(CHECKS) + 4),
            Layout(name="rule", size=1),
            Layout(name="log", ratio=1),
            Layout(name="footer", size=1),
        )

    def refresh_checks(self):
        for c in CHECKS:
            try:
                c.ok, c.detail = c.probe()
            except Exception as e:
                c.ok, c.detail = False, f"probe error: {e}"
        self.last_refresh = time.time()

    def render_title(self) -> Panel:
        return Panel(Align.center(Text("OBS Feed Health — Diagnostics", style="bold cyan")),
                     border_style="cyan")

    def render_checklist(self) -> Panel:
        table = Table(show_header=True, header_style="bold dim", box=None, pad_edge=False, expand=True)
        table.add_column("", width=3, justify="center")
        table.add_column("Check", min_width=16)
        table.add_column("Detail", min_width=30)
        for c in CHECKS:
            dot = Text("●", style="green" if c.ok else "red")
            name = Text(c.name, style="" if c.ok else "red")
            detail = Text(c.detail, style="" if c.ok else "red")
            table.add_row(dot, name, detail)
        age = time.time() - self.last_refresh if self.last_refresh else 0
        return Panel(table, title=f"[bold]Checklist[/]  [dim](refreshed {age:.0f}s ago, every {REFRESH_SECONDS}s)[/]",
                     border_style="blue")

    def render_rule(self) -> Panel:
        return Panel(Text("─" * self.console.width, style="dim"), border_style="dim")

    def render_log(self) -> Panel:
        if not self.tail.lines:
            body = Text("waiting for MediaMTX log…", style="dim")
        else:
            body = Text("\n".join(self.tail.lines[-60:]))
        return Panel(body, title="[bold]MediaMTX Log[/] [dim](scrolling)[/]", border_style="green")

    def render_footer(self) -> Panel:
        return Panel(Align.center(Text("q / ESC: quit    r: refresh now", style="dim")),
                     border_style="dim")

    def render(self):
        self.layout["title"].update(self.render_title())
        self.layout["checklist"].update(self.render_checklist())
        self.layout["rule"].update(self.render_rule())
        self.layout["log"].update(self.render_log())
        self.layout["footer"].update(self.render_footer())

    def run(self):
        self.tail.start()
        self.refresh_checks()
        try:
            with Live(self.layout, console=self.console, refresh_per_second=4, screen=True) as live:
                self.render()
                while self.running:
                    now = time.time()
                    if now - self.last_refresh >= REFRESH_SECONDS:
                        self.refresh_checks()
                        self.render()
                    # non-blocking key read
                    if sys.stdin.isatty() and select.select([sys.stdin], [], [], 0)[0]:
                        ch = sys.stdin.read(1)
                        if ch in ("q", "Q", "\x1b"):
                            self.running = False
                        elif ch in ("r", "R"):
                            self.refresh_checks()
                            self.render()
                    time.sleep(0.15)
        finally:
            self.tail.stop()

if __name__ == "__main__":
    for dep in ("ffprobe", "pgrep", "ss", "fuser", "lsusb"):
        if subprocess.run(["which", dep], capture_output=True).returncode != 0:
            sys.exit(f"missing dependency: {dep}")
    FeedTUI().run()