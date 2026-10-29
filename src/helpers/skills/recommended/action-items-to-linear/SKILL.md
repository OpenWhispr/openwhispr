---
name: action-items-to-linear
description: "Pulls action items from a meeting and drafts Linear issues for the user to approve. Use after a meeting when the user asks for action items or tickets."
metadata:
  display_name: "Action items to Linear"
---

## Purpose

Turn a meeting's action items into tracked work.

## When to use

After a meeting, when the user asks for action items, tickets or issues.

## Steps

1. Read the meeting's note: its notes and summary, and the transcript where something is unclear. If it isn't clear which meeting, ask.
2. List each action item that has an owner, with its due date if one was given.
3. If Linear is connected, draft one Linear issue per item for the user to approve, up to five per request, and offer to draft the rest next. Put the owner and due date in the issue's description, and assign the issue to the user only when the item is theirs. Create nothing without approval.
4. If Linear isn't connected, list the items as text.

## Output format

item · owner · due date, one line each. With Linear, an approval card for each issue.

## Avoid

- Items with no owner: ask who owns them instead.
