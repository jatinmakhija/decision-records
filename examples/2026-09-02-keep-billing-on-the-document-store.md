---
schemaVersion: "0.1"
id: "a1d07c55-2e9b-4f3a-8c61-0b7d4e2f9a18"
decision: "Keep billing on the document store"
status: "superseded"
createdAt: "2026-09-02T11:05:00Z"
decidedAt: "2026-09-02"
deciders:
  - "Backend guild"
recordedBy: "Priya Raman"
tags:
  - "engineering"
  - "billing"
supersededBy:
  - "3f8c2a91-6b4e-4d1a-9c7e-2a5b8e1f0d34"
---

## Context

Billing launched on the document store because the team already operated it.

## Rationale

A migration in the first quarter would have delayed invoicing. The document model was good enough for the first customers.

## Consequences

Reconciliation queries stayed slow. This record is replaced by the PostgreSQL decision.
