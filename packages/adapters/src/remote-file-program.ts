/** Fixed, non-model-authored Linux file driver. Payload/output use a private channel. */
export const remoteFileProgram = String.raw`import os, sys, json, base64, hashlib, stat, uuid, ctypes, errno
MAX = 1048576
HASH = lambda value: hashlib.sha256(value).hexdigest()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('ascii')
class Refused(Exception):
    def __init__(self, code): self.code = code

def checked_uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value: raise Refused('invalid-binding')
    return value

def same_version(a, b): return a['sha256'] == b['sha256'] and a['metadataDigest'] == b['metadataDigest']
def same_displaced(a, b):
    return a['sha256'] == b['sha256'] and a['attributeDigest'] == b['attributeDigest'] and a['stable'] == b['stable']
def public_snapshot(value):
    return dict({key: value[key] for key in ('version', 'path', 'sha256', 'metadataDigest', 'attributeDigest',
        'executionUid', 'uid', 'gid', 'mode', 'size', 'device', 'inode', 'commitSupported', 'limitation')},
        contentBase64=base64.b64encode(value['data']).decode('ascii'))

class LinuxFiles:
    def __init__(self, request):
        if sys.platform != 'linux': raise Refused('unsupported-platform')
        import fcntl, struct
        self.fcntl, self.struct = fcntl, struct
        self.request, self.parent, self.backup = request, None, None
        self.created, self.exchanged, self.staged_identity = False, False, None
        path = request['path']
        if not isinstance(path, str) or not path.startswith('/') or path.startswith('//') or '\x00' in path or os.path.normpath(path) != path:
            raise Refused('invalid-path')
        parts = path.split('/')[1:]
        if not parts or not parts[-1] or any(part in ('.', '..') for part in parts): raise Refused('invalid-path')
        self.parts, self.name = parts, parts[-1]
        self.parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.parent)
                os.close(self.parent); self.parent = next_fd
            self.uid = os.geteuid()
            if request.get('root') and self.uid != 0: raise Refused('root-identity-unconfirmed')
            if request.get('expectedExecutionUid') is not None and request['expectedExecutionUid'] != self.uid:
                raise Refused('execution-identity-changed')
            self.exchange_fn = getattr(ctypes.CDLL(None, use_errno=True), 'renameat2', None)
            self.full = False
            fs_type = (ctypes.c_long * 32)()
            libc = ctypes.CDLL(None, use_errno=True)
            local_fs = libc.fstatfs(self.parent, ctypes.byref(fs_type)) == 0 and (fs_type[0] & 0xffffffff) in (0xef53, 0x58465342)
            try:
                with open('/proc/self/status', 'r', encoding='ascii') as stream:
                    cap = next(line.split()[1] for line in stream if line.startswith('CapEff:'))
                self.full = local_fs and self.uid == 0 and bool(int(cap, 16) & (1 << 21))
            except Exception: pass
        except Exception:
            self.close(); raise
    def directory(self, create=False):
        if self.backup is not None: return self.backup
        identifier = checked_uuid(self.request.get('backupTransactionId') or self.request['transactionId'])
        self.dirname = '.cloudhelm-edit-' + identifier
        if create:
            os.mkdir(self.dirname, 0o700, dir_fd=self.parent); self.created = True
        self.backup = os.open(self.dirname, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.parent)
        entry = os.fstat(self.backup)
        if entry.st_uid != self.uid or stat.S_IMODE(entry.st_mode) != 0o700 or entry.st_dev != os.fstat(self.parent).st_dev:
            raise Refused('unsafe-recovery-directory')
        return self.backup
    def snapshot(self, backup=False):
        directory, name = (self.directory(), 'entry') if backup else (self.parent, self.name)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX:
                raise Refused('not-a-bounded-single-link-file')
            data = bytearray()
            while len(data) <= MAX:
                chunk = os.read(fd, min(65536, MAX + 1 - len(data)))
                if not chunk: break
                data.extend(chunk)
            if len(data) > MAX: raise Refused('file-too-large')
            attrs, flags, complete = {}, 0, self.full
            try:
                names = os.listxattr(fd)
                if len(names) > 128: raise Refused('metadata-too-large')
                total = 0
                for name in names:
                    value = os.getxattr(fd, name); total += len(os.fsencode(name)) + len(value)
                    if total > 65536: raise Refused('metadata-too-large')
                    attrs[name] = value
                flags = self.struct.unpack('L', self.fcntl.ioctl(fd, 0x80086601, self.struct.pack('L', 0)))[0]
                extended = self.struct.unpack('=IIIII8s', self.fcntl.ioctl(fd, 0x801c581f, bytes(28)))
                if extended[0] & ~0x80000000 or extended[1] or extended[3] or extended[4]:
                    raise Refused('unsupported-project-or-allocation-metadata')
            except Refused: raise
            except Exception: complete = False
            after = os.fstat(fd)
            signature = lambda item: [str(item.st_dev), str(item.st_ino), item.st_size, item.st_mtime_ns, item.st_ctime_ns,
                item.st_uid, item.st_gid, stat.S_IMODE(item.st_mode), item.st_nlink]
            if signature(before) != signature(after) or len(data) != after.st_size: raise Refused('source-changed-during-read')
            attr_list = sorted([[base64.b64encode(os.fsencode(key)).decode(), base64.b64encode(value).decode()] for key, value in attrs.items()])
            attribute = HASH(canonical([after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), flags, attr_list]))
            limitation = ''
            if not complete: limitation = 'complete-metadata-requires-root-CAP_SYS_ADMIN-and-xattr/flags-support'
            elif flags & ~0x80000: limitation = 'unsupported-inode-flags'
            elif stat.S_IMODE(after.st_mode) & 0o7000: limitation = 'special-permission-bits-require-manual-handling'
            elif any(key in attrs for key in ('security.capability', 'security.ima', 'security.evm')):
                limitation = 'integrity-or-capability-attributes-require-manual-handling'
            elif self.exchange_fn is None: limitation = 'atomic-exchange-unavailable'
            return {'version': 1, 'path': self.request['path'], 'data': bytes(data), 'sha256': HASH(data),
                'metadataDigest': HASH(canonical([signature(after), attribute])), 'attributeDigest': attribute,
                'executionUid': self.uid, 'uid': after.st_uid, 'gid': after.st_gid, 'mode': stat.S_IMODE(after.st_mode),
                'size': len(data), 'device': str(after.st_dev), 'inode': str(after.st_ino),
                'commitSupported': not limitation, 'limitation': limitation, 'attrs': attrs,
                'stable': [str(after.st_dev), str(after.st_ino), after.st_size, after.st_mtime_ns, attribute]}
        finally: os.close(fd)
    def stage(self, content, original):
        if not original['commitSupported']: raise Refused(original['limitation'])
        fd = os.open('entry', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.directory(True))
        try:
            entry = os.fstat(fd); self.staged_identity = (entry.st_dev, entry.st_ino)
            view = memoryview(content)
            while view:
                written = os.write(fd, view)
                if written <= 0: raise Refused('staging-write-failed')
                view = view[written:]
            os.fchown(fd, original['uid'], original['gid']); os.fchmod(fd, original['mode'])
            for name in os.listxattr(fd):
                if name not in original['attrs']: os.removexattr(fd, name)
            for name, value in original['attrs'].items(): os.setxattr(fd, name, value)
            os.fsync(fd)
        finally: os.close(fd)
        staged = self.snapshot(True)
        if staged['attributeDigest'] != original['attributeDigest'] or staged['sha256'] != HASH(content):
            raise Refused('staged-metadata-or-content-mismatch')
        return staged
    def check_paths(self):
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in self.parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = next_fd
            identity = lambda item: (item.st_dev, item.st_ino)
            if identity(os.fstat(fd)) != identity(os.fstat(self.parent)): raise Refused('parent-path-changed')
            if self.backup is not None and identity(os.stat(self.dirname, dir_fd=self.parent, follow_symlinks=False)) != identity(os.fstat(self.backup)):
                raise Refused('recovery-directory-changed')
        finally: os.close(fd)
    def exchange(self):
        self.check_paths()
        fn = self.exchange_fn
        if fn is None: raise Refused('atomic-exchange-unavailable')
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        if fn(self.directory(), b'entry', self.parent, os.fsencode(self.name), 2) != 0:
            raise Refused('atomic-exchange-failed-' + str(ctypes.get_errno()))
        self.exchanged = True
    def flush(self):
        self.check_paths(); os.fsync(self.parent); os.fsync(self.directory())
    def cleanup(self):
        if not self.created or self.exchanged: return
        if self.backup is not None:
            try:
                entry = os.stat('entry', dir_fd=self.backup, follow_symlinks=False)
                if self.staged_identity != (entry.st_dev, entry.st_ino): raise Refused('staged-entry-changed')
                os.unlink('entry', dir_fd=self.backup)
            except FileNotFoundError: pass
            os.close(self.backup); self.backup = None
        os.rmdir(self.dirname, dir_fd=self.parent); self.created = False
    def close(self):
        for name in ('backup', 'parent'):
            fd = getattr(self, name, None)
            if fd is not None: os.close(fd); setattr(self, name, None)

def transaction(request, files):
    published = False
    try:
        original = files.snapshot()
        if request['action'] == 'inspect': return {'status': 'inspected', 'snapshot': public_snapshot(original)}
        if request['action'] == 'inspect-backup': return {'status': 'inspected', 'snapshot': public_snapshot(files.snapshot(True))}
        if not original['commitSupported']: raise Refused(original['limitation'])
        if original['sha256'] != request['expectedSha256'] or original['metadataDigest'] != request['expectedMetadataDigest']:
            raise Refused('source-version-or-metadata-changed')
        content = base64.b64decode(request['contentBase64'], validate=True)
        if len(content) > MAX: raise Refused('file-too-large')
        if request['action'] == 'apply': candidate = files.stage(content, original)
        elif request['action'] == 'restore':
            candidate = files.snapshot(True)
            if candidate['metadataDigest'] != request['expectedBackupMetadataDigest'] or candidate['sha256'] != HASH(content):
                raise Refused('recovery-version-or-metadata-changed')
        else: raise Refused('invalid-action')
        if not candidate['commitSupported'] or candidate['sha256'] != HASH(content): raise Refused('candidate-unverifiable')
        if not same_version(original, files.snapshot()): raise Refused('source-changed-before-exchange')
        files.exchange(); published = True
        displaced, current = files.snapshot(True), files.snapshot()
        if not same_displaced(original, displaced) or current['inode'] != candidate['inode'] or current['device'] != candidate['device']:
            raise Refused('concurrent-path-change-after-exchange')
        if current['sha256'] != HASH(content) or current['attributeDigest'] != candidate['attributeDigest']:
            raise Refused('read-back-metadata-or-content-mismatch')
        files.flush()
        return {'status': 'committed', 'snapshot': public_snapshot(current), 'recovery': {'version': 1,
            'directoryId': request.get('backupTransactionId') or request['transactionId'], 'path': request['path'],
            'beforeSha256': displaced['sha256'], 'beforeMetadataDigest': displaced['metadataDigest'],
            'afterSha256': current['sha256'], 'afterMetadataDigest': current['metadataDigest']}}
    except Exception as error:
        published = published or getattr(files, 'exchanged', False)
        clean = False
        if not published:
            try: files.cleanup(); clean = True
            except Exception: pass
        return {'status': 'unknown' if published or not clean else 'refused', 'code': error.code if isinstance(error, Refused)
            else 'filesystem-operation-failed', 'effects': 'possible' if published or not clean else 'none'}
    finally: files.close()

def main():
    nonce = sys.argv[1] if len(sys.argv) == 2 else ''
    try:
        if len(nonce) != 32 or any(c not in '0123456789abcdef' for c in nonce): return
        if sys.stdin.isatty():
            import tty
            tty.setraw(sys.stdin.fileno())
        print(json.dumps({'ready': nonce}), flush=True)
        line = sys.stdin.buffer.readline(2 * MAX + 1)
        if not line.endswith(b'\n') or len(line) > 2 * MAX: raise Refused('request-too-large')
        request = json.loads(line)
        if request.get('nonce') != nonce or request.get('version') != 1: raise Refused('invalid-binding')
        checked_uuid(request['transactionId'])
        if request.get('backupTransactionId'): checked_uuid(request['backupTransactionId'])
        if request.get('action') not in ('inspect', 'inspect-backup', 'apply', 'restore'): raise Refused('invalid-action')
        result = transaction(request, LinuxFiles(request))
        print(json.dumps({'nonce': nonce, **result}, ensure_ascii=True, separators=(',', ':')), flush=True)
    except Exception as error:
        print(json.dumps({'nonce': nonce, 'status': 'refused', 'effects': 'none',
            'code': error.code if isinstance(error, Refused) else 'unsupported-or-unavailable'}), flush=True)
if __name__ == '__main__': main()
`;
