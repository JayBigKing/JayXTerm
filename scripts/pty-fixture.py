"""POSIX-only real Bash PTY for terminal wrapping/readline regression tests."""
import base64
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios

cols, rows = map(int, sys.argv[1:3])
def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

pid, fd = pty.fork()
if pid == 0:
    resize(0, cols, rows)
    env = dict(os.environ, TERM='xterm-256color', HISTFILE='/dev/null', PROMPT_COMMAND='', PS1=r'\[\e[31m\]qa@host:/project/long/path/to/terminal-regression\[\e[0m\] $ ')
    os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-i'], env)

resize(fd, cols, rows)
selector = selectors.DefaultSelector()
selector.register(fd, selectors.EVENT_READ)
selector.register(sys.stdin, selectors.EVENT_READ)
try:
    while True:
        for key, _ in selector.select():
            if key.fileobj == sys.stdin:
                line = sys.stdin.readline()
                if not line:
                    sys.exit(0)
                message = json.loads(line)
                if message['type'] == 'resize':
                    resize(fd, message['cols'], message['rows'])
                    os.kill(pid, signal.SIGWINCH)
                else:
                    os.write(fd, base64.b64decode(message['data']))
            else:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    sys.exit(0)
                if not data:
                    sys.exit(0)
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
