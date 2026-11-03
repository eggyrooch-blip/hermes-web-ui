from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, os.path.dirname(__file__))

import bridge_runtime


def _write_yaml(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")


def test_merge_bridge_config_keeps_shared_custom_providers() -> None:
    merged = bridge_runtime._merge_bridge_config(
        {
            "custom_providers": [
                {
                    "name": "litellm-sre",
                    "api_key": "K",
                    "base_url": "https://llm.example.com",
                }
            ]
        },
        {"model": {"provider": "custom:litellm-sre"}},
    )

    assert merged["custom_providers"] == [
        {
            "name": "litellm-sre",
            "api_key": "K",
            "base_url": "https://llm.example.com",
        }
    ]


def test_merge_bridge_config_profile_overrides_and_merges_nested_dicts() -> None:
    merged = bridge_runtime._merge_bridge_config(
        {
            "model": {
                "provider": "custom:shared",
                "base_url": "https://shared.example.com",
                "headers": {"x-shared": "1", "x-keep": "shared"},
            },
            "timeout": 30,
        },
        {
            "model": {
                "provider": "custom:profile",
                "headers": {"x-shared": "2", "x-profile": "1"},
            },
            "timeout": 15,
        },
    )

    assert merged["timeout"] == 15
    assert merged["model"] == {
        "provider": "custom:profile",
        "base_url": "https://shared.example.com",
        "headers": {
            "x-shared": "2",
            "x-keep": "shared",
            "x-profile": "1",
        },
    }


def test_load_cfg_merges_shared_and_profile_disk_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    base_home = tmp_path / "hermes-home"
    profile_home = base_home / "profiles" / "p1"
    _write_yaml(
        base_home / "config.yaml",
        {
            "custom_providers": [
                {
                    "name": "litellm-sre",
                    "api_key": "shared-key",
                    "base_url": "https://shared.example.com",
                }
            ],
            "model": {
                "provider": "custom:shared",
                "base_url": "https://shared.example.com",
                "headers": {"x-shared": "1", "x-keep": "shared"},
            },
            "agent": {"service_tier": "fast"},
        },
    )
    _write_yaml(
        profile_home / "config.yaml",
        {
            "model": {
                "provider": "custom:litellm-sre",
                "headers": {"x-shared": "2", "x-profile": "1"},
            }
        },
    )

    monkeypatch.setattr(bridge_runtime, "_ensure_agent_imports", lambda: None)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    monkeypatch.setenv("HERMES_AGENT_BRIDGE_BASE_HOME", str(base_home))
    hermes_cli_pkg = types.ModuleType("hermes_cli")
    hermes_cli_pkg.__path__ = []  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli_pkg)
    monkeypatch.delitem(sys.modules, "hermes_cli.config", raising=False)

    cfg = bridge_runtime._load_cfg()

    assert cfg["custom_providers"][0]["api_key"] == "shared-key"
    assert cfg["model"]["provider"] == "custom:litellm-sre"
    assert cfg["model"]["base_url"] == "https://shared.example.com"
    assert cfg["model"]["headers"] == {
        "x-shared": "2",
        "x-keep": "shared",
        "x-profile": "1",
    }
    assert cfg["agent"]["service_tier"] == "fast"


def test_load_cfg_missing_shared_config_fails_open_to_profile_only(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    base_home = tmp_path / "missing-shared"
    profile_home = base_home / "profiles" / "p1"
    _write_yaml(
        profile_home / "config.yaml",
        {"model": {"provider": "anthropic", "default": "anthropic/claude-x"}},
    )

    monkeypatch.setattr(bridge_runtime, "_ensure_agent_imports", lambda: None)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    monkeypatch.setenv("HERMES_AGENT_BRIDGE_BASE_HOME", str(base_home))
    hermes_cli_pkg = types.ModuleType("hermes_cli")
    hermes_cli_pkg.__path__ = []  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli_pkg)
    monkeypatch.delitem(sys.modules, "hermes_cli.config", raising=False)

    cfg = bridge_runtime._load_cfg()

    assert cfg == {"model": {"provider": "anthropic", "default": "anthropic/claude-x"}}


