"""Validate input shared by the CLI and HTTP actions."""
from datetime import date, datetime, timezone
import json
import math
import re


CADENCES = ("Daily", "Weekly", "Every 2 weeks", "Monthly")
STATUS_CATEGORIES = ("Backlog", "Unstarted", "Started", "Completed", "Canceled", "Duplicate")


def json_value(value):
    def reject_constant(value):
        raise ValueError("Invalid JSON number: " + value)
    return json.loads(value, parse_constant=reject_constant)


def date_value(value, field, optional=False):
    if optional and value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError(field + " must be a date")
    try:
        result = date.fromisoformat(value)
        if result.isoformat() != value:
            raise ValueError()
    except ValueError as error:
        raise ValueError(field + " must use YYYY-MM-DD with a valid date") from error
    return value


def timestamp_value(value, field):
    if not isinstance(value, str):
        raise ValueError(field + " must be a date or timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(field + " must be a valid ISO date or timestamp") from error
    return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc)


def mutation_payload(data, path):
    if not isinstance(data, dict):
        raise ValueError("Request body must be an object")
    try:
        json.dumps(data, allow_nan=False)
    except (ValueError, TypeError) as error:
        raise ValueError("Request body must contain JSON values with finite numbers") from error
    result = dict(data)
    for field in ("title", "name", "body", "description", "summary", "status", "health", "key", "icon", "color",
                  "category", "timezone", "estimateType", "cadence", "scope", "entity", "section", "url", "type",
                  "externalUrl", "relatedIssueId"):
        if field in result and not isinstance(result[field], str):
            if field in ("externalUrl", "url") and result[field] is None:
                continue
            raise ValueError(field + " must be text")
    for field in ("title", "name", "body", "key"):
        if field in result:
            result[field] = result[field].strip()
            if not result[field]:
                raise ValueError(field + " must not be empty")
    for field in ("teamId", "projectId", "cycleId", "milestoneId", "parentId", "dependsOnId"):
        if field in result:
            value = result[field]
            if value is None and (field in ("projectId", "cycleId", "milestoneId", "parentId") or (field == "teamId" and (path == "/api/labels" or path == "/api/views" or re.fullmatch(r"/api/views/\d+",path)))):
                continue
            if type(value) is not int or value < 1:
                raise ValueError(field + " must be a positive integer")
    for field in ("labelIds", "teamIds", "dependencies", "ids"):
        if field in result:
            values = result[field]
            if not isinstance(values, list) or any(type(v) is not int or v < 1 for v in values):
                raise ValueError(field + " must be an array of positive integers")
            result[field] = list(dict.fromkeys(values))
    for field in ("filters", "display", "trigger", "condition", "action"):
        if field in result and not isinstance(result[field], dict):
            raise ValueError(field + " must be an object")
    for field in ("issues", "files", "milestones"):
        if field in result and (not isinstance(result[field], list) or any(not isinstance(v, dict) for v in result[field])):
            raise ValueError(field + " must be an array of objects")
    for field in ("estimate", "capacity"):
        if field in result:
            value = result[field]
            if field == "estimate" and value is None:
                continue
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError(field + " must be a finite number of zero or more")
    for field in ("dueDate", "startDate", "targetDate"):
        if field in result:
            result[field] = date_value(result[field], field, optional=True)
    if path == "/api/cycles":
        start = timestamp_value(result.get("startsAt"), "startsAt")
        end = timestamp_value(result.get("endsAt"), "endsAt")
        if end < start:
            raise ValueError("Cycle end must not be before its start")
    if path == "/api/recurring":
        if result.get("cadence", "Weekly") not in CADENCES:
            raise ValueError("Unknown recurring cadence")
        if "nextRun" in result:
            result["nextRun"] = date_value(result["nextRun"], "nextRun")
    if path == "/api/statuses" and result.get("category", "Unstarted") not in STATUS_CATEGORIES:
        raise ValueError("Unknown workflow status category")
    if path == "/api/projects" or re.fullmatch(r"/api/projects/\d+", path):
        if "status" in result and result["status"] not in ("Backlog", "Planned", "In Progress", "Completed", "Canceled"):
            raise ValueError("Unknown project status")
    if path == "/api/views" or re.fullmatch(r"/api/views/\d+", path):
        if "entity" in result and result["entity"] not in ("issues", "projects"):
            raise ValueError("Unknown view entity")
        if "scope" in result and result["scope"] not in ("Personal", "Workspace", "Team"):
            raise ValueError("Unknown view scope")
        if "isFavorite" in result and type(result["isFavorite"]) not in (bool, int):
            raise ValueError("isFavorite must be a boolean or 0 or 1")
        if "isFavorite" in result and result["isFavorite"] not in (True, False):
            raise ValueError("isFavorite must be a boolean or 0 or 1")
    if path == "/api/automations":
        trigger, condition, action = result.get("trigger", {}), result.get("condition", {}), result.get("action", {})
        if "event" in trigger and trigger["event"] not in ("issue.created", "issue.updated", "issue.completed"):
            raise ValueError("Unknown automation event")
        if "priority" in condition and condition["priority"] not in (None,"","Any","Urgent","High","Medium","Low","No priority"):
            raise ValueError("Unknown automation priority condition")
        if "label" in condition and condition["label"] is not None and not isinstance(condition["label"],str):
            raise ValueError("Automation label condition must be text")
        if "name" in action and not isinstance(action["name"], str):
            raise ValueError("Automation action name must be text")
    if path == "/api/preferences":
        if "sidebar" in result and (not isinstance(result["sidebar"],dict) or any(type(v) is not bool for v in result["sidebar"].values())):
            raise ValueError("sidebar must be an object of booleans")
        for field in ("autoAssignToSelf", "spelling"):
            if field in result and type(result[field]) is not bool:
                raise ValueError(field + " must be a boolean")
    if path == "/api/settings":
        key, value = result.get("key"), result.get("value", {})
        if key in ("preferences", "workspace"):
            if not isinstance(value, dict):
                raise ValueError(key + " must be an object")
            if key == "preferences":
                mutation_payload(value, "/api/preferences")
            if key == "workspace" and "name" in value:
                if not isinstance(value["name"], str) or not value["name"].strip():
                    raise ValueError("Workspace name must not be empty")
        if key == "integrations" and (not isinstance(value, list) or any(not isinstance(v,dict) for v in value)):
            raise ValueError("integrations must be an array of objects")
    if "milestones" in result:
        result["milestones"] = [mutation_payload(item, "/api/milestones") for item in result["milestones"]]
    if "recurringRule" in result and result["recurringRule"] is not None:
        rule = result["recurringRule"]
        if isinstance(rule, dict):
            result["recurringRule"] = json.dumps(rule, allow_nan=False)
        elif not isinstance(rule, str):
            raise ValueError("recurringRule must be an object, text, or null")
    return result
