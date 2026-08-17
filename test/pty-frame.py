#!/usr/bin/env python3
"""Cattura i frame del deck da uno pseudo-terminale di dimensioni note.

Serve al gate di larghezza (`frame-width.test.ts`): Ink renderizza solo su un
TTY vero e la larghezza del frame dipende da `stdout.columns`, quindi una pipe
non basta. `script(1)` non è utilizzabile (mangia la geometria), da cui
`pty.openpty` + `TIOCSWINSZ` a mano.

Uso: pty-frame.py <cols> <rows> <cwd> <cmd...> [--keys <sequenza>]
     dove <sequenza> usa D/U/R/L per le frecce, X per un incollaggio, e ogni
     altro carattere è digitato.
Stampa su stdout i byte grezzi letti dal pty.
"""
import os
import pty
import fcntl
import termios
import struct
import subprocess
import sys
import time
import select
import signal

# 'T' = tab, l'unico tasto che sposta il focus fra i due pane da T100 in poi:
# le frecce orizzontali sono passate al selettore di vista dell'header.
# 'X' = INCOLLAGGIO: 60 caratteri in una scrittura sola, cioè un chunk unico di
# stdin. Riempie un campo di testo oltre il budget al costo di UN tasto (una
# `x` per volta costerebbe 60 pump da 0.7s), ed è anche l'unico modo di provare
# dal gate la strada che `useInput` percorre davvero su un paste.
KEYS = {'D': b'\x1b[B', 'U': b'\x1b[A', 'R': b'\x1b[C', 'L': b'\x1b[D', 'T': b'\t', 'X': b'x' * 60}

argv = sys.argv[1:]
keys = ''
if '--keys' in argv:
    i = argv.index('--keys')
    keys = argv[i + 1]
    argv = argv[:i] + argv[i + 2:]

cols, rows, cwd, cmd = int(argv[0]), int(argv[1]), argv[2], argv[3:]

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

env = dict(os.environ, TERM='xterm-256color', COLUMNS=str(cols), LINES=str(rows))
proc = subprocess.Popen(
    cmd, stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env, preexec_fn=os.setsid
)
os.close(slave)

buf = b''


def pump(seconds):
    global buf
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                buf += os.read(master, 65536)
            except OSError:
                return


pump(4)
for k in keys:
    os.write(master, KEYS.get(k, k.encode()))
    pump(0.7)
pump(1.0)

os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
sys.stdout.buffer.write(buf)
