# Diagrams

Mermaid sources for the OpsPilot OS blueprint. Render with any Mermaid tool
(GitHub renders `.mmd` in Markdown fences; VS Code Mermaid preview; mermaid.live).

| File | View | Referenced by |
|---|---|---|
| `01-system-context.mmd` | System context (target) | 14 |
| `02-container-architecture.mmd` | Container architecture (target) | 14 |
| `03-business-domains.mmd` | Major business domains | 04 |
| `04-user-role-relationships.mmd` | User & role relationships | 05 |
| `05-ai-request-approval-flow.mmd` | AI request & approval flow | 07 |
| `06-job-lifecycle.mmd` | Job lifecycle | 03, 08 |
| `07-quote-to-cash.mmd` | Quote-to-cash lifecycle | 04, 09 |
| `08-event-processing-flow.mmd` | Event processing (outbox) | 08 |
| `09-multi-tenant-data-boundaries.mmd` | Multi-tenant data boundaries | 05, 09 |

All diagrams depict the **target/transitional** architecture unless noted;
`09` also shows the current-state leak risk (the two wrapper-bypass files).
