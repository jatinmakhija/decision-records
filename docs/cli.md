# Command line

Install with `npm install -g decision-records`. The command is `decision`. `decision-records` runs the same program.

```bash
decision --help
decision help
```

## Store selection

These apply to every command that reads or writes records.

| Flag or variable | Effect |
| --- | --- |
| `--dir <path>` | Use this directory as the store root. |
| `DECISION_DIR` | Same as `--dir`, used when the flag is omitted. |
| *(neither)* | Walk up from the current directory for `decisions/.decision.json`. Otherwise use `~/Decisions/`. |

`decision where` prints which store is active and why.

## Commands

### `decision init`

Create `.decision.json` in `./decisions/`, or in `--dir` when that flag is set. Asks once for your name when a terminal is attached and no name is saved yet. Enter accepts the laptop username. The name is saved in `~/.config/decision/config.json` on that machine.

### `decision new "<sentence>"`

Create one record. The default status is `decided`. `decidedAt` is left empty.

| Flag | Effect |
| --- | --- |
| `--proposed` | Status `proposed` instead of `decided`. |
| `--enriched` | Write the four empty sections: Context, Rationale, Alternatives, Consequences. |
| `--short` | Write no body, even when the store’s `capture` setting is `enriched`. |
| `--edit` | Open the new file in `$EDITOR` after saving. |
| `--by <name>` | Set `recordedBy` for this record. |
| `--publish` | Publish to Confluence without asking. Fails if Confluence is not configured. |
| `--no-publish` | Do not ask and do not publish. |
| `--format md\|json` | File format for this record. Default is the store’s `defaultFormat`. |

When Confluence is enabled and neither publish flag is set, an interactive terminal asks `Publish to Confluence? [y/N]`. Enter means no. A non-interactive run does not ask and does not publish.

### `decision list`

List records, newest first. Each row starts with the first 8 characters of the id. Pass that value to `show`, `edit`, `decide`, `reject`, `revoke`, `supersede`, or `publish`.

| Flag | Effect |
| --- | --- |
| `--status <status>` | Keep one status. |
| `--tag <tag>` | Keep records that have this tag. Repeatable. |
| `--json` | Print a JSON array. |

### `decision show <id>`

Print one record. `<id>` may be a unique prefix.

| Flag | Effect |
| --- | --- |
| `--json` | Print the JSON form. |

### `decision search "<query>"`

Case-insensitive search across the decision sentence, tags, deciders, participants, and body. Matches in the sentence rank first.

| Flag | Effect |
| --- | --- |
| `--status <status>` | Filter. |
| `--tag <tag>` | Filter. Repeatable. |
| `--decider <name>` | Filter by decider text. |
| `--since <YYYY-MM-DD>` | `createdAt` on or after this date. |
| `--until <YYYY-MM-DD>` | `createdAt` on or before this date. |
| `--json` | Print a JSON array. |

### `decision edit <id>`

Open the file in `$EDITOR` (`vi` when `EDITOR` is unset). With no id, open the newest record.

### `decision decide <id>`

Move `proposed` to `decided` and set `decidedAt` to today’s UTC date.

### `decision reject <id>`

Move `proposed` to `rejected`.

### `decision revoke <id>`

Move `decided` to `revoked`.

### `decision supersede <id> "<sentence>"`

Create a new `decided` record that lists `<id>` in `supersedes`, and set the old record to `superseded` with `supersededBy`. Accepts `--enriched`, `--edit`, `--by`, `--publish`, and `--no-publish`.

### `decision check [path]`

Validate the active store, or the file or directory you pass. Errors mention the file. Warnings are printed and do not fail the process unless `--strict` is set.

Errors: unsupported schema, bad UUID, bad timestamp, `decidedAt` on a proposal, `superseded` without `supersededBy`, duplicate ids, illegal status.

Warnings: unknown key without an `x-` prefix, missing link target, one-way supersede link, decision sentence longer than 200 characters.

### `decision export`

| Flag | Effect |
| --- | --- |
| `--json` | Write the JSON form to stdout. |
| `--id <id>` | Export one record. Omit to export every record as a JSON array. |

### `decision import <file>`

Read a JSON decision file and write it into the store using the store’s default format. The id must be new.

### `decision open`

Start the local browser UI on `127.0.0.1`. The printed URL contains a session token. Requests without that token are rejected. The server binds only to loopback and rejects other Host headers.

### `decision confluence`

Turn Confluence on or off for the active store.

```bash
decision confluence --base-url https://example.atlassian.net --space ENG --parent 123456
decision confluence --off
```

The email and token are environment variables, not flags: `CONFLUENCE_EMAIL` and `CONFLUENCE_API_TOKEN`.

### `decision publish <id>`

Publish one saved record to Confluence. Local files are not rolled back when Confluence is unavailable.

### `decision mcp`

Start the MCP server on stdin and stdout. Tools: `list`, `show`, `search`, and `create_proposal`. `create_proposal` always writes `proposed` and sets `recordedBy` to `mcp:<client>`. It cannot change status or publish.

### `decision where`

Print the active store path, why it was chosen, the default format, and whether Confluence is enabled.

## Environment

| Variable | Effect |
| --- | --- |
| `DECISION_DIR` | Store root. |
| `DECISION_RECORDED_BY` | Recorder name for this run. |
| `EDITOR` | Editor used by `decision edit`. |
| `CONFLUENCE_EMAIL` | Atlassian account email. |
| `CONFLUENCE_API_TOKEN` | Atlassian API token. |
