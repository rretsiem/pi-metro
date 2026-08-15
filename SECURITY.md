# Security

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security-sensitive reports.

Send a private disclosure to the maintainer listed in the repository's owner
settings, or use GitHub's "Security → Advisories" private reporting flow.

Include:

- A description of the impact.
- Reproduction steps or a proof-of-concept.
- Affected version/commit.

A reply is usually sent within 7 days.

## Trust boundary

Metrol runs with the same privileges as the host Pi session. It reads and
writes files under `~/.pi/agent/metrol/` and `~/.pi/agent/extensions/`. It
does **not** open network sockets, perform DNS lookups, or launch other
processes.

Cross-process message contents are treated as untrusted data. Validate
every custom entry, registry entry, and inbox message before acting on it.
