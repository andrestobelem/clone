# Linear-style workspace clone — product specification

**Status:** implemented local single-user alpha; hosted and third-party integrations remain out of scope

**Reference audited:** installed Linear desktop app, 2026-10-02

**Purpose:** replace the current visual prototype with a persistent, useful issue and project workspace.

## 1. Goal and boundary

Build a local web application that reproduces Linear's core team workflow: capture work as issues, move issues through a configurable workflow, organize work into projects, and find it through saved views and search.

The starting app was a static front end with sample data held in JavaScript memory. This version serves the UI and a JSON API from the Python standard library and persists a local demo workspace in SQLite. It is single-user and binds to `127.0.0.1`; hosted collaboration and permission enforcement need a separate deployment and identity design.

The reference workspace has one team and one member, with no team issues, projects, documents, reviews, or custom views. Empty states and create forms were visible; issue and project detail pages, collaboration, and populated team workflows could not be audited end to end. Feature notes below separate verified UI from inferred behavior.

## 2. Product roles

- **Workspace admin:** manages workspace, teams, members, security, integrations, API, billing, usage, and import/export.
- **Team member:** creates and updates issues, projects, documents, views, and team resources; participates in cycles and reviews.
- **Viewer/collaborator:** reads shared work and participates where permissions allow.
- **Agent:** acts through explicit user requests and configured skills/connectors; its actions appear in the same issue/project activity history.

Role names and exact permissions need confirmation against the intended deployment. The installed account showed a workspace-admin member and plan-gated settings, but did not expose a second role to compare.

## 3. Information architecture

### Workspace navigation

- Workspace switcher, global search, and create-issue action.
- Inbox, My issues, Reviews, and Agent.
- Workspace-level Projects and Views.
- Team navigation: Home/Overview, Issues, Projects, Views, Documents, and Members.
- More menu for Members and Teams, plus sidebar customization.
- Workspace settings, invitation/member management, import/export, and help/documentation.

### Main surfaces observed

| Surface | Verified controls and behavior |
| --- | --- |
| Inbox | Notification list plus selected-item detail pane; unread-only toggle, filter, display options, and bulk notification actions. |
| My issues | Assigned, Created, Subscribed, and Activity tabs; filter, display, and detail-pane controls. |
| Reviews | For you and Created tabs; filter and display controls. Empty state says “Nothing to review.” |
| Agent | Chat composer, attachment, Skills picker, chat history, and suggested actions for creating a project, researching the backlog, or setting up a team. |
| Projects | All-projects view, create action, filters, display options, and empty state explaining that projects can span teams and contain issues and optional documents. |
| Custom Views | Separate Issues and Projects views. A view has a name, optional description, icon, visibility (Personal, Workspace, or Team), filters, display settings, and a shareable URL. Views can be saved, shared, and favorited. |
| Team Overview | Editable team name/description, favorite and copy-URL actions, Overview/Documents/Members tabs, team resources and sections, member list, Connect channel shortcut, and team settings. |
| Team Documents | Create documents; filter and display controls. Empty state describes notes, decisions, and plans for a team. |
| Team Members | Roster with ordering by name, email, or role; add-member action. |
| Search | Searches issues, projects, initiatives, and documents; has All, Issues, Projects, and Documents scopes plus filters and display options. |
| Settings | Personal, Issues, Projects, Features, Administration, and per-team configuration areas (catalog below). |

## 4. Functional requirements

### 4.1 Workspace, teams, and navigation — P0

- **NAV-1:** Show the workspace and team hierarchy in a persistent, collapsible sidebar. Preserve the current page and selected team when navigating back and forth.
- **NAV-2:** Provide global entry points to Inbox, My issues, Reviews, Agent, Projects, Views, Search, and Create issue.
- **NAV-3:** A team overview exposes team identity, description, resources, members, documents, and shortcuts to team issues/projects/views/settings.
- **NAV-4:** Support workspace switching and team switching without losing saved work.
- **NAV-5:** Sidebar item visibility and ordering are user preferences.

**Acceptance:** navigating between workspace and team routes changes the selected page and active navigation item; collapsing the sidebar works at desktop and narrow widths; refreshing retains the active route.

### 4.2 Issues — P0

An issue belongs to one team and has a generated team identifier. If it belongs to a project, that project must include the issue's team. Minimum fields:

- Required title; optional rich-text description.
- Workflow status; priority (`Urgent`, `High`, `Medium`, `Low`, `No priority`).
- Assignee, creator, team, project, labels, subscribers, estimate, and due date.
- Parent/sub-issue and issue relations/links; cycle and milestone association where enabled.
- Created/updated timestamps, activity, comments, attachments, and external links.

