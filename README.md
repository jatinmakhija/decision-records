# decision

Local-first decision records. A decision is one Markdown or JSON file. This package is the tool that reads and writes those files. It is not a hosted service, and it does not need an account.

The command is `decision`. `decision-records` runs the same program.

```bash
npm install -g decision-records
decision init
decision new "Adopt trunk-based development"
decision list
decision open
```

Node.js 20 or newer is required. The other laptop does not need this git repository.

## What you get

- A versioned file format. See [docs/spec-v0.1.md](docs/spec-v0.1.md).
- A command line. Every flag is listed in [docs/cli.md](docs/cli.md).
- A local browser UI from `decision open`. It binds to `127.0.0.1` and requires the session token printed in the URL.
- A thin MCP server from `decision mcp` that can list, show, search, and create proposals. It cannot mark a record decided or publish it.
- Opt-in Confluence Cloud publishing. It stays off until a store turns it on.

## Capture

`decision new "Buy a used hybrid"` writes a decided record with no body and no `decidedAt`. Add `--proposed` when the choice is not final. Add `--enriched` to insert Context, Rationale, Alternatives, and Consequences. Add `--short` to force an empty body. Add `--edit` to open `$EDITOR`.

```bash
decision new "Pause external hiring for Q1" --proposed --enriched
decision edit
decision decide <id>
decision supersede <id> "Pause hiring except two security roles"
```

The field words are defined in [docs/glossary.md](docs/glossary.md). `decision help fields` prints the short versions.

## Where files go

`decision init` creates `decisions/.decision.json` in the current project. Without that marker, records go to `~/Decisions/` on your machine. `--dir` and `DECISION_DIR` select a store directly. `decision where` prints which one is active.

Your name is asked once and stored in `~/.config/decision/config.json` on that laptop. It is copied into `recordedBy`. It is not written into the shared store file, and it is not added to deciders or participants.

This repository is the tool. It is not a decision store. The gallery in `examples/` is described in [docs/examples.md](docs/examples.md).

## Confluence

Off by default. Turn it on per store:

```bash
decision confluence --base-url https://example.atlassian.net --space ENG --parent 123456
```

Set `CONFLUENCE_EMAIL` and `CONFLUENCE_API_TOKEN` in the environment. After a save, an interactive terminal asks `Publish to Confluence? [y/N]`. Enter means no. `--publish` and `--no-publish` skip the question. `decision publish <id>` sends a saved record later. The local file stays the source of truth.

## Another computer

```bash
npm install -g decision-records
decision init
decision new "Buy a used hybrid"
decision list
decision open
```

Project decisions show up after `git pull` of a repository that contains `decisions/`. Personal decisions in `~/Decisions/` show up only if you sync that folder yourself. This tool does not sync.

For Cursor, point MCP at the installed `decision mcp` command.

## Upgrade

```bash
npm install -g decision-records@latest
```

The file schema stays `0.1` until the file format changes. A newer program still reads 0.1 records. An older program stops with an error when it sees a newer `schemaVersion`.
