# Local HTTP API

The web server uses JSON under `/api/`. The default URL is `http://127.0.0.1:4173`. The API has no authentication. Keep it on loopback. Use the [CLI](CLI.md) for agent operations when possible.

## Requests and responses

Send mutation bodies as JSON objects. An omitted body is an empty object. Fields use camelCase, such as `teamId` and `assigneeId`. Stored record fields in responses use snake_case; assembled records also include names, progress, and related arrays.

`actorId` selects the actor for a mutation and defaults to 1. IDs must be integers. Unknown or inactive actors return a relationship conflict. Existing inactive assignments and participation can remain when an update preserves them. Bootstrap uses actor 1; actor selection does not create a separate web session.

Creation usually returns HTTP 201. Other successful actions return HTTP 200. Response bodies vary by action: issue actions can return an assembled `issue`; project creation/update returns `projectId`; views return `viewId`; other actions return IDs or `ok`. Errors return a JSON `error` string.

Request bodies are limited to 5,000,000 bytes. Attachments are base64 in JSON and must total no more than 3,000,000 decoded bytes per upload. HTTP responses do not include the internal `_status` field used by shared actions.

## Read routes

| Method and route | Result |
| --- | --- |
| `GET /api/health` | Storage access and local-mode health |
| `GET /api/bootstrap` | Workspace, teams, actors, members, active issues/projects, views, Inbox, cycles, statuses, labels, rules, archives, and settings |
| `GET /api/issues/IDENTIFIER` | Assembled issue, including an archived issue |
| `GET /api/projects/ID` | Assembled active project; archived projects return 404 |
| `GET /api/actors` | Active actors; `?all=true` includes inactive actors |
| `GET /api/actors/ID` | Actor identity and human profile fields when present |
| `GET /api/agents` | Active agents; `?all=true` includes inactive agents |
| `GET /api/agents/ID` | Agent identity |
| `GET /api/search?q=TEXT&scope=All` | Active issue/project matches; scope is All, Issues, or Projects |
| `GET /api/export` | UI bootstrap data plus exportedAt; not a complete backup |
| `GET /api/attachments/ID` | Binary attachment with download headers |

There are no separate HTTP list routes for teams, labels, cycles, statuses, or settings. Use bootstrap or the CLI. Issue routes use identifiers, such as `PRO-248`; other resource routes use numeric IDs. Extra path segments do not match detail routes.

## Mutation routes

`PATCH` and `PUT` both apply supplied fields; `PUT` does not replace an entire record.

| Resource | Routes |
| --- | --- |
| Agents | `POST /api/agents`; `PATCH /api/agents/ID`; `POST /api/agents/ID/deactivate`; `POST /api/agents/ID/restore` |
| Issues | `POST /api/issues`; `PATCH` or `PUT /api/issues/IDENTIFIER`; `DELETE /api/issues/IDENTIFIER`; `POST /api/issues/IDENTIFIER/restore` |
| Issue details | `POST /api/issues/IDENTIFIER/comments`, `/attachments`, or `/relations` |
| Projects | `POST /api/projects`; `PATCH` or `PUT /api/projects/ID`; `DELETE /api/projects/ID`; `POST /api/projects/ID/restore` |
| Project details | `POST /api/projects/ID/milestones`, `/updates`, or `/dependencies` |
| Teams | `POST /api/teams`; `PATCH` or `PUT /api/teams/ID`; `POST /api/teams/ID/resources`; `DELETE /api/teams/ID/resources/RESOURCE_ID` |
| Workflow statuses | `POST /api/statuses` |
| Labels | `POST /api/labels` |
| Cycles | `POST /api/cycles` |
| Saved views | `POST /api/views`; `PATCH` or `PUT /api/views/ID`; `DELETE /api/views/ID` |
| Inbox | `POST /api/notifications/ID/read`, `/unread`, or `/archive`; `POST /api/notifications/read-all`, `/read-selected`, or `/archive-selected` |
| Preferences | `PATCH` or `PUT /api/preferences` |
| Settings | `PATCH` or `PUT /api/settings` |
| Issue import | `POST /api/import` |
| Automations | `POST /api/automations` |
| Recurring rules | `POST /api/recurring` |

DELETE archives issues and projects. DELETE removes saved views and team resources. No member mutation, agent chat, document, or review route is provided. Snapshot synchronization and migration are CLI operations.

## Common payloads

