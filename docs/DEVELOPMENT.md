# Development and verification

Read [repository instructions](../AGENTS.md) and [the glossary](../GLOSSARY.md) before changes. Use English technical text with short, direct sentences. Use the same product term across code, UI, and documentation.

## Safe local setup

Run from the repository root with the Python 3.14 environment. Run `uv sync --locked` first. Use an unused directory to separate demo data from real records:

```sh
uv run python cli.py --db /tmp/clone-check/workspace.sqlite3 init --demo
PORT=4174 uv run python cli.py --db /tmp/clone-check/workspace.sqlite3 serve
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174). Stop the server with Ctrl+C. Reuse the same database path to test restart. For a workspace without teams, create a second unused directory and run `init` without `--demo`.

Use the CLI for workspace actions. Test fixtures can build invalid records or inject failures in temporary storage. Do not run import, migration, forced synchronization, or demo initialization against real storage for a code check.

## Automated checks

```sh
uv run python -m unittest discover -s tests -v
uv run python -m py_compile cli.py server.py workspace.py snapshot.py validation.py
```

The tests use temporary directories and loopback HTTP servers. They do not need a running application or change repository snapshots. They cover actor identities, CLI/HTTP action parity, invalid payloads, relationships, attachments, concurrent writes, stable snapshots, migration, and interrupted-operation recovery.

If Node.js 18 or later is already available, run `node --check app.js` and `node --test tests/test_ui.js`. The UI model tests cover custom workflow categories, empty groups, team views, defaults, and display toggles. Node.js is optional and is not an application dependency.

Add a regression test for each behavior bug. Test results and rejected changes, including unchanged storage after failure. Do not add tests that only copy implementation details. Run the complete suite after changes to shared actions or storage.

## Browser checks

Reload after changes because there is no hot reload. Use temporary storage for this checklist:

- Start both a demo workspace and a workspace without teams. Confirm the empty state offers team creation and Settings opens.
- Create an issue. Switch its team in the form and check status, project, cycle, and label options. Edit its title, status, assignment, and dates; add a comment and attachment.
- Create a custom Completed status. Check Active, completed visibility, triage, and progress against that category.
- Check issue list/board, filters, grouping, empty status groups, and sorting. Open a row with Enter and Space.
- Create and edit a project. Check linked teams, participants, milestones, updates, dependencies, archive, and restore.
- Save a team view. Switch teams, open the view, and confirm its team, title, filters, and display settings. Confirm Team views does not show another team's views.
- Check Inbox unread, individual, and selected-item actions. Check team selection, cycles, human rosters, and local preferences.
- Search, change the query, change scope, and close before a response. Check that closed dialogs stay closed and older results do not replace newer ones.
- Use Tab, Shift+Tab, and Escape in dialogs. Confirm visible focus, background isolation, accessible control names, and focus return.
- Check desktop and narrow layouts. Confirm there are no unexpected console errors.
- Refresh and restart the server. Confirm saved records remain.

## Documentation and delivery

Treat the implementation and tests as evidence for current behavior. Keep historical observations in [the reference audit](REFERENCE-AUDIT.md), not in current requirements.

Check relative links, command help, examples, route tables, and the glossary. Run examples that write data only in temporary storage. Use valid payload fields; [the command catalog](CLI.md#discovery-and-errors) lists flags but does not describe every business requirement.

Review `git diff --check`, the final diff, and `git status --short`. Preserve earlier uncommitted work. Do not include temporary storage, backups, bytecode, or browser artifacts. Use atomic Conventional Commits when commits are requested, without co-author trailers.

Report what changed, which checks passed, and any behavior that remains unverified. Do not claim full feature parity or full accessibility compliance from smoke checks.
