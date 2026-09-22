# Configuring Claude Code and Codex

Run `kimchi setup-tools` to configure installed coding tools to use Kimchi.
Selecting Claude Code or Codex changes the configuration used when you launch
`claude` or `codex` directly, too.

Before applying changes in an interactive terminal, each integration explains
the effect and asks for confirmation. The default is **No**. Declining or
cancelling that confirmation leaves the tool's files unchanged.

## Claude Code

Setup updates the `env` block in `~/.claude/settings.json`, preserving unrelated
settings. The preview redacts existing and replacement API keys, tokens and
telemetry headers.

The saved `ANTHROPIC_AUTH_TOKEN` takes precedence over a claude.ai login and
disables claude.ai connectors. To use Kimchi for one Claude session without
saving these changes, decline and run `kimchi claude`. The authentication
change still applies within that temporary session.

## Codex

Setup changes the default model and provider in `~/.codex/config.toml` and
replaces `~/.codex/model_catalog.json`. Unrelated TOML settings and other
providers are preserved. Serialization rewrites formatting and removes
comments; the original text is retained in the backup. Invalid TOML is rejected
before either file is changed.

## Backups and recovery

Before changing an existing file, setup saves its exact original contents
beside it as `<filename>.kimchi-<unique-id>.bak`. Backups use owner-only
permissions and are never overwritten by later runs. Files that did not
previously exist have no backup.

Setup prints each backup's path and a `Restore: cp ...` command. Close the tool,
then run the printed command to restore that version of its configuration.
For Codex, restore both the config and catalog backups if both were created.
Restoring replaces any edits made since the backup, so keep those edits
separately if needed.

Both Codex backups must succeed before either configuration file is written.
A later write failure can leave a partial update; use the printed restore
commands to recover. Backups are also made when the writers run without an
interactive terminal, although confirmation is only shown in a terminal.

These protections apply to Claude Code and Codex. Other integrations have
their own configuration behavior.
