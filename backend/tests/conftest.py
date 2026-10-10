import os

import pytest

# Tests never call a paid API, whatever .env says. Set before app.config loads.
os.environ["MOCK_MODE"] = "1"


def pytest_addoption(parser):
    parser.addoption("--models", action="store_true", help="also run tests that load local ML models (slow)")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--models"):
        return
    skip = pytest.mark.skip(reason="loads local ML models; run with --models")
    for item in items:
        if "models" in item.keywords:
            item.add_marker(skip)
