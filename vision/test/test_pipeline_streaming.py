# vision/test/test_pipeline_streaming.py
#
# `_iter_world_states` must not retain every decoded frame (audit V-2).
#
# THE NUMBER THAT MATTERS. The stated goal is a 90-minute match at 720p/5 fps. That is 27,000
# sampled frames × 1280×720×3 bytes ≈ 69.5 GiB of decoded pixels held simultaneously — the run is
# not "slow", it is physically impossible on any machine this project will ever touch, and it fails
# with a MemoryError or the OOM killer partway through rather than with anything a user could act on.
#
# The frames were dead weight even so: run_v1's production writer re-decodes the source anyway
# (`write_smooth_annotated_video` reads the file again to encode at native fps), so pass 1's copies
# were never the ones written. Only the injected-writer test seam consumes (frame, ws) pairs, and it
# consumes them one at a time.
#
# HOW THIS MEASURES IT. Frames are yielded as a weak-referenceable ndarray subclass, and a weak
# reference to each is kept; counting the ones that have not been collected is exactly "how many
# decoded frames the pipeline is holding right now". (A WeakSet cannot be used: ndarray's __eq__
# returns an array, so frames are unhashable.) The naive baseline is measured in the same run rather
# than hardcoded, so the 1/10 acceptance ratio means what it says regardless of how many frames the
# fixture happens to use.

import gc
import weakref

import numpy as np
import supervision as sv

from footballcv.pipeline import _iter_world_states

N_FRAMES = 60
SHAPE = (48, 64, 3)


class _Frame(np.ndarray):
    """ndarray subclass — a plain ndarray cannot be weak-referenced, a subclass can."""


def _make_frame(value: int) -> _Frame:
    return np.full(SHAPE, value % 256, np.uint8).view(_Frame)


def _fake_track_provider(frame, frame_idx):
    """Three stable tracks (>=3 crops is what fit_teams' silhouette guard needs), two on the
    left and one on the right so the image-x anchoring has real spread."""
    return sv.Detections(
        xyxy=np.array([[2.0, 2.0, 10.0, 40.0],
                       [6.0, 2.0, 14.0, 40.0],
                       [40.0, 2.0, 50.0, 40.0]], float),
        confidence=np.array([0.9, 0.88, 0.85]),
        class_id=np.array([0, 0, 0]),
        tracker_id=np.array([1, 2, 3]),
        data={"class_name": np.array(["player", "player", "player"])})


class _FakeEmbedder:
    def __init__(self):
        self.calls = 0

    def embed(self, crops):
        self.calls += 1
        n = len(crops)
        return np.array([[0.0, 0.0] if i < n - 1 else [100.0, 100.0] for i in range(n)], float)


class _Live:
    """Weak references to every frame ever yielded; `count()` is how many are still alive."""

    def __init__(self):
        self.refs: list[weakref.ref] = []

    def track(self, frame):
        self.refs.append(weakref.ref(frame))

    def count(self) -> int:
        gc.collect()
        return sum(1 for r in self.refs if r() is not None)


def _factory(alive: _Live):
    def make():
        for i in range(N_FRAMES):
            f = _make_frame(i)
            alive.track(f)
            yield i, i / 10.0, f
    return make


def _peak_live_frames_naive() -> int:
    """What the previous implementation did: materialise every decoded frame first."""
    alive = _Live()
    held = list(_factory(alive)())        # the `per_frame` list, in one line
    peak = alive.count()
    del held
    return peak


def test_world_state_stream_holds_a_bounded_number_of_frames():
    naive = _peak_live_frames_naive()
    assert naive == N_FRAMES, "the baseline must actually hold every frame, or the ratio is meaningless"

    alive = _Live()
    embedder = _FakeEmbedder()
    peak = 0
    seen = 0
    for frame, ws in _iter_world_states(_factory(alive), track_provider=_fake_track_provider,
                                        embedder=embedder):
        assert frame.shape == SHAPE          # a real decoded frame still reaches the writer
        assert ws.frame_idx == seen
        seen += 1
        peak = max(peak, alive.count())

    assert seen == N_FRAMES
    assert embedder.calls == 1               # teams still fit exactly ONCE over the whole clip
    assert peak * 10 < naive, (
        f"peak retained frames {peak} is not under 1/10 of the naive {naive} — "
        "the stream is still materialising the clip")


