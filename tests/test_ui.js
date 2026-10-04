/* Check UI model behavior without a browser or third-party packages. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/boot\(\);\s*$/, '');
function model() {
  const nodes = new Map();
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', addEventListener() {} });
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const context = vm.createContext({ document, console });
  vm.runInContext(source, context);
  vm.runInContext(`data={teams:[{id:1},{id:2}],settings:{},issues:[],projects:[],views:[],statuses:[],actors:[]};`, context);
  return { run: code => {
    const value = vm.runInContext(code, context);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } };
}
function issue(id, status, category) {
  return {id, identifier:`PRO-${id}`, title:`Issue ${id}`, team_id:1, status, status_category:category,
    priority:4, assignee_id:1, labels:[], subscribers:[], relations:[], activity:[], comments:[],
    created_at:'2026-01-01', updated_at:'2026-01-01', number:id};
}

test('Active and completed visibility use custom workflow categories', () => {
  const m = model();
  m.run(`data.issues=${JSON.stringify([issue(1,'Released','Completed'),issue(2,'Building','Started'),issue(3,'Stopped','Canceled')])}; currentView='Active';`);
  assert.deepEqual(m.run('filterIssues().map(i=>i.id)'), [2]);
  m.run(`currentView='All issues'; display.showCompleted=false;`);
  assert.deepEqual(m.run('filterIssues().map(i=>i.id)'), [2]);
});

test('Backlog supports a custom workflow name', () => {
  const m = model();
  m.run(`data.issues=${JSON.stringify([issue(1,'Ideas','Backlog'),issue(2,'Building','Started')])}; currentView='Backlog';`);
  assert.deepEqual(m.run('filterIssues().map(i=>i.id)'), [1]);
});

test('Empty status groups remain available with populated issues', () => {
  const m = model();
  m.run(`data.issues=${JSON.stringify([issue(1,'Building','Started')])}; data.statuses=[{team_id:1,name:'Ideas',position:0},{team_id:1,name:'Building',position:1},{team_id:1,name:'Released',position:2}]; display.showEmptyGroups=true;`);
  assert.deepEqual(m.run('issueGroups(data.issues).map(g=>({name:g.name,count:g.issues.length}))'),
    [{name:'Ideas',count:0},{name:'Building',count:1},{name:'Released',count:0}]);
});

test('Team views exclude views from another team', () => {
  const m = model();
  m.run(`currentPage='Team views';currentView='Issues';data.views=[
    {id:1,team_id:1,scope:'Team',entity:'issues',name:'Current view'},
    {id:2,team_id:2,scope:'Team',entity:'issues',name:'Other team'},
    {id:3,team_id:1,scope:'Personal',entity:'issues',name:'Personal view'}];renderViews();`);
  const html = m.run('content.innerHTML');
  assert.match(html, /Current view/);
  assert.doesNotMatch(html, /Other team|Personal view/);
});

test('A workspace without teams has usable preference defaults', () => {
  const m = model();
  m.run('data.teams=[];normalizeData();');
  assert.equal(m.run('activeTeamId'), null);
  assert.equal(m.run('data.settings.preferences.fontSize'), 'Default');
  assert.deepEqual(m.run('data.settings.integrations'), []);
  assert.equal(m.run('team().name'), 'Workspace');
});

test('Completed issues sort after open issues with custom names', () => {
  const m = model();
  m.run(`data.issues=${JSON.stringify([issue(1,'Released','Completed'),issue(2,'Building','Started')])};display.completedAtBottom=true;display.orderBy='Title';display.direction='Ascending';`);
  assert.deepEqual(m.run('filterIssues().map(i=>i.id)'), [2,1]);
});

test('Display visibility menu toggles the current value', () => {
  const m = model();
  m.run(`let pick;popover=(_anchor,_values,onPick)=>{pick=onPick;};renderPage=()=>{};openPopoverForDisplay({});pick('Show completed · On');`);
  assert.equal(m.run('display.showCompleted'), false);
  m.run(`openPopoverForDisplay({});pick('Show empty groups · Off');`);
  assert.equal(m.run('display.showEmptyGroups'), true);
  m.run(`openPopoverForDisplay({});pick('Show sub-issues · On');`);
  assert.equal(m.run('display.showSubissues'), false);
});

test('Project filters support unassigned leads and no labels', () => {
  const m = model();
  m.run(`currentPage='Projects'; data.projects=[
    {id:1,name:'First',status:'Planned',lead_id:null,lead:null,labels:[],updated_at:'2026-01-01'},
    {id:2,name:'Second',status:'Planned',lead_id:1,lead:{name:'Local'},labels:[{name:'Bug'}],updated_at:'2026-01-02'}
  ];filters.assignee='Unassigned';filters.label='No label';`);
  assert.deepEqual(m.run('filterProjects().map(p=>p.id)'),[1]);
});

test('Project update ordering follows timestamps and direction', () => {
  const m = model();
  m.run(`currentPage='Projects'; data.projects=[
    {id:1,name:'First',updated_at:'2026-01-02'},
    {id:2,name:'Second',updated_at:'2026-01-01'}
  ];display.orderBy='Updated';display.direction='Descending';`);
  assert.deepEqual(m.run('filterProjects().map(p=>p.id)'),[1,2]);
  m.run("display.direction='Ascending';");
  assert.deepEqual(m.run('filterProjects().map(p=>p.id)'),[2,1]);
});
