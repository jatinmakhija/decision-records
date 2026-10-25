# Decision Record Specification 0.1

A decision record is one UTF-8 file. Markdown (`.md`) is YAML front matter plus an optional Markdown body. JSON (`.json`) is the same fields plus `body`. The file is the record. A tool is optional.

The package version of a tool and `schemaVersion` are independent. This document is schema `0.1`.

## File rules

- Line endings are LF.
- Markdown front matter sits between opening and closing `---` lines.
- Readers treat YAML scalars as strings. The canonical writer double-quotes every string.
- Canonical key order is: `schemaVersion`, `id`, `decision`, `status`, `createdAt`, `updatedAt`, `decidedAt`, `deciders`, `participants`, `recordedBy`, `tags`, `sources`, `supersedes`, `supersededBy`, `related`, then extension keys (`x-*`) and any other unknown keys in the order they were read.
- Optional fields that are absent are omitted. Empty lists are omitted.
- JSON is 2-space indented, uses the same key order, puts `body` last, and ends with a newline.
- Converting canonical Markdown to JSON and back produces the same Markdown bytes.
- A reader rejects a `schemaVersion` other than `0.1`. Unknown keys are preserved. Keys that do not start with `x-` produce a warning.

## Fields

| Field | Required | Rule |
| --- | --- | --- |
| `schemaVersion` | yes | `"0.1"` |
| `id` | yes | Lowercase UUID. Never changes. |
| `decision` | yes | One line. Tools warn above 200 characters. |
| `status` | yes | `proposed`, `decided`, `rejected`, `superseded`, or `revoked` |
| `createdAt` | yes | RFC 3339 UTC, written as `YYYY-MM-DDThh:mm:ssZ`. Never changes. |
| `updatedAt` | no | RFC 3339 UTC. Tools set it when they change a record. |
| `decidedAt` | no | `YYYY-MM-DD`. Forbidden when `status` is `proposed`. |
| `deciders` | no | People accountable for the choice. |
| `participants` | no | People consulted or present who did not decide. |
| `recordedBy` | no | Who wrote the record down. |
| `tags` | no | Lowercase labels. |
| `sources` | no | URLs or citations. |
| `supersedes` | no | UUIDs of records this one replaces. |
| `supersededBy` | no | Required when `status` is `superseded`. |
| `related` | no | Untyped links to other records. |
| `x-*` | no | Extensions. Tools preserve them. |

`deciders` and `participants` are names, roles, or groups. A name may appear in both. Tools do not invent membership.

## Body

Recommended H2 headings, in this order: `Context`, `Rationale`, `Alternatives`, `Consequences`.

- Context is the situation. Rationale is why this option won.
- Tools extract a section only when the heading text matches, ignoring case.
- A short capture omits the body. Enriched capture inserts the four headings, each followed by a blank line.
- Empty headings are valid, preserved on disk, hidden when reading, and ignored by search.
- The body does not repeat the decision sentence as a title.

## Status

Allowed moves:

- `proposed` to `decided` or `rejected`
- `decided` to `superseded` or `revoked`

`rejected`, `superseded`, and `revoked` are final. Reopening a question means a new record linked with `related`.

A choice not to do something is `decided`. `rejected` means a proposal did not pass.

`decidedAt` is set only by an explicit transition to `decided` (the `decide` command or the equivalent UI action). A record created already `decided` has no `decidedAt`. Readers show “recorded on {createdAt}” in that case.

`superseded` without `supersededBy` is an error. A successor whose `supersedes` list does not point back is a warning. A referenced id that is missing from the store is a warning.

Changing the `decision` text of a `decided` record warns. The tool still saves. A substantive change should be a new record that supersedes the old one.

## Identity and filenames

`id` is the identity. The filename is `YYYY-MM-DD-slug.md` or `.json`, using the `createdAt` date. The slug is ASCII, lowercase, at most 60 characters. Collisions append `-2`, `-3`, and so on. Renaming a file does not change the record. A short unique id prefix may select a record.

## Stores

A store is a directory of record files plus `.decision.json`.

```json
{
  "schemaVersion": "0.1",
  "defaultFormat": "md"
}
```

Optional store keys: `suggestedTags` (filter hints), `capture` (`short` or `enriched`), and `confluence` (`enabled`, `baseUrl`, `spaceKey`, `parentPageId`). Secrets never go in this file.

Lookup order:

1. `--dir`
2. `DECISION_DIR`
3. The nearest parent directory that contains `decisions/.decision.json`
4. The personal store at `~/Decisions/`

`--dir` and `DECISION_DIR` are the store root (`.decision.json` lives directly inside). A discovered project store is the `decisions/` directory. The personal store is created on the first write. Every save prints the file path.

New records use `defaultFormat` (`md` when omitted). An edit keeps the file’s existing extension.

`recordedBy` is copied from `~/.config/decision/config.json` at creation. It is not stored in `.decision.json` and it is not added to `deciders` or `participants`. `--by` and `DECISION_RECORDED_BY` override it. When no name has been set, the laptop username is used and the save line says `Recording as <name>`.

## Confluence

Confluence publishing is off until `confluence.enabled` is true for that store. The API email and token come from `CONFLUENCE_EMAIL` and `CONFLUENCE_API_TOKEN`.

After a local save, an interactive session asks `Publish to Confluence? [y/N]`. Enter means no. The local file is already saved. `--publish` and `--no-publish` skip the question. A non-interactive run does not ask and does not publish. Publishing again updates the same page. The page URL is appended to `sources`. The file remains canonical.

## Search

Search is a case-insensitive scan. A match in `decision` ranks ahead of a match in the body, tags, or deciders. Newer `createdAt` wins ties. Empty body sections do not count as text.
