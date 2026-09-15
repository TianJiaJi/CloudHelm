"""Concurrency invariants.

FastAPI runs sync endpoints in a thread pool, so store mutations are reachable
from many threads at once.

Honesty note: the stress tests below did NOT reproduce a failure when the lock
was removed on this machine — the interleaving window is a few bytecodes, which
the GIL rarely interrupts. They are invariant checks, not a proof of
thread-safety. The real guarantee for double-processing comes from the atomic
`dict.pop` claim in promote_starting_pods/recover_due_pods, which is exercised
deterministically by test_healing_does_not_repeat_on_second_tick.
"""

import threading

from app.store import store


def _run(target, threads: int = 8) -> list[str]:
    errors: list[str] = []

    def wrapper():
        try:
            target()
        except Exception as exc:  # a race usually surfaces as an exception
            errors.append(repr(exc))

    workers = [threading.Thread(target=wrapper) for _ in range(threads)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    return errors


def test_release_counter_never_loses_or_repeats_a_value():
    """`version += 1` is a read-modify-write, so it must be serialised."""
    start = int(store.current_release().split('.')[1])
    results: list[int] = []
    lock = threading.Lock()

    def bump():
        value = int(store.next_release().split('.')[1])
        with lock:
            results.append(value)

    errors = _run(lambda: [bump() for _ in range(25)], threads=8)
    assert not errors, errors
    assert len(results) == 200
    assert sorted(results) == list(range(start + 1, start + 1 + len(results)))


def test_concurrent_scale_never_duplicates_pod_names():
    errors = _run(lambda: [store.start_pods(store.apply_scale('miniapp-api', n)) for n in (1, 2, 3, 4, 5)], threads=8)
    assert not errors, errors

    pods = store.snapshot_pods()
    names = [pod['name'] for pod in pods]
    assert len(names) == len(set(names)), 'duplicate pod names after concurrent scale'
    count = sum(1 for pod in pods if pod['deployment'] == 'miniapp-api')
    assert count in (1, 2, 3, 4, 5), f'unexpected replica count {count}'


def test_self_healing_restart_is_counted_exactly_once():
    original = store.pod_recovery_seconds
    store.pod_recovery_seconds = 0.0
    try:
        target = store.snapshot_pods()[0]['name']
        before = next(pod for pod in store.snapshot_pods() if pod['name'] == target)['restarts']
        store.mark_pod_deleted(target)

        errors = _run(lambda: [store.tick() for _ in range(30)], threads=8)
        assert not errors, errors

        after = next(pod for pod in store.snapshot_pods() if pod['name'] == target)['restarts']
        assert after == before + 1, f'restart counted {after - before} times'
        assert next(pod for pod in store.snapshot_pods() if pod['name'] == target)['ready'] is True
    finally:
        store.pod_recovery_seconds = original


def test_concurrent_tick_does_not_raise():
    """Recovery/promotion iterate and mutate dicts; that must stay thread-safe."""
    errors = _run(lambda: [store.tick() for _ in range(50)], threads=8)
    assert not errors, errors


def test_healing_does_not_repeat_on_second_tick():
    """Deterministic: the recovery entry is consumed, so healing happens once."""
    original = store.pod_recovery_seconds
    store.pod_recovery_seconds = 0.0
    try:
        target = store.snapshot_pods()[0]['name']
        before = next(pod for pod in store.snapshot_pods() if pod['name'] == target)['restarts']
        store.mark_pod_deleted(target)

        store.tick()
        after_first = next(pod for pod in store.snapshot_pods() if pod['name'] == target)['restarts']
        store.tick()
        after_second = next(pod for pod in store.snapshot_pods() if pod['name'] == target)['restarts']

        assert after_first == before + 1
        assert after_second == after_first, 'a second tick healed the same pod again'
    finally:
        store.pod_recovery_seconds = original


def test_starting_pod_is_promoted_only_once():
    """Same atomic-claim guarantee for the start-up transition."""
    original = store.pod_start_seconds
    store.pod_start_seconds = 0.0
    try:
        target = store.snapshot_pods()[0]['name']
        store.start_pods([target])
        first = store.promote_starting_pods()
        second = store.promote_starting_pods()
        assert target in first
        assert second == [], 'a second promotion pass re-promoted the same pod'
    finally:
        store.pod_start_seconds = original
