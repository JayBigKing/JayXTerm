#!/usr/bin/env python3
"""Exercise tun-guard with temporary hosts, fake TUN state and route sources."""

import os
from pathlib import Path
import signal
from shlex import quote
import subprocess
import tempfile
import time
import unittest


SCRIPT = Path(__file__).with_name("tun-guard.sh")
FUNCTIONS = SCRIPT.read_text().split('\nif [ "${1:-}" = "--selftest" ]; then')[0]


class TunGuardCheck(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tun-guard-check-")
        self.root = Path(self.temp.name)
        (self.root / "functions.sh").write_text(FUNCTIONS + "\n")
        self.baseline = b"127.0.0.1 localhost\n::1 localhost\n"
        (self.root / "hosts").write_bytes(self.baseline)
        (self.root / "domains").write_text("openai.com\n")
        (self.root / "state").write_text("up")
        self.prelude = '''source "$1/functions.sh"
HOSTS="$1/hosts"; CONF="$1/domains"; ROUTE="$1/route"
STATEFILE="$1/state"
flush_dns() { :; }
tun_up() { [ "$(/bin/cat "$STATEFILE")" = up ]; }
WANT=""; CONF_SIG="__init__"
'''

    def tearDown(self):
        self.temp.cleanup()

    def run_commands(self, commands):
        run = self.root / "check.sh"
        run.write_text(self.prelude + commands)
        result = subprocess.run(
            ["/bin/bash", str(run), str(self.root)],
            capture_output=True,
            text=True,
            timeout=4,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return (self.root / "hosts").read_bytes()

    def start_loop(self, route_body):
        route = self.root / "route"
        route.write_text("#!/bin/bash\n" + route_body + "\n")
        route.chmod(0o700)
        run = self.root / "loop.sh"
        run.write_text(self.prelude + 'sync_state\nprintf ready > "$1/ready"\nmain_loop\n')
        process = subprocess.Popen(
            ["/bin/bash", str(run), str(self.root)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        deadline = time.monotonic() + 2
        while not (self.root / "ready").exists():
            if process.poll() is not None or time.monotonic() >= deadline:
                self.stop_loop(process)
                self.fail("Temporary runner did not initialize")
            time.sleep(0.01)
        return process

    @staticmethod
    def stop_loop(process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=1)

    def observe_block(self, limit):
        start = time.monotonic()
        while time.monotonic() - start < limit:
            hosts = (self.root / "hosts").read_bytes()
            if b"0.0.0.0 openai.com # tun-guard\n:: openai.com # tun-guard\n" in hosts:
                return time.monotonic() - start
            time.sleep(0.01)
        return None

    def test_route_exit_still_detects_tun_shutdown(self):
        process = self.start_loop("exit 1")
        try:
            time.sleep(0.2)
            (self.root / "state").write_text("down")
            elapsed = self.observe_block(2.5)
            self.assertIsNotNone(elapsed, "Repeated EOF left domains unprotected")
            self.assertLess(elapsed, 1.5)
            self.assertIsNone(process.poll())
        finally:
            self.stop_loop(process)

    def test_route_event_blocks_before_fallback(self):
        state_file = quote(str(self.root / "state"))
        process = self.start_loop(
            f'''while [ "$(/bin/cat {state_file})" != down ]; do
  /bin/sleep 0.01
done
printf 'RTM_DELADDR: test\\n'
exec /bin/sleep 30'''
        )
        try:
            (self.root / "state").write_text("down")
            elapsed = self.observe_block(2)
            self.assertIsNotNone(elapsed, "Address removal event was not handled")
            self.assertLess(elapsed, 1.5, "Route event waited for the ten-second fallback")
        finally:
            self.stop_loop(process)

    def test_silent_monitor_keeps_ten_second_fallback(self):
        process = self.start_loop("exec /bin/sleep 30")
        try:
            time.sleep(0.2)
            (self.root / "state").write_text("down")
            elapsed = self.observe_block(10.6)
            self.assertIsNotNone(elapsed, "Silent event source disabled the fallback")
            self.assertGreater(elapsed, 8)
            self.assertIsNone(process.poll())
        finally:
            self.stop_loop(process)

    def test_missing_empty_and_invalid_lists_preserve_protection(self):
        hosts = self.run_commands('''printf down > "$STATEFILE"
sync_state
cp "$HOSTS" "$1/expected"
rm "$CONF"
sync_state
cmp -s "$HOSTS" "$1/expected" || exit 11
: > "$CONF"
sync_state
cmp -s "$HOSTS" "$1/expected" || exit 12
printf '*.invalid.example\n' > "$CONF"
sync_state
cmp -s "$HOSTS" "$1/expected" || exit 13
''')
        self.assertIn(b"0.0.0.0 openai.com # tun-guard\n", hosts)

    def test_missing_list_after_restart_keeps_existing_hosts(self):
        hosts = self.run_commands('''printf down > "$STATEFILE"
sync_state
cp "$HOSTS" "$1/expected"
rm "$CONF"
WANT=""; CONF_SIG="__init__"
sync_state
cmp -s "$HOSTS" "$1/expected" || exit 14
''')
        self.assertIn(b":: openai.com # tun-guard\n", hosts)

    def test_valid_list_changes_and_tun_enable_restore_hosts(self):
        hosts = self.run_commands('''printf down > "$STATEFILE"
sync_state
printf 'gemini.google.com\n' > "$CONF"
sync_state
grep -q '0.0.0.0 gemini.google.com # tun-guard' "$HOSTS" || exit 15
grep -q openai.com "$HOSTS" && exit 16
printf up > "$STATEFILE"
sync_state
''')
        self.assertEqual(hosts, self.baseline)


if __name__ == "__main__":
    unittest.main(verbosity=2)