| Action | Fields |
| --- | --- |
| Register agent | Required `key`, `name`; update accepts `name`; key cannot change |
| Create issue | Required `title`; `teamId` defaults to 1; omitted `status` uses team default; optional `description`, `priority`, `assigneeId`, `projectId`, `cycleId`, `milestoneId`, `parentId`, `estimate`, `dueDate`, `externalUrl`, `labelIds`, `subscriberIds`, `recurringRule` |
| Update issue | Supplied issue fields, including `teamId`; `labelIds` and `subscriberIds` replace their lists |
| Comment | Required `body` |
| Attach | Required nonempty `files` array; each item has `name`, base64 `data`, and optional MIME `type` |
| Relate | `relatedIssueId` is an issue identifier, or provide `url`; optional relation `type` |
| Create/update project | Required `name` on creation; optional `summary`, `description`, `status`, `priority`, `icon`, `leadId`, `startDate`, `targetDate`, `teamIds`, `memberIds`, `labelIds`; creation also accepts `dependencies` and `milestones` |
| Project milestone | Required `name`; optional `dueDate`, `status` |
| Project update | Required `body`; optional `health` |
| Project dependency | Required `dependsOnId`; optional `type` |
| Create/update team | Required `name` on creation; creation accepts `key`, `description`, `icon`, `memberIds`; update accepts `name`, `description`, `icon`, `timezone`, `estimateType`, `memberIds` |
| Team resource | Required `title` and HTTP(S) `url`; optional `section` |
| Workflow status | Required `name`; optional `teamId`, `category`, `color` |
| Label | Required `name`; optional `teamId`, `color` |
| Cycle | Required `name`, `startsAt`, `endsAt`; optional `teamId`, `status`, `capacity` |
| Saved view | Required `name` on creation; optional `description`, `icon`, `entity`, `scope`, `teamId`, `filters`, `display`, `isFavorite` |
| Selected Inbox actions | `ids` array; only the caller's notifications change; count is the number of matched notifications |
| Preferences | Preference fields directly in the body |
| Settings | Required `key`; `value` defaults to an empty object; object values merge with existing objects |
| Issue import | `issues` array of issue creation objects; the outer actor overrides row actors |
| Automation | Required `name`; optional `teamId`, `trigger`, `condition`, `action`; see the product specification for supported rules |
| Recurring rule | Required `title`; optional `teamId`, `description`, `cadence`, `nextRun` |

Project creation defaults to team 1 and the caller as lead and participant. Team creation adds the caller as Lead and creates standard workflow statuses. A missing team 1 must be replaced with an existing team ID in calls that use this default.

Issue creation always subscribes the caller in addition to `subscriberIds`. On update, `subscriberIds` replaces the full list and can remove the caller. Team and project `memberIds` select participants, including agents. See [stored names and their meanings](ARCHITECTURE.md#components).

### Example issue request

```json
{
  "actorId": 1,
  "teamId": 1,
  "title": "Check search",
  "priority": "High",
  "labelIds": [],
  "subscriberIds": [1]
}
```

### Validation and clearing fields

Titles, names, comment bodies, and keys must contain nonempty text. Priorities are Urgent, High, Medium, Low, or No priority, or integers/numeric strings from 0 to 4. Values outside that range are rejected.

Use JSON `null` to clear nullable references or dates. Use `[]` to clear relationship lists. Actor references are `assigneeId`, `leadId`, `memberIds`, and `subscriberIds`; other IDs select the related resource. Boolean IDs, invalid object/array types, nonfinite numbers, and negative estimates/capacity are rejected.

Dates use valid `YYYY-MM-DD`. Empty optional dates are stored as null. Cycle endpoints also accept ISO timestamps and must be in chronological order. Recurring rules accept Daily, Weekly, Every 2 weeks, or Monthly and a valid nextRun date.

Workflow categories are Backlog, Unstarted, Started, Completed, Canceled, and Duplicate. Project statuses and saved-view scopes use the values in [the specification](../SPEC.md). Saved-view `entity` is `issues` or `projects`. `filters`, `display`, `trigger`, `condition`, and `action` are JSON objects. `recurringRule` accepts an object, text, or null; objects are stored as JSON text. This issue field does not create a schedule. Create a recurring rule through `/api/recurring` to schedule issue creation.

Issue team/status, project/team, cycle/team, milestone/project, and parent relationships are checked by shared actions. Changing a team or project must clear or replace incompatible cycle or milestone references. Existing issue identifiers remain unchanged after a team move.

Filters store the UI's selected scalar values, such as `{"priority":"Urgent","status":"All"}`. Display settings include layout, groupBy, orderBy, direction, and visibility options. Arbitrary filter objects are stored, but the UI only applies supported fields and values; an array is not a scalar filter value.

### Automation rules

`trigger.event` is `issue.created`, `issue.updated`, or `issue.completed`. An empty trigger never matches. `condition.priority` is a priority name or `Any`. `condition.label` is a label name or `Any`. Omitted, null, or empty text values for these two conditions impose no restriction.

Each rule runs one action. `action.assignTo` selects an active actor ID and takes precedence over `action.name`. Otherwise, `action.name` supports `Assign to me`, `Add LABEL_NAME label`, or `Set status: STATUS_NAME`. `Assign to me` selects the actor that caused the event. Label and status names must match existing records for the issue team; workspace labels also match. Unknown action names, missing labels, and missing statuses cause no change.

```json
{
  "actorId": 1,
  "teamId": 1,
  "name": "Assign urgent issues",
  "trigger": {"event": "issue.created"},
  "condition": {"priority": "Urgent"},
  "action": {"name": "Assign to me"}
}
```

## Errors and retries

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid input, missing required field, or invalid action relationship |
| 404 | Unknown read or mutation route, or missing read resource |
| 409 | SQLite relationship conflict, inactive/unknown actor, or synchronization conflict |
| 503 with `committed: true` | The change committed; snapshot publication needs recovery |
| 503 without `committed` | Storage is unavailable during a read |
| 500 | Unexpected mutation failure |

Some missing mutation records return 400, consistent with shared CLI actions. Some idempotent Inbox and resource actions succeed when no record matches. Read-route errors and mutation errors do not have the CLI's structured error codes.

For a committed error, do not repeat the mutation. Use `sync status` or `sync export` through the CLI to recover publication. For a synchronization conflict, inspect both database and snapshot state before import or export. See [recovery instructions](CLI.md#file-format-and-recovery).
