"""Unit tests for hermes_cli.toolset_validation (see #38798).

Pure logic — the validity predicate is injected, so these tests need neither the
tool registry nor a running Hermes.
"""

import pytest

from hermes_cli.toolset_validation import validate_platform_toolsets

# A representative set of real toolset names. `hermes` is deliberately absent —
# that is the corruption #38798 reported (`hermes-cli` rewritten to `hermes`).
_KNOWN = {
    "hermes-cli",
    "hermes-telegram",
    "hermes-discord",
    "terminal",
    "web",
}


def _is_valid(name):
    return name in _KNOWN



def test_38798_corruption_warns_and_suggests_correct_name():
    # The exact reported shape: cli holds 'hermes' instead of 'hermes-cli'.
    warnings = validate_platform_toolsets({"cli": ["hermes"]}, _is_valid)
    unknown = [w for w in warnings if "unknown toolset 'hermes'" in w]
    assert len(unknown) == 1
    # Actionable: points at the valid name the entry should have been.
    assert "did you mean 'hermes-cli'?" in unknown[0]
    # And the zero-valid-toolsets safety net fires.
    assert any("zero valid toolsets" in w for w in warnings)


def test_mixed_valid_and_invalid_flags_only_the_invalid():
    cfg = {"cli": ["hermes-cli"], "discord": ["bogus"]}
    warnings = validate_platform_toolsets(cfg, _is_valid)
    # One valid entry exists, so no zero-valid warning.
    assert not any("zero valid toolsets" in w for w in warnings)
    assert len(warnings) == 1
    assert "platform 'discord'" in warnings[0]
    assert "unknown toolset 'bogus'" in warnings[0]


def test_empty_platform_warns_even_when_other_platform_is_valid():
    cfg = {"cli": [], "telegram": ["hermes-telegram"]}
    warnings = validate_platform_toolsets(cfg, _is_valid)

    assert len(warnings) == 1
    assert "platform 'cli' is configured with an empty toolset list" in warnings[0]
    assert "the agent will have no tools on this platform" in warnings[0]
    assert not any("zero valid toolsets" in w for w in warnings)


def test_only_empty_platform_also_keeps_global_zero_tool_warning():
    warnings = validate_platform_toolsets({"cli": []}, _is_valid)

    assert any(
        "platform 'cli' is configured with an empty toolset list" in w
        for w in warnings
    )
    assert any("zero valid toolsets" in w for w in warnings)