def test_resolve_custom_provider_runtime_matches_named_slug() -> None:
    api_key, base_url = bridge_runtime._resolve_custom_provider_runtime(
        {
            "model": {"base_url": "https://shared.example.com"},
            "custom_providers": [
                {
                    "name": "LiteLLM SRE",
                    "api_key": "shared-key",
                    "base_url": "https://shared.example.com",
                }
            ],
        },
        "custom:litellm-sre",
    )

    assert api_key == "shared-key"
    assert base_url == "https://shared.example.com"


def test_resolve_custom_provider_runtime_matches_bare_custom_by_base_url() -> None:
    api_key, base_url = bridge_runtime._resolve_custom_provider_runtime(
        {
            "model": {"base_url": "https://match.example.com/"},
            "custom_providers": [
                {"name": "first", "api_key": "ignore", "base_url": "https://other.example.com"},
                {"name": "second", "api_key": "match", "url": "https://match.example.com/"},
            ],
        },
        "custom",
    )

    assert api_key == "match"
    assert base_url == "https://match.example.com"


def test_resolve_runtime_injects_explicit_values_for_custom_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_resolve_runtime_provider(**kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return {"provider": "ok"}

    monkeypatch.setattr(bridge_runtime, "_ensure_agent_imports", lambda: None)
    monkeypatch.setattr(
        bridge_runtime,
        "_load_cfg",
        lambda profile=None: {
            "model": {
                "provider": "custom:litellm-sre",
                "base_url": "https://shared.example.com",
            },
            "custom_providers": [
                {
                    "name": "litellm-sre",
                    "api_key": "shared-key",
                    "base_url": "https://shared.example.com",
                }
            ],
        },
    )
    hermes_cli_pkg = types.ModuleType("hermes_cli")
    hermes_cli_pkg.__path__ = []  # type: ignore[attr-defined]
    runtime_provider_module = types.ModuleType("hermes_cli.runtime_provider")
    runtime_provider_module.resolve_runtime_provider = fake_resolve_runtime_provider  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli_pkg)
    monkeypatch.setitem(sys.modules, "hermes_cli.runtime_provider", runtime_provider_module)

    result = bridge_runtime._resolve_runtime("custom:litellm-sre/some-model", "custom:litellm-sre")

    assert result == {"provider": "ok"}
    # Downgraded from the "custom:litellm-sre" slug to bare "custom": core's named
    # lookup reads its own per-profile config (no custom_providers in the bridge),
    # so only the bare-"custom" direct-alias branch can consume the explicit creds
    # we resolved from the merged shared config.
    assert captured["requested"] == "custom"
    assert captured["target_model"] == "custom:litellm-sre/some-model"
    assert captured["explicit_api_key"] == "shared-key"
    assert captured["explicit_base_url"] == "https://shared.example.com"


def test_resolve_runtime_named_custom_keeps_slug_without_explicit_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # When the merged config has no matching custom_providers entry (no base_url
    # resolved), preserve the original "custom:<name>" slug so a core that CAN
    # resolve the named provider from its own config keeps its richer behavior.
    captured: dict[str, object] = {}

    def fake_resolve_runtime_provider(**kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return {"provider": "ok"}

    monkeypatch.setattr(bridge_runtime, "_ensure_agent_imports", lambda: None)
    monkeypatch.setattr(
        bridge_runtime,
        "_load_cfg",
        lambda profile=None: {"model": {"provider": "custom:absent"}},
    )
    hermes_cli_pkg = types.ModuleType("hermes_cli")
    hermes_cli_pkg.__path__ = []  # type: ignore[attr-defined]
    runtime_provider_module = types.ModuleType("hermes_cli.runtime_provider")
    runtime_provider_module.resolve_runtime_provider = fake_resolve_runtime_provider  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli_pkg)
    monkeypatch.setitem(sys.modules, "hermes_cli.runtime_provider", runtime_provider_module)

    result = bridge_runtime._resolve_runtime("custom:absent/some-model", "custom:absent")

    assert result == {"provider": "ok"}
    assert captured["requested"] == "custom:absent"
    assert captured["explicit_base_url"] is None


