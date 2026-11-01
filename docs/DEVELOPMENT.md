# Development and verification

Read [repository instructions](../AGENTS.md) and [the glossary](../GLOSSARY.md) before changes. Use English technical text with short, direct sentences. Use the same product term across code, UI, and documentation.

## Safe local setup

Install Node.js 24.15 or later. Then run `npm ci` from the repository root. Use an unused directory to keep test data separate from real records:

```sh
npm run build
node bin/clone.js --data-dir /tmp/clone-check init --demo
node bin/clone.js --data-dir /tmp/clone-check serve --port 4174
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174). Stop the server with Ctrl+C. Reuse the same data directory to test restart. Run `init` without `--demo` to test an empty workspace.

Use the CLI for workspace actions. Tests can build invalid records or inject failures in temporary storage. Do not run import, migration, forced synchronization, or demo initialization against real storage.

## Automated checks

```sh
npm run check
npm pack --dry-run
```

The checks format and type-check the TypeScript source. They also run the runtime, storage, command-contract, and UI model tests. The tests use temporary directories and do not change repository snapshots. GitHub Actions runs the same checks on each pull request and each push to `main`.

Add a regression test for each behavior bug. Test rejected changes and confirm that storage remains unchanged after failure. Do not add tests that only copy implementation details.

## Browser checks

Reload after changes because there is no hot reload. Use temporary storage for this checklist:

- Start both a demo workspace and a workspace without teams. Confirm that the empty state offers team creation and Settings opens.
- Create an issue. Edit its title, status, assignment, dates, comment, and attachment.
- Create a custom Completed status. Check Active, completed visibility, triage, and progress.
- Check issue list and board layouts, filters, grouping, empty groups, and sorting.
- Create and edit a project. Check teams, participants, milestones, updates, dependencies, archive, and restore.
- Save a team view. Confirm that another team's view does not appear.
- Check Inbox actions, cycles, human rosters, and preferences.
- Check search result ordering while the query changes.
- Use Tab, Shift+Tab, and Escape in dialogs. Confirm visible focus and focus return.
- Check desktop and narrow layouts. Confirm that the browser console has no unexpected errors.
- Refresh and restart the server. Confirm that records remain.

## Documentation and delivery

Treat the implementation and tests as evidence for current behavior. Keep historical observations in [the reference audit](REFERENCE-AUDIT.md), not in current requirements.

Check relative links, command help, examples, routes, and glossary terms. Run examples only with temporary storage. Review `git diff --check`, the final diff, and `git status --short`. Do not include workspace data, backups, generated packages, bytecode, or browser artifacts.

Before release, run `npm pack --dry-run`. Inspect the file list. Install the generated tarball in a temporary directory and run `clone --local init --demo`. Do not create a tag or publish npm without approval.
