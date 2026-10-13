# Automations: natural-language authoring

Approved 2026-10-11. Issue #1589 (split from #242).

## What it is

In a chat thread the user describes a later workflow. The agent creates the
automation immediately: name, prompt, provider, and either a schedule or a
GitHub trigger. Chat shows a result card with **Open in Automations**.

## Tool

`automation_create` on coder-threads (always registered, not Planboard-only).

Same thread/project guard as the other host tools. The automation is created
on the calling thread’s project via `services.addAutomation`. Existing
validation rejects bad names, prompts, providers, presets, and trigger events.

Required: `threadId`, `projectId`, `name`, `prompt`, `provider`, and either
`preset` (`hourly` / `daily` / `weekly`, plus `hour` 0–23 for daily/weekly)
or `trigger` (`pr_opened`, `pr_merged`, `pr_labeled`, `review_submitted`,
`push`, `ci_completed`, with the existing optional filters). Optional: `model`,
`memory`, `tier`, `enabled`.

Event-triggered rows use the same dummy `hourly` preset the Automations form
already uses (ignored when a trigger is set).

If a required field is missing, the agent uses `ask_user`. It must not invent
a trigger or schedule the user did not ask for.

## Card

A successful `automation_create` (bare or `mcp__coder-threads__…` name) is not
collapsed into a tool group. It renders a small result card: name, schedule or
trigger label, and **Open in Automations**. That opens the Automations view
(which refreshes the list) and puts that row in edit mode.

## Out of scope

Update/list/delete tools, confirm-before-create, Slack/Linear/PagerDuty
triggers, and a second draft object on the thread.