def test_stream_still_assigns_stable_teams_across_the_clip():
    """The memory fix must not cost the one-shot team fit: ids keep their team every frame."""
    alive = _Live()
    team_by_tid = {}
    frames = 0
    for _frame, ws in _iter_world_states(_factory(alive), track_provider=_fake_track_provider,
                                         embedder=_FakeEmbedder()):
        frames += 1
        assert {p.track_id for p in ws.players} == {1, 2, 3}
        for p in ws.players:
            team_by_tid.setdefault(p.track_id, p.team)
            assert team_by_tid[p.track_id] == p.team
            assert p.team in (0, 1)
    assert frames == N_FRAMES
    assert team_by_tid[1] == team_by_tid[2]      # the two left tracks share a team
    assert team_by_tid[3] != team_by_tid[1]      # the right one does not


def test_states_only_mode_never_yields_a_frame_at_all():
    """The production path (`write_smooth_annotated_video`) re-decodes the source itself and needs
    only the states. Asking for states alone must not decode a second time NOR retain frames."""
    alive = _Live()
    peak = 0
    states = []
    for ws in _iter_world_states(_factory(alive), track_provider=_fake_track_provider,
                                 embedder=_FakeEmbedder(), with_frames=False):
        states.append(ws)
        peak = max(peak, alive.count())
    assert len(states) == N_FRAMES
    assert peak * 10 < N_FRAMES


# ---------------------------------------------------------------------------------------------
# The case the first version of this file MISSED, found by mutation-testing it: reverting `_crop`
# to return a numpy VIEW instead of a copy left every assertion above green.
#
# Why it hid. The fake provider up there returns the same three track ids on every frame, and a
# sample crop is kept only the FIRST time an id is seen — so all three crops were views into frame
# 0, pinning exactly one frame. And the measurement loop runs during pass 2, by which time
# `sample_crop.clear()` has already released them.
#
# Both of those are artefacts of the fixture, not of the pipeline. Real tracking produces a stream
# of NEW ids — BoT-SORT id switches are why the provenance calls this `track_id_space: "raw"` — and
# under views each new id pins its own whole parent frame for the entire length of pass 1. A clip
# with 900 distinct ids would hold 900 decoded frames, which is the V-2 leak wearing a different hat.
#
# So this measures at the one instant that matters: inside `embed()`, which is called once at the
# end of pass 1, with every sample crop simultaneously live.

class _IdChurnProvider:
    """A fresh track id on every frame — the worst case, and not a rare one."""

    def __call__(self, frame, frame_idx):
        tid = 1000 + frame_idx
        return sv.Detections(
            xyxy=np.array([[2.0, 2.0, 30.0, 40.0], [34.0, 2.0, 60.0, 40.0]], float),
            confidence=np.array([0.9, 0.85]),
            class_id=np.array([0, 0]),
            tracker_id=np.array([tid, tid + 500]),
            data={"class_name": np.array(["player", "player"])})


class _MeasuringEmbedder:
    """Records how many decoded frames are still alive at the moment of the team fit."""

    def __init__(self, alive: _Live):
        self.alive, self.live_at_fit, self.calls = alive, None, 0

    def embed(self, crops):
        self.calls += 1
        self.live_at_fit = self.alive.count()
        n = len(crops)
        return np.array([[0.0, 0.0] if i % 2 == 0 else [100.0, 100.0] for i in range(n)], float)


def test_sample_crops_do_not_pin_their_parent_frames():
    alive = _Live()
    embedder = _MeasuringEmbedder(alive)
    for _ws in _iter_world_states(_factory(alive), track_provider=_IdChurnProvider(),
                                  embedder=embedder, with_frames=False):
        pass

    assert embedder.calls == 1
    assert embedder.live_at_fit is not None
    # 2 new ids per frame over N_FRAMES frames: under views that is N_FRAMES pinned frames.
    assert embedder.live_at_fit * 10 < N_FRAMES, (
        f"{embedder.live_at_fit} decoded frames were still alive at the team fit, out of "
        f"{N_FRAMES} — the per-track sample crops are numpy VIEWS pinning their parent frames, "
        "not copies")
