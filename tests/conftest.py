from __future__ import annotations

import time
from collections.abc import Callable, Iterator

import pytest

from hue_sdk import BridgeCredentials
from hue_sdk.twin import BridgeSimulator, sample_recording


def wait_for(predicate: Callable[[], bool], timeout_s: float = 5.0, interval_s: float = 0.01) -> None:
    deadline = time.monotonic() + timeout_s
    while not predicate():
        if time.monotonic() > deadline:
            raise TimeoutError("wait_for timed out")
        time.sleep(interval_s)


def creds_for(sim: BridgeSimulator) -> BridgeCredentials:
    return BridgeCredentials(
        bridge_id=sim.bridge_id,
        host=sim.host,
        port=sim.port,
        scheme=sim.scheme,
        application_key=sim.application_key,
        fingerprint=sim.fingerprint or None,
        device_type="tests#ci",
    )


@pytest.fixture
def twin() -> Iterator[BridgeSimulator]:
    """HTTPS twin on the sample recording with the replay paused (deterministic state)."""
    sim = BridgeSimulator.start(sample_recording(), autostart_replay=False)
    try:
        yield sim
    finally:
        sim.close()


@pytest.fixture
def http_twin() -> Iterator[BridgeSimulator]:
    sim = BridgeSimulator.start(sample_recording(), autostart_replay=False, scheme="http")
    try:
        yield sim
    finally:
        sim.close()
