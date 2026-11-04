/* Check UI model behavior without a browser or third-party packages. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/boot\(\);\s*$/, '');
function model(globals = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) {
        const classes = new Set(), attributes = new Map();
        nodes.set(selector, { innerHTML: '',
          classList: { toggle(name, enabled) { const next=enabled??!classes.has(name);next?classes.add(name):classes.delete(name);return next; }, contains(name) { return classes.has(name); } },
          setAttribute(name,value) { attributes.set(name,String(value)); }, getAttribute(name) { return attributes.get(name)??null; },
          addEventListener(event, callback) { listeners.set(`${selector}:${event}`, callback); }
        });
      }
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const context = vm.createContext({ document, console, ...globals });
  vm.runInContext(source, context);
  vm.runInContext(`data={teams:[{id:1},{id:2}],settings:{},issues:[],projects:[],views:[],statuses:[],actors:[]};`, context);
  return { event: (selector, type, event) => listeners.get(`${selector}:${type}`)(event), dispatch: (selector, event) => listeners.get(`${selector}:click`)(event), runAsync: code => vm.runInContext(code, context), run: code => {
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

test('Saved-view tab saves reconcile revisions before a later explicit save', async () => {
  let revision = 1;
  const sent = [];
  const m = model({ fetch: async (_path, options) => {
    const body = JSON.parse(options.body);
    sent.push(body.ifRevision);
    assert.equal(body.ifRevision, revision);
    revision++;
    return { ok:true, json:async () => ({viewId:1}) };
  }});
  m.run('data.views=[{id:1,revision:1}];viewId=1;refresh=async()=>{};toast=()=>{};void 0;');
  const click = {target:{closest:()=>true}};
  m.dispatch('#view-tabs', click);
  await m.runAsync('Promise.all([...viewSaves.values()])');
  m.dispatch('#view-tabs', click);
  await m.runAsync('Promise.all([...viewSaves.values()])');
  await m.runAsync('action("update-view",{dataset:{}})');
  assert.deepEqual(sent,[1,2,3]);
  assert.equal(m.run('data.views[0].revision'),4);
});

test('Rapid saved-view clicks serialize writes and preserve each selected payload', async () => {
  let revision = 1;
  let active = 0;
  const sent = [];
  const m = model({ fetch: async (_path, options) => {
    const body = JSON.parse(options.body);
    assert.equal(++active,1);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(body.ifRevision,revision++);
    sent.push(body.filters.status);
    active--;
    return {ok:true,json:async()=>({viewId:1})};
  }});
  m.run('data.views=[{id:1,revision:1}];viewId=1;filters.status="Todo";');
  const click = {target:{closest:()=>true}};
  m.dispatch('#view-tabs',click);
  m.run('filters.status="Done"');
  m.dispatch('#view-tabs',click);
  await m.runAsync('Promise.all([...viewSaves.values()])');
  assert.deepEqual(sent,['Todo','Done']);
  assert.equal(m.run('data.views[0].revision'),3);
});

test('A remote saved-view conflict remains visible without automatic retry', async () => {
  let calls = 0;
  const m = model({fetch:async()=>{
    calls++;
    return {ok:false,json:async()=>({error:'Record revision conflict'})};
  }});
  m.run('data.views=[{id:1,revision:1}];viewId=1;');
  await assert.rejects(m.runAsync('saveView(viewId,{filters,display},true)'),/Record revision conflict/);
  assert.equal(calls,1);
  assert.equal(m.run('data.views[0].revision'),1);
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

test('Settings navigation renders one selected panel', () => {
  const m = model();
  m.run(`data.workspace={name:'Workspace'};data.settings={preferences:{sidebar:{}},workspace:{},integrations:[]};data.recurring=[];data.automations=[];data.statuses=[];settingsSection='workspace';renderSettings();`);
  const html = m.run('content.innerHTML');
  assert.match(html, /data-settings-panel="workspace"/);
  assert.match(html, /class="selected" data-action="settings-workspace"/);
  assert.match(html, /<h2>Workspace<\/h2>/);
  assert.doesNotMatch(html, /<h2>Preferences<\/h2>/);
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


test('Board and list choices leave issue detail without discarding view settings', () => {
  const m = model();
  for (const layout of ['Board','List']) {
    m.run(`selectedIssue='PRO-1';currentPage='Issues';viewId=9;filters.priority='High';display.groupBy='Assignee';setCollectionLayout('${layout}');`);
    assert.deepEqual(m.run('[selectedIssue,display.layout,viewId,filters.priority,display.groupBy]'), [null,layout,9,'High','Assignee']);
  }
  m.run(`selectedProject=3;currentPage='Projects';setCollectionLayout('Board');`);
  assert.equal(m.run('selectedProject'),null);
});

test('Issue properties toggle without replacing an unfinished form', () => {
  const m=model();
  m.run(`selectedIssue='PRO-1';$('#content-area').innerHTML='unsaved text';`);
  m.run('toggleIssueProperties()');
  assert.equal(m.run(`$('#issue-properties').classList.contains('hidden')`),true);
  assert.equal(m.run(`$('#details-toggle').getAttribute('aria-expanded')`),'false');
  assert.equal(m.run(`$('#content-area').innerHTML`),'unsaved text');
  m.run('toggleIssueProperties()');
  assert.equal(m.run(`$('#issue-properties').classList.contains('hidden')`),false);
  assert.equal(m.run(`$('#details-toggle').getAttribute('aria-expanded')`),'true');
});

test('Board cards obey every visible property setting and escape text', () => {
  const m=model();
  const record={...issue(1,'Todo','Unstarted'),project:'Project <one>',assignee:'Alex',due_date:'2026-11-10',labels:[{name:'Bug <one>'}]};
  m.run(`data.issues=${JSON.stringify([record])};display.groupBy='Status';display.properties={Status:false,Priority:false,Assignee:false,Project:false,Label:false,'Due date':false,Updated:false};`);
  let html=m.run('issueCard(data.issues[0])');
  assert.ok(!html.includes('card-foot'));
  assert.ok(html.includes('draggable="true"'));
  const names={Status:'card-status',Priority:'card-priority',Assignee:'card-assignee',Project:'card-project',Label:'card-labels','Due date':'card-due-date',Updated:'card-updated'};
  for(const [property, css] of Object.entries(names)) {
    m.run(`display.properties[${JSON.stringify(property)}]=true;`);
    html=m.run('issueCard(data.issues[0])');
    assert.ok(html.includes(`class="${css}"`),property);
    m.run(`display.properties[${JSON.stringify(property)}]=false;`);
  }
  m.run(`display.properties.Project=true;display.properties.Label=true;`);
  html=m.run('issueCard(data.issues[0])');
  assert.ok(html.includes('Project &lt;one&gt;'));
  assert.ok(html.includes('Bug &lt;one&gt;'));
});

test('Board secondary groups preserve every card and show counts', () => {
  const m=model();
  m.run(`data.issues=${JSON.stringify([{...issue(1,'Todo','Unstarted'),assignee:'Alex'},{...issue(2,'Todo','Unstarted'),assignee:'Maya'},{...issue(3,'Todo','Unstarted'),assignee:'Alex'}])};display.groupBy='Status';display.groupBy2='Assignee';`);
  const html=m.run('boardGroupContents(data.issues)');
  assert.equal((html.match(/class="board-subgroup"/g)||[]).length,2);
  assert.ok(html.includes('Alex<span>2</span>'));
  assert.ok(html.includes('Maya<span>1</span>'));
  assert.equal((html.match(/data-issue=/g)||[]).length,3);
  m.run(`display.groupBy2='Status';`);
  assert.ok(!m.run('boardGroupContents(data.issues)').includes('board-subgroup'));
});

test('Board accepts drops only when grouped by status and sends the read revision', async () => {
  const calls=[];
  const m=model({fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({issueId:1})};}});
  m.run(`data.issues=${JSON.stringify([{...issue(1,'Backlog','Backlog'),revision:7}])};refresh=async()=>{};report=e=>{throw e};void 0;`);
  const event={target:{closest:()=>({dataset:{dropGroup:'Todo'}})},preventDefault(){},dataTransfer:{getData:()=>'PRO-1'}};
  await m.event('#content-area','drop',event);
  assert.deepEqual(calls,[{url:'/api/issues/PRO-1',body:{status:'Todo',ifRevision:7}}]);
  m.run(`display.groupBy='Priority';`);
  await m.event('#content-area','drop',event);
  assert.equal(calls.length,1);
  assert.ok(m.run('issueCard(data.issues[0])').includes('draggable="false"'));
});
