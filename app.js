const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const content = $("#content-area"), modalLayer = $("#modal-layer"), commandLayer = $("#command-layer");
const PRIORITIES = ["Urgent", "High", "Medium", "Low", "No priority"];
const GROUPS = ["Status", "Assignee", "Project", "Priority", "Cycle", "Label", "Team"];
const SORTS = ["Manual", "Title", "Status", "Priority", "Assignee", "Estimate", "Updated", "Created", "Due date", "Link count", "Time in status"];
const ISSUE_PAGES = ["Issues", "My issues"];
const STATUS_CLASS = {"In Progress":"progress", "In Review":"review", Todo:"todo", Backlog:"backlog", Done:"done", Canceled:"canceled", Duplicate:"canceled"};
let data = null, currentPage = "Issues", currentView = "All issues", selectedIssue = null, selectedProject = null;
let selectedNotification = null, selectedNotifications = new Set(), inboxUnreadOnly = false, filters = {status:"All", priority:"All", assignee:"All", project:"All", label:"All", creator:"All", relations:"All", dueDate:"All", projectStatus:"All", subscribers:"All", externalLink:"All"};
let display = {layout:"List", groupBy:"Status", orderBy:"Updated", direction:"Descending", showCompleted:true, completedAtBottom:false, showSubissues:true, showEmptyGroups:false};
let popoverNode = null, searchScope = "All", viewId = null, issueParentId = null, activeTeamId = 1, importPreview = null;

