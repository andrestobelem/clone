export const schema = `
CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'A', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'Member', avatar_color TEXT NOT NULL DEFAULT '#d8b5a4', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('member','agent')),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  member_id INTEGER UNIQUE REFERENCES members(id), key TEXT UNIQUE, avatar_color TEXT NOT NULL DEFAULT '#8585cc', created_at TEXT NOT NULL,
  CHECK((kind='member' AND member_id IS NOT NULL AND member_id=id AND key IS NULL) OR (kind='agent' AND member_id IS NULL AND key IS NOT NULL AND length(trim(key)) > 0))
);
CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '✳', timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires', estimate_type TEXT NOT NULL DEFAULT 'Points', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_members (team_id INTEGER NOT NULL REFERENCES teams(id), member_id INTEGER NOT NULL REFERENCES actors(id), role TEXT NOT NULL DEFAULT 'Member', PRIMARY KEY(team_id, member_id));
CREATE TABLE IF NOT EXISTS issue_statuses (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL, category TEXT NOT NULL, position INTEGER NOT NULL, color TEXT NOT NULL DEFAULT '#8e8e98', is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#8585cc', team_id INTEGER REFERENCES teams(id), UNIQUE(name, team_id));
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Backlog', priority INTEGER NOT NULL DEFAULT 4, icon TEXT NOT NULL DEFAULT '◈', lead_id INTEGER REFERENCES actors(id), start_date TEXT, target_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS project_teams (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, team_id INTEGER NOT NULL REFERENCES teams(id), PRIMARY KEY(project_id, team_id));
CREATE TABLE IF NOT EXISTS project_members (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES actors(id), PRIMARY KEY(project_id, member_id));
CREATE TABLE IF NOT EXISTS project_labels (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id), PRIMARY KEY(project_id, label_id));
CREATE TABLE IF NOT EXISTS project_dependencies (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, depends_on_id INTEGER NOT NULL REFERENCES projects(id), dependency_type TEXT NOT NULL DEFAULT 'blocks', PRIMARY KEY(project_id, depends_on_id));
CREATE TABLE IF NOT EXISTS cycles (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Upcoming', capacity REAL NOT NULL DEFAULT 20, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS milestones (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'Todo', position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS project_updates (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, health TEXT NOT NULL DEFAULT 'On track', body TEXT NOT NULL, author_id INTEGER REFERENCES actors(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issues (id INTEGER PRIMARY KEY, identifier TEXT NOT NULL UNIQUE, number INTEGER NOT NULL, team_id INTEGER NOT NULL REFERENCES teams(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status_id INTEGER NOT NULL REFERENCES issue_statuses(id), priority INTEGER NOT NULL DEFAULT 4, assignee_id INTEGER REFERENCES actors(id), creator_id INTEGER REFERENCES actors(id), project_id INTEGER REFERENCES projects(id), cycle_id INTEGER REFERENCES cycles(id), milestone_id INTEGER REFERENCES milestones(id), due_date TEXT, estimate REAL, parent_id INTEGER REFERENCES issues(id), recurring_rule TEXT, external_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS issue_labels (issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES labels(id), PRIMARY KEY(issue_id, label_id));
CREATE TABLE IF NOT EXISTS issue_subscribers (issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES actors(id), PRIMARY KEY(issue_id, member_id));
CREATE TABLE IF NOT EXISTS issue_relations (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, related_issue_id INTEGER REFERENCES issues(id), relation_type TEXT NOT NULL DEFAULT 'relates to', url TEXT);
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, author_id INTEGER NOT NULL REFERENCES actors(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issue_attachments (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE, name TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL, storage_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity_events (id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, actor_id INTEGER REFERENCES actors(id), action TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS views (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '◈', entity TEXT NOT NULL DEFAULT 'issues', scope TEXT NOT NULL DEFAULT 'Personal', owner_id INTEGER REFERENCES actors(id), team_id INTEGER REFERENCES teams(id), filters_json TEXT NOT NULL DEFAULT '{}', display_json TEXT NOT NULL DEFAULT '{}', is_favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_resources (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, section TEXT NOT NULL DEFAULT 'Resources', title TEXT NOT NULL, url TEXT);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, recipient_id INTEGER NOT NULL REFERENCES actors(id), kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', entity_type TEXT, entity_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recurring_rules (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', cadence TEXT NOT NULL, next_run TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automations (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), name TEXT NOT NULL, trigger_json TEXT NOT NULL, condition_json TEXT NOT NULL DEFAULT '{}', action_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

export const issueStatuses = [
  ["Backlog", "Backlog"],
  ["Todo", "Unstarted"],
  ["In Progress", "Started"],
  ["In Review", "Started"],
  ["Done", "Completed"],
  ["Canceled", "Canceled"],
  ["Duplicate", "Duplicate"],
] as const;

export const priorities = [
  "Urgent",
  "High",
  "Medium",
  "Low",
  "No priority",
] as const;
