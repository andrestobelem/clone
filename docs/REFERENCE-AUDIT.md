# Reference UI audit

The original product audit used the installed Linear desktop application on 2026-10-02. The inspected workspace had one team and one member, with no issues, projects, documents, reviews, or custom views.

The audit inspected navigation, empty states, issue and project create forms, dropdown values, the issue action menu, saved-view scope/filter/display controls, Inbox actions, Review tabs, Agent controls, team pages, status catalogs, and account/team settings. It did not save new issues, projects, views, or settings in the reference application.

The audit could not verify populated issue details, project details, collaboration, or team workflows end to end. Notes about those behaviors were design proposals, not proof of Linear behavior.

The first local prototype kept sample data in JavaScript memory. The current application uses a Python server, SQLite, a CLI, and Git snapshots. It has a separate local product scope. Documents, reviews, member invitations, and agent chat were later excluded at the user's request. External agents use actor identities through the CLI and API.

Use [the current specification](../SPEC.md) for supported behavior. Reference controls do not establish an implementation requirement or a connected service.
