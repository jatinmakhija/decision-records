---
schemaVersion: "0.1"
id: "6d4e8a21-0c55-4b7e-8f19-2a6b7c8d9e01"
decision: "Rewrite the billing service in Rust"
status: "rejected"
createdAt: "2026-10-11T16:22:00Z"
deciders:
  - "Backend guild"
participants:
  - "Priya Raman"
  - "Platform on-call"
recordedBy: "Priya Raman"
tags:
  - "engineering"
  - "billing"
---

## Context

Invoice calculation sometimes spikes CPU during month-end. A rewrite was proposed to make that path faster.

## Rationale

The spikes come from one query, not from the language runtime. A rewrite would stop feature work for two quarters.

## Alternatives

- Rewrite in Rust: faster steady state, and almost nobody on the team can review it.
- Index the month-end query: small change, and it targets the measured cost.

## Consequences

The proposal does not proceed. The query index is tracked separately. We accept month-end slowness until that index ships.