Verified issue creation controls: title, description, status, priority, assignee, project, labels, attachment, more actions, “Create more,” and suggested assignee. The More menu exposed Set due date, Make recurring, Add link, and Add sub-issue. The menu showed a team workflow with Backlog, Todo, In Progress, In Review, Done, Canceled, and Duplicate. Priority values were 0–4.

- **ISS-1:** Create an issue from the global action, a team view, or an empty state. Require a title and team; assign an ID after save.
- **ISS-2:** Edit the issue title, description, status, priority, assignee, project, labels, due date, relations, cycle, and estimate.
- **ISS-3:** Show an issue detail view with properties, activity/comments, attachments, relations, and change history.
- **ISS-4:** Create sub-issues and recurring issues; link issues and external URLs.
- **ISS-5:** Support list and board layouts; group by Status, Assignee, Agent, Project, Priority, Cycle, Label, or Team; allow a secondary grouping.
- **ISS-6:** Sort by Manual, Title, Status, Priority, Assignee, Agent, Estimate, Updated, Created, Due date, Link count, or Time in status; choose direction.
- **ISS-7:** Configure completed-issue visibility, completed ordering, sub-issue visibility/nesting, empty groups, and which properties appear in the list.
- **ISS-8:** Persist every create/edit and reflect it immediately in search, views, project rollups, and activity.

### 4.3 Projects — P0

A project can span multiple teams and contain issues and optional documents. Each issue in the project must belong to one of the project's teams. Verified creation controls:

- Team(s), icon, required project name, short summary, status, priority, lead, members.
- Start date, target date, labels, dependencies, rich-text description, milestones.
- “Create with Agent” entry point.

The observed project status menu contained Backlog, Planned, In Progress, Completed, and Canceled.

- **PRJ-1:** Create and edit projects with the fields above.
- **PRJ-2:** Show project status, priority, lead, members, dates, progress, issues, dependencies, milestones, description, documents, and activity.
- **PRJ-3:** Support project list and board views, filters, display options, and project-specific saved views.
- **PRJ-4:** Derive progress from linked issues and milestone completion; show overdue/upcoming dates.
- **PRJ-5:** Keep project and issue changes synchronized in both directions.
- **PRJ-6:** Accept issues only from teams linked to the project. Reject a team change or project edit that would leave a linked issue outside the project's team set.

### 4.4 Views, filtering, and search — P0

- **VIEW-1:** Create an issue or project view with a name, optional description, icon, and scope: Personal, Workspace, or Team.
- **VIEW-2:** Save filters and display configuration; allow favorite, share URL, rename, update, and delete.
- **VIEW-3:** Provide filters for status, assignee, agent/session, creator, priority, labels, relations, suggested label, dates, project/project properties, subscribers, external source, auto-closed state, content, links, and template. Provide an advanced filter and AI filter entry point.
- **VIEW-4:** Preserve list/board layout, grouping, ordering, completed-issue options, sub-issue behavior, empty-group visibility, and visible properties per view.
- **SEARCH-1:** Search issues, projects, initiatives, and documents; scope results by entity type; support filters and display options.
- **SEARCH-2:** Opening a search result navigates to its detail view; search results respect access permissions.

### 4.5 Personal work, notifications, and reviews — P1

- **ME-1:** My issues provides Assigned, Created, Subscribed, and Activity views with shared filters and display settings.
- **INBOX-1:** Inbox lists notifications and opens a selected notification in a detail pane; filter by unread and other supported fields.
- **INBOX-2:** Support mark read/unread, archive/delete, and bulk actions with clear confirmation for destructive bulk operations.
- **REVIEW-1:** Reviews separates work “For you” from reviews “Created by you,” with filters and display options. Populate it from connected code-review sources.
- **REVIEW-2:** Link a review to its issue/PR and update state as the review changes.

The inspected account contained only a welcome notification and no review items, so notification and review detail actions remain unverified.

### 4.6 Documents and team resources — P1

- **DOC-1:** Create and edit rich-text documents at team/project/workspace scope, with title, body, author, timestamps, and access scope.
- **DOC-2:** Organize team resources into named sections containing documents and links.
- **DOC-3:** Search documents and link them to projects/issues.

Only the team document list and its empty state were inspected; the document editor was not opened.

### 4.7 Cycles, triage, and automation — P1/P2

Team settings surfaced Cycles, Triage, Workflows & automations, recurring issues, and configurable issue statuses.

