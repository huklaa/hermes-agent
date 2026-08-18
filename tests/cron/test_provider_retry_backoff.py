"""Regression tests for cron provider retry-after backoff (#89376)."""

from datetime import datetime, timedelta, timezone

from cron.jobs import (
    create_job,
    get_due_jobs,
    get_job,
    mark_job_run,
    set_provider_backoff,
    update_job,
    use_cron_store,
)
from cron.scheduler import _provider_retry_after_seconds
from hermes_cli.auth import AuthError, CODEX_RATE_LIMITED_CODE


def test_retry_after_parser_accepts_codex_quota_error():
    exc = AuthError(
        "Codex provider quota exhausted (429); retry after 123518s. "
        "Credentials are still valid.",
        provider="openai-codex",
        code=CODEX_RATE_LIMITED_CODE,
    )
    assert _provider_retry_after_seconds(exc) == 123518


def test_retry_after_parser_rejects_non_rate_limit_auth_error():
    exc = AuthError(
        "temporary auth problem; retry after 3600s",
        provider="openai-codex",
        code="token_expired",
        relogin_required=True,
    )
    assert _provider_retry_after_seconds(exc) is None


def test_due_scan_suppresses_job_until_provider_backoff_expires(
    tmp_path, monkeypatch
):
    now = datetime(2026, 8, 18, 20, 0, tzinfo=timezone.utc)
    clock = {"now": now}
    monkeypatch.setattr("cron.jobs._hermes_now", lambda: clock["now"])

    with use_cron_store(tmp_path):
        job = create_job(
            prompt="quota-sensitive job",
            schedule="every 1m",
            deliver="local",
        )
        update_job(
            job["id"],
            {"next_run_at": (now - timedelta(minutes=1)).isoformat()},
        )

        expiry = set_provider_backoff(job["id"], 3600)
        assert expiry == (now + timedelta(hours=1)).isoformat()
        assert get_due_jobs() == []

        persisted = get_job(job["id"])
        assert persisted["provider_backoff_until"] == expiry

        clock["now"] = now + timedelta(hours=1, seconds=1)
        due = get_due_jobs()
        assert [item["id"] for item in due] == [job["id"]]
        assert get_job(job["id"]).get("provider_backoff_until") is None


def test_provider_backoff_never_shortens_and_success_clears_it(
    tmp_path, monkeypatch
):
    now = datetime(2026, 8, 18, 20, 0, tzinfo=timezone.utc)
    monkeypatch.setattr("cron.jobs._hermes_now", lambda: now)

    with use_cron_store(tmp_path):
        job = create_job(
            prompt="quota-sensitive job",
            schedule="every 5m",
            deliver="local",
        )
        long_expiry = set_provider_backoff(job["id"], 7200)
        short_expiry = set_provider_backoff(job["id"], 60)

        assert short_expiry == long_expiry
        assert get_job(job["id"])["provider_backoff_until"] == long_expiry

        assert mark_job_run(job["id"], success=True)
        assert get_job(job["id"]).get("provider_backoff_until") is None
