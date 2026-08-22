#!/usr/bin/env python3
"""Cattura i frame del deck da uno pseudo-terminale di dimensioni note.

Serve al gate di larghezza (`frame-width.test.ts`): Ink renderizza solo su un
TTY vero e la larghezza del frame dipende da `stdout.columns`, quindi una pipe
non basta. `script(1)` non è utilizzabile (mangia la geometria), da cui
`pty.openpty` + `TIOCSWINSZ` a mano.

Uso: pty-frame.py <cols> <rows> <cwd> <cmd...> [--keys <sequenza>]
     dove <sequenza> usa D/U/R/L per le frecce, X per un incollaggio, e ogni
     altro carattere è digitato.
Stampa su stdout i byte grezzi letti dal pty, seguiti da una riga
`<<PROC alive>>` o `<<PROC exit=N>>`: se il processo sia sopravvissuto alla
sequenza è un ESITO come il frame, e senza questa riga uno scenario che verifica
un'uscita non ha niente da leggere — il buffer di un deck morto e quello di un
deck vivo finiscono uguali.
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

# 'T' = tab, il selettore di vista dell'header; 'L'/'R' = frecce orizzontali,
# cioè il cambio pane ('L' = task, 'R' = sessioni). Chi scrive uno scenario deve
# guardare qui: la lettera dice il TASTO, non l'intenzione, e un rimappaggio
# lascia verde ogni scenario che continua a battere il tasto vecchio.
# 'X' = INCOLLAGGIO: 60 caratteri in una scrittura sola, cioè un chunk unico di
# stdin. Riempie un campo di testo oltre il budget al costo di UN tasto (una
# `x` per volta costerebbe 60 pump da 0.7s), ed è anche l'unico modo di provare
# dal gate la strada che `useInput` percorre davvero su un paste.
# 'K' = CANC (`\x1b[3~`), l'apertura della conferma di eliminazione. Serve una
# voce nella mappa perché la sequenza è di 4 byte: scritta dentro `--keys`
# arriverebbe come quattro tasti separati.
# '<' e '>' = PagUp e PagDn (`\x1b[5~` / `\x1b[6~`), lo scorrimento a pagina dei
# viewer. Servono una voce come 'K' perché la sequenza è di 4 byte; i due segni
# sono scelti fra i caratteri che il deck NON lega a nessuna azione, così una
# lettera resta libera per un binding futuro.
# 'W' = ATTESA: nessun byte scritto, ma il pump fra un tasto e l'altro avviene
# lo stesso (0.7s). È l'unico modo di far passare TEMPO dentro uno scenario, e
# serve a chi verifica una finestra che scade — es. i 5s del doppio `^C`, che
# otto 'W' superano. Un tasto vero non andrebbe bene: sposterebbe lo stato.
# I tasti CTRL non hanno voce qui: `\x03`, `\x06` … si scrivono nudi dentro
# `--keys`, perché ogni carattere fuori mappa viene digitato tale e quale.
KEYS = {
    'D': b'\x1b[B',
    'U': b'\x1b[A',
    'R': b'\x1b[C',
    'L': b'\x1b[D',
    'T': b'\t',
    'X': b'x' * 60,
    'K': b'\x1b[3~',
    '<': b'\x1b[5~',
    '>': b'\x1b[6~',
    'W': b'',
}

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

# Il verdetto di vitalità si prende PRIMA del kill, o lo cancellerebbe.
rc = proc.poll()
if rc is None:
    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    verdict = b'<<PROC alive>>'
else:
    verdict = b'<<PROC exit=%d>>' % rc

sys.stdout.buffer.write(buf)
sys.stdout.buffer.write(b'\n' + verdict + b'\n')