- **FLOW-1:** Allow teams to configure workflow states within Backlog, Unstarted, Started, Completed, Canceled, or Duplicate categories.
- **FLOW-2:** Support cycles as time-boxed planning periods with dates, team capacity, issue assignment, and progress.
- **FLOW-3:** Support triage queues for incoming requests and rules for routing/assignment.
- **FLOW-4:** Support workflow automations triggered by issue/project events, with conditions and actions, and retain an audit trail.
- **FLOW-5:** Generate recurring issues on a schedule.

Cycle and automation behavior is cataloged from settings labels only; detailed rule builders were not inspected.

### 4.8 Agent and integrations — P2

- **AI-1:** Agent chat accepts a request, optional attachments, and selected skills; supports chat history and issue/project/backlog context.
- **AI-2:** Agent-generated changes require an explicit user instruction, produce a reviewable result, and are attributed in activity.
- **AI-3:** Provide team guidance, shared skills, and connectors with workspace/team access controls.
- **INT-1:** Provide integration configuration for code hosting, Slack, and other connected services; sync issues, pull requests, notifications, and reviews as configured.

Observed configuration catalog: AI & Agents, Loops, Initiatives, Documents, Customer requests, Releases, Pulse, Asks, Emojis, Integrations; team settings also expose team agents, agent skills/connectors, generated project updates, and resolved-thread summaries. Full behavior and availability were not verified.

### 4.9 Administration and preferences — P2

Settings navigation exposed:

- Personal: preferences, profile, notifications, code & reviews, security & access, connected accounts, agent personalization.
- Issues: labels, templates, SLAs.
- Projects: labels, templates, statuses, updates.
- Features: AI & Agents, Loops, Initiatives, Documents, Customer requests, Releases, Pulse, Asks, Emojis, Integrations.
- Administration: workspace, teams, members, security, API, applications, billing, usage & limits, import & export.
- Team: general settings, members, Slack notifications, issue labels/templates/recurrence/statuses, workflows/automations, triage, cycles, agents/skills/connectors, project updates, resolved-thread summaries, team hierarchy.

- **ADMIN-1:** Restrict administrative changes by role and record who changed what and when.
- **ADMIN-2:** Support import/export with validation and a preview before applying imported records.
- **ADMIN-3:** Security, billing, API keys, and integrations require explicit authorization and must never expose secrets in the UI or logs.
- **PREF-1:** Persist default home view, display names, first weekday, comment submit key, sidebar visibility/order, font size, theme, editor preferences, notification badge, spelling, stale-tab policy, and auto-assignment preferences.

Some settings displayed plan-gated “Available on Business” links. Exact plan matrix and billing workflows are outside this audit.

## 5. Data model

Minimum persisted entities and relationships:

```text
Workspace 1—N Teams 1—N Issues
Workspace 1—N Members; Team N—N Members
Issue N—1 Assignee/Creator; Issue N—N Labels/Subscribers
Issue N—1 Project/Cycle/Milestone; Issue 1—N Sub-issues
Issue N—N IssueRelations; Issue 1—N Comments/Attachments/ActivityEvents
Project N—N Teams/Members/Labels; Project 1—N Milestones/Updates/Documents
View N—1 Owner/Scope; View 1—N Filters + DisplayConfiguration
InboxNotification N—1 Recipient + source entity
```

IDs must be unique within the relevant namespace. Workflow statuses, labels, team membership, view scope, and project links must be validated server-side. Soft-deleted issues/projects should remain recoverable for a defined retention period; permanent deletion and retention policy need a product decision.

An issue linked to a project must belong to one of that project's teams. A project cannot remove a team while issues from that team remain linked to it.

## 6. Quality requirements

- Persistent state survives refresh, browser restart, and multiple sessions.
- Responsive desktop layout with keyboard-first use; visible focus and accessible names for controls.
- Search, navigation, and issue/project updates should feel immediate; show loading, empty, error, and success states.
- Enforce workspace/team permissions on reads, writes, search, shared URLs, agent actions, and integrations.
- Maintain audit/activity history for changes to issues, projects, settings, membership, and automation actions.
- Keep local development runnable with one documented command and seed data isolated from real user data.

## 7. Suggested delivery slices

