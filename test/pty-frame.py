#!/usr/bin/env python3
"""Cattura i frame del deck da uno pseudo-terminale di dimensioni note.

Serve al gate di larghezza (`frame-width.test.ts`): Ink renderizza solo su un
TTY vero e la larghezza del frame dipende da `stdout.columns`, quindi una pipe
non basta. `script(1)` non è utilizzabile (mangia la geometria), da cui
`pty.openpty` + `TIOCSWINSZ` a mano.

Uso: pty-frame.py <cols> <rows> <cwd> <cmd...> [--keys <sequenza>]
     dove <sequenza> usa D/U/R/L per le frecce, X per un incollaggio,
     `@<col>,<riga>;` per un click del mouse, `^<col>,<riga>;` / `_<col>,<riga>;`
     per una tacca di rotella su / giù, e ogni altro carattere è digitato.
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

# Le forme MOUSE, per carattere di apertura: la lista di (bottone, M|m) da
# emettere per un token `<ch><col>,<riga>;`. Il click è due eventi, pressione
# e rilascio; la ROTELLA è uno solo — i terminali la mandano come sola
# pressione (codice 64 su, 65 giù), e un driver che aggiungesse il rilascio
# proverebbe una grammatica che nessun terminale parla. `^` e `_` sono scelti
# come `<` e `>`: fuori dalle lettere, che restano libere per un binding futuro.
MOUSE = {
    '@': [(0, b'M'), (0, b'm')],
    '^': [(64, b'M')],
    '_': [(65, b'M')],
}


def tokenize(keys):
    """Sequenza `--keys` → lista di byte da scrivere, un elemento per pump.

    I tasti sono a carattere singolo, ma un evento mouse porta con sé due
    coordinate e nessun carattere le può esprimere: da qui la forma
    `<ch><col>,<riga>;` (`@` click, `^`/`_` rotella), gli unici token del
    linguaggio a lunghezza variabile. Il click emette la coppia
    pressione+rilascio (`M` e `m`) come fa un terminale vero — un deck che
    agisse anche sul rilascio spawnerebbe due volte, e uno scenario che mandasse
    la sola pressione non se ne accorgerebbe.
    """
    out, i = [], 0
    while i < len(keys):
        ch = keys[i]
        if ch in MOUSE:
            end = keys.index(';', i)
            col, row = (int(v) for v in keys[i + 1:end].split(','))
            out.extend(b'\x1b[<%d;%d;%d%s' % (b, col, row, kind) for b, kind in MOUSE[ch])
            i = end + 1
            continue
        out.append(KEYS.get(ch, ch.encode()))
        i += 1
    return out


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


def echo_on():
    """L'eco del pty e' ancora acceso, cioe' nessuno ha messo il tty in raw mode.

    La termios appartiene alla COPPIA master/slave, quindi si legge dal master
    senza toccare il processo figlio.
    """
    try:
        return bool(termios.tcgetattr(master)[3] & termios.ECHO)
    except OSError:
        return False


def pump_until_raw(seconds):
    global buf
    deadline = time.time() + seconds
    while echo_on() and time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                buf += os.read(master, 65536)
            except OSError:
                return
    return


def pump_until_quiet(idle, cap):
    """Aspetta che il deck smetta di ridisegnare: `idle` secondi senza un byte.

    Un deck fermo non scrive nulla — i poll hanno un gate a monte e ridisegnano
    solo quando il dato cambia — quindi la quiete e' raggiungibile e significa
    che i dati asincroni dell'avvio sono arrivati tutti.
    """
    global buf
    deadline = time.time() + cap
    last = time.time()
    while time.time() < deadline and time.time() - last < idle:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if chunk:
                buf += chunk
                last = time.time()


pump(4)
# I tasti si scrivono solo dopo che il tty e' in RAW MODE, non dopo un'attesa
# fissa. Finche' non lo e', il pty ECHEGGIA quello che gli si scrive: un `^O`
# finisce nel buffer come testo, la riga catturata esce di due colonne e il gate
# rosseggia su una larghezza che il deck non ha mai disegnato.
#
# Il frame non e' il segnale: il deck CHIUDE il primo frame molto prima di
# entrare in raw mode (misurato: 0,9s contro 3,5s), perche' Ink monta `useInput`
# dopo il primo paint. Quattro secondi coprono quel divario a macchina scarica e
# non lo coprono quando la suite gira in parallelo su 37 file, da cui un rosso
# che compariva solo sotto carico e spariva rilanciando il singolo test.
#
# Il segnale vero e' il flag ECHO della termios, che si legge dal master. Il
# tetto e' generoso perche' l'attesa non costa: chi e' gia' in raw mode esce
# subito, e chi non ci entra mai fallisce comunque a valle, sul frame mancante.
pump_until_raw(20)
# E dopo la raw mode, la QUIETE: i dati che il deck carica in asincrono (le date
# di ultimo commit dei task file, i sensori) arrivano dopo il primo frame e
# RIORDINANO le liste. Una sequenza che clicca due volte la stessa riga di
# schermo aspettandosi lo stesso oggetto misura allora due oggetti diversi — il
# secondo click risulta il primo su una riga nuova, e l'azione che si voleva
# provare non parte. Anche qui il rosso compare solo a macchina carica, dove il
# riordino cade dopo il primo tasto invece che prima.
pump_until_quiet(0.5, 10)
for chunk in tokenize(keys):
    os.write(master, chunk)
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
