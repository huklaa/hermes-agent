from unittest.mock import MagicMock, patch


def test_tool_override_prompt_fails_closed_when_stdout_redirected():
    from hermes_cli.plugins_cmd import _resolve_tool_override_grant

    console = MagicMock()
    with (
        patch("sys.stdin") as stdin,
        patch("sys.stdout") as stdout,
        patch("hermes_cli.plugins_cmd._set_plugin_entry_flag") as persist,
    ):
        stdin.isatty.return_value = True
        stdout.isatty.return_value = False

        _resolve_tool_override_grant(console, "capplug", None)

    console.input.assert_not_called()
    persist.assert_called_once_with("capplug", "allow_tool_override", False)


def test_tool_override_prompt_still_accepts_interactive_yes():
    from hermes_cli.plugins_cmd import _resolve_tool_override_grant

    console = MagicMock()
    console.input.return_value = "yes"
    with (
        patch("sys.stdin") as stdin,
        patch("sys.stdout") as stdout,
        patch("hermes_cli.plugins_cmd._set_plugin_entry_flag") as persist,
    ):
        stdin.isatty.return_value = True
        stdout.isatty.return_value = True

        _resolve_tool_override_grant(console, "capplug", None)

    console.input.assert_called_once()
    persist.assert_called_once_with("capplug", "allow_tool_override", True)