1. **Persistent MVP:** workspace/team shell, login or single-user mode decision, issue CRUD/detail/activity, statuses/priorities/assignee/labels, search, list/board, filters/group/sort, SQLite or Postgres persistence.
2. **Planning:** projects, milestones, cycles, dependencies, project progress, custom views.
3. **Collaboration:** inbox, notifications, comments, documents, members/roles, shared views, review queue.
4. **Automation and integrations:** triage, recurring issues, workflows, Git/Slack integrations, import/export.
5. **Agent and advanced features:** agent tools/skills/connectors, initiatives, customer requests, releases, loops, pulse, asks, and administrative plan controls.

Before selecting a database, deployment target, auth model, and collaboration model, decide whether this clone is single-user/local or multi-user/hosted. Those choices change the data schema, permission model, and synchronization requirements.

## 8. Verification notes

The following were observed in the installed app without saving new issues, projects, views, or settings: navigation; empty states; issue/project create forms and dropdown values; issue action menu; custom-view scope/filter/display controls; Inbox actions menu; Review tabs; Agent composer/skills/history; team overview/documents/members; team status catalog; and account/team settings navigation.

This is a core-product specification grounded in the visible app, not a claim of complete Linear feature parity. The implementation below covers local issue/project workflows and stores sample records in SQLite. The initial audit still did not establish exact behavior for every populated Linear flow.

## 9. Implementation status and boundaries

**Current clone scope:** Reviews, document authoring/search (including team and project documents), and member invitations/creation are omitted at the user’s request. The Members page remains a read-only roster. Unused document, review, and Agent tables are removed from SQLite.

Implemented in the local version:

- SQLite persistence and a seeded example workspace; issue/project create and edit, team workflows, assignees, labels, comments, activity, sub-issues, relations, milestones, project dependencies, and archive flags.
- Issue list and board, filters, primary and secondary grouping, visible-property controls, saved issue/project views with rename/edit, search across issues and projects, and team selection.
- Issue attachments stored locally with download links, plus issue/project archive and restore flows.
- Inbox unread filtering, selected-item actions, and bulk mark-read/archive; a read-only members roster; cycles with progress; preferences; workspace/team basics; JSON issue import preview; and workspace JSON export.
- A local triage queue for active unassigned issues, with one-click assignment to the current member; named team resource sections support external URLs.
- Project progress derived from linked issues and milestones, with overdue/upcoming target-date labels.
- Project status updates saved with health, author, and timestamp.
- Recurring issues run on a local background scheduler; issue-created, issue-updated, and issue-completed automations support a limited set of conditions and actions.
- The Agent screen, interactions, and API are intentionally omitted from this clone at the user's request. Existing local chat history is retained in the database but is no longer exposed.

Known boundaries that require additional product or service work:

- No sign-in, multi-user synchronization, hosted database, role-enforced permissions, or invitation email delivery. The current member is the seeded Alex Morgan account.
- This demo has one workspace. Its workspace menu returns to Home or opens workspace settings; multiple workspace switching is not supported. Team switching and current-page/team persistence work. Sidebar visibility and collapse state persist; custom sidebar ordering does not.
- No GitHub/Slack connection, live pull-request review sync, real AI provider, or external notifications. Local issue attachments are capped at 3 MB total per upload and stored under the workspace data directory.
- Issue filters cover status, priority, assignee, creator, project, project status, label, subscribers, internal relations, external-link presence, and due date. Agent/session, project priority and membership, external-source, content, template, advanced-builder, and AI-filter facets are not implemented. Agent grouping and sorting are omitted with the Agent feature. Manual order uses the issue creation sequence.
- Automation execution supports a small set of issue events, priority/label conditions, and assignment/label/status actions. Recurring rules create missed issues once and advance to the next scheduled date; there is no rule editor for disabling/deleting rules or a delivery guarantee while the app is stopped.
- Triage currently covers active unassigned issues and has no configurable routing rules. Project updates are manual; generated AI summaries are not implemented.
- Document authoring is omitted. The UI import creates issues only. The archive browser restores issues and projects.
- Billing, API-key management, security controls, plan-gated features, initiatives, customer requests, releases, Pulse, and Asks are not implemented.

These limitations are deliberate consequences of the local single-user scope; they are not represented as active external integrations.

### CLI and complete Git snapshots

The local CLI exposes the current app queries and actions without an HTTP server. It shares business logic with the web server. All app tables and attachment files are saved to stable JSON records and binary files after each mutation, including recurring issue execution. Members remain read-only.

Snapshot import replaces the complete database without events or automations. It preserves archived records, inactive members, IDs, and dates. Local fingerprints block writes after snapshot edits and block imports that would discard unexported database changes. A local journal supports recovery after interrupted publication. Git commands and database merge conflict resolution remain manual. See `docs/CLI.md` for the command contract and file format.
