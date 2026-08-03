import ast, socket
from pathlib import Path

PIPE = Path(__file__).resolve().parents[1] / "footballcv" / "pipeline.py"

def test_pipeline_does_not_import_fetch_models():
    tree = ast.parse(PIPE.read_text())
    imported = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import): imported |= {a.name for a in n.names}
        if isinstance(n, ast.ImportFrom): imported.add(n.module or "")
    assert not any("fetch_models" in m for m in imported)

def test_selftest_fails_on_any_socket_connection(monkeypatch):
    import footballcv.pipeline as p
    attempts = []
    def boom(self, addr, *a, **k):
        attempts.append(addr)
        raise AssertionError(f"network attempt to {addr}")
    monkeypatch.setattr(socket.socket, "connect", boom)
    rc = p.main(["--selftest"])
    assert attempts == [], "pipeline made a network call at run time"
    assert rc == 0
