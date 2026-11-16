"""Config tree. Owner: Foundation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from phonegaze.config import (
    Config,
    ConfigError,
    get_value,
    load_config,
    save_config,
    set_value,
    settings,
    update,
)


def test_every_setting_is_described_and_default_matches_tree() -> None:
    cfg = Config()
    paths = set()
    for s in settings():
        assert s.description, s.path
        assert s.type in {"bool", "int", "float", "str", "list[str]"}
        assert get_value(cfg, s.path) == s.default
        if s.choices is not None:
            items = s.default if isinstance(s.default, list) else [s.default]
            assert all(v in s.choices for v in items), s.path
        paths.add(s.path)
    sections = {p.split(".")[0] for p in paths}
    for name in ["phone", "stream", "lens", "estimators", "models", "calibration", "filters",
                 "outputs", "hotkeys", "recording", "server", "sim", "ui"]:
        assert name in sections


def test_settings_are_json_serialisable() -> None:
    json.dumps([s.to_dict() for s in settings()])


def test_validation() -> None:
    cfg = Config()
    assert set_value(cfg, "lens.zoom", "2.5") == 2.5
    assert set_value(cfg, "outputs.cursor", "true") is True
    with pytest.raises(ConfigError):
        set_value(cfg, "lens.zoom", 0.5)  # below min
    with pytest.raises(ConfigError):
        set_value(cfg, "stream.roi_source", "nope")
    with pytest.raises(ConfigError):
        set_value(cfg, "server.port", 1.5)
    with pytest.raises(ConfigError):
        set_value(cfg, "no.such", 1)
    errors = update(cfg, {"lens.fps": 60, "lens.zoom": -1})
    assert cfg.lens.fps == 60 and list(errors) == ["lens.zoom"]


def test_list_defaults_are_not_shared() -> None:
    a, b = Config(), Config()
    a.estimators.order.append("appearance")
    assert "appearance" not in b.estimators.order


def test_save_load_round_trip(tmp_path: Path) -> None:
    cfg = Config()
    cfg.lens.zoom = 3.0
    cfg.models.candidates = ["ridge"]
    path = save_config(cfg, tmp_path / "sub" / "config.json")
    assert load_config(path) == cfg
    assert load_config(tmp_path / "missing.json") == Config()


def test_unknown_and_invalid_keys_are_ignored(tmp_path: Path) -> None:
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"lens": {"zoom": 2.2, "bogus": 1, "fps": "x"}, "old": {}}))
    cfg = load_config(p)
    assert cfg.lens.zoom == 2.2 and cfg.lens.fps == Config().lens.fps
    p.write_text("{not json")
    with pytest.raises(ConfigError):
        load_config(p)
