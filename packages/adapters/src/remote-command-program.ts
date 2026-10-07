/** Fixed transport component. Business commands and credentials are data, never generated shell scripts. */
export const remoteCommandProgram = String.raw`#!/usr/bin/env python3
import base64, codecs, fcntl, json, os, pty, pwd, select, signal, socket, struct, subprocess, sys, termios, threading, time, uuid

def askpass():
    client = socket.socket(socket.AF_UNIX)
    client.settimeout(125)
    try:
        client.connect(os.environ['CLOUDHELM_AUTH_SOCKET'])
        client.sendall((os.environ['CLOUDHELM_AUTH_TOKEN'] + '\n').encode())
        response = json.loads(client.makefile('rb').readline(16384))
        if not isinstance(response, str): return 1
        sys.stdout.write(response + '\n')
        sys.stdout.flush()
        return 0
    except Exception:
        return 1
    finally:
        client.close()

if len(sys.argv) < 2 or sys.argv[1] != '--serve':
    sys.exit(askpass())

output_lock = threading.Lock()
state_lock = threading.Lock()
finished = threading.Event()
pending = {}
process = None
master = None
slave = None

def emit(value):
    with output_lock:
        sys.stdout.write(json.dumps(value, ensure_ascii=True) + '\n')
        sys.stdout.flush()

def authenticate(client, token):
    challenge = None
    try:
        client.settimeout(125)
        offered = client.makefile('rb').readline(256).decode().strip()
        with state_lock:
            if offered != token or finished.is_set() or process.poll() is not None or pending:
                client.sendall(b'null\n')
                return
            challenge = uuid.uuid4().hex
            entry = {'event': threading.Event(), 'answer': None}
            pending[challenge] = entry
        emit({'type': 'auth', 'id': challenge})
        entry['event'].wait(120)
        # This socket belongs only to sudo's askpass child, never to the payload's stdin.
        client.sendall((json.dumps(entry['answer']) + '\n').encode())
    except Exception:
        pass
    finally:
        if challenge:
            with state_lock:
                pending.pop(challenge, None)
            emit({'type': 'auth-close', 'id': challenge})
        client.close()

def auth_loop(server, token):
    server.settimeout(0.1)
    while not finished.is_set():
        try:
            client, _ = server.accept()
            threading.Thread(target=authenticate, args=(client, token), daemon=True).start()
        except socket.timeout:
            pass
        except OSError:
            break

def read_output():
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    def take(data):
        text = decoder.decode(data)
        if text: emit({'type': 'data', 'data': text})
    try:
        quiet = 0
        # The parent keeps the slave open until the transport closes, so output written
        # just before the payload exits cannot be discarded by a racing slave close.
        # Two idle reads after the exit still outwait a delayed tty buffer flush.
        while quiet < 2:
            if select.select([master], [], [], 0.1)[0]:
                quiet = 0
                try: data = os.read(master, 8192)
                except OSError: break
                if not data: break
                take(data)
            elif process.poll() is not None:
                quiet += 1
        tail = decoder.decode(b'', final=True)
        if tail: emit({'type': 'data', 'data': tail})
        code = process.wait()
        emit({'type': 'exit', 'code': code if code >= 0 else 128 - code})
    finally:
        finished.set()
        with state_lock:
            for entry in pending.values(): entry['event'].set()

server = None
socket_path = None
try:
    header = b''
    while not header.endswith(b'\n'):
        part = os.read(sys.stdin.fileno(), 1)
        if not part or len(header) >= 1048576: raise ValueError('Missing launch request')
        header += part
    launch = json.loads(header)
    argv = launch['argv']
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) and '\0' not in arg for arg in argv):
        raise ValueError('Invalid process arguments')
    environment = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME') if key in os.environ}
    environment.update(PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG='C.UTF-8', LC_ALL='C.UTF-8', TERM='xterm-256color', PAGER='cat', GIT_PAGER='cat', SYSTEMD_PAGER='cat', SYSTEMD_PAGERSECURE='1', GIT_TERMINAL_PROMPT='0', GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='core.quotepath', GIT_CONFIG_VALUE_0='false')
    user = pwd.getpwuid(os.getuid())
    cwd = launch['cwd']
    directory = '~' + cwd[len(user.pw_dir):] if cwd == user.pw_dir or cwd.startswith(user.pw_dir + '/') else cwd
    # Full remote identity and directory are presentation only, never captured as process output.
    label = lambda value: ''.join(char for char in value if ord(char) >= 32 and ord(char) != 127)
    prompt = '\x1b[01;32m' + label(user.pw_name + '@' + socket.gethostname().split('.')[0]) + '\x1b[00m:\x1b[01;34m' + label(directory) + '\x1b[00m' + ('# ' if os.getuid() == 0 else '$ ')
    emit({'type': 'prompt', 'data': prompt})
    if isinstance(launch.get('command'), str):
        emit({'type': 'display', 'data': '\r\x1b[2K' + prompt + launch['command'].replace('\n', '\r\n') + '\r\n'})
    token = uuid.uuid4().hex
    if launch.get('sudo'):
        if os.path.basename(argv[0]) != 'sudo': raise ValueError('Invalid authentication recipient')
        socket_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'auth-' + token)
        server = socket.socket(socket.AF_UNIX)
        server.bind(socket_path)
        os.chmod(socket_path, 0o600)
        server.listen(1)
        environment.update(SUDO_ASKPASS=os.path.abspath(__file__), CLOUDHELM_AUTH_SOCKET=socket_path, CLOUDHELM_AUTH_TOKEN=token)
        # Standard sudo askpass mode; sudo still authorizes the exact target executable, not a root shell.
        argv = [argv[0], '-A'] + argv[1:]
    master, slave = pty.openpty()
    rows, cols = int(launch.get('rows', 30)), int(launch.get('cols', 100))
    if 1 <= rows <= 1000 and 1 <= cols <= 1000:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    def child_session():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    process = subprocess.Popen(argv, cwd=launch['cwd'], env=environment, stdin=slave, stdout=slave, stderr=slave,
                               close_fds=True, preexec_fn=child_session)
    # The slave descriptor stays open here on purpose: closing it while the payload's last
    # writes are still in the tty buffer can make the master read miss that output entirely.
    if server: threading.Thread(target=auth_loop, args=(server, token), daemon=True).start()
    threading.Thread(target=read_output, daemon=True).start()
    # Unbuffered reads avoid a control message remaining in Python's read-ahead buffer.
    incoming = b''
    while not finished.is_set():
        ready, _, _ = select.select([sys.stdin.fileno()], [], [], 0.1)
        if not ready: continue
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk: break
        incoming += chunk
        if len(incoming) > 1048576: raise ValueError('Control message too large')
        while b'\n' in incoming:
            line, incoming = incoming.split(b'\n', 1)
            message = json.loads(line)
            kind = message.get('type')
            if kind == 'input':
                data = base64.b64decode(message['data'])
                if data == b'\x03': os.killpg(process.pid, signal.SIGINT)
                else: os.write(master, data)
            elif kind == 'resize':
                rows, cols = int(message['rows']), int(message['cols'])
                if 1 <= rows <= 1000 and 1 <= cols <= 1000:
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            elif kind == 'answer':
                with state_lock:
                    entry = pending.get(message.get('id'))
                    answer = message.get('answer')
                    if entry and not entry['event'].is_set() and (answer is None or (isinstance(answer, str) and len(answer) <= 4095 and not any(c in answer for c in '\r\n\0'))):
                        entry['answer'] = answer
                        entry['event'].set()
except (FileNotFoundError, PermissionError):
    if process is None:
        emit({'type': 'launch-error', 'kind': 'permission-denied' if isinstance(sys.exc_info()[1], PermissionError) else 'unsupported'})
    else: emit({'type': 'error', 'message': 'Command transport failed; verify remote outcome.'})
except Exception:
    # Do not serialize exceptions or control messages: they might contain credentials.
    emit({'type': 'error', 'message': 'Direct command transport failed; verify the remote outcome before retrying.'})
finally:
    finished.set()
    with state_lock:
        for entry in pending.values(): entry['event'].set()
    if server: server.close()
    if socket_path:
        try: os.unlink(socket_path)
        except OSError: pass
    if master is not None: os.close(master)
    if slave is not None: os.close(slave)
    # Closing a transport does not prove the payload stopped. Never automatically kill or replay it.
`;
