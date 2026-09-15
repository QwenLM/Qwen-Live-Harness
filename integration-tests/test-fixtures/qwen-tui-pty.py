# Copyright 2026 Qwen
# SPDX-License-Identifier: Apache-2.0

"""Give an isolated test CLI a real terminal without using the user's terminal."""

import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
child = subprocess.Popen(
    sys.argv[1:],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    start_new_session=True,
)
os.close(slave)


def stop(*args):
    if child.poll() is None:
        child.terminate()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
stdin_open = True
try:
    while child.poll() is None:
        readers = [master]
        if stdin_open:
            readers.append(sys.stdin.fileno())
        ready, _, _ = select.select(readers, [], [], 0.2)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if data:
                os.write(sys.stdout.fileno(), data)
        if stdin_open and sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 4096)
            if data:
                os.write(master, data)
            else:
                stdin_open = False
    child.wait(timeout=5)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
sys.exit(child.returncode or 0)