function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function priorityName(v) { return typeof v === "number" ? PRIORITIES[v] || "No priority" : v || "No priority"; }
function priorityIndex(v) { return PRIORITIES.indexOf(priorityName(v)); }
function api(path, options = {}) {
  const opts = Object.assign({headers:{"Content-Type":"application/json"}}, options);
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  return fetch(path, opts).then(async response => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Something went wrong");
    return body;
  });
}
async function refresh() { data = await api("/api/bootstrap"); updateShell(); renderPage(); }
function toast(message) { const node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 2600); }
function report(error) { console.error(error); toast(error.message || "Could not save changes"); }
async function save(method, path, body) { const result = await api(path, {method, body}); await refresh(); return result; }
function priorityMark(v) { return ["⇈","↑","↗","↓","–"][priorityIndex(v)] || "–"; }
function statusClass(v) { return STATUS_CLASS[v] || "backlog"; }
function avatar(name, color) {
  const person = data.members.find(m => m.name === name) || {};
  const initials = String(name || "?").split(/\s+/).slice(0,2).map(part => part[0] || "").join("").toUpperCase();
  return '<span class="mini-avatar" style="background:' + esc(color || person.avatar_color || "#aaa") + '">' + esc(initials) + '</span>';
}
function team(id = activeTeamId) { return data.teams.find(t => t.id === Number(id)) || data.teams[0]; }
function statuses(teamId = activeTeamId) { return data.statuses.filter(s => s.team_id === Number(teamId)).sort((a,b) => a.position-b.position); }
function projectOptionsForTeam(teamId) { return data.projects.filter(p => p.teams.some(t => t.id === Number(teamId))).map(p => ({value:p.id,label:p.name})); }
function refreshIssueProjectOptions(form, preferredId) {
  const projectSelect=$("select[name='projectId']",form),teamSelect=$("select[name='teamId']",form);
  if(!projectSelect||!teamSelect)return false;
  const selected=preferredId===undefined?projectSelect.value:preferredId;
  const projects=projectOptionsForTeam(teamSelect.value),isAllowed=projects.some(p=>Number(p.value)===Number(selected));
  projectSelect.innerHTML=options([{value:"",label:"No project"},...projects],isAllowed?selected:"");
  return Boolean(selected)&&!isAllowed;
}
function options(list, current, label = "") { return (label ? '<option value="">' + esc(label) + '</option>' : "") + list.map(x => { const value=x.value==null?x:x.value, chosen=Array.isArray(current)?current.map(String).includes(String(value)):String(value)===String(current==null?"":current);return '<option value="'+esc(value)+'" '+(chosen?'selected':'')+'>'+esc(x.label==null?x:x.label)+'</option>'; }).join(""); }
function select(name, list, current, label = "", attrs = "") { return '<select name="' + name + '" ' + attrs + '>' + options(list,current,label) + '</select>'; }
function input(name, value = "", placeholder = "", type = "text", attrs = "") { return '<input name="' + name + '" type="' + type + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" ' + attrs + '>'; }
function field(label, control, wide = false) { return '<label class="form-field' + (wide ? ' wide' : '') + '"><span>' + esc(label) + '</span>' + control + '</label>'; }
function pageTitle(page) { return ({"Home":"Product overview","Issues":"Issues","My issues":"My issues","Team projects":"Projects","Team views":"Views","Triage":"Triage","Archive":"Archive"})[page] || page; }
function updateShell() {
  $("#sidebar").classList.toggle("collapsed",localStorage.getItem("clone-sidebar-collapsed")==="true");
  document.body.classList.toggle("dark-theme", (data.settings.preferences || {}).theme === "Dark");
  document.documentElement.style.fontSize=({Small:"12px",Default:"13px",Large:"15px"})[(data.settings.preferences||{}).fontSize]||"13px";
  const sidebarPrefs=(data.settings.preferences||{}).sidebar||{};
  for(const [name,visible] of Object.entries(sidebarPrefs)) $$(".nav-item[data-page=\""+name+"\"]").forEach(el=>el.classList.toggle("preference-hidden",!visible));
  $(".workspace-name").textContent = (data.workspace.name || "Workspace").toLowerCase();
  $(".workspace-avatar").textContent = data.workspace.icon || "A";
  const teamNode=$(".team-name");if(teamNode){$(".team-emoji",teamNode).textContent=team().icon;const name=$$("span",teamNode)[1];if(name)name.textContent=team().name;}
  $(".user-meta b").textContent = data.members.find(m => m.id === data.currentMemberId)?.name || "Member";
  $("#page-title").textContent = viewId ? currentView : pageTitle(currentPage);
  $("#tab-title").textContent = viewId ? currentView : pageTitle(currentPage);
  $("#breadcrumb").textContent = currentPage.startsWith("Team") || ["Home","Issues","Members","Cycles"].includes(currentPage) ? team().name + " / " + pageTitle(currentPage) : "Workspace / " + pageTitle(currentPage);
  $$(".nav-item[data-page]").forEach(node => node.classList.toggle("active", node.dataset.page === currentPage));
  const showToolbar = ISSUE_PAGES.includes(currentPage) || ["Projects","Team projects","Views","Team views","Members","Cycles"].includes(currentPage);
  $("#view-toolbar").classList.toggle("hidden", !showToolbar);
  $("#new-issue-header").classList.toggle("hidden", !ISSUE_PAGES.includes(currentPage));
  $("#new-project").classList.toggle("hidden", !["Projects","Team projects"].includes(currentPage));
  $("#share-view").classList.toggle("hidden", !["Issues","Projects","Team projects","Views","Team views"].includes(currentPage));
  if (currentPage === "Inbox") $(".nav-count").textContent = data.notifications.filter(n => !n.is_read).length || "";
}
function setPage(page) {
  currentPage = page; selectedIssue = null; selectedProject = null; selectedNotification = null;
  const baseView = page === "My issues" ? "Assigned" : ["Projects","Team projects"].includes(page) ? "All projects" : ["Views","Team views"].includes(page) ? "Issues" : "All issues";
  currentView = baseView; viewId = null;
  localStorage.setItem("clone-page",page);
  history.replaceState(null,"","#" + encodeURIComponent(page.toLowerCase().replaceAll(" ","-")));
  updateShell(); renderPage();
}
function setViewTabs() {
  const tabs = $("#view-tabs");
  let names = ISSUE_PAGES.includes(currentPage) ? (currentPage === "My issues" ? ["Assigned","Created","Subscribed","Activity"] : ["All issues","Active","Backlog"]) : ["All projects"];
  if (["Views","Team views"].includes(currentPage)) names = ["Issues","Projects"];
  if (viewId) names = [currentView];
  tabs.innerHTML = names.map(name => '<button class="view-pill ' + (name === currentView ? "selected" : "") + '" data-view="' + esc(name) + '">' + esc(name) + '</button>').join("") + (viewId?'<button class="saved-view" data-action="update-view" title="Save current view settings">✓</button>':'') + '<button class="saved-view" data-action="create-view" title="Create saved view">＋</button>';
  tabs.classList.toggle("hidden", ["Inbox","Triage","Archive","Home","Settings","Team overview","Members","Cycles"].includes(currentPage));
}
function renderPage() {
  if (!data) return;
  setViewTabs();
  if (selectedIssue) return renderIssueDetail();
  if (selectedProject) return renderProjectDetail();
  if (ISSUE_PAGES.includes(currentPage)) return renderIssues();
  if (["Projects","Team projects"].includes(currentPage)) return renderProjects();
  if (["Views","Team views"].includes(currentPage)) return renderViews();
  if (currentPage === "Inbox") return renderInbox();
  if (currentPage === "Triage") return renderTriage();
  if (currentPage === "Archive") return renderArchive();
  if (currentPage === "Members") return renderMembers();
  if (currentPage === "Cycles") return renderCycles();
  if (currentPage === "Settings") return renderSettings();
  if (currentPage === "Home" || currentPage === "Team overview") return renderTeamHome();
  return renderTeamHome();
}
function groupValue(issue,key) {
  if(key==="Status")return issue.status;
  if(key==="Assignee")return issue.assignee||"Unassigned";
  if(key==="Project")return issue.project||"No project";
  if(key==="Priority")return priorityName(issue.priority);
  if(key==="Cycle")return issue.cycle||"No cycle";
  if(key==="Label")return issue.labels[0]?.name||"No label";
  if(key==="Team")return issue.team_name;
  return "Other";
}
function issueGroups(list,key=display.groupBy) {
  let keys=[...new Set(list.map(issue=>groupValue(issue,key)))];
  if(!keys.length&&display.showEmptyGroups)keys=key==="Status"?statuses().map(s=>s.name):[];
  if(key==="Status")keys.sort((a,b)=>statuses().findIndex(x=>x.name===a)-statuses().findIndex(x=>x.name===b));
  if(key==="Priority")keys.sort((a,b)=>priorityIndex(a)-priorityIndex(b));
  return keys.map(name=>({name,issues:list.filter(issue=>groupValue(issue,key)===name)}));
}
function filterIssues() {
  let list = data.issues.filter(i => i.team_id === activeTeamId || currentPage === "My issues" || !["Issues","Team issues"].includes(currentPage));
  if (!display.showSubissues) list = list.filter(i => !i.parent_id);
  if (filters.status !== "All") list = list.filter(i => i.status === filters.status);
  if (filters.priority !== "All") list = list.filter(i => priorityName(i.priority) === filters.priority);
  if (filters.assignee !== "All") list = list.filter(i => filters.assignee === "Unassigned" ? !i.assignee_id : i.assignee === filters.assignee);
  if (filters.project !== "All") list = list.filter(i => filters.project === "No project" ? !i.project_id : String(i.project_id) === String(filters.project));
  if (filters.projectStatus !== "All") list = list.filter(i => data.projects.find(p => p.id === Number(i.project_id))?.status === filters.projectStatus);
  if (filters.label !== "All") list = list.filter(i => filters.label === "No label" ? !i.labels.length : i.labels.some(l => l.name === filters.label));
  if (filters.creator !== "All") list = list.filter(i => filters.creator === "Me" ? i.creator_id===data.currentMemberId : String(i.creator_id)===String(filters.creator));
  if (filters.relations === "Linked") list = list.filter(i => i.relations.length>0);
  if (filters.relations === "No links") list = list.filter(i => !i.relations.length);
  if (filters.subscribers === "Me") list = list.filter(i => i.subscribers.some(m => m.id === data.currentMemberId));
  if (filters.subscribers === "No subscribers") list = list.filter(i => !i.subscribers.length);
  if (filters.subscribers === "Others") list = list.filter(i => i.subscribers.some(m => m.id !== data.currentMemberId));
  if (filters.subscribers === "Has subscribers") list = list.filter(i => i.subscribers.length > 0);
  if (filters.externalLink === "Has link") list = list.filter(i => !!i.external_url);
  if (filters.externalLink === "No link") list = list.filter(i => !i.external_url);
  if (filters.dueDate !== "All") {
    const today=new Date(),todayUtc=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());
    list=list.filter(i=>{if(filters.dueDate==="No date")return !i.due_date;if(!i.due_date)return false;const due=new Date(i.due_date+"T00:00:00Z").getTime(),delta=Math.round((due-todayUtc)/86400000);return filters.dueDate==="Overdue"?delta<0:delta>=0&&delta<=7;});
  }
  if (currentPage === "My issues") {
    if (currentView === "Assigned") list = list.filter(i => i.assignee_id === data.currentMemberId);
    else if (currentView === "Created") list = list.filter(i => i.creator_id === data.currentMemberId);
    else if (currentView === "Subscribed") list = list.filter(i => i.subscribers.some(m => m.id === data.currentMemberId));
    else if (currentView === "Activity") list = list.filter(i => i.activity.some(a=>a.actor_id===data.currentMemberId)||i.comments.some(c=>c.author_id===data.currentMemberId));
  }
  if (currentView === "Active") list = list.filter(i => !["Done","Canceled","Duplicate"].includes(i.status));
  if (currentView === "Backlog") list = list.filter(i => i.status === "Backlog");
  if (!display.showCompleted) list = list.filter(i => !["Done","Canceled","Duplicate"].includes(i.status));
  const order = display.orderBy;
  list.sort((a,b) => {
    if(display.completedAtBottom){const aDone=["Done","Canceled","Duplicate"].includes(a.status),bDone=["Done","Canceled","Duplicate"].includes(b.status);if(aDone!==bDone)return aDone?1:-1;}
    let cmp = 0;
    if (order === "Manual") cmp = a.number-b.number;
    else if (order === "Priority") cmp = priorityIndex(a.priority)-priorityIndex(b.priority);
    else if (order === "Title") cmp = a.title.localeCompare(b.title);
    else if (order === "Status") cmp = a.status.localeCompare(b.status);
    else if (order === "Assignee") cmp = (a.assignee||"").localeCompare(b.assignee||"");
    else if (order === "Created") cmp = a.created_at.localeCompare(b.created_at);
    else if (order === "Due date") cmp = (a.due_date||"9999").localeCompare(b.due_date||"9999");
    else if (order === "Estimate") cmp = (a.estimate||0)-(b.estimate||0);
    else if (order === "Link count") cmp = ((a.relations||[]).length+!!a.external_url)-((b.relations||[]).length+!!b.external_url);
    else if (order === "Time in status") cmp = (a.status_changed_at||a.created_at).localeCompare(b.status_changed_at||b.created_at);
    else cmp = a.updated_at.localeCompare(b.updated_at);
    return display.direction === "Ascending" ? cmp : -cmp;
  });
  return list;
}
function renderIssues() {
  const list = filterIssues();
  $("#filter-button").classList.toggle("is-active", Object.values(filters).some(v => v !== "All"));
  const defaultProperties={Status:true,Priority:true,Assignee:true,Project:false,Label:false,"Due date":false,Updated:true},properties=Object.assign({},defaultProperties,display.properties||{});
  $("#display-button").classList.toggle("is-active", display.layout !== "List" || display.groupBy !== "Status" || (display.groupBy2&&display.groupBy2!=="None") || display.orderBy!=="Updated" || display.direction!=="Descending" || !display.showCompleted || display.completedAtBottom || !display.showSubissues || display.showEmptyGroups || Object.keys(defaultProperties).some(k=>properties[k]!==defaultProperties[k]));
  if (!list.length) { content.innerHTML = '<div class="empty-state"><div class="empty-illustration"><span>◇</span></div><h2>No issues found</h2><p>Change your filters or create an issue for ' + esc(team().name) + '.</p><button class="primary-button" data-action="new-issue">Create issue</button></div>'; return; }
  const groups = issueGroups(list);
  if (display.layout === "Board") {
    content.innerHTML = '<div class="board-grid">' + groups.map(g => '<section class="board-column" data-drop-group="' + esc(g.name) + '"><header><i class="status-dot ' + statusClass(g.name) + '"></i><b>' + esc(g.name) + '</b><span>' + g.issues.length + '</span></header>' + g.issues.map(issueCard).join("") + '</section>').join("") + '</div>';
    return;
  }
  content.innerHTML = '<div class="issue-list">' + groups.map(g => {
    const secondary=display.groupBy2&&display.groupBy2!=="None"&&display.groupBy2!==display.groupBy?issueGroups(g.issues,display.groupBy2):null;
    const rows=secondary?secondary.map(sub=>'<section class="secondary-issue-group"><button class="group-head secondary-head" data-action="toggle-group"><span class="group-chevron">⌄</span><i class="status-dot '+statusClass(sub.name)+'"></i><span>'+esc(sub.name)+'</span><span class="group-count">'+sub.issues.length+'</span></button><div class="group-rows">'+sub.issues.map(issueRow).join("")+'</div></section>').join(""):g.issues.map(issueRow).join("");
    return '<section class="issue-group"><button class="group-head" data-action="toggle-group"><span class="group-chevron">⌄</span><i class="status-dot ' + statusClass(g.name) + '"></i><span>' + esc(g.name) + '</span><span class="group-count">' + g.issues.length + '</span></button><div class="group-rows">' + rows + '</div></section>';
  }).join("") + '</div>';
}
function issueRow(i) {
  const props=Object.assign({Status:true,Priority:true,Assignee:true,Project:false,Label:false,"Due date":false,Updated:true},display.properties||{}),cells=[];
  if(props.Status)cells.push('<span class="issue-status"><i class="status-dot '+statusClass(i.status)+'"></i>'+esc(i.status)+'</span>');
  if(props.Priority)cells.push('<span class="priority-chip"><i class="priority-mark p'+(priorityIndex(i.priority)+1)+'">'+priorityMark(i.priority)+'</i>'+esc(priorityName(i.priority))+'</span>');
  if(props.Assignee)cells.push('<span class="assignee-chip">'+avatar(i.assignee,i.assignee_color)+esc((i.assignee||"Unassigned").split(" ")[0])+'</span>');
  if(props.Project)cells.push('<span class="project-chip">'+esc(i.project||"No project")+'</span>');
  if(props.Label)cells.push('<span class="project-chip">'+esc(i.labels.map(l=>l.name).join(", ")||"No label")+'</span>');
  if(props["Due date"])cells.push('<span class="updated-cell">'+esc(i.due_date||"No due date")+'</span>');
  if(props.Updated)cells.push('<span class="updated-cell">'+esc(new Date(i.updated_at).toLocaleDateString())+'</span>');
  const cols=['70px','minmax(140px,1fr)',...cells.map(()=> 'minmax(72px,auto)')].join(" ");
  return '<div class="issue-row" style="--issue-columns:'+cols+'" data-issue="'+esc(i.identifier)+'" tabindex="0" role="button"><span class="issue-id">'+esc(i.identifier)+'</span><span class="issue-title">'+esc(i.title)+'</span>'+cells.join("")+'</div>';
}
function issueCard(i) { return '<button class="board-card" data-issue="' + esc(i.identifier) + '" draggable="true"><span class="issue-id">' + esc(i.identifier) + '</span><strong>' + esc(i.title) + '</strong><span class="card-foot"><i class="priority-mark p' + (priorityIndex(i.priority)+1) + '">' + priorityMark(i.priority) + '</i><span>' + esc(i.project||"") + '</span>' + avatar(i.assignee,i.assignee_color) + '</span></button>'; }
function projectCard(p) {
  const due=projectDue(p);
  return '<button class="project-card" data-project="' + p.id + '"><div class="project-card-top"><span class="project-icon">' + esc(p.icon) + '</span><span class="project-status">◉ ' + esc(p.status) + '</span></div><h3>' + esc(p.name) + '</h3><p>' + esc(p.summary) + '</p><div class="progress-track"><div class="progress-fill" style="width:' + p.progress + '%"></div></div><div class="project-foot"><span>' + p.completed_count + ' / ' + p.issue_count + ' issues</span><span>' + p.progress + '%</span></div><small class="'+due.className+'">' + esc(due.label) + '</small></button>';
}
function projectDue(project) {
  if(!project.target_date)return {label:"No target date",className:"project-due"};
  if(["Completed","Canceled"].includes(project.status))return {label:"Target · "+project.target_date,className:"project-due"};
  const today=new Date(),nowUtc=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()),target=new Date(project.target_date+"T00:00:00Z").getTime(),days=Math.round((target-nowUtc)/86400000);
  if(days<0)return {label:"Overdue · "+Math.abs(days)+"d",className:"project-due overdue"};
  if(days===0)return {label:"Due today",className:"project-due upcoming"};
  if(days<=14)return {label:"Due in "+days+"d",className:"project-due upcoming"};
  return {label:"Target · "+project.target_date,className:"project-due"};
}
function renderProjects() {
  let list = data.projects.slice();
  if (currentPage === "Team projects") list = list.filter(p => p.teams.some(t => t.id === activeTeamId));
  if (filters.status !== "All") list = list.filter(p => p.status === filters.status);
  if (filters.priority !== "All") list = list.filter(p => p.priority_name === filters.priority);
  if (filters.assignee !== "All") list = list.filter(p => p.lead?.name === filters.assignee);
  if (filters.label !== "All") list = list.filter(p => p.labels.some(l=>l.name===filters.label));
  if (display.orderBy === "Title" || display.orderBy === "Name") list.sort((a,b)=>a.name.localeCompare(b.name));
  else if (display.orderBy === "Priority") list.sort((a,b)=>priorityIndex(a.priority_name)-priorityIndex(b.priority_name));
  else if (display.orderBy === "Target date" || display.orderBy === "Due date") list.sort((a,b)=>(a.target_date||"9999").localeCompare(b.target_date||"9999"));
  if(display.direction==="Descending")list.reverse();
  if (display.layout === "Board") {
    const names = [...new Set(list.map(p => p.status))];
    content.innerHTML = '<div class="board-grid">' + names.map(n => '<section class="board-column"><header><i class="status-dot todo"></i><b>' + esc(n) + '</b><span>' + list.filter(p=>p.status===n).length + '</span></header>' + list.filter(p=>p.status===n).map(projectCard).join("") + '</section>').join("") + '</div>';
  } else content.innerHTML = list.length ? '<div class="project-grid">' + list.map(projectCard).join("") + '</div>' : emptyBlock("No projects yet","Create a project to coordinate work across teams.","new-project","Create project");
}
function renderIssueDetail() {
  const i = data.issues.find(x => x.identifier === selectedIssue);
  if (!i) { selectedIssue = null; return renderPage(); }
  content.innerHTML = '<div class="detail-page"><div class="detail-top"><button class="quiet-button" data-action="back">← Issues</button><span class="issue-id">' + esc(i.identifier) + '</span><div class="spacer"></div><button class="quiet-button" data-action="archive-issue">Archive</button><button class="quiet-button" data-action="issue-menu">···</button></div><input class="detail-title" data-issue-field="title" value="' + esc(i.title) + '"/><textarea class="detail-description" data-issue-field="description" placeholder="Add a description...">' + esc(i.description) + '</textarea><div class="property-grid">' + propertySelect("Status", "status", statuses(i.team_id).map(s=>s.name),i.status) + propertySelect("Priority","priority",PRIORITIES,priorityName(i.priority)) + propertySelect("Assignee","assigneeId",[{value:"",label:"Unassigned"},...data.members.map(m=>({value:m.id,label:m.name}))],i.assignee_id) + '<div class="property-control"><span>Team</span><strong>'+esc(i.team_name)+'</strong></div>' + propertySelect("Project","projectId",[{value:"",label:"No project"},...projectOptionsForTeam(i.team_id)],i.project_id) + propertySelect("Cycle","cycleId",[{value:"",label:"No cycle"},...data.cycles.map(c=>({value:c.id,label:c.name}))],i.cycle_id) + propertySelect("Estimate","estimate",["","1","2","3","5","8","13"],i.estimate||"") + propertyInput("Due date","dueDate",i.due_date||"","date") + '</div><section class="detail-section"><h3>Labels</h3><div class="chips">' + i.labels.map(l=>'<span class="label-chip" style="--label-color:' + esc(l.color) + '">' + esc(l.name) + '</span>').join("") + '<button class="tiny-button" data-action="issue-labels">＋ Add label</button></div></section>' + '<section class="detail-section"><div class="section-heading"><h3>Attachments</h3><button class="tiny-button" data-action="add-attachments">＋ Attach</button><input id="issue-file-picker" class="hidden" type="file" multiple></div>' + i.attachments.map(a=>'<a class="attachment-row" href="/api/attachments/'+a.id+'" download>'+esc(a.name)+' <small>'+Math.ceil(a.size/1024)+' KB</small></a>').join("") + '</section>' + detailRelated("Relations",i.relations.map(r=>'<div class="relation-line">' + esc(r.relation_type) + ' · ' + esc(r.related_identifier||r.url) + ' ' + esc(r.related_title||"") + '</div>').join(""),"add-relation") + detailRelated("Sub-issues",i.subissues.map(s=>'<button class="link-row" data-issue-id="' + s.id + '">' + esc(s.identifier) + ' · ' + esc(s.title) + '</button>').join(""),"add-subissue") + '<section class="detail-section"><h3>Activity</h3><form id="comment-form"><textarea name="body" placeholder="Leave a comment…" required></textarea><button class="primary-button">Comment</button></form>' + i.comments.map(c=>'<div class="activity-item">' + avatar(c.author,c.avatar_color) + '<div><b>' + esc(c.author) + '</b><p>' + esc(c.body) + '</p><small>' + esc(new Date(c.created_at).toLocaleString()) + '</small></div></div>').join("") + i.activity.map(a=>'<div class="activity-item"><span class="activity-dot"></span><div><b>' + esc(a.actor||"Workspace") + '</b><p>' + esc(a.action.replaceAll("_"," ")) + '</p><small>' + esc(new Date(a.created_at).toLocaleString()) + '</small></div></div>').join("") + '</section><footer class="detail-actions"><button class="tiny-button" data-action="add-relation">Link issue</button><button class="tiny-button" data-action="add-subissue">Add sub-issue</button><button class="tiny-button" data-action="subscribe">' + (i.subscribers.some(m=>m.id===data.currentMemberId)?"Unsubscribe":"Subscribe") + '</button></footer></div>';
}
function propertySelect(label,key,list,value) { return '<label class="property-control"><span>' + esc(label) + '</span>' + select(key,list,value) + '</label>'; }
function propertyInput(label,key,value,type) { return '<label class="property-control"><span>' + esc(label) + '</span><input data-issue-field="' + key + '" type="' + type + '" value="' + esc(value) + '"></label>'; }
function detailRelated(title,rows,action) { return '<section class="detail-section"><div class="section-heading"><h3>' + title + '</h3><button class="tiny-button" data-action="' + action + '">＋</button></div>' + (rows || '<small class="muted">Nothing linked yet</small>') + '</section>'; }
function renderProjectDetail() {
  const p = data.projects.find(x => x.id === Number(selectedProject));
  if (!p) { selectedProject = null; return renderPage(); }
  const progress = p.progress || 0;
  content.innerHTML = '<div class="detail-page project-detail"><div class="detail-top"><button class="quiet-button" data-action="back-projects">← Projects</button><span class="issue-id">Project</span><div class="spacer"></div><button class="quiet-button" data-action="edit-project">Edit project</button><button class="quiet-button" data-action="archive-project">Archive</button></div><div class="project-heading"><span class="project-icon large">' + esc(p.icon) + '</span><div><h2>' + esc(p.name) + '</h2><p>' + esc(p.summary) + '</p></div></div><div class="property-grid">' + propertySelect("Status","projectStatus",["Backlog","Planned","In Progress","Completed","Canceled"],p.status) + propertySelect("Priority","projectPriority",PRIORITIES,p.priority_name) + '<div class="property-control"><span>Lead</span><strong>' + esc(p.lead?.name||"Unassigned") + '</strong></div><div class="property-control"><span>Teams</span><strong>' + esc(p.teams.map(t=>t.name).join(", ")) + '</strong></div><div class="property-control"><span>Members</span><strong>' + esc(p.members.map(m=>m.name).join(", ")) + '</strong></div><div class="property-control"><span>Start date</span><strong>' + esc(p.start_date||"Not set") + '</strong></div><div class="property-control"><span>Target date</span><strong>' + esc(p.target_date||"Not set") + '</strong></div></div><section class="detail-section"><div class="section-heading"><h3>Progress</h3><span>' + p.completed_count + ' of ' + p.issue_count + ' complete · ' + progress + '%</span></div><div class="progress-track"><div class="progress-fill" style="width:' + progress + '%"></div></div></section><section class="detail-section"><div class="section-heading"><h3>Milestones</h3><button class="tiny-button" data-action="add-milestone">＋ Add milestone</button></div>' + (p.milestones.length ? p.milestones.map(m=>'<div class="milestone-row"><i class="status-dot ' + statusClass(m.status) + '"></i><b>' + esc(m.name) + '</b><span>' + esc(m.due_date||"No date") + '</span><span>' + esc(m.status) + '</span></div>').join("") : '<small class="muted">No milestones yet</small>') + '</section><section class="detail-section"><div class="section-heading"><h3>Issues</h3><button class="tiny-button" data-action="add-project-issue">＋ Add issue</button></div>' + (p.issues.length ? p.issues.map(x=>'<button class="link-row" data-issue="' + esc(x.identifier) + '"><span class="issue-id">' + esc(x.identifier) + '</span>' + esc(x.title) + '<span class="row-end">' + esc(x.status) + '</span></button>').join("") : '<small class="muted">No linked issues yet</small>') + '</section><section class="detail-section"><div class="section-heading"><h3>Dependencies</h3><button class="tiny-button" data-action="add-dependency">＋ Add</button></div>' + (p.dependencies.map(d=>'<div class="relation-line">Depends on · ' + esc(d.name) + '</div>').join("")||'<small class="muted">No dependencies</small>') + '</section><section class="detail-section"><h3>Description</h3><textarea class="detail-description" data-project-field="description" placeholder="Add project description…">' + esc(p.description) + '</textarea></section><section class="detail-section"><div class="section-heading"><h3>Updates</h3><button class="tiny-button" data-action="add-project-update">＋ Post update</button></div>' + (p.updates.length?p.updates.map(u=>'<article class="project-update"><span class="status-pill">'+esc(u.health)+'</span><p>'+esc(u.body)+'</p><small>'+esc(u.author||"")+' · '+esc(new Date(u.created_at).toLocaleString())+'</small></article>').join(""):'<small class="muted">No updates yet</small>') + '</section><section class="detail-section"><h3>Activity</h3>' + (p.activity||[]).map(a=>'<div class="activity-item"><span class="activity-dot"></span><div><b>'+esc(a.actor||"Workspace")+'</b><p>'+esc(a.action.replaceAll("_"," "))+'</p><small>'+esc(new Date(a.created_at).toLocaleString())+'</small></div></div>').join("") + '</section></div>';
}
function emptyBlock(title,description,action,label) { return '<div class="empty-state"><div class="empty-illustration"><span>◇</span></div><h2>' + esc(title) + '</h2><p>' + esc(description) + '</p><button class="primary-button" data-action="' + action + '">' + esc(label) + '</button></div>'; }
function renderViews() {
  const entity = currentView === "Projects" ? "projects" : "issues";
  const list = data.views.filter(v => v.entity === entity && (currentPage !== "Team views" || v.team_id === activeTeamId || v.scope === "Team"));
  content.innerHTML = list.length ? '<div class="view-grid">' + list.map(v=>'<article class="view-card"><button class="view-open" data-saved-view="' + v.id + '"><span class="project-icon">' + esc(v.icon) + '</span><h3>' + esc(v.name) + '</h3><p>' + esc(v.description) + '</p><small>' + esc(v.scope) + ' · ' + (v.entity === "issues" ? "Issues" : "Projects") + '</small></button><div><button class="tiny-button" data-action="favorite-view" data-id="' + v.id + '">' + (v.is_favorite?"★":"☆") + '</button><button class="tiny-button" data-action="edit-view" data-id="' + v.id + '" aria-label="Edit view">✎</button><button class="tiny-button" data-action="delete-view" data-id="' + v.id + '">···</button></div></article>').join("") + '</div>' : emptyBlock("No saved views","Save your filters and display settings as a view.","create-view","Create a view");
}
function renderInbox() {
  const rows = data.notifications;
  const selected = rows.find(n=>n.id===Number(selectedNotification)) || rows[0];
  selectedNotification = selected ? selected.id : null;
  selectedNotifications = new Set([...selectedNotifications].filter(id=>rows.some(n=>n.id===id)));
  const selectedCount=selectedNotifications.size,visibleRows=rows.filter(n=>!inboxUnreadOnly||!n.is_read),allVisibleSelected=visibleRows.length&&visibleRows.every(n=>selectedNotifications.has(n.id));
  content.innerHTML = '<div class="inbox-layout"><section class="inbox-list"><div class="inbox-toolbar"><label><input id="unread-only" type="checkbox" '+(inboxUnreadOnly?'checked':'')+'> Unread only</label><label class="select-all-label"><input id="select-all-notifications" type="checkbox" '+(allVisibleSelected?'checked':'')+'> Select all</label><button class="tiny-button" data-action="read-all">Mark all read</button><button class="tiny-button" data-action="read-selected" '+(!selectedCount?'disabled':'')+'>Mark selected read</button><button class="tiny-button" data-action="archive-selected" '+(!selectedCount?'disabled':'')+'>Archive selected'+(selectedCount?' ('+selectedCount+')':'')+'</button></div>' + (rows.length ? rows.map(n=>'<div class="notification-row ' + (!n.is_read?'unread ':'') + (selected&&selected.id===n.id?'selected':'') + (inboxUnreadOnly&&n.is_read?' filtered-out':'') + '" data-notification="' + n.id + '" role="button" tabindex="0"><input type="checkbox" aria-label="Select notification" data-notification-select="' + n.id + '" '+(selectedNotifications.has(n.id)?'checked':'')+'><i class="status-dot ' + (!n.is_read?'progress':'') + '"></i><span><b>' + esc(n.title) + '</b><small>' + esc(n.body) + '</small></span><time>' + esc(new Date(n.created_at).toLocaleDateString()) + '</time></div>').join("") : '<div class="empty-inline">You are all caught up.</div>') + '</section><aside class="inbox-detail">' + (selected ? '<div class="detail-top"><span class="muted">Notification</span><div class="spacer"></div><button class="tiny-button" data-action="notification-read" data-id="' + selected.id + '">' + (selected.is_read?'Mark unread':'Mark read') + '</button><button class="tiny-button" data-action="notification-archive" data-id="' + selected.id + '">Archive</button></div><h2>' + esc(selected.title) + '</h2><p>' + esc(selected.body) + '</p><small>' + esc(new Date(selected.created_at).toLocaleString()) + '</small>' + (selected.entity_type==='issue'?'<button class="primary-button" data-issue-id="' + selected.entity_id + '">Open issue</button>':selected.entity_type==='project'?'<button class="primary-button" data-project="' + selected.entity_id + '">Open project</button>':'') : '<p class="muted">Select a notification to read it.</p>') + '</aside></div>';
}
function renderTriage() {
  const incoming=data.issues.filter(i=>i.team_id===activeTeamId&&!i.assignee_id&&!['Done','Canceled','Duplicate'].includes(i.status));
  content.innerHTML='<div class="content-heading"><div><h2>Triage</h2><p>Incoming unassigned issues for '+esc(team().name)+'. Assign one to yourself to move it into Todo.</p></div><button class="primary-button" data-action="new-issue">＋ New issue</button></div>'+(incoming.length?'<div class="simple-list">'+incoming.map(i=>'<article class="triage-row"><span class="issue-id">'+esc(i.identifier)+'</span><button class="triage-title" data-issue="'+esc(i.identifier)+'">'+esc(i.title)+'</button><span class="status-pill">'+esc(i.status)+'</span><i class="priority-mark p'+(priorityIndex(i.priority)+1)+'">'+priorityMark(i.priority)+'</i><button class="tiny-button" data-action="triage-accept" data-issue-id="'+esc(i.identifier)+'">Assign to me</button></article>').join('')+'</div>':emptyBlock("Triage is clear","No unassigned active issues need review.","new-issue","Create issue"));
}
function renderArchive() {
  const issues=data.archives.issues,projects=data.archives.projects;
  content.innerHTML='<div class="content-heading"><div><h2>Archive</h2><p>Restore issues and projects when you need them again.</p></div></div><section class="detail-section"><h3>Issues</h3>'+(issues.length?issues.map(i=>'<div class="archive-row"><span class="issue-id">'+esc(i.identifier)+'</span><span>'+esc(i.title)+'</span><small>'+esc(i.status)+'</small><button class="tiny-button" data-action="restore-issue" data-identifier="'+esc(i.identifier)+'">Restore</button></div>').join(''):'<small class="muted">No archived issues</small>')+'</section><section class="detail-section"><h3>Projects</h3>'+(projects.length?projects.map(p=>'<div class="archive-row"><span>'+esc(p.name)+'</span><small>'+esc(p.status)+'</small><button class="tiny-button" data-action="restore-project" data-id="'+p.id+'">Restore</button></div>').join(''):'<small class="muted">No archived projects</small>')+'</section>';
}
function renderMembers() {
  const members = team().members;
  content.innerHTML = '<div class="content-heading"><div><h2>' + esc(team().name) + ' members</h2><p>' + members.length + ' people in this team</p></div></div><div class="member-list">' + members.map(m=>'<div class="member-row">'+avatar(m.name,m.avatar_color)+'<span><b>'+esc(m.name)+'</b><small>'+esc(m.email)+'</small></span><span class="row-end">'+esc(m.role)+'</span></div>').join("") + '</div>';
}
function renderCycles() {
  const cycles = data.cycles.filter(c=>c.team_id===activeTeamId);
  content.innerHTML = '<div class="content-heading"><div><h2>Cycles</h2><p>Time-box planning and track the team’s work.</p></div><button class="primary-button" data-action="new-cycle">Create cycle</button></div>' + (cycles.length?'<div class="cycle-list">'+cycles.map(c=>'<article class="cycle-card"><div><span class="status-pill">'+esc(c.status)+'</span><h3>'+esc(c.name)+'</h3><p>'+esc(new Date(c.starts_at).toLocaleDateString())+' – '+esc(new Date(c.ends_at).toLocaleDateString())+'</p></div><div class="cycle-capacity">Capacity <b>'+esc(c.estimate_points)+'</b> / '+esc(c.capacity)+' pts</div><div class="progress-track"><div class="progress-fill" style="width:'+c.progress+'%"></div></div><small class="muted">'+c.completed_count+' of '+c.issue_count+' issues complete · '+c.progress+'%</small></article>').join("")+'</div>':emptyBlock("No cycles","Create cycles to plan work in short, focused periods.","new-cycle","Create cycle"));
}
function renderTeamResources(resources) {
  const links = resources.filter(r => r.url && /^https?:\/\//i.test(r.url));
  const sections = [...new Set(links.map(r => r.section || "Resources"))];
  return sections.map(section => '<div class="resource-section"><h4>' + esc(section) + '</h4>' + links.filter(r => (r.section || "Resources") === section).map(r => '<div class="resource-row"><a class="resource-title" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.title) + '</a><button class="tiny-button" data-action="delete-resource" data-id="' + r.id + '" aria-label="Remove ' + esc(r.title) + '">×</button></div>').join('') + '</div>').join('') || '<small class="muted">No team resources yet</small>';
}
function renderTeamHome() {
  const t = team();
  const active = data.issues.filter(i=>i.team_id===t.id&&!['Done','Canceled','Duplicate'].includes(i.status));
  const projects = data.projects.filter(p=>p.teams.some(x=>x.id===t.id));
  content.innerHTML = '<div class="team-home"><div class="team-hero"><div class="team-hero-icon">'+esc(t.icon)+'</div><div><h2>'+esc(t.name)+'</h2><p>'+esc(t.description)+'</p></div><div class="spacer"></div><button class="tiny-button" data-action="edit-team">Edit team</button><button class="tiny-button" data-action="team-settings">Team settings</button></div><div class="team-shortcuts"><button data-page-go="Issues">Issues <b>'+active.length+'</b></button><button data-page-go="Team projects">Projects <b>'+projects.length+'</b></button><button data-page-go="Members">Members <b>'+t.members.length+'</b></button></div><div class="home-columns"><section class="detail-section"><div class="section-heading"><h3>In progress</h3><button class="tiny-button" data-page-go="Issues">View issues</button></div>'+active.slice(0,5).map(i=>'<button class="link-row" data-issue="'+esc(i.identifier)+'"><span class="issue-id">'+esc(i.identifier)+'</span>'+esc(i.title)+'<span class="row-end">'+esc(i.status)+'</span></button>').join("")+'</section><section class="detail-section"><div class="section-heading"><h3>Projects</h3><button class="tiny-button" data-page-go="Team projects">View all</button></div>'+projects.slice(0,4).map(p=>'<button class="link-row" data-project="'+p.id+'">'+esc(p.name)+'<span class="row-end">'+p.progress+'%</span></button>').join("")+'</section><section class="detail-section"><div class="section-heading"><h3>Resources</h3><button class="tiny-button" data-action="new-resource">＋ Add</button></div>'+renderTeamResources(t.resources)+'</section></div></div>';
}
function renderSettings() {
  const prefs = data.settings.preferences || {}, ws = data.settings.workspace || {};
  const rules = data.recurring, automations = data.automations;
  content.innerHTML = '<div class="settings-layout"><aside class="settings-nav"><b>Settings</b><button class="selected">Preferences</button><button data-action="settings-workspace">Workspace</button><button data-action="settings-issues">Issues & workflow</button><button data-action="settings-integrations">Integrations</button><button data-action="settings-data">Import & export</button></aside><div class="settings-content"><h2>Preferences</h2><p>Personal defaults for this local workspace.</p><form id="preferences-form" class="settings-form">'+field("Default home view",select("defaultHome",["Issues","Projects","My issues","Inbox","Home"],prefs.defaultHome))+field("Display names",select("displayNames",["Full name","First name","Username"],prefs.displayNames))+field("First day of week",select("firstDayOfWeek",["Monday","Sunday","Saturday"],prefs.firstDayOfWeek))+field("Comment submit",select("commentSubmit",["Enter","⌘ Enter"],prefs.commentSubmit))+field("Theme",select("theme",["Light","Dark","System"],prefs.theme))+field("Font size",select("fontSize",["Small","Default","Large"],prefs.fontSize))+field("Automatically assign new issues to me",'<input type="checkbox" name="autoAssignToSelf" '+(prefs.autoAssignToSelf?'checked':'')+'>')+field("Spelling suggestions",'<input type="checkbox" name="spelling" '+(prefs.spelling?'checked':'')+'>')+field("Show Inbox",'<input type="checkbox" name="showInbox" '+(prefs.sidebar?.Inbox?'checked':'')+'>')+field("Show My issues",'<input type="checkbox" name="showMyIssues" '+(prefs.sidebar?.["My issues"]?'checked':'')+'>')+field("Show Projects",'<input type="checkbox" name="showProjects" '+(prefs.sidebar?.Projects?'checked':'')+'>')+field("Show Views",'<input type="checkbox" name="showViews" '+(prefs.sidebar?.Views?'checked':'')+'>')+'<button class="primary-button">Save preferences</button></form><section class="detail-section"><h3>Team workflow</h3><p class="muted">'+esc(team().name)+' statuses</p><div class="chips">'+statuses().map(s=>'<span class="label-chip">'+esc(s.name)+' · '+esc(s.category)+'</span>').join("")+'<button class="tiny-button" data-action="new-status">＋ Add status</button></div><button class="tiny-button" data-action="new-label">＋ Add label</button></section><section class="detail-section"><div class="section-heading"><h3>Recurring issues</h3><button class="tiny-button" data-action="new-recurring">＋ Add</button></div>'+rules.map(r=>'<div class="simple-row"><div><b>'+esc(r.title)+'</b><small>'+esc(r.cadence)+' · next '+esc(r.next_run)+'</small></div><span class="row-end">'+(r.enabled?'On':'Off')+'</span></div>').join("")+'</section><section class="detail-section"><div class="section-heading"><h3>Automations</h3><button class="tiny-button" data-action="new-automation">＋ Add</button></div>'+automations.map(a=>'<div class="simple-row"><div><b>'+esc(a.name)+'</b><small>Team '+esc(team(a.team_id).name)+'</small></div><span class="row-end">'+(a.enabled?'On':'Off')+'</span></div>').join("")+'</section><section class="detail-section"><h3>Integrations</h3>'+data.settings.integrations.map(i=>'<div class="simple-row"><div><b>'+esc(i.name)+'</b><small>'+ (i.connected?'Connected':'Not connected')+'</small></div><button class="tiny-button" data-action="integrations">Configure</button></div>').join("")+'</section><section class="detail-section"><h3>Workspace settings</h3><form id="workspace-form" class="settings-form">'+field("Workspace name",input("name",ws.name||data.workspace.name))+field("Timezone",input("timezone",ws.timezone||"America/Argentina/Buenos_Aires"))+field("Issue identifier",input("issueIdentifier",ws.issueIdentifier||"PRO"))+ '<button class="primary-button">Save workspace settings</button></form></section><section class="detail-section"><h3>Data</h3><button class="secondary-button" data-action="export">Export workspace JSON</button><button class="secondary-button" data-action="import">Import issues from JSON</button><input id="import-file" class="hidden" type="file" accept="application/json,.json"></section></div></div>';
}
function openModal(title, formId, body, submitLabel = "Save") {
  closePopover();
  modalLayer.classList.remove("hidden");
  modalLayer.innerHTML='<section class="issue-modal wide-modal" role="dialog" aria-modal="true"><div class="modal-top"><strong>'+esc(title)+'</strong><span class="spacer"></span><button class="modal-close" aria-label="Close">×</button></div><form id="'+esc(formId)+'" class="issue-form"><div class="modal-fields">'+body+'</div><div class="modal-bottom"><span class="spacer"></span><button type="button" class="secondary-button modal-cancel">Cancel</button><button class="primary-button" type="submit">'+esc(submitLabel)+'</button></div></form></section>';
  $(".modal-close",modalLayer).onclick=closeModal; $(".modal-cancel",modalLayer).onclick=closeModal;
  $("input:not([type=hidden]),textarea,select",modalLayer)?.focus();
}
function closeModal() { modalLayer.classList.add("hidden"); modalLayer.innerHTML=""; }
function formObject(form) {
  const fd=new FormData(form), out={};
  for(const [key,value] of fd.entries()) { if(key.endsWith("[]")){const name=key.slice(0,-2);out[name]??=[];out[name].push(value);} else out[key]=value; }
  $$('input[type="checkbox"]',form).forEach(box=>out[box.name]=box.checked);
  return out;
}
function openIssueModal(extra = {}) {
  issueParentId=extra.parentId||null;
  const project=extra.projectId?data.projects.find(p=>p.id===Number(extra.projectId)):null;
  const projectTeamIds=project?.teams.map(t=>t.id)||[];
  const availableTeams=projectTeamIds.length?data.teams.filter(t=>projectTeamIds.includes(t.id)):data.teams;
  const requestedTeam=Number(extra.teamId||activeTeamId);
  const teamId=availableTeams.some(t=>t.id===requestedTeam)?requestedTeam:(availableTeams[0]?.id||activeTeamId);
  const projectId=projectTeamIds.includes(teamId)?project.id:"";
  const defaultStatus=statuses(teamId).find(s=>s.is_default)?.name||"Backlog";
  const body=field("Title",input("title","","Issue title","text","required maxlength="+"160"),true)+field("Description",'<textarea name="description" placeholder="Add a description…"></textarea>',true)+field("Attachments",'<input type="file" multiple data-issue-attachments><small class="muted">Up to 3 MB total</small>',true)+field("Team",select("teamId",availableTeams.map(t=>({value:t.id,label:t.name})),teamId))+field("Status",select("status",statuses(teamId).map(s=>s.name),defaultStatus))+field("Priority",select("priority",PRIORITIES,"No priority"))+field("Assignee",select("assigneeId",[{value:"",label:"Unassigned"},...data.members.map(m=>({value:m.id,label:m.name}))],(data.settings.preferences||{}).autoAssignToSelf?data.currentMemberId:""))+field("Project",select("projectId",[{value:"",label:"No project"},...projectOptionsForTeam(teamId)],projectId))+field("Labels",select("labelIds[]",data.labels.filter(l=>!l.team_id||l.team_id===teamId).map(l=>({value:l.id,label:l.name})),"","Choose labels","multiple"))+field("Cycle",select("cycleId",[{value:"",label:"No cycle"},...data.cycles.filter(c=>c.team_id===teamId).map(c=>({value:c.id,label:c.name}))],""))+field("Estimate",select("estimate",["","1","2","3","5","8","13"],""))+field("Due date",input("dueDate","","","date"))+field("External link",input("externalUrl","","https://…"),true);
  openModal(issueParentId?"New sub-issue":"New issue","issue-form",body,"Create issue");
}
function openProjectModal(project = null) {
  const body=field("Name",input("name",project?.name||"","Project name","text","required"),true)+field("Summary",input("summary",project?.summary||"","One sentence about the project"),true)+field("Icon",select("icon",["◈","◎","✳","⬡","◇","▤"],project?.icon||"◈"))+field("Status",select("status",["Backlog","Planned","In Progress","Completed","Canceled"],project?.status||"Backlog"))+field("Priority",select("priority",PRIORITIES,project?.priority_name||"No priority"))+field("Lead",select("leadId",data.members.map(m=>({value:m.id,label:m.name})),project?.lead_id||data.currentMemberId))+field("Teams",select("teamIds[]",data.teams.map(t=>({value:t.id,label:t.name})),project?.teams.map(t=>t.id)||[activeTeamId],"","multiple"))+field("Members",select("memberIds[]",data.members.map(m=>({value:m.id,label:m.name})),project?.members.map(m=>m.id)||[data.currentMemberId],"","multiple"))+field("Start date",input("startDate",project?.start_date||"","","date"))+field("Target date",input("targetDate",project?.target_date||"","","date"))+field("Labels",select("labelIds[]",data.labels.map(l=>({value:l.id,label:l.name})),project?.labels.map(l=>l.id)||[],"","multiple"))+field("Description",'<textarea name="description" placeholder="What is this project about?">'+esc(project?.description||"")+'</textarea>',true);
  openModal(project?"Edit project":"New project","project-form",body,project?"Save changes":"Create project");
  $("#project-form").dataset.id=project?.id||"";
}
function openViewModal(existing = null) {
  const entity = existing?.entity || (["Projects","Team projects"].includes(currentPage) || currentView==="Projects" ? "projects" : "issues");
  const body=field("Name",input("name",existing?.name||"","View name","text","required"),true)+field("Description",input("description",existing?.description||"","Optional description"),true)+field("Icon",select("icon",["◈","◎","✳","⬡","◇","▤"],existing?.icon||"◈"))+field("Scope",select("scope",["Personal","Workspace","Team"],existing?.scope||"Personal"))+field("Favorite",'<input type="checkbox" name="isFavorite" '+(existing?.is_favorite?'checked':'')+'>')+field("Entity",select("entity",[{value:"issues",label:"Issues"},{value:"projects",label:"Projects"}],entity))+field("Team",select("teamId",data.teams.map(t=>({value:t.id,label:t.name})),existing?.team_id||activeTeamId));
  openModal(existing?"Edit saved view":"Create saved view","view-form",body,existing?"Save changes":"Save view");
  if(existing){const form=$("#view-form");form.dataset.id=existing.id;form.dataset.filters=JSON.stringify(existing.filters||{});form.dataset.display=JSON.stringify(existing.display||{});}
}
function openSimpleModal(kind) {
  let title="",id="",body="",submit="Create";
  if(kind==="team"){title="Create team";id="team-form";body=field("Name",input("name","","Team name","text","required"))+field("Key",input("key","","PRO"))+field("Description",input("description","","What does this team work on?"),true);}
  if(kind==="cycle"){title="Create cycle";id="cycle-form";body=field("Name",input("name","","Cycle name","text","required"))+field("Team",select("teamId",data.teams.map(t=>({value:t.id,label:t.name})),activeTeamId))+field("Starts",input("startsAt","","","date","required"))+field("Ends",input("endsAt","","","date","required"))+field("Capacity",input("capacity","20","","number"));}
  if(kind==="milestone"){title="Add milestone";id="milestone-form";body=field("Name",input("name","","Milestone name","text","required"))+field("Due date",input("dueDate","","","date"))+field("Status",select("status",["Todo","In Progress","Done"],"Todo"));}
  if(kind==="project-update"){title="Project update";id="project-update-form";body=field("Health",select("health",["On track","At risk","Off track"],"On track"))+field("Update",'<textarea name="body" placeholder="Share progress, risks, or next steps…" required></textarea>',true);}
  if(kind==="dependency"){title="Add dependency";id="dependency-form";body=field("Project",select("dependsOnId",data.projects.filter(p=>p.id!==Number(selectedProject)).map(p=>({value:p.id,label:p.name})),""),true);}
  if(kind==="relation"){title="Link issue";id="relation-form";body=field("Relation",select("type",["relates to","blocks","blocked by","duplicate of","parent of"],"relates to"))+field("Issue",select("relatedIssueId",data.issues.filter(i=>i.identifier!==selectedIssue).map(i=>({value:i.identifier,label:i.identifier+" · "+i.title})),"","Choose an issue"),true)+field("Or external URL",input("url","","https://…","url"),true);}
  if(kind==="milestone") submit="Add milestone";
  if(kind==="project-update") submit="Post update";
  openModal(title,id,body,submit);
}
function openLabelsModal() {
  const issue=data.issues.find(i=>i.identifier===selectedIssue); if(!issue)return;
  const body=field("Labels",select("labelIds[]",data.labels.map(l=>({value:l.id,label:l.name})),issue.labels.map(l=>l.id),"","multiple"),true);
  openModal("Edit labels","labels-form",body,"Save labels");
}
function openCreateView() { openViewModal(); }
function popover(anchor, items, onPick, current) {
  closePopover(); const rect=anchor.getBoundingClientRect(), node=document.createElement("div"); node.className="popover"; node.style.top=Math.min(innerHeight-250,rect.bottom+5)+"px"; node.style.left=Math.max(8,Math.min(rect.left,innerWidth-225))+"px";
  node.innerHTML=items.map(item=>'<button class="popover-item" data-value="'+esc(item)+'">'+esc(item)+(item===current?'<span class="check">✓</span>':'')+'</button>').join(""); document.body.appendChild(node);popoverNode=node;
  $$(".popover-item",node).forEach(b=>b.onclick=()=>{onPick(b.dataset.value);closePopover();});
}
function closePopover(){if(popoverNode)popoverNode.remove();popoverNode=null;}
function openSearch() {
  closePopover();commandLayer.classList.remove("hidden");commandLayer.innerHTML='<section class="search-modal" role="dialog" aria-label="Search workspace"><div class="search-field"><span>⌕</span><input placeholder="Search issues and projects…" autocomplete="off"><kbd class="shortcut">ESC</kbd></div><div class="search-scopes">'+["All","Issues","Projects"].map(s=>'<button class="scope-chip '+(s===searchScope?'selected':'')+'" data-scope="'+s+'">'+s+'</button>').join("")+'</div><div class="search-results" id="search-results-list"><div class="search-hint">Type to search this workspace</div></div></section>';
  const field=$("input",commandLayer);field.focus();let timer;
  field.oninput=()=>{clearTimeout(timer);timer=setTimeout(async()=>{try{const res=await api("/api/search?q="+encodeURIComponent(field.value)+"&scope="+searchScope);const box=$("#search-results-list",commandLayer);box.innerHTML=res.results.length?res.results.map(r=>'<button class="search-result" data-result-type="'+esc(r.type)+'" data-result-id="'+esc(r.key)+'"><span class="issue-id">'+esc(r.type)+'</span><span>'+esc(r.title)+'</span><small>'+esc(r.status||"")+'</small></button>').join(""):'<div class="search-hint">No matching results</div>';}catch(e){report(e);}},120);};
}
function closeSearch(){commandLayer.classList.add("hidden");commandLayer.innerHTML="";}
function getIssueForm(form) {
  const obj=formObject(form);obj.teamId=Number(obj.teamId||activeTeamId);obj.priority=obj.priority||"No priority";obj.assigneeId=obj.assigneeId?Number(obj.assigneeId):null;obj.projectId=obj.projectId?Number(obj.projectId):null;obj.cycleId=obj.cycleId?Number(obj.cycleId):null;obj.estimate=obj.estimate?Number(obj.estimate):null;obj.labelIds=(obj.labelIds||[]).map(Number);if(issueParentId)obj.parentId=Number(issueParentId);return obj;
}
async function attachmentPayload(fileList) {
  const files=[...fileList];if(files.reduce((sum,file)=>sum+file.size,0)>3_000_000)throw new Error("Attachments must total 3 MB or less");
  return Promise.all(files.map(async file=>{const bytes=new Uint8Array(await file.arrayBuffer());let binary="";for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return{name:file.name,type:file.type,data:btoa(binary)};}));
}
async function attachFiles(identifier,fileList) { if(!fileList?.length)return;const files=await attachmentPayload(fileList);await api("/api/issues/"+identifier+"/attachments",{method:"POST",body:{files}});await refresh();toast("Attachments added"); }
async function action(action, node) {
  const id=Number(node?.dataset.id||0);
  if(action==="new-issue") return openIssueModal({teamId:activeTeamId,projectId:selectedProject});
  if(action==="new-project") return openProjectModal();
  if(action==="create-view") return openCreateView();
  if(action==="update-view") { if(!viewId)return;await api("/api/views/"+viewId,{method:"PATCH",body:{filters,display}});await refresh();toast("Saved view updated");return; }
  if(action==="edit-view") { const view=data.views.find(v=>v.id===id);if(view)openViewModal(view);return; }
  if(action==="new-resource") { const body=field("Title",input("title","","Resource name","text","required"),true)+field("Section",input("section","Resources","Section name"))+field("Link",input("url","","https://…","url","required"),true);openModal("Add team resource","team-resource-form",body,"Add resource");return; }
  if(action==="delete-resource") { if(!confirm("Remove this team resource?"))return;await api("/api/teams/"+activeTeamId+"/resources/"+id,{method:"DELETE",body:{}});return refresh(); }
  if(action==="new-team") return openSimpleModal("team");
  if(action==="new-cycle") return openSimpleModal("cycle");
  if(action==="add-milestone") return openSimpleModal("milestone");
  if(action==="add-project-update") return openSimpleModal("project-update");
  if(action==="add-dependency") return openSimpleModal("dependency");
  if(action==="add-relation") return openSimpleModal("relation");
  if(action==="issue-labels") return openLabelsModal();
  if(action==="add-subissue") return openIssueModal({parentId:data.issues.find(i=>i.identifier===selectedIssue)?.id,teamId:data.issues.find(i=>i.identifier===selectedIssue)?.team_id});
  if(action==="add-project-issue") return openIssueModal({projectId:Number(selectedProject),teamId:data.projects.find(p=>p.id===Number(selectedProject))?.teams[0]?.id||activeTeamId});
  if(action==="back") { selectedIssue=null; renderPage(); return; }
  if(action==="triage-accept") { const issue=data.issues.find(i=>i.identifier===node.dataset.issueId);if(!issue)return;const next=statuses(issue.team_id).some(s=>s.name==="Todo")?"Todo":issue.status;await api("/api/issues/"+issue.identifier,{method:"PATCH",body:{assigneeId:data.currentMemberId,status:next}});await refresh();toast(issue.identifier+" assigned to you");return; }
  if(action==="restore-issue") { await api("/api/issues/"+encodeURIComponent(node.dataset.identifier)+"/restore",{method:"POST",body:{}});await refresh();toast("Issue restored");return; }
  if(action==="restore-project") { await api("/api/projects/"+id+"/restore",{method:"POST",body:{}});await refresh();toast("Project restored");return; }
  if(action==="add-attachments") { $("#issue-file-picker")?.click();return; }
  if(action==="back-projects") { selectedProject=null; renderPage(); return; }
  if(action==="archive-issue") { if(!confirm("Archive this issue? You can recover it from the archive later."))return;await api("/api/issues/"+selectedIssue,{method:"DELETE",body:{}});selectedIssue=null;await refresh();toast("Issue archived");return; }
  if(action==="archive-project") { if(!confirm("Archive this project?"))return;await api("/api/projects/"+selectedProject,{method:"DELETE",body:{}});selectedProject=null;await refresh();toast("Project archived");return; }
  if(action==="edit-project") return openProjectModal(data.projects.find(p=>p.id===Number(selectedProject)));
  if(action==="subscribe") { const i=data.issues.find(x=>x.identifier===selectedIssue),ids=i.subscribers.map(m=>m.id);const next=ids.includes(data.currentMemberId)?ids.filter(x=>x!==data.currentMemberId):ids.concat(data.currentMemberId);await api("/api/issues/"+selectedIssue,{method:"PATCH",body:{subscriberIds:next}});return refresh(); }
  if(action==="notification-read"||action==="notification-archive") { const verb=action==="notification-archive"?"archive":(data.notifications.find(n=>n.id===id)?.is_read?"unread":"read");await api("/api/notifications/"+id+"/"+verb,{method:"POST",body:{}});await refresh();selectedNotification=id;return renderInbox(); }
  if(action==="read-selected"||action==="archive-selected") { const ids=[...selectedNotifications];if(!ids.length)return;if(action==="archive-selected"&&!confirm("Archive "+ids.length+" selected notifications?"))return;await api("/api/notifications/"+(action==="archive-selected"?"archive-selected":"read-selected"),{method:"POST",body:{ids}});selectedNotifications.clear();if(action==="archive-selected"&&ids.includes(Number(selectedNotification)))selectedNotification=null;await refresh();toast(action==="archive-selected"?ids.length+" notifications archived":ids.length+" notifications marked read");return; }
  if(action==="read-all") { await api("/api/notifications/read-all",{method:"POST",body:{}});return refresh(); }
  if(action==="favorite-view") { const v=data.views.find(x=>x.id===id);await api("/api/views/"+id,{method:"PATCH",body:{isFavorite:!v.is_favorite}});return refresh(); }
  if(action==="delete-view") { if(!confirm("Delete this saved view?"))return;await api("/api/views/"+id,{method:"DELETE",body:{}});return refresh(); }
  if(action==="export") { const out=await api("/api/export");const blob=new Blob([JSON.stringify(out,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="workspace-export.json";a.click();URL.revokeObjectURL(url);toast("Workspace export downloaded");return; }
  if(action==="import") { $("#import-file").click();return; }
  if(action==="integrations"||action==="settings-integrations") { toast("Connectors need their service credentials and are not connected in local mode.");return; }
  if(action==="settings-data") { $("#import-file")?.scrollIntoView({behavior:"smooth"});return; }
  if(action==="settings-workspace") { $("#workspace-form")?.scrollIntoView({behavior:"smooth"});return; }
  if(action==="settings-issues") { $(".settings-content .detail-section")?.scrollIntoView({behavior:"smooth"});return; }
  if(action==="new-status") { const body=field("Name",input("name","","Status name","text","required"))+field("Category",select("category",["Backlog","Unstarted","Started","Completed","Canceled","Duplicate"],"Unstarted"));openModal("Add workflow status","status-form",body,"Add status");return; }
  if(action==="new-label") { const body=field("Name",input("name","","Label name","text","required"))+field("Color",input("color","#8585cc","","color"));openModal("Add label","label-form",body,"Create label");return; }
  if(action==="new-recurring") { const body=field("Issue title",input("title","","Recurring issue title","text","required"),true)+field("Description",'<textarea name="description"></textarea>',true)+field("Cadence",select("cadence",["Daily","Weekly","Every 2 weeks","Monthly"],"Weekly"))+field("Next run",input("nextRun","","","date","required"));openModal("Recurring issue","recurring-form",body,"Save recurring issue");return; }
  if(action==="new-automation") { const body=field("Name",input("name","","Automation name","text","required"),true)+field("When",select("event",["issue.created","issue.updated","issue.completed"],"issue.created"))+field("Priority condition",select("priority",["Any","Urgent","High","Medium","Low"],"Any"))+field("Label condition",select("label",["Any",...data.labels.map(l=>l.name)],"Any"))+field("Action",select("action",["Assign to me","Add Bug label","Add Feature label","Set status: Todo","Set status: In Progress"],"Assign to me"));openModal("Create automation","automation-form",body,"Create automation");return; }
  if(action==="edit-team") { const t=team();const body=field("Name",input("name",t.name,"Team name","text","required"))+field("Description",input("description",t.description,"","text"),true)+field("Timezone",input("timezone",t.timezone||"America/Argentina/Buenos_Aires"));openModal("Edit team","team-edit-form",body,"Save changes");return; }
  if(action==="team-settings") { setPage("Settings");return; }
  if(action==="toggle-group") { node.nextElementSibling?.classList.toggle("hidden");return; }
  if(action==="issue-menu") { popover(node,["Set due date","Make recurring","Add link","Add sub-issue","Archive issue"],async pick=>{if(pick==="Add sub-issue")openIssueModal({parentId:data.issues.find(i=>i.identifier===selectedIssue)?.id,teamId:data.issues.find(i=>i.identifier===selectedIssue)?.team_id});else if(pick==="Add link")openSimpleModal("relation");else if(pick==="Make recurring"){const body=field("Issue title",input("title","","Recurring issue title","text","required"),true)+field("Description",'<textarea name="description"></textarea>',true)+field("Cadence",select("cadence",["Daily","Weekly","Every 2 weeks","Monthly"],"Weekly"))+field("Next run",input("nextRun","","","date","required"));openModal("Recurring issue","recurring-form",body,"Save recurring issue");}else if(pick==="Archive issue"){if(confirm("Archive this issue?")){await api("/api/issues/"+selectedIssue,{method:"DELETE",body:{}});selectedIssue=null;await refresh();}}else toast("Set the due date from the issue properties.");});return; }
}
async function submitForm(form) {
  const f=formObject(form), id=form.dataset.id;
  if(form.id==="issue-form") {
    const body=getIssueForm(form),files=form.querySelector("[data-issue-attachments]")?.files;const uploads=files?.length?await attachmentPayload(files):[];const result=await api("/api/issues",{method:"POST",body});closeModal();issueParentId=null;let attachmentError=null;if(uploads.length){try{await api("/api/issues/"+result.issue.identifier+"/attachments",{method:"POST",body:{files:uploads}});}catch(error){attachmentError=error;}}await refresh();selectedIssue=result.issue.identifier;renderPage();toast(attachmentError?"Issue created, but attachments could not be added":result.issue.identifier+" created");return;
  }
  if(form.id==="project-form") {
    f.priority=f.priority||"No priority";f.leadId=Number(f.leadId);f.teamIds=(f.teamIds||[]).map(Number);f.memberIds=(f.memberIds||[]).map(Number);f.labelIds=(f.labelIds||[]).map(Number);f.startDate=f.startDate||null;f.targetDate=f.targetDate||null;
    const result=await api(id?"/api/projects/"+id:"/api/projects",{method:id?"PATCH":"POST",body:f});closeModal();await refresh();selectedProject=Number(id||result.projectId);renderPage();toast(id?"Project updated":"Project created");return;
  }
  if(form.id==="view-form") { f.isFavorite=!!f.isFavorite;f.teamId=Number(f.teamId);if(id){f.filters=JSON.parse(form.dataset.filters||"{}");f.display=JSON.parse(form.dataset.display||"{}");await api("/api/views/"+id,{method:"PATCH",body:f});closeModal();await refresh();if(viewId===Number(id)){const updated=data.views.find(v=>v.id===Number(id));if(updated)applyView(updated);}toast("View updated");return;}f.filters=filters;f.display=display;const result=await api("/api/views",{method:"POST",body:f});closeModal();await refresh();const v=data.views.find(x=>x.id===result.viewId);if(v)applyView(v);toast("View saved");return; }
  if(form.id==="team-form") { const res=await api("/api/teams",{method:"POST",body:f});closeModal();await refresh();activeTeamId=res.teamId;setPage("Home");toast("Team created");return; }
  if(form.id==="team-edit-form") { await api("/api/teams/"+activeTeamId,{method:"PATCH",body:f});closeModal();await refresh();return; }
  if(form.id==="team-resource-form") { await api("/api/teams/"+activeTeamId+"/resources",{method:"POST",body:f});closeModal();await refresh();toast("Team resource added");return; }
  if(form.id==="cycle-form") { f.teamId=Number(f.teamId);f.capacity=Number(f.capacity);f.startsAt=new Date(f.startsAt+"T00:00:00Z").toISOString();f.endsAt=new Date(f.endsAt+"T23:59:00Z").toISOString();await api("/api/cycles",{method:"POST",body:f});closeModal();await refresh();toast("Cycle created");return; }
  if(form.id==="milestone-form") { await api("/api/projects/"+selectedProject+"/milestones",{method:"POST",body:f});closeModal();await refresh();return; }
  if(form.id==="project-update-form") { await api("/api/projects/"+selectedProject+"/updates",{method:"POST",body:f});closeModal();await refresh();toast("Project update posted");return; }
  if(form.id==="dependency-form") { f.dependsOnId=Number(f.dependsOnId);await api("/api/projects/"+selectedProject+"/dependencies",{method:"POST",body:f});closeModal();await refresh();return; }
  if(form.id==="relation-form") { if(!f.relatedIssueId)delete f.relatedIssueId;await api("/api/issues/"+selectedIssue+"/relations",{method:"POST",body:f});closeModal();await refresh();return; }
  if(form.id==="labels-form") { f.labelIds=(f.labelIds||[]).map(Number);await api("/api/issues/"+selectedIssue,{method:"PATCH",body:{labelIds:f.labelIds}});closeModal();return refresh(); }
  if(form.id==="status-form") { f.teamId=activeTeamId;await api("/api/statuses",{method:"POST",body:f});closeModal();return refresh(); }
  if(form.id==="label-form") { f.teamId=activeTeamId;await api("/api/labels",{method:"POST",body:f});closeModal();return refresh(); }
  if(form.id==="recurring-form") { f.teamId=activeTeamId;await api("/api/recurring",{method:"POST",body:f});closeModal();return refresh(); }
  if(form.id==="automation-form") { f.teamId=activeTeamId;f.trigger={event:f.event};f.condition={priority:f.priority,label:f.label};f.action={name:f.action};delete f.event;delete f.priority;delete f.label;await api("/api/automations",{method:"POST",body:f});closeModal();return refresh(); }
  if(form.id==="comment-form") { await api("/api/issues/"+selectedIssue+"/comments",{method:"POST",body:{body:f.body}});return refresh(); }
  if(form.id==="preferences-form") { f.sidebar={Inbox:f.showInbox,"My issues":f.showMyIssues,Projects:f.showProjects,Views:f.showViews};for(const key of ["showInbox","showMyIssues","showProjects","showViews"])delete f[key];await api("/api/preferences",{method:"PATCH",body:f});await refresh();if(f.defaultHome&&currentPage!==f.defaultHome){currentPage=f.defaultHome;localStorage.setItem("clone-page",currentPage);updateShell();renderPage();}toast("Preferences saved");return; }
  if(form.id==="workspace-form") { await api("/api/settings",{method:"PATCH",body:{key:"workspace",value:f}});closeModal();await refresh();toast("Workspace settings saved");return; }
  if(form.id==="import-form") { if(!importPreview)return;const rows=importPreview.issues||importPreview;const created=await api("/api/import",{method:"POST",body:{issues:rows}});closeModal();importPreview=null;await refresh();toast(created.count+" issues imported");return; }
}
function applyView(v) { const savedFilters=Object.assign({status:"All",priority:"All",assignee:"All",project:"All",label:"All",creator:"All",relations:"All",dueDate:"All",projectStatus:"All",subscribers:"All",externalLink:"All"},v.filters||{});if(String(savedFilters.status||"").toLowerCase()==="all")savedFilters.status="All";if(String(savedFilters.priority||"").toLowerCase()==="all")savedFilters.priority="All";if(savedFilters.assignee==="Anyone")savedFilters.assignee="All";const savedDisplay=Object.assign({},display,v.display||{});if(savedDisplay.groupBy==="Agent")savedDisplay.groupBy="Status";if(savedDisplay.orderBy==="Agent")savedDisplay.orderBy="Updated";if(savedDisplay.orderBy)savedDisplay.orderBy=savedDisplay.orderBy==="Last updated"?"Updated":savedDisplay.orderBy;filters=savedFilters;display=savedDisplay;if(v.entity==="projects")setPage("Projects");else setPage("Issues");viewId=v.id;currentView=v.name;history.replaceState(null,"","#view-"+v.id);renderPage(); }
function selectIssue(identifier) { const issue=data.issues.find(i=>i.identifier===identifier)||data.issues.find(i=>i.id===Number(identifier));if(!issue)return;selectedIssue=issue.identifier;renderPage(); }
function selectProject(id) { if(!data.projects.some(p=>p.id===Number(id)))return;selectedProject=Number(id);selectedIssue=null;renderPage(); }
function openSavedView(id) { const v=data.views.find(x=>x.id===Number(id));if(v)applyView(v); }
function openPopoverForFilters(button) {
  const projectPage=["Projects","Team projects"].includes(currentPage),statusOptions=projectPage?["Backlog","Planned","In Progress","Completed","Canceled"]:statuses().map(s=>s.name);
  const issueOnlyValues=projectPage?[]:[...(["All",...new Set(data.projects.map(p=>p.status))].map(s=>"Project status · "+s)),"Relations · All","Relations · Linked","Relations · No links","External link · All","External link · Has link","External link · No link","Subscribers · All","Subscribers · Has subscribers","Subscribers · Me","Subscribers · Others","Subscribers · No subscribers","Due date · All","Due date · Overdue","Due date · Next 7 days","Due date · No date"];
  const values=["Status · All",...statusOptions.map(s=>"Status · "+s),"Priority · All",...PRIORITIES.map(p=>"Priority · "+p),"Assignee · All",...data.members.map(m=>"Assignee · "+m.name),"Assignee · Unassigned","Creator · All","Creator · Me",...data.members.map(m=>"Creator · "+m.name),"Project · All",...data.projects.map(p=>"Project · "+p.name),"Project · No project","Label · All",...data.labels.map(l=>"Label · "+l.name),"Label · No label",...issueOnlyValues];
  popover(button,values,value=>{const parts=value.split(" · "),key=parts[0].toLowerCase(),chosen=parts.slice(1).join(" · ");if(key==="project"){const p=data.projects.find(x=>x.name===chosen);filters.project=chosen==="All"?"All":chosen==="No project"?"No project":String(p?.id||"");}else if(key==="creator"){const m=data.members.find(x=>x.name===chosen);filters.creator=chosen==="All"?"All":chosen==="Me"?"Me":String(m?.id||"");}else if(key==="project status")filters.projectStatus=chosen;else if(key==="subscribers")filters.subscribers=chosen;else if(key==="external link")filters.externalLink=chosen;else if(key==="relations")filters.relations=chosen;else if(key==="due date")filters.dueDate=chosen==="Next 7 days"?"Next 7 days":chosen;else filters[key]=chosen;renderPage();});
}
function openPopoverForDisplay(button) {
  const properties=Object.assign({Status:true,Priority:true,Assignee:true,Project:false,Label:false,"Due date":false,Updated:true},display.properties||{});
  const values=["Layout · List","Layout · Board",...GROUPS.map(x=>"Group by · "+x),"Secondary group · None",...GROUPS.map(x=>"Secondary group · "+x),...SORTS.map(x=>"Sort by · "+x),"Direction · Ascending","Direction · Descending",...Object.keys(properties).map(x=>"Property · "+x+" · "+(properties[x]?"On":"Off")),"Show completed · "+(display.showCompleted?"On":"Off"),"Completed at bottom · "+(display.completedAtBottom?"On":"Off"),"Show sub-issues · "+(display.showSubissues?"On":"Off"),"Show empty groups · "+(display.showEmptyGroups?"On":"Off")];
  popover(button,values,value=>{const [kind,...rest]=value.split(" · "),picked=rest.join(" · ");if(kind==="Layout")display.layout=picked;else if(kind==="Group by")display.groupBy=picked;else if(kind==="Secondary group")display.groupBy2=picked;else if(kind==="Sort by")display.orderBy=picked;else if(kind==="Direction")display.direction=picked;else if(kind==="Property"){const state=rest.pop(),name=rest.join(" · ");display.properties=Object.assign({},properties,{[name]:state!=="On"});}else if(kind==="Show completed")display.showCompleted=picked==="On";else if(kind==="Completed at bottom")display.completedAtBottom=picked==="On";else if(kind==="Show sub-issues")display.showSubissues=picked==="On";else if(kind==="Show empty groups")display.showEmptyGroups=picked==="On";renderPage();});
}
document.addEventListener("click", async event=>{
  const actionNode=event.target.closest("[data-action]");
  if(actionNode){event.preventDefault();try{await action(actionNode.dataset.action,actionNode);}catch(error){report(error);}return;}
  const workspacePicker=event.target.closest("#workspace-open");
  if(workspacePicker){const workspaceName=data.workspace.name||"Workspace";popover(workspacePicker,[workspaceName+" · Current","Workspace settings"],value=>{if(value==="Workspace settings"){setPage("Settings");requestAnimationFrame(()=>$("#workspace-form")?.scrollIntoView({behavior:"smooth",block:"center"}));}else setPage("Home");});return;}
  if(event.target.closest(".add-team")){openSimpleModal("team");return;}
  const pageNode=event.target.closest("[data-page-go]");if(pageNode){setPage(pageNode.dataset.pageGo);return;}
  const pageItem=event.target.closest(".nav-item[data-page]");if(pageItem){if(pageItem.dataset.page==="More"){popover(pageItem,["Triage","Archive","Members","Cycles","Settings","Create team"],value=>value==="Create team"?openSimpleModal("team"):setPage(value==="Create team"?"Home":value));return;}setPage(pageItem.dataset.page);return;}
  const teamPicker=event.target.closest(".team-name");if(teamPicker){popover(teamPicker,data.teams.map(t=>t.name).concat("Create team"),value=>{if(value==="Create team")openSimpleModal("team");else{activeTeamId=data.teams.find(t=>t.name===value).id;localStorage.setItem("clone-team",String(activeTeamId));setPage("Home");}});return;}
  const saved=event.target.closest("[data-saved-view]");if(saved){openSavedView(saved.dataset.savedView);return;}
  const issueLink=event.target.closest("[data-issue]");if(issueLink){selectIssue(issueLink.dataset.issue);return;}
  const issueIdLink=event.target.closest("[data-issue-id]");if(issueIdLink){selectIssue(issueIdLink.dataset.issueId);return;}
  const projectLink=event.target.closest("[data-project]");if(projectLink){selectProject(projectLink.dataset.project);return;}
  if(event.target.closest("[data-notification-select],#select-all-notifications"))return;
  const notification=event.target.closest("[data-notification]");if(notification){selectedNotification=Number(notification.dataset.notification);const n=data.notifications.find(x=>x.id===selectedNotification);if(n&&!n.is_read)await api("/api/notifications/"+n.id+"/read",{method:"POST",body:{}}).then(refresh).catch(report);else renderInbox();return;}
  const result=event.target.closest("[data-result-type]");if(result){closeSearch();if(result.dataset.resultType==="Issue")selectIssue(result.dataset.resultId);else if(result.dataset.resultType==="Project")selectProject(result.dataset.resultId);return;}
  const scope=event.target.closest("[data-scope]");if(scope){searchScope=scope.dataset.scope;$$(".scope-chip",commandLayer).forEach(x=>x.classList.toggle("selected",x===scope));$(".search-field input",commandLayer).dispatchEvent(new Event("input"));return;}
  const tab=event.target.closest(".view-pill");if(tab){if(["Views","Team views"].includes(currentPage))currentView=tab.dataset.view;else currentView=tab.dataset.view;$$(".view-pill",$("#view-tabs")).forEach(x=>x.classList.toggle("selected",x===tab));renderPage();return;}
  const collapsed=event.target.closest(".window-sidebar");if(collapsed){const sidebar=$("#sidebar");sidebar.classList.toggle("collapsed");localStorage.setItem("clone-sidebar-collapsed",String(sidebar.classList.contains("collapsed")));return;}
});
$("#search-open").onclick=openSearch;
$("#create-open").onclick=()=>openIssueModal({teamId:activeTeamId});
$("#new-project").onclick=()=>openProjectModal();
$("#new-issue-header").onclick=()=>openIssueModal({teamId:activeTeamId});
$("#filter-button").onclick=event=>openPopoverForFilters(event.currentTarget);
$("#display-button").onclick=event=>openPopoverForDisplay(event.currentTarget);
$("#details-toggle").onclick=()=>{if(selectedIssue)renderPage();else toast("Open an issue to see its details");};
$("#share-view").onclick=async()=>{try{await navigator.clipboard.writeText(location.href);toast("Link copied");}catch{toast("Copy this page URL to share it");}};
$("#view-tabs").addEventListener("click",event=>{if(event.target.closest(".view-pill")&&viewId){const v=data.views.find(x=>x.id===viewId);if(v)api("/api/views/"+v.id,{method:"PATCH",body:{filters,display}}).catch(report);}});
content.addEventListener("submit",async event=>{const form=event.target.closest("form");if(!form)return;event.preventDefault();try{await submitForm(form);}catch(error){report(error);}});
modalLayer.addEventListener("submit",async event=>{const form=event.target.closest("form");if(!form)return;event.preventDefault();try{await submitForm(form);}catch(error){report(error);}});
content.addEventListener("change",async event=>{
  const target=event.target;
  if(target.id==="issue-file-picker"){const files=target.files;attachFiles(selectedIssue,files).catch(report).finally(()=>{target.value="";});return;}
  if(target.id==="unread-only"){ inboxUnreadOnly=target.checked; $$(".notification-row").forEach(row=>row.classList.toggle("filtered-out",inboxUnreadOnly&&!row.classList.contains("unread")));return; }
  if(target.id==="select-all-notifications"){
    $$(".notification-row:not(.filtered-out) [data-notification-select]").forEach(box=>{const id=Number(box.dataset.notificationSelect);box.checked=target.checked;if(target.checked)selectedNotifications.add(id);else selectedNotifications.delete(id);});
  }
  if(target.matches("[data-notification-select]")){const id=Number(target.dataset.notificationSelect);if(target.checked)selectedNotifications.add(id);else selectedNotifications.delete(id);}
  if(target.id==="select-all-notifications"||target.matches("[data-notification-select]")){
    const visible=$$(".notification-row:not(.filtered-out) [data-notification-select]"),allChecked=visible.length>0&&visible.every(box=>box.checked),head=$("#select-all-notifications");if(head)head.checked=allChecked;
    const count=selectedNotifications.size,read=$("[data-action=read-selected]"),archive=$("[data-action=archive-selected]");if(read){read.disabled=!count;read.textContent="Mark selected read";}if(archive){archive.disabled=!count;archive.textContent="Archive selected"+(count?" ("+count+")":"");}
  }
  if(target.matches("select[name]")&&selectedIssue){const key=target.name,value=target.value;let body={};if(key==="status"||key==="priority")body[key]=value;else if(key==="assigneeId"||key==="projectId"||key==="cycleId"||key==="estimate")body[key]=value?Number(value):null;else if(key==="teamId")body.teamId=Number(value);if(Object.keys(body).length){try{await api("/api/issues/"+selectedIssue,{method:"PATCH",body});await refresh();}catch(e){report(e);}}}
  if(target.name==="projectStatus"||target.name==="projectPriority"){const body=target.name==="projectStatus"?{status:target.value}:{priority:target.value};try{await api("/api/projects/"+selectedProject,{method:"PATCH",body});await refresh();}catch(e){report(e);}}
});
content.addEventListener("blur",async event=>{
  const target=event.target;
  if(target.dataset.issueField){const key=target.dataset.issueField,body={};body[key]=target.value;if(key==="estimate")body[key]=target.value?Number(target.value):null;try{await api("/api/issues/"+selectedIssue,{method:"PATCH",body});await refresh();}catch(e){report(e);}}
  if(target.dataset.projectField){try{await api("/api/projects/"+selectedProject,{method:"PATCH",body:{[target.dataset.projectField]:target.value}});await refresh();}catch(e){report(e);}}
},{capture:true});
content.addEventListener("dragstart",event=>{const card=event.target.closest("[data-issue]");if(card){event.dataTransfer.setData("text/plain",card.dataset.issue);}});
content.addEventListener("dragover",event=>{if(event.target.closest("[data-drop-group]"))event.preventDefault();});
content.addEventListener("drop",async event=>{const column=event.target.closest("[data-drop-group]");if(!column)return;event.preventDefault();const identifier=event.dataTransfer.getData("text/plain");const status=column.dataset.dropGroup;if(GROUPS.includes(display.groupBy)&&display.groupBy!=="Status")return;try{await api("/api/issues/"+identifier,{method:"PATCH",body:{status}});await refresh();}catch(e){report(e);}});
modalLayer.addEventListener("click",event=>{if(event.target===modalLayer)closeModal();});
commandLayer.addEventListener("click",event=>{if(event.target===commandLayer)closeSearch();});
document.addEventListener("change",async event=>{
  const target=event.target,issueForm=target.closest("#issue-form");
  if(issueForm&&target.name==="teamId"){
    if(refreshIssueProjectOptions(issueForm))toast("Project removed because it is not linked to this team");
    return;
  }
  if(target.id!=="import-file")return;
  const file=target.files[0];if(!file)return;
  try{const parsed=JSON.parse(await file.text());importPreview=Array.isArray(parsed)?{issues:parsed}:parsed;if(!Array.isArray(importPreview.issues))throw new Error("JSON must contain an issues array");const sample=importPreview.issues.slice(0,5).map(x=>'<li>'+esc(x.identifier||"")+ ' '+esc(x.title||x.name||"Untitled")+'</li>').join("");const body='<p>Found <b>'+importPreview.issues.length+'</b> issues. Review a sample before importing into '+esc(team().name)+'.</p><ul>'+sample+'</ul><input type="hidden" name="confirm" value="yes">';openModal("Preview import","import-form",body,"Import issues");}catch(error){report(new Error("Could not read import file: "+error.message));}target.value="";
});
document.addEventListener("keydown",event=>{
  if(event.key==="Escape"){closeModal();closeSearch();closePopover();return;}
  if(event.target.matches?.("#comment-form textarea")&&event.key==="Enter"&&!event.shiftKey){const mode=(data.settings.preferences||{}).commentSubmit||"Enter";if(mode==="Enter"||event.metaKey||event.ctrlKey){event.preventDefault();event.target.closest("form").requestSubmit();return;}}
  const typing=["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName);
  if(!typing&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();openSearch();}
  else if(!typing&&event.key.toLowerCase()==="c"){event.preventDefault();openIssueModal({teamId:activeTeamId});}
});
async function boot(){
  try{data=await api("/api/bootstrap");const savedTeam=Number(localStorage.getItem("clone-team"));if(data.teams.some(t=>t.id===savedTeam))activeTeamId=savedTeam;const pages={inbox:"Inbox","my-issues":"My issues",projects:"Projects",views:"Views",home:"Home",issues:"Issues","team-projects":"Team projects","team-views":"Team views",members:"Members",cycles:"Cycles",settings:"Settings",triage:"Triage",archive:"Archive"};const route=decodeURIComponent(location.hash.slice(1));if(route.startsWith("view-")){const view=data.views.find(v=>v.id===Number(route.slice(5)));if(view){updateShell();return applyView(view);}}const routePage=pages[route];const savedPage=localStorage.getItem("clone-page");const homePage=(data.settings.preferences||{}).defaultHome||"Issues";if(routePage)currentPage=routePage;else if(savedPage&&Object.values(pages).includes(savedPage))currentPage=savedPage;else if(Object.values(pages).includes(homePage))currentPage=homePage;updateShell();renderPage();}
  catch(error){content.innerHTML='<div class="empty-state"><h2>Could not connect to the local workspace</h2><p>Start the app with <code>python3 server.py</code>, then reload this page.</p></div>';report(error);}
}
boot();
