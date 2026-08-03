from dataclasses import dataclass
from typing import Protocol
import numpy as np
from sklearn.decomposition import PCA
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

MIN_SILHOUETTE = 0.5   # min silhouette for a real 2-team split; below -> "low" confidence (seed; tune in §11)

class Embedder(Protocol):
    def embed(self, crops: list[np.ndarray]) -> np.ndarray: ...   # -> (N, D)

@dataclass
class TeamFit:
    labels: np.ndarray        # raw KMeans labels per input row
    team0_cluster: int        # which KMeans cluster is anchored to team 0
    confidence: str           # "ok" | "low"
    def label_of(self, i: int) -> int:
        return 0 if self.labels[i] == self.team0_cluster else 1

def fit_teams(embeddings: np.ndarray, mean_image_x: np.ndarray, *,
              seed: int = 0, min_silhouette: float = MIN_SILHOUETTE) -> TeamFit:
    # PCA + fixed seed (NOT UMAP) for determinism (ADR §5). n_components must not exceed the
    # SAMPLE count either — real SigLIP features are ~768-dim but a clip may yield few crops
    # (a real-footage run with 22 crops surfaced this; the old cap only bounded by n_features).
    n_comp = min(32, embeddings.shape[0], embeddings.shape[1])
    feats = (PCA(n_components=n_comp, random_state=seed).fit_transform(embeddings)
             if embeddings.shape[1] > n_comp else embeddings)
    km = KMeans(n_clusters=2, random_state=seed, n_init=10).fit(feats)
    labels = km.labels_
    # degenerate-cluster guard: silhouette measures whether a REAL 2-cluster structure exists.
    # Two genuine kits score high; a single blob KMeans-split scores low -> "low" confidence.
    # silhouette_score needs >= 3 samples (2 <= n_clusters <= n_samples-1), so guard tiny sets.
    sil = (float(silhouette_score(feats, labels))
           if len(set(labels.tolist())) == 2 and len(labels) >= 3 else -1.0)
    confidence = "ok" if sil >= min_silhouette else "low"
    # §7.1 anchoring: cluster with smaller mean image-x -> team 0 (tie-break omitted for v1 seed)
    mean_x = {k: float(mean_image_x[labels == k].mean()) for k in (0, 1)}
    team0_cluster = 0 if mean_x[0] <= mean_x[1] else 1
    return TeamFit(labels=labels, team0_cluster=team0_cluster, confidence=confidence)

def assign_goalkeeper(gk_xy: np.ndarray, team_centroids_image: dict[int, np.ndarray]) -> int:
    return min(team_centroids_image, key=lambda t: float(np.linalg.norm(gk_xy - team_centroids_image[t])))

def _pooled(feats):
    """`SiglipModel.get_image_features(...)` returns a bare tensor on some transformers versions
    and a model-output object (BaseModelOutputWithPooling) on others — coerce to the embedding
    tensor either way. (A real-footage run surfaced this; synthetic clips never reach embed().)"""
    if hasattr(feats, "pooler_output") and feats.pooler_output is not None:
        return feats.pooler_output
    if hasattr(feats, "last_hidden_state"):
        return feats.last_hidden_state.mean(dim=1)   # mean-pool the patch tokens
    return feats


class SiglipEmbedder:
    """Default embedder; swappable for ResNet/CLIP. The §11 labelled-crop test picks the default."""
    def __init__(self, model_name: str = "google/siglip-base-patch16-224", device: str = "cuda"):
        # IMAGE processor only — we embed crops, never text. AutoProcessor would also load SigLIP's
        # text tokenizer (needs the `sentencepiece` package); AutoImageProcessor avoids that dep.
        from transformers import AutoModel, AutoImageProcessor
        self.processor = AutoImageProcessor.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name).to(device).eval()
        self.device = device

    def embed(self, crops: list[np.ndarray]) -> np.ndarray:
        import torch
        inputs = self.processor(images=crops, return_tensors="pt").to(self.device)
        with torch.no_grad():
            feats = _pooled(self.model.get_image_features(**inputs))
        return feats.detach().cpu().numpy()
