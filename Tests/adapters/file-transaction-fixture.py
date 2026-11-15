import sys, runpy, copy, json, hashlib, base64, types
m = runpy.run_path(sys.argv[1], run_name='fixed_file_driver_test')
H = lambda b: hashlib.sha256(b).hexdigest()
C = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
attrs = {'system.posix_acl_access': b'ACL', 'security.selinux': b'LABEL', 'trusted.private': b'opaque'}
def snapshot(data=b'old\n', inode='1', metadata='a', attributes=None):
    values = copy.deepcopy(attrs if attributes is None else attributes)
    attribute = H(C([37, 42, 0o640, [[key, base64.b64encode(value).decode()] for key, value in sorted(values.items())]]))
    return {'version': 1, 'path': '/srv/config', 'data': data, 'sha256': H(data), 'metadataDigest': metadata * 64,
        'attributeDigest': attribute, 'executionUid': 0, 'uid': 37, 'gid': 42, 'mode': 0o640, 'size': len(data),
        'device': '10', 'inode': inode, 'commitSupported': True, 'limitation': '', 'attrs': values,
        'stable': ['10', inode, len(data), H(data), attribute]}
class Files:
    def __init__(self, scenario='ok'):
        self.target, self.backup = snapshot(), None
        self.scenario, self.published, self.stages, self.exchanges, self.cleaned = scenario, False, 0, 0, False
    def snapshot(self, backup=False): return copy.deepcopy(self.backup if backup else self.target)
    def stage(self, content, original):
        self.stages += 1
        self.backup = snapshot(content, '2', 'b', original['attrs'])
        if self.scenario in ('stage-failure', 'cleanup-failure'): raise OSError('synthetic')
        if self.scenario == 'before-race': self.target = snapshot(b'external', '3', 'c')
        return self.snapshot(True)
    def exchange(self):
        self.exchanges += 1
        if self.scenario == 'exchange-unavailable': raise m['Refused']('atomic-exchange-unavailable')
        if self.scenario == 'exchange-race': self.target = snapshot(b'external', '3', 'c')
        self.target, self.backup = self.backup, self.target
        self.published = True
        if self.scenario == 'read-back-failure': self.target = snapshot(b'external after publish', '2', 'e')
    def flush(self):
        if self.scenario == 'flush-failure': raise OSError('synthetic')
    def cleanup(self):
        if self.scenario == 'cleanup-failure': raise OSError('synthetic')
        self.cleaned = True; self.backup = None
    def close(self): pass
request = {'version': 1, 'action': 'apply', 'path': '/srv/config', 'transactionId': '11111111-1111-4111-8111-111111111111',
    'expectedSha256': H(b'old\n'), 'expectedMetadataDigest': 'a' * 64, 'contentBase64': base64.b64encode(b'new\n').decode()}
run = m['transaction']
passed = []
f = Files(); result = run(request, f)
assert result['status'] == 'committed' and f.target['data'] == b'new\n' and f.backup['data'] == b'old\n'
assert f.target['attrs'] == attrs and f.backup['attrs'] == attrs and f.target['uid'] == 37 and f.target['gid'] == 42
passed.append('apply-and-private-metadata-backup')
restore = dict(request, action='restore', expectedSha256=f.target['sha256'], expectedMetadataDigest=f.target['metadataDigest'],
    backupTransactionId=request['transactionId'], expectedBackupMetadataDigest=f.backup['metadataDigest'], contentBase64=base64.b64encode(b'old\n').decode())
restored = run(restore, f)
assert restored['status'] == 'committed' and f.target['data'] == b'old\n' and f.target['attrs'] == attrs
passed.append('explicit-version-bound-restore')
f = Files(); changed = dict(request, expectedMetadataDigest='f' * 64)
assert run(changed, f)['effects'] == 'none' and f.stages == 0 and f.exchanges == 0
passed.append('metadata-conflict-zero-stage')
f = Files(); f.target['commitSupported'] = False; f.target['limitation'] = 'unsupported'
assert run(request, f)['effects'] == 'none' and f.stages == 0
passed.append('unknown-metadata-zero-stage')
for scenario in ('before-race', 'stage-failure', 'exchange-unavailable'):
    f = Files(scenario); result = run(request, f)
    assert result['status'] == 'refused' and result['effects'] == 'none' and f.cleaned
    assert f.target['data'] != b'new\n'
    passed.append(scenario)
for scenario in ('exchange-race', 'read-back-failure', 'flush-failure', 'cleanup-failure'):
    f = Files(scenario); result = run(request, f)
    assert result['status'] == 'unknown' and result['effects'] == 'possible'
    assert f.exchanges <= 1  # Never blindly exchange back over an external writer.
    passed.append(scenario)
f = Files(); f.backup = snapshot(b'changed backup', '9', 'f')
restore = dict(request, action='restore', backupTransactionId=request['transactionId'], expectedBackupMetadataDigest='d' * 64)
assert run(restore, f)['effects'] == 'none' and f.exchanges == 0
passed.append('changed-recovery-zero-exchange')
# Exercise the actual Linux staging implementation with a deterministic syscall port,
# including partial writes, inherited xattr removal and exact owner/mode restoration.
real_os = m['LinuxFiles'].stage.__globals__['os']
for reject_attribute in (False, True):
    state = {'data': bytearray(), 'uid': 0, 'gid': 0, 'mode': 0o600, 'attrs': {'inherited': b'no'}}
    def write(fd, data):
        size = min(2, len(data)); state['data'].extend(data[:size]); return size
    def set_attribute(fd, key, value):
        if reject_attribute: raise PermissionError('synthetic')
        state['attrs'][key] = value
    fake = types.SimpleNamespace(O_RDWR=2, O_CREAT=64, O_EXCL=128, O_NOFOLLOW=256,
        fstat=lambda fd: types.SimpleNamespace(st_dev=10, st_ino=2), open=lambda *a, **k: 9, write=write, close=lambda *a: None, fsync=lambda *a: None,
        fchown=lambda fd, uid, gid: state.update(uid=uid, gid=gid), fchmod=lambda fd, mode: state.update(mode=mode),
        listxattr=lambda fd: list(state['attrs']), removexattr=lambda fd, name: state['attrs'].pop(name), setxattr=set_attribute)
    method_globals = m['LinuxFiles'].stage.__globals__; method_globals['os'] = fake
    fs = object.__new__(m['LinuxFiles']); fs.directory = lambda create=False: 7
    def staged(_backup=False):
        result = snapshot(bytes(state['data']), '2', 'b', state['attrs'])
        result.update(uid=state['uid'], gid=state['gid'], mode=state['mode'])
        return result
    fs.snapshot = staged
    try:
        try:
            m['LinuxFiles'].stage(fs, b'new\n', snapshot())
            assert not reject_attribute
            assert state['data'] == b'new\n' and state['uid'] == 37 and state['gid'] == 42 and state['mode'] == 0o640 and state['attrs'] == attrs
        except PermissionError: assert reject_attribute
    finally: method_globals['os'] = real_os
    passed.append('actual-stage-xattr-refusal' if reject_attribute else 'actual-stage-partial-write-and-metadata')
print(json.dumps({'passed': passed}))
