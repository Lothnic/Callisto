from callisto_eval.datasets import load_subset


def test_load_webvoyager_smoke_subset():
    tasks = load_subset("webvoyager", "smoke")

    assert len(tasks) == 3
    assert tasks[0].id == "webvoyager-smoke-001"
    assert tasks[0].benchmark == "webvoyager"
    assert tasks[0].expected == "Example Domain"


def test_load_webvoyager_full_subset():
    tasks = load_subset("webvoyager", "full")
    assert len(tasks) == 643
    sites = {t.site for t in tasks}
    assert len(sites) == 13
    assert "github.com" in sites
    categories = {t.metadata["web_name"] for t in tasks}
    assert len(categories) == 15


def test_load_webvoyager_pr_50_subset():
    tasks = load_subset("webvoyager", "pr-50")
    assert len(tasks) == 50
    sites = {t.site for t in tasks}
    assert len(sites) == 13
    categories = {t.metadata["web_name"] for t in tasks}
    assert len(categories) == 15


