import { remoteCommandProgram } from './remote-command-program.js';

// These programs are application-owned constants, never model-generated scripts.
export const suRootProgram = String.raw`
import base64, json, os, signal, socket, subprocess, sys, threading
if os.getuid() != 0: sys.exit(1)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
try: os.setsid()
except OSError: pass
# Credentials can only enter su's controlling TTY. No payload inherits that TTY.
null = os.open('/dev/null', os.O_RDWR)
for fd in (0, 1, 2): os.dup2(null, fd)
if null > 2: os.close(null)
link = socket.socket(socket.AF_UNIX)
link.connect(sys.argv[1])
lock = threading.Lock()
def emit(value):
    with lock: link.sendall((json.dumps(value) + '\n').encode())
emit({'type': 'ready', 'uid': os.getuid()})
process = None
reader = None
program = base64.b64decode(sys.argv[2]).decode()
def forward(child):
    try:
        for line in child.stdout:
            emit({'type': 'output', 'data': line.decode('utf-8', 'replace')})
    except OSError: pass
try:
    for line in link.makefile('rb'):
        if len(line) > 1048576: break
        message = json.loads(line)
        if message.get('type') == 'start':
            if process:
                process.stdin.close()
                process.wait(timeout=3)
                reader.join(timeout=3)
            process = subprocess.Popen([sys.executable, '-I', '-u', '-c', program, '--serve'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
            reader = threading.Thread(target=forward, args=(process,), daemon=True)
            reader.start()
        elif message.get('type') == 'control' and process:
            process.stdin.write(message['data'].encode())
            process.stdin.flush()
        elif message.get('type') == 'end' and process:
            if not process.stdin.closed: process.stdin.close()
        else: break
finally:
    if process and not process.stdin.closed: process.stdin.close()
    link.close()
`;

export const suSessionProgram = String.raw`#!/usr/bin/env python3
import base64, fcntl, json, os, pty, select, shlex, signal, socket, struct, subprocess, sys, termios, time
ROOT = '${Buffer.from(suRootProgram).toString('base64')}'
COMMAND = '${Buffer.from(remoteCommandProgram).toString('base64')}'
def emit(value):
    sys.stdout.write(json.dumps(value) + '\n'); sys.stdout.flush()
server = socket.socket(socket.AF_UNIX)
location = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'root.sock')
server.bind(location); os.chmod(location, 0o600); server.listen(1)
master, slave = pty.openpty()
def setup():
    os.setsid(); fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
bootstrap = 'import base64;exec(compile(base64.b64decode(' + repr(ROOT) + '),"<cloudhelm-root>","exec"))'
command = ' '.join(shlex.quote(arg) for arg in [sys.executable, '-I', '-u', '-c', bootstrap, location, COMMAND])
process = subprocess.Popen(['/usr/bin/su', '-s', '/bin/sh', 'root', '-c', command],
    stdin=slave, stdout=slave, stderr=slave, env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL':'C'}, preexec_fn=setup, close_fds=True)
peer = None
ready = False
waiting = False
attempts = 0
prompt = b''
incoming = b''
remote = b''
deadline = time.monotonic() + 120
try:
    while True:
        if not ready and (time.monotonic() > deadline or process.poll() is not None): raise ValueError('Authentication ended')
        watched = [sys.stdin.fileno(), peer if peer else server]
        if not ready: watched.append(master)
        readable, _, _ = select.select(watched, [], [], 0.1)
        for source in readable:
            if source is server:
                candidate, _ = server.accept()
                _, uid, _ = struct.unpack('3i', candidate.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != 0: candidate.close(); raise ValueError('Wrong peer')
                peer = candidate
            elif source == master:
                chunk = os.read(master, 4096)
                if not chunk: raise ValueError('Authentication closed')
                prompt = (prompt + chunk)[-4096:]
                if not waiting and prompt.rstrip().endswith(b'Password:'):
                    if termios.tcgetattr(slave)[3] & termios.ECHO or attempts >= 3: raise ValueError('Unsafe authentication')
                    attempts += 1; waiting = True; prompt = b''
                    emit({'type': 'auth', 'id': str(attempts)})
            elif source is peer:
                chunk = peer.recv(65536)
                if not chunk: raise ValueError('Root channel closed')
                remote += chunk
                if len(remote) > 1048576: raise ValueError('Invalid frame')
                while b'\n' in remote:
                    line, remote = remote.split(b'\n', 1)
                    event = json.loads(line)
                    if not ready:
                        if event != {'type':'ready', 'uid':0}: raise ValueError('Root identity not verified')
                        ready = True; waiting = False; prompt = b''
                        emit({'type':'ready', 'uid':0})
                    else: emit(event)
            else:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk: raise ValueError('Controller closed')
                incoming += chunk
                if len(incoming) > 1048576: raise ValueError('Invalid control')
                while b'\n' in incoming:
                    line, incoming = incoming.split(b'\n', 1)
                    message = json.loads(line)
                    if message.get('type') == 'answer':
                        if ready or not waiting or message.get('id') != str(attempts): continue
                        answer = message.get('answer')
                        if not isinstance(answer, str) or len(answer) > 4095 or any(c in answer for c in '\r\n\0'): raise ValueError('Authentication canceled')
                        if process.poll() is not None or termios.tcgetattr(slave)[3] & termios.ECHO: raise ValueError('Authentication stale')
                        waiting = False
                        os.write(master, answer.encode() + b'\n')
                        answer = None; message = None; line = b''
                    elif ready: peer.sendall(line + b'\n')
                    else: raise ValueError('Not authenticated')
except Exception:
    emit({'type':'error', 'message':'Root session ended; verify remote outcomes before retrying.'})
finally:
    if peer: peer.close()
    if not ready and process.poll() is None:
        try: os.killpg(process.pid, signal.SIGTERM)
        except OSError: pass
    os.close(master); os.close(slave); server.close()
    try: os.unlink(location)
    except OSError: pass
`;
