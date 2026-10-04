# Local workspace product specification

This document describes the current application. It is a local, single-user workspace inspired by Linear. It does not claim complete Linear feature parity. See the [reference audit](docs/REFERENCE-AUDIT.md) for the original observations.

Use the [glossary](GLOSSARY.md) for product terms. Implementation and storage contracts are in the [architecture](docs/ARCHITECTURE.md), [API](docs/API.md), and [CLI](docs/CLI.md) guides.

## Workspace and identities

- Each database contains one workspace. The UI can select a team and keep the selected team and page in browser storage.
- A team owns its issues, workflow statuses, and cycles. A project can link to multiple teams.
- Members are human profiles. Each member has an actor identity. Agents have persistent actor identities with unique, fixed keys.
- Actors can receive issues, lead projects, participate in teams and projects, subscribe to issues, and own saved views. Authors and activity records use actors.
- Unknown or inactive actors cannot perform new writes or receive new assignments. Deactivation preserves history and existing relationships. An existing inactive participant can remain in an unchanged relationship.
- The web UI uses actor 1. The CLI and API can select another actor. Actor selection does not authenticate a process or enforce roles.
- Human rosters are read-only. Member creation and invitations are not provided.

## Issues and workflow

Issues have a team, identifier, title, workflow status, and priority. Optional fields include an assignee, project, cycle, milestone, parent, estimate, due date, description, and external link.

- New issue identifiers use the team key and next available number. Moving an issue preserves its identifier and reserves that identifier for later creation.
- Statuses belong to teams. A new issue uses the team's default status unless the caller supplies one.
- A simultaneous team and status change resolves the status in the destination team. Without an explicit status, a move keeps the status name when the destination has it; otherwise it uses the destination default.
- A project can contain an issue only when it links to the issue's team. A selected cycle must belong to that team. A selected milestone must belong to the issue's project. Parent links must not form a cycle.
- A move or project change must clear or replace incompatible relationships in the same action. Older records are preserved on reads; changing a cycle or milestone relationship validates it.
- Labels, subscribers, comments, relations, attachments, and sub-issues appear in issue details. Changes to labels and subscribers record activity and run update automations.
- Archive hides an issue from normal lists and search. Restore makes it available again. Comments and history remain stored.
- Attachments must total no more than 3,000,000 bytes per upload. Empty files are rejected. Downloads use local attachment IDs.

## Projects and planning

- Projects have a name, summary, description, status, priority, lead, linked teams, participants, labels, and optional start and target dates.
- Project statuses are Backlog, Planned, In Progress, Completed, and Canceled.
- Milestones have a name, status, and optional due date. Dependencies link projects. Direct self-dependencies are rejected; dependency graphs do not enforce an acyclic order.
- Removing a project's team is rejected while issues from that team remain linked, including archived issues.
- Progress uses the percentage of non-archived issues in a Completed workflow category and the percentage of Done milestones. When both exist, progress is their average. With neither, progress is zero.
- Project updates store text, author, date, and health: On track, At risk, or Off track.
- Cycles have a team, start, end, status, and nonnegative capacity. Progress counts completed issues; points total issue estimates.
- Triage lists active unassigned issues for the selected team. Accepting an issue assigns it to the current actor and selects Todo when that status exists.

## Finding and displaying work

- Search returns active issues and projects. It matches issue identifiers, titles, descriptions, project names, summaries, and descriptions.
- Issue lists and boards support filters, grouping, sorting, visible properties, sub-issue visibility, and empty status groups.
- Active and completed visibility use workflow categories, including custom status names. Backlog uses the Backlog category.
- Issue filters include status, priority, assignee, creator, project, project status, label, subscribers, relations, external-link presence, and due date.
- Saved views store issue or project filters and display settings. Scope can be Personal, Workspace, or Team. Scope controls display, not access permissions.
- Team views lists views for the selected team. Opening an issue view with a team selects that team and displays the saved view name.
- My issues can show assigned, created, subscribed, or actor activity records across teams.
- Inbox supports unread filtering, individual actions, and selected-item or all-item actions for the current actor.
- Preferences store local defaults. Theme, font size, default page, sidebar visibility, auto-assignment in the issue form, and comment submission are applied. Display-name and first-day-of-week values are stored but do not change all surfaces. System theme is displayed as Light. Spelling preference is stored but does not control browser spelling tools.

## Automation and persistence

- Automation rules run for issue.created, issue.updated, and issue.completed. Conditions support priority and label names. Actions support assignment, adding a named label, and setting a named team status.
- Automations execute in ID order. They do not recursively emit new automation events. Completion rules run after an update changes the workflow category to Completed.
- Recurring rules support Daily, Weekly, Every 2 weeks, and Monthly. The server checks them every 30 seconds. The CLI can run them explicitly.
- Scheduling uses UTC dates. A due rule creates one issue, advances past missed dates, and records actor 1. Monthly dates are clamped to the target month's last day. Later runs use that clamped date.
- The database and complete snapshot are synchronized after successful mutations. Import replaces the complete database and attachments without events or automations.
- The UI issue import creates new issues from an issues array. It does not restore IDs, comments, history, or attachments. The UI uses the selected team for rows without a team ID.
- Refresh and restart preserve records. Browser storage keeps page, team, and sidebar choices on that browser origin.

## Product limits

- No authentication, hosted database, enforced permissions, multi-user synchronization, or workspace switching.
- No connected GitHub/Slack services, AI provider, external notifications, billing, API keys, or plan enforcement.
- No document authoring, reviews, member invitations, or agent chat. Unused tables for those removed surfaces are deleted by supported storage operations.
- No rule editor for disabling or deleting recurring rules or automations. Rules do not execute while the server is stopped unless the CLI runs them.
- No advanced filter builder, templates, manual drag ordering, project membership/priority issue filters, or custom sidebar ordering. Some generic toolbar options apply only to issues; project boards group by project status.
- No complete role or preference enforcement. Decorative window history, arrows, tab, and profile controls are disabled.
- Import is replacement, not merging. Git operations and merge conflict resolution remain manual.

The acceptance checks for changes are in the [development guide](docs/DEVELOPMENT.md).
