"""Regression coverage for API-server approval transport classification."""

import tools.approval as approval_module


def _bind_api_session(monkeypatch, session_key: str):
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.delenv("HERMES_GATEWAY_SESSION", raising=False)
    monkeypatch.delenv("HERMES_INTERACTIVE", raising=False)
    monkeypatch.delenv("HERMES_EXEC_ASK", raising=False)
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "api_server")
    return approval_module.set_current_session_key(session_key)


def test_listenerless_api_server_stays_unattended(monkeypatch):
    session_key = "api-listenerless"
    token = _bind_api_session(monkeypatch, session_key)
    try:
        approval_module.unregister_gateway_notify(session_key)
        assert approval_module._is_unattended_platform_approval_context() is True
        assert approval_module._is_gateway_approval_context() is False
    finally:
        approval_module.unregister_gateway_notify(session_key)
        approval_module.reset_current_session_key(token)


def test_registered_api_transport_is_gateway_context(monkeypatch):
    session_key = "api-with-approval-transport"
    token = _bind_api_session(monkeypatch, session_key)
    try:
        approval_module.register_gateway_notify(session_key, lambda _data: None)
        assert approval_module._is_unattended_platform_approval_context() is False
        assert approval_module._is_gateway_approval_context() is True
    finally:
        approval_module.unregister_gateway_notify(session_key)
        approval_module.reset_current_session_key(token)


def test_execute_code_reaches_registered_api_transport(monkeypatch):
    session_key = "api-execute-code-approval"
    token = _bind_api_session(monkeypatch, session_key)
    calls = []

    def fake_await(key, notify_cb, approval_data, *, surface="gateway"):
        calls.append((key, notify_cb, approval_data, surface))
        return {"resolved": True, "choice": "once", "reason": None}

    monkeypatch.setattr(approval_module, "_YOLO_MODE_FROZEN", False)
    monkeypatch.setattr(approval_module, "_get_approval_mode", lambda: "manual")
    monkeypatch.setattr(approval_module, "_await_gateway_decision", fake_await)
    try:
        approval_module.register_gateway_notify(session_key, lambda _data: None)
        result = approval_module.check_execute_code_guard("print('ok')", "local")
        assert result["approved"] is True
        assert result["user_approved"] is True
        assert calls and calls[0][0] == session_key
    finally:
        approval_module.unregister_gateway_notify(session_key)
        approval_module.reset_current_session_key(token)
