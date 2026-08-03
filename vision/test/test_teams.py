import numpy as np
from footballcv.teams import fit_teams, assign_goalkeeper, _pooled


class _Out:                       # stand-in for a transformers model-output object
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)

def test_pooled_passes_through_a_bare_tensor():
    sentinel = object()           # a bare tensor has neither attr -> returned as-is
    assert _pooled(sentinel) is sentinel

def test_pooled_extracts_pooler_output():
    target = object()
    assert _pooled(_Out(pooler_output=target, last_hidden_state=object())) is target

def test_pooled_mean_pools_last_hidden_state_when_no_pooler():
    class _LHS:
        def mean(self, dim):      # only last_hidden_state present -> mean-pooled
            assert dim == 1
            return "pooled"
    assert _pooled(_Out(pooler_output=None, last_hidden_state=_LHS())) == "pooled"

def test_fit_teams_handles_few_samples_many_features():
    # real SigLIP-like dims: FAR more features than samples — the PCA n_components cap must be
    # bounded by n_samples, not just n_features (a real-footage run with 22 crops hit this).
    rng = np.random.RandomState(1)
    n = 22
    emb = np.vstack([rng.normal(0, 0.05, (n // 2, 768)) + 1.0,
                     rng.normal(0, 0.05, (n - n // 2, 768))])
    xs = np.concatenate([np.full(n // 2, 100.0), np.full(n - n // 2, 900.0)])
    fit = fit_teams(emb, xs, seed=0)          # must NOT raise
    assert set(fit.labels.tolist()) == {0, 1}
    assert fit.team0_cluster in (0, 1)


def _two_clusters():
    rng = np.random.RandomState(0)
    a = rng.normal(0, 0.05, (10, 8)) + np.array([1,0,0,0,0,0,0,0])
    b = rng.normal(0, 0.05, (10, 8)) + np.array([0,1,0,0,0,0,0,0])
    emb = np.vstack([a, b])
    # cluster A players are on the LEFT (small x), B on the RIGHT
    xs = np.concatenate([np.full(10, 100.0), np.full(10, 900.0)])
    return emb, xs

def test_anchoring_left_cluster_is_team0_and_deterministic():
    emb, xs = _two_clusters()
    f1 = fit_teams(emb, xs, seed=0)
    f2 = fit_teams(emb, xs, seed=0)
    left_labels  = {f1.label_of(i) for i in range(10)}
    right_labels = {f1.label_of(i) for i in range(10, 20)}
    assert left_labels == {0} and right_labels == {1}        # left -> team 0 (§7.1)
    assert [f1.label_of(i) for i in range(20)] == [f2.label_of(i) for i in range(20)]
    assert f1.confidence == "ok"

def test_degenerate_clusters_flag_low_confidence():
    rng = np.random.RandomState(0)
    emb = rng.normal(0, 0.05, (20, 8))                       # one blob, no real 2-cluster
    xs = rng.uniform(0, 1000, 20)
    assert fit_teams(emb, xs, seed=0).confidence == "low"

def test_gk_assigned_to_nearest_team_centroid_image_xy():
    centroids = {0: np.array([100.0, 50.0]), 1: np.array([900.0, 50.0])}
    assert assign_goalkeeper(np.array([120.0, 55.0]), centroids) == 0
