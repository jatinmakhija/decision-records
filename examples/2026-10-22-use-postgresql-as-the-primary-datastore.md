---
schemaVersion: "0.1"
id: "3f8c2a91-6b4e-4d1a-9c7e-2a5b8e1f0d34"
decision: "Use PostgreSQL as the primary datastore for the billing service"
status: "decided"
createdAt: "2026-10-20T09:14:03Z"
decidedAt: "2026-10-22"
deciders:
  - "Priya Raman"
  - "Backend guild"
recordedBy: "Priya Raman"
tags:
  - "engineering"
  - "billing"
  - "database"
sources:
  - "https://github.com/acme/billing/issues/412"
supersedes:
  - "a1d07c55-2e9b-4f3a-8c61-0b7d4e2f9a18"
---

## Context

Billing needs multi-row transactions and auditability. Reconciliation queries on the document store are slow and easy to get wrong.

## Rationale

PostgreSQL gives us transactions and a team that already operates it. Managed hosting is available on the cloud account we use.

## Alternatives

- Keep the document store: no migration, and reconciliation stays fragile.
- CockroachDB: horizontal scale we do not need yet, at a higher operating cost.

## Consequences

A migration project lands in Q1. The old store becomes read-only after cutover. We accept a one-time data-move risk.
