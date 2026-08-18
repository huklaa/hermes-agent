"""Regression coverage for Nous provider request-body routing fields."""

from providers import get_provider_profile


def test_nous_omits_openrouter_provider_preferences():
    """OpenRouter-only routing preferences must not reach the Nous endpoint."""
    profile = get_provider_profile("nous")

    body = profile.build_extra_body(
        provider_preferences={
            "only": ["anthropic"],
            "sort": "price",
            "require_parameters": True,
        }
    )

    assert "provider" not in body
