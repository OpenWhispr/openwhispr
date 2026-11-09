---
name: meeting-summary-to-slack
description: "Writes a short meeting summary and drafts it to a Slack channel for the user to approve. Use when the user asks to share a meeting summary."
metadata:
  display_name: "Meeting summary to Slack"
---

## Purpose

Share what happened without writing it twice.

## When to use

When the user asks to share or post a meeting summary.

## Steps

1. Summarise the decisions and next steps.
2. If Slack is connected, draft it to the channel the user names and wait for approval before posting.
3. If Slack isn't connected, show the summary as text to copy.

## Output format

Five lines or fewer: decisions first, then next steps with owners.

## Avoid

- Private details in public channels.