def _agent_core_on_path() -> bool:
    """Add HERMES_AGENT_ROOT to sys.path (if set) and report core importability.

    No hardcoded path: portable across machines/CI. The real-core regression test
    skips when hermes-agent isn't importable.
    """
    root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if root and os.path.isdir(root) and root not in sys.path:
        sys.path.insert(0, root)
    try:
        import hermes_cli.runtime_provider  # noqa: F401

        return True
    except Exception:
        return False


@pytest.mark.skipif(not _agent_core_on_path(), reason="hermes-agent core not importable")
def test_resolve_runtime_named_custom_from_shared_only_resolves_via_real_core(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # RED-GREEN regression against the REAL core resolver: a custom:<name> whose
    # entry lives ONLY in the shared config (the group-chat / bridge multitenant
    # reality). Before the fix, passing the "custom:<name>" slug made core's named
    # lookup — which reads the per-profile HERMES_HOME config that has no
    # custom_providers — fail and raise AuthError "Unknown provider 'custom:...'".
    # After the fix, the bridge downgrades to bare "custom" + explicit creds and
    # core resolves via its direct-alias branch.
    profile_home = tmp_path / "profiles" / "p1"
    _write_yaml(
        profile_home / "config.yaml",
        {
            "model": {
                "provider": "custom:litellm-sre",
                "default": "custom:litellm-sre/tencent-sonnet-4-6",
                "base_url": "https://llm.example.test/v1",
            }
        },
    )
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    monkeypatch.setattr(bridge_runtime, "_ensure_agent_imports", lambda: None)
    # Merged bridge config carries the shared custom_providers entry (with creds);
    # the on-disk profile config above deliberately does NOT.
    monkeypatch.setattr(
        bridge_runtime,
        "_load_cfg",
        lambda profile=None: {
            "model": {
                "provider": "custom:litellm-sre",
                "base_url": "https://llm.example.test/v1",
            },
            "custom_providers": [
                {
                    "name": "litellm-sre",
                    "api_key": "shared-key",
                    "base_url": "https://llm.example.test/v1",
                }
            ],
        },
    )

    runtime = bridge_runtime._resolve_runtime(
        "tencent-sonnet-4-6", "custom:litellm-sre"
    )

    assert runtime.get("base_url") == "https://llm.example.test/v1"
    assert runtime.get("api_key") == "shared-key"
    assert runtime.get("provider") == "custom"


def test_resolve_runtime_keeps_non_custom_path_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_resolve_runtime_provider(**kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return {"provider": "ok"}

    monkeypatch.setattr(bridge_runtime, "_ensure_agent_imports", lambda: None)
    monkeypatch.setattr(
        bridge_runtime,
        "_load_cfg",
        lambda profile=None: {"model": {"provider": "anthropic", "base_url": "https://unused.example.com"}},
    )
    hermes_cli_pkg = types.ModuleType("hermes_cli")
    hermes_cli_pkg.__path__ = []  # type: ignore[attr-defined]
    runtime_provider_module = types.ModuleType("hermes_cli.runtime_provider")
    runtime_provider_module.resolve_runtime_provider = fake_resolve_runtime_provider  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli_pkg)
    monkeypatch.setitem(sys.modules, "hermes_cli.runtime_provider", runtime_provider_module)

    result = bridge_runtime._resolve_runtime("anthropic/claude-x", "anthropic")

    assert result == {"provider": "ok"}
    assert captured == {
        "requested": "anthropic",
        "target_model": "anthropic/claude-x",
    }
