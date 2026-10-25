# Decision records

Open, local-first decision records for any kind of choice. The file is the record. The `decision` command is the tool.

## Read these first

- [docs/spec-v0.1.md](docs/spec-v0.1.md) — Decision Record Specification 0.1
- [docs/glossary.md](docs/glossary.md) — field meanings
- [docs/cli.md](docs/cli.md) — commands and flags, including `--enriched`
- [docs/examples.md](docs/examples.md) — the gallery
- [README.md](README.md) — install and everyday use

## Locked for 0.1.0

- Package `decision-records`. Commands `decision` and `decision-records`.
- Markdown and JSON files. No database. No AI extraction.
- Default status is `decided`. `--proposed` creates a proposal. `decidedAt` is set only by `decision decide`.
- Stores: `--dir`, `DECISION_DIR`, `decisions/.decision.json`, then `~/Decisions/`.
- Recorder name lives in `~/.config/decision/config.json`, not in the shared store.
- Tags only. No category field.
- Confluence Cloud is opt-in, asks before publishing, and does not own the file.
- MCP can read and create proposals only.
- License MIT. Node 20 or newer.

## Out of this release

MADR import, Jira sync, a hosted service, Confluence Data Center, and pulling edits from Confluence back into the file.

Do not publish to npm or create a git remote until asked. See the local publish notes on the maintainer laptop for the registry steps.
