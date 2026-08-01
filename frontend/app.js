/* ===================== CONFIG ===================== */
// When hosted by the backend, the app automatically uses the same domain.
const API_BASE = (window.API_BASE || `${window.location.origin}/api`).replace(/\/$/, '');

const BRANCHES = [
  {code:'BR1', name:'Thandi Sarak'},
  {code:'BR2', name:'Qasimabad'},
  {code:'BR3', name:'MPK'},
  {code:'BR4', name:'Latifabad'},
  {code:'JDC', name:'JDC Warehouse', noTeam:true},
  {code:'MANDI', name:'Mandi', noTeam:true}
];
const branchName = c => (BRANCHES.find(b=>b.code===c)||{}).name || c;

const CATEGORIES = ['Electrical','Refrigeration / Cold storage','Plumbing','Civil / Structure','Equipment / Machinery','Cleanliness / Hygiene','Other'];

const ROLE_LABEL = {captain:'Branch Captain', auditor:'Branch Auditor', coordinator:'Maintenance Team', admin:'Head Office Admin', reporter:'Issue Reporter', ceo:'Chief Executive Officer'};

/* ===================== STATE ===================== */
let currentUser = null;   // {id, role, branch, name, isHead, mustChangePassword, routes}
let AUTH_TOKEN = null;
let ISSUES = [];
let USERS = [];
let AUDIT_LOGS = [];
let NOTIFICATIONS = [];
let VISITS = [];
let sidebarView = 'overview';
let passwordChangeRequired = false;
let notificationTimer = null;

/* ===================== API HELPER ===================== */
async function apiFetch(path, opts={}){
  const headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  if(AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
  const res = await fetch(API_BASE + path, Object.assign({}, opts, {headers}));
  let data = null;
  try{ data = await res.json(); }catch(e){ /* no body */ }
  if(!res.ok){
    throw new Error((data && data.error) || 'Request failed');
  }
  return data;
}

/* ===================== DATA ===================== */
async function loadIssues(){
  try{
    const raw = await apiFetch('/issues');
    ISSUES = raw.map(normalizeIssue);
  }catch(e){
    console.error(e);
    ISSUES = [];
    if(String(e.message || '').includes('Password change required')) {
      currentUser.mustChangePassword = true;
      localStorage.setItem('mb_user', JSON.stringify(currentUser));
    }
  }
}
async function loadUsers(){
  USERS = currentUser && currentUser.role === 'admin' ? await apiFetch('/users') : [];
}
async function loadAuditLogs(){
  AUDIT_LOGS = currentUser && currentUser.role === 'admin' ? await apiFetch('/users/audit/logs') : [];
}
async function loadNotifications(){
  if(!currentUser || !['coordinator','admin'].includes(currentUser.role)){
    NOTIFICATIONS = [];
    return;
  }
  try{
    NOTIFICATIONS = await apiFetch('/notifications/mine');
  }catch(e){
    console.error(e);
    NOTIFICATIONS = [];
  }
}
async function loadVisits(){
  if(!currentUser || !['admin','ceo','coordinator'].includes(currentUser.role)){
    VISITS = [];
    return;
  }
  try{
    VISITS = await apiFetch('/visits');
  }catch(e){
    console.error(e);
    VISITS = [];
  }
}
function normalizeIssue(i){
  const media = i.media || [];
  const openMedia = media.find(m=>m.phase==='open');
  const closeMedia = media.find(m=>m.phase==='close');
  return {
    id:i.id, branch:i.branch_code, title:i.title, category:i.category, description:i.description,
    status:i.status, isOld:i.is_old,
    openProof:i.open_proof,
    openProofMedia: openMedia ? {type:openMedia.media_type, dataUrl:openMedia.url} : null,
    openedBy:i.opened_by, openedByName:i.opened_by_name, openedAt:i.opened_at,
    verifiedByName:i.verified_by_name, verifiedAt:i.verified_at, auditorNote:i.auditor_note,
    closeProof:i.close_proof,
    closeProofMedia: closeMedia ? {type:closeMedia.media_type, dataUrl:closeMedia.url} : null,
    closedByName:i.closed_by_name, closedAt:i.closed_at
  };
}
function genLocalId(){ return 'tmp-' + Date.now(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function fmtDate(d){ if(!d) return '\u2014'; const dt=new Date(d); return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }
function fmtDateTime(d){
  if(!d) return '\u2014';
  const dt = new Date(d);
  return dt.toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

/* ===================== MEDIA UPLOAD (direct to Spaces via presigned URL) ===================== */
function mediaTypeFor(file){
  const name = (file && file.name || '').toLowerCase();
  if(file && file.type) return file.type;
  if(/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name)) return 'image/jpeg';
  if(/\.(mp4|mov|m4v|webm)$/i.test(name)) return 'video/mp4';
  return 'application/octet-stream';
}

async function uploadMediaFile(file){
  if(!file) return null;
  const mediaType = mediaTypeFor(file);
  const isVideo = mediaType.startsWith('video/');
  if(mediaType.startsWith('image/')) return uploadCompressedPhoto(file);
  if(!isVideo) throw new Error('Please choose a photo or video file.');
  const maxBytes = isVideo ? 60*1024*1024 : 15*1024*1024;
  if(file.size > maxBytes){
    alert(`That file is too large (max ${isVideo ? '60MB for video' : '15MB for photos'}). Please choose a smaller file.`);
    return null;
  }
  const presign = await apiFetch('/media/presign', {
    method:'POST',
    body: JSON.stringify({ filename:file.name, contentType:mediaType, size:file.size })
  });
  const uploadHeaders = {'Content-Type':mediaType};
  if(presign.acl) uploadHeaders['x-amz-acl'] = presign.acl;
  const putRes = await fetch(presign.uploadUrl, { method:'PUT', headers:uploadHeaders, body:file });
  if(!putRes.ok) throw new Error('File upload to storage failed');
  return { type: presign.type, key: presign.key };
}

function canvasToBlob(canvas, type, quality){
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function uploadCompressedPhoto(file){
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.78);
  if(!blob) throw new Error('Could not prepare photo');
  if(blob.size > 3*1024*1024) throw new Error('Photo is too large after compression. Please choose a smaller photo.');
  const dataBase64 = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
  return {
    type: 'image',
    key: `inline/${Date.now()}.jpg`,
    url: `data:image/jpeg;base64,${dataBase64}`
  };
}

/* ===================== LOGIN ===================== */
async function doLogin(){
  const id = document.getElementById('login-id').value.trim().toUpperCase();
  const pass = document.getElementById('login-pass').value.trim();
  const err = document.getElementById('login-error');
  err.textContent = '';
  if(!id || !pass){ err.textContent = 'Please enter your ID and password.'; return; }
  try{
    const data = await apiFetch('/auth/login', { method:'POST', body: JSON.stringify({ id, password: pass }) });
    setSession(data.token, data.user);
    await enterApp();
    if(currentUser.mustChangePassword) openChangePasswordModal(true);
  }catch(e){
    err.textContent = 'Incorrect ID or password. Please check and try again.';
  }
}
function setSession(token, user){
  AUTH_TOKEN = token;
  currentUser = user;
  localStorage.setItem('mb_token', AUTH_TOKEN);
  localStorage.setItem('mb_user', JSON.stringify(currentUser));
}
async function enterApp(){
  const u = currentUser;
  await loadIssues();
  await loadNotifications();
  await loadVisits();
  startNotificationPolling();
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='block';
  document.getElementById('user-initials').textContent = u.name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  document.getElementById('user-name').innerHTML = escapeHtml(u.name) + (u.isHead ? '<span class="head-badge">Head of Maintenance</span>':'');
  document.getElementById('user-role').textContent = ROLE_LABEL[u.role] + (u.branch ? ' \u00b7 '+branchName(u.branch) : ' \u00b7 All branches');
  sidebarView = u.role==='admin' ? 'overview' : u.role==='captain' ? 'my-issues' : u.role==='auditor' ? 'pending-verify' : u.role==='coordinator' ? 'pending-close' : u.role==='reporter' ? 'my-issues' : 'summary';
  renderSidebar();
  renderMain();
}
function doLogout(){
  currentUser = null; AUTH_TOKEN = null;
  passwordChangeRequired = false;
  if(notificationTimer){ clearInterval(notificationTimer); notificationTimer = null; }
  localStorage.removeItem('mb_token'); localStorage.removeItem('mb_user');
  document.getElementById('modal-backdrop').classList.remove('show');
  document.getElementById('app').style.display='none';
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('login-id').value='';
  document.getElementById('login-pass').value='';
}
// resume a session on page reload
(async function tryResumeSession(){
  const token = localStorage.getItem('mb_token');
  const user = localStorage.getItem('mb_user');
  if(token && user){
    AUTH_TOKEN = token;
    currentUser = JSON.parse(user);
    try{
      await enterApp();
      if(currentUser.mustChangePassword) openChangePasswordModal(true);
    }catch(e){ doLogout(); }
  }
})();

/* ===================== SIDEBAR ===================== */
function renderSidebar(){
  const s = document.getElementById('sidebar');
  const u = currentUser;
  let items = [];
  if(u.role==='admin'){
    items = [
      {key:'overview', label:'Overview', count: ISSUES.length},
      {key:'all-open', label:'Open', count: ISSUES.filter(i=>i.status==='open').length},
      {key:'all-verified', label:'Verified', count: ISSUES.filter(i=>i.status==='verified').length},
      {key:'all-closed', label:'Closed', count: ISSUES.filter(i=>i.status==='closed').length},
      {key:'visits', label:'Visits', count: VISITS.length},
      {key:'users', label:'Users', count: ''},
      {key:'audit', label:'Audit log', count: ''},
    ];
  } else if(u.role==='captain'){
    const mine = ISSUES.filter(i=>i.branch===u.branch);
    items = [
      {key:'my-issues', label:'All issues', count: mine.length},
      {key:'my-open', label:'Awaiting verification', count: mine.filter(i=>i.status==='open').length},
      {key:'my-verified', label:'Awaiting closure', count: mine.filter(i=>i.status==='verified').length},
      {key:'my-closed', label:'Closed', count: mine.filter(i=>i.status==='closed').length},
    ];
  } else if(u.role==='auditor'){
    const mine = ISSUES.filter(i=>i.branch===u.branch);
    items = [
      {key:'pending-verify', label:'Pending verification', count: mine.filter(i=>i.status==='open').length},
      {key:'aud-verified', label:'Verified by me', count: mine.filter(i=>i.status!=='open').length},
      {key:'aud-all', label:'All branch issues', count: mine.length},
    ];
  } else if(u.role==='coordinator'){
    const mine = ISSUES.filter(i=>u.routes.includes(i.branch));
    const forceCount = NOTIFICATIONS.filter(n=>n.event_type==='force_issue_created').length;
    items = [
      {key:'force-alerts', label:'Force alerts', count: forceCount},
      {key:'pending-close', label:'Open issues', count: mine.filter(i=>i.status==='verified').length},
      {key:'sc-closed', label:'Resolved', count: mine.filter(i=>i.status==='closed').length},
    ];
    if(u.isHead){ items.push({key:'sc-headview', label:'All branches (Head view)', count: ISSUES.length}); }
  } else if(u.role==='reporter'){
    const mine = ISSUES.filter(i=>i.branch===u.branch);
    items = [ {key:'my-issues', label:'All issues', count: mine.length} ];
  }
  if(u.role==='ceo'){ s.innerHTML=''; return; }
  s.innerHTML = `<div class="side-label">Menu</div>` + items.map(it=>
    `<button class="side-btn ${sidebarView===it.key?'active':''}" onclick="setView('${it.key}')"><span>${it.label}</span><span class="count">${it.count}</span></button>`
  ).join('');
}
async function setView(v){
  sidebarView=v;
  if(v==='force-alerts') await loadNotifications();
  renderSidebar();
  renderMain();
}

function startNotificationPolling(){
  if(notificationTimer){ clearInterval(notificationTimer); notificationTimer = null; }
  if(!currentUser || !['coordinator','admin'].includes(currentUser.role)) return;
  notificationTimer = setInterval(async () => {
    await loadNotifications();
    renderSidebar();
    if(sidebarView==='force-alerts') renderMain();
  }, 45000);
}

/* ===================== MAIN RENDER ===================== */
function renderMain(){
  const u = currentUser;
  if(u.role==='admin') return renderAdmin();
  if(u.role==='captain') return renderCaptain();
  if(u.role==='auditor') return renderAuditor();
  if(u.role==='coordinator') return renderCoordinator();
  if(u.role==='reporter') return renderReporter();
  if(u.role==='ceo') return renderCEO();
}

function branchStats(code){ return statsFor([code]); }
function statsFor(codes){
  const list = ISSUES.filter(i=>codes.includes(i.branch));
  const closed = list.filter(i=>i.status==='closed').length;
  const total = list.length;
  const pct = total ? Math.round((closed/total)*100) : 0;
  return {total, open:list.filter(i=>i.status==='open').length, verified:list.filter(i=>i.status==='verified').length, closed, pct};
}
function daysBetween(start, end){
  if(!start || !end) return null;
  return Math.max(0, (new Date(end) - new Date(start)) / 86400000);
}
function avg(list){
  const nums = list.filter(n=>Number.isFinite(n));
  return nums.length ? nums.reduce((a,b)=>a+b,0) / nums.length : null;
}
function performanceRows(){
  const teams = [
    {code:'MT-BR1', name:'Fayaz - Head Maintenance', branches:['BR1','JDC','MANDI']},
    {code:'MT-BR2', name:'Amjad - Qasimabad', branches:['BR2']},
    {code:'MT-BR3', name:'Anees - MPK', branches:['BR3']},
    {code:'MT-BR4', name:'Asad - Latifabad', branches:['BR4']}
  ];
  return teams.map(t=>{
    const list = ISSUES.filter(i=>t.branches.includes(i.branch));
    const closed = list.filter(i=>i.status==='closed');
    const verified = list.filter(i=>i.status!=='open');
    const resolutionDays = closed.map(i=>daysBetween(i.openedAt, i.closedAt));
    const avgDays = avg(resolutionDays);
    const pending = list.filter(i=>i.status!=='closed');
    const oldestPendingDays = pending.length ? Math.max(...pending.map(i=>daysBetween(i.openedAt, new Date()) || 0)) : 0;
    const closureRate = list.length ? closed.length / list.length : null;
    const speedScore = avgDays === null ? 0 : Math.max(0, Math.min(1, (7 - avgDays) / 7));
    const pendingPenalty = Math.max(0, Math.min(1, oldestPendingDays / 7));
    const efficiency = list.length ? Math.round(((closureRate * 0.60) + (speedScore * 0.25) + ((1 - pendingPenalty) * 0.15)) * 100) : null;
    const verificationRate = list.length ? Math.round((verified.length / list.length) * 100) : null;
    return {
      ...t,
      total:list.length,
      closed:closed.length,
      pending:pending.length,
      avgDays,
      oldestPendingDays,
      efficiency,
      verificationRate
    };
  });
}
function scoreClass(score){
  if(score === null) return 'mid';
  if(score >= 75) return '';
  if(score >= 45) return 'mid';
  return 'low';
}
function scoreText(score){ return score === null ? 'N/A' : score + '%'; }
function renderPerformanceDashboard(){
  const rows = performanceRows();
  return `
    <div class="panel">
      <div class="panel-title">Maintenance team performance</div>
      <div class="perf-table">
        <div class="perf-row perf-head">
          <span>Team</span><span>Highlighted</span><span>Closed</span><span>Avg resolve</span><span>Efficiency</span><span>Verify rate</span>
        </div>
        ${rows.map(r=>`
          <div class="perf-row">
            <span class="perf-name" data-label="Team">${escapeHtml(r.name)}<span class="perf-sub">${r.branches.map(branchName).join(' + ')}</span></span>
            <span data-label="Highlighted">${r.total}</span>
            <span data-label="Closed">${r.closed}/${r.total || 0}<span class="perf-sub">${r.pending} pending</span></span>
            <span data-label="Avg resolve">${r.avgDays === null ? 'N/A' : r.avgDays.toFixed(1)+' days'}<span class="perf-sub">${Math.round(r.oldestPendingDays)}d oldest pending</span></span>
            <span data-label="Efficiency"><span class="score-pill ${scoreClass(r.efficiency)}">${scoreText(r.efficiency)}</span></span>
            <span data-label="Verify rate"><span class="score-pill ${scoreClass(r.verificationRate)}">${scoreText(r.verificationRate)}</span></span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/* ---------- ADMIN ---------- */
function renderAdmin(){
  if(sidebarView==='users') return renderAdminUsers();
  if(sidebarView==='audit') return renderAdminAudit();
  if(sidebarView==='visits') return renderAdminVisits();
  const m = document.getElementById('main');
  const total = ISSUES.length;
  const open = ISSUES.filter(i=>i.status==='open').length;
  const verified = ISSUES.filter(i=>i.status==='verified').length;
  const closed = ISSUES.filter(i=>i.status==='closed').length;
  const overallPct = total ? Math.round((closed/total)*100) : 0;

  let listFilter = 'all';
  if(sidebarView==='all-open') listFilter='open';
  if(sidebarView==='all-verified') listFilter='verified';
  if(sidebarView==='all-closed') listFilter='closed';

  m.innerHTML = `
    <div class="page-head">
      <div><h1>Head office overview</h1><p>Maintenance performance across all branches and locations</p></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="lbl">Total issues logged</div><div class="val">${total}</div></div>
      <div class="stat-card red"><div class="lbl">Open</div><div class="val">${open}</div></div>
      <div class="stat-card amber"><div class="lbl">Verified, pending closure</div><div class="val">${verified}</div></div>
      <div class="stat-card green"><div class="lbl">Closed</div><div class="val">${closed} <small>(${overallPct}%)</small></div></div>
    </div>
    <div class="panel">
      <div class="panel-title">Opened vs closed, by branch</div>
      <div style="position:relative;height:240px;"><canvas id="admin-chart"></canvas></div>
    </div>
    ${renderPerformanceDashboard()}
    <div class="panel">
      <div class="panel-title">Branch resolution rate</div>
      <div class="bars">
        ${BRANCHES.map(b=>{
          const st = branchStats(b.code);
          const cls = st.pct>=70?'':st.pct>=40?'mid':'low';
          return `<div class="bar-row"><div class="bar-top"><span class="bname">${b.code} \u2014 ${b.name}</span><span class="bpct">${st.closed}/${st.total} closed \u00b7 ${st.pct}%</span></div><div class="bar-track"><div class="bar-fill ${cls}" style="width:${st.pct}%"></div></div></div>`;
        }).join('')}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Issue log</div>
      <div class="ticket-grid" id="admin-ticket-list"></div>
    </div>
  `;
  let filtered = ISSUES.slice().sort((a,b)=> new Date(b.openedAt)-new Date(a.openedAt));
  if(listFilter!=='all') filtered = filtered.filter(i=>i.status===listFilter);
  renderTicketGrid('admin-ticket-list', filtered, 'view');

  const ctx = document.getElementById('admin-chart');
  new Chart(ctx, {
    type:'bar',
    data:{
      labels: BRANCHES.map(b=>b.code),
      datasets:[
        {label:'Opened', data: BRANCHES.map(b=>ISSUES.filter(i=>i.branch===b.code).length), backgroundColor:'#D6231C', borderRadius:5, maxBarThickness:34},
        {label:'Closed', data: BRANCHES.map(b=>branchStats(b.code).closed), backgroundColor:'#1E8A4C', borderRadius:5, maxBarThickness:34}
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:'bottom', labels:{boxWidth:10, font:{size:11}}}},
      scales:{y:{beginAtZero:true, ticks:{precision:0}}, x:{grid:{display:false}}}
    }
  });
}

async function renderAdminVisits(){
  const m = document.getElementById('main');
  await loadVisits();
  const branchCounts = BRANCHES.map(b => ({
    ...b,
    count: VISITS.filter(v=>v.branch_code===b.code).length,
    last: VISITS.find(v=>v.branch_code===b.code)
  }));
  m.innerHTML = `
    <div class="page-head">
      <div><h1>Branch visit tracking</h1><p>Maintenance team attendance by branch and visit time</p></div>
    </div>
    <div class="stat-grid">
      ${branchCounts.map(b=>`
        <div class="stat-card">
          <div class="lbl">${escapeHtml(b.name)}</div>
          <div class="val">${b.count}</div>
          <small>${b.last ? 'Last: '+fmtDateTime(b.last.visited_at) : 'No visits logged'}</small>
        </div>
      `).join('')}
    </div>
    <div class="panel">
      <div class="panel-title">Latest visits</div>
      <div class="bars">
        ${VISITS.map(v=>`
          <div class="bar-row" style="border-bottom:1px solid var(--line);padding-bottom:10px;">
            <div class="bar-top">
              <span class="bname">${escapeHtml(branchName(v.branch_code))} · ${escapeHtml(v.user_name || v.user_id)}</span>
              <span class="bpct">${fmtDateTime(v.visited_at)}</span>
            </div>
            <div class="desc">${escapeHtml(v.note || 'Visit logged')}${v.latitude && v.longitude ? ` · GPS: ${Number(v.latitude).toFixed(4)}, ${Number(v.longitude).toFixed(4)}` : ''}</div>
          </div>
        `).join('') || '<div class="empty-state">No branch visits logged yet.</div>'}
      </div>
    </div>
  `;
}

async function renderAdminUsers(){
  const m = document.getElementById('main');
  m.innerHTML = `
    <div class="page-head">
      <div><h1>User management</h1><p>Create users, reset passwords, and disable access</p></div>
      <button class="btn btn-fill" onclick="openCreateUserModal()">+ New user</button>
    </div>
    <div class="panel">
      <div class="panel-title">Accounts</div>
      <div id="users-table" class="bars"></div>
    </div>
  `;
  try{
    await loadUsers();
    document.getElementById('users-table').innerHTML = USERS.map(u => `
      <div class="bar-row" style="border-bottom:1px solid var(--line);padding-bottom:10px;">
        <div class="bar-top">
          <span class="bname">${escapeHtml(u.id)} · ${escapeHtml(u.name)}</span>
          <span class="bpct">${escapeHtml(u.role)}${u.branch_code ? ' · '+escapeHtml(u.branch_code) : ''} · ${u.phone ? escapeHtml(u.phone)+' · ' : ''}${u.is_active ? 'Active' : 'Disabled'}</span>
        </div>
        <div class="actions-row">
          <button class="btn-ghost-sm" onclick="openPhoneModal('${escapeHtml(u.id)}','${escapeHtml(u.phone || '')}')">Phone</button>
          <button class="btn-ghost-sm" onclick="openResetPasswordModal('${escapeHtml(u.id)}')">Reset password</button>
          <button class="btn-ghost-sm" onclick="toggleUserStatus('${escapeHtml(u.id)}', ${!u.is_active})">${u.is_active ? 'Disable' : 'Enable'}</button>
        </div>
      </div>
    `).join('') || '<div class="empty-state">No users found.</div>';
  }catch(e){
    document.getElementById('users-table').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

async function renderAdminAudit(){
  const m = document.getElementById('main');
  m.innerHTML = `
    <div class="page-head">
      <div><h1>Audit log</h1><p>Recent admin and issue workflow activity</p></div>
    </div>
    <div class="panel">
      <div class="panel-title">Latest 200 events</div>
      <div id="audit-table" class="bars"></div>
    </div>
  `;
  try{
    await loadAuditLogs();
    document.getElementById('audit-table').innerHTML = AUDIT_LOGS.map(a => `
      <div class="bar-row" style="border-bottom:1px solid var(--line);padding-bottom:10px;">
        <div class="bar-top">
          <span class="bname">${escapeHtml(a.action)} · ${escapeHtml(a.target_type)} ${escapeHtml(a.target_id || '')}</span>
          <span class="bpct">${fmtDate(a.created_at)}</span>
        </div>
        <div class="desc">${escapeHtml(a.actor_name || a.actor_id || 'System')}</div>
      </div>
    `).join('') || '<div class="empty-state">No audit events yet.</div>';
  }catch(e){
    document.getElementById('audit-table').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

/* ---------- CAPTAIN ---------- */
function renderCaptain(){
  const u = currentUser;
  const m = document.getElementById('main');
  const mine = ISSUES.filter(i=>i.branch===u.branch);
  const st = branchStats(u.branch);
  let list = mine;
  if(sidebarView==='my-open') list = mine.filter(i=>i.status==='open');
  if(sidebarView==='my-verified') list = mine.filter(i=>i.status==='verified');
  if(sidebarView==='my-closed') list = mine.filter(i=>i.status==='closed');
  list = list.slice().sort((a,b)=> new Date(b.openedAt)-new Date(a.openedAt));

  m.innerHTML = `
    <div class="page-head">
      <div><h1>${branchName(u.branch)} \u2014 Captain</h1><p>Highlight issues and track them through to closure</p></div>
      <div class="actions-row">
        <button class="btn" onclick="openIssueModal(true)">+ Add old issue</button>
        <button class="btn btn-fill" onclick="openIssueModal(false)">+ New issue</button>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="lbl">Total logged</div><div class="val">${st.total}</div></div>
      <div class="stat-card red"><div class="lbl">Awaiting verification</div><div class="val">${st.open}</div></div>
      <div class="stat-card amber"><div class="lbl">Awaiting closure</div><div class="val">${st.verified}</div></div>
      <div class="stat-card green"><div class="lbl">Closed</div><div class="val">${st.closed}</div></div>
    </div>
    <div class="panel">
      <div class="panel-title">Issues \u2014 ${branchName(u.branch)}</div>
      <div class="ticket-grid" id="cap-ticket-list"></div>
    </div>
  `;
  renderTicketGrid('cap-ticket-list', list, 'view');
}

/* ---------- AUDITOR ---------- */
function renderAuditor(){
  const u = currentUser;
  const m = document.getElementById('main');
  const mine = ISSUES.filter(i=>i.branch===u.branch);
  let list;
  if(sidebarView==='aud-verified') list = mine.filter(i=>i.status!=='open');
  else if(sidebarView==='aud-all') list = mine;
  else list = mine.filter(i=>i.status==='open');
  list = list.slice().sort((a,b)=> new Date(b.openedAt)-new Date(a.openedAt));
  const st = branchStats(u.branch);

  m.innerHTML = `
    <div class="page-head">
      <div><h1>${branchName(u.branch)} \u2014 Auditor</h1><p>Verify issues raised by the branch captain</p></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card red"><div class="lbl">Pending verification</div><div class="val">${st.open}</div></div>
      <div class="stat-card amber"><div class="lbl">Verified, pending closure</div><div class="val">${st.verified}</div></div>
      <div class="stat-card green"><div class="lbl">Closed</div><div class="val">${st.closed}</div></div>
    </div>
    <div class="panel">
      <div class="panel-title">${sidebarView==='pending-verify' ? 'Awaiting your verification' : 'Branch issues'}</div>
      <div class="ticket-grid" id="aud-ticket-list"></div>
    </div>
  `;
  renderTicketGrid('aud-ticket-list', list, sidebarView==='pending-verify' ? 'verify' : 'view');
}

/* ---------- COORDINATOR (Maintenance Team) ---------- */
function renderCoordinator(){
  const u = currentUser;
  const m = document.getElementById('main');
  let list, branchLabel;
  if(sidebarView==='force-alerts'){
    list = ISSUES.filter(i=>u.routes.includes(i.branch));
    branchLabel = u.routes.map(c=>branchName(c)).join(' + ');
  } else if(sidebarView==='sc-headview'){
    list = ISSUES.slice();
    branchLabel = 'All branches';
  } else {
    const mine = ISSUES.filter(i=>u.routes.includes(i.branch));
    if(sidebarView==='sc-closed') list = mine.filter(i=>i.status==='closed');
    else list = mine.filter(i=>i.status==='verified');
    branchLabel = u.routes.map(c=>branchName(c)).join(' + ');
  }
  list = list.slice().sort((a,b)=> new Date(b.openedAt)-new Date(a.openedAt));
  const st = statsFor(u.routes);

  m.innerHTML = `
    <div class="page-head">
      <div><h1>${branchLabel} \u2014 Maintenance Team${u.isHead?' <span class="head-badge">Head of Maintenance Department</span>':''}</h1><p>Track open issues and mark them resolved with proof</p></div>
      <div class="actions-row"><button class="btn btn-fill" onclick="openVisitModal()">+ Log visit</button></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card red"><div class="lbl">Open issues</div><div class="val">${st.verified}</div></div>
      <div class="stat-card green"><div class="lbl">Resolved</div><div class="val">${st.closed}</div></div>
    </div>
    ${sidebarView==='force-alerts' ? `
      <div class="panel">
        <div class="panel-title">Recent force notifications</div>
        <div class="bars">
          ${renderNotificationRows(NOTIFICATIONS.filter(n=>n.event_type==='force_issue_created'))}
        </div>
      </div>
    ` : ''}
    <div class="panel">
      <div class="panel-title">${sidebarView==='pending-close' ? 'Open issues \u2014 ready to resolve' : sidebarView==='sc-headview' ? 'All branches, all issues' : sidebarView==='force-alerts' ? 'Related branch issues' : 'Resolved issues'}</div>
      <div class="ticket-grid" id="sc-ticket-list"></div>
    </div>
  `;
  renderTicketGrid('sc-ticket-list', list, sidebarView==='pending-close' ? 'close' : 'view');
}

function renderNotificationRows(list){
  if(!list.length) return '<div class="empty-state">No force notifications yet.</div>';
  return list.map(n => `
    <div class="bar-row" style="border-bottom:1px solid var(--line);padding-bottom:10px;">
      <div class="bar-top">
        <span class="bname">${escapeHtml(n.issue_id || 'Notification')}</span>
        <span class="bpct">${escapeHtml(n.status || 'queued')} \u00b7 ${fmtDateTime(n.created_at)}</span>
      </div>
      <div class="desc" style="white-space:pre-line;">${escapeHtml(n.message || '')}${n.error ? '\nError: '+escapeHtml(n.error) : ''}</div>
    </div>
  `).join('');
}

/* ---------- REPORTER (JDC Warehouse / Mandi \u2014 no local team) ---------- */
function renderReporter(){
  const u = currentUser;
  const m = document.getElementById('main');
  const mine = ISSUES.filter(i=>i.branch===u.branch).slice().sort((a,b)=> new Date(b.openedAt)-new Date(a.openedAt));
  const st = branchStats(u.branch);

  m.innerHTML = `
    <div class="page-head">
      <div><h1>${branchName(u.branch)}</h1><p>Report maintenance issues \u2014 the Head of Maintenance Department (Thandi Sarak) resolves them</p></div>
      <div class="actions-row">
        <button class="btn" onclick="openIssueModal(true)">+ Add old issue</button>
        <button class="btn btn-fill" onclick="openIssueModal(false)">+ New issue</button>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="lbl">Total logged</div><div class="val">${st.total}</div></div>
      <div class="stat-card amber"><div class="lbl">Pending resolution</div><div class="val">${st.verified}</div></div>
      <div class="stat-card green"><div class="lbl">Resolved</div><div class="val">${st.closed}</div></div>
    </div>
    <div class="panel">
      <div class="panel-title">Your reported issues</div>
      <div class="ticket-grid" id="rep-ticket-list"></div>
    </div>
  `;
  renderTicketGrid('rep-ticket-list', mine, 'view');
}

/* ---------- CEO (short summary only) ---------- */
function renderCEO(){
  const m = document.getElementById('main');
  const total = ISSUES.length;
  const open = ISSUES.filter(i=>i.status==='open').length;
  const verified = ISSUES.filter(i=>i.status==='verified').length;
  const closed = ISSUES.filter(i=>i.status==='closed').length;
  const pct = total ? Math.round((closed/total)*100) : 0;

  m.innerHTML = `
    <div class="page-head">
      <div><h1>Executive summary</h1><p>Maintenance performance snapshot across all branches and locations</p></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="lbl">Total issues logged</div><div class="val">${total}</div></div>
      <div class="stat-card red"><div class="lbl">Awaiting action</div><div class="val">${open+verified}</div></div>
      <div class="stat-card green"><div class="lbl">Resolved</div><div class="val">${closed} <small>(${pct}%)</small></div></div>
    </div>
    <div class="panel">
      <div class="panel-title">Resolution rate by branch / location</div>
      <div class="bars">
        ${BRANCHES.map(b=>{
          const st = branchStats(b.code);
          if(!st.total) return `<div class="bar-row"><div class="bar-top"><span class="bname">${b.name}</span><span class="bpct">No issues logged</span></div></div>`;
          const cls = st.pct>=70?'':st.pct>=40?'mid':'low';
          return `<div class="bar-row"><div class="bar-top"><span class="bname">${b.name}</span><span class="bpct">${st.closed}/${st.total} resolved \u00b7 ${st.pct}%</span></div><div class="bar-track"><div class="bar-fill ${cls}" style="width:${st.pct}%"></div></div></div>`;
        }).join('')}
      </div>
    </div>
  `;
}

/* ===================== TICKET GRID ===================== */
function renderTicketGrid(containerId, list, mode){
  const el = document.getElementById(containerId);
  if(!list.length){
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">No issues to show here right now.</div>`;
    return;
  }
  el.innerHTML = list.map(i => ticketCard(i, mode)).join('');
}
function mediaBlock(media, label){
  if(!media) return '';
  if(media.type==='image'){
    return `<div class="proof-media"><div class="proof-media-label">${label}</div><img src="${media.dataUrl}" alt="${label}" loading="lazy"></div>`;
  }
  return `<div class="proof-media"><div class="proof-media-label">${label}</div><video src="${media.dataUrl}" controls preload="metadata"></video></div>`;
}
function ticketCard(i, mode){
  const badge = i.status==='open' ? '<span class="badge open">Open</span>' : i.status==='verified' ? '<span class="badge verified">Verified</span>' : '<span class="badge closed">Closed</span>';
  let meta = `<div class="meta-line">
    <span>Opened by <b>${i.openedByName}</b> \u00b7 ${fmtDate(i.openedAt)}${i.branch ? ' \u00b7 '+i.branch : ''}</span>
    ${i.verifiedByName ? `<span>Verified by <b>${i.verifiedByName}</b> \u00b7 ${fmtDate(i.verifiedAt)}</span>` : ''}
    ${i.closedByName ? `<span>Closed by <b>${i.closedByName}</b> \u00b7 ${fmtDate(i.closedAt)}</span>` : ''}
  </div>`;
  let proofs = '';
  if(i.openProof) proofs += `<div class="proof-note"><b>Opening proof:</b> ${escapeHtml(i.openProof)}</div>`;
  proofs += mediaBlock(i.openProofMedia, 'Opening photo / video');
  if(i.auditorNote) proofs += `<div class="proof-note"><b>Auditor note:</b> ${escapeHtml(i.auditorNote)}</div>`;
  if(i.closeProof) proofs += `<div class="proof-note"><b>Closure proof:</b> ${escapeHtml(i.closeProof)}</div>`;
  proofs += mediaBlock(i.closeProofMedia, 'Closure photo / video');

  let cta = '';
  if(mode==='verify' && i.status==='open') cta = `<div class="ticket-cta"><button class="btn-ghost-sm" style="width:100%" onclick="openVerifyModal('${i.id}')">Verify issue</button></div>`;
  if(mode==='close' && i.status==='verified') cta = `<div class="ticket-cta"><button class="btn-ghost-sm" style="width:100%" onclick="openCloseModal('${i.id}')">Mark as resolved</button></div>`;
  const canDelete = currentUser && ['captain','reporter'].includes(currentUser.role) && i.status==='open' && i.openedBy===currentUser.id;
  if(canDelete){
    const deleteButton = `<button class="btn-ghost-sm" style="width:100%;color:var(--red-dark);border-color:var(--red-tint);" onclick="openDeleteIssueModal('${i.id}')">Delete issue</button>`;
    cta = cta ? cta.replace('</div>', `${deleteButton}</div>`) : `<div class="ticket-cta">${deleteButton}</div>`;
  }

  return `<div class="ticket status-${i.status}">
    <div class="ticket-top"><span class="ticket-id">${i.id}${i.isOld?' \u00b7 backdated':''}</span>${badge}</div>
    <h4>${escapeHtml(i.title)}</h4>
    <span class="cat">${i.category}</span>
    <div class="desc">${escapeHtml(i.description)}</div>
    ${proofs}
    ${meta}
    ${cta}
  </div>`;
}
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

/* ===================== MODALS ===================== */
function showModal(html, opts={}){
  passwordChangeRequired = !!opts.required;
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-backdrop').classList.add('show');
}
function closeModal(){
  if(passwordChangeRequired) return;
  document.getElementById('modal-backdrop').classList.remove('show');
}

function openChangePasswordModal(required){
  const title = required ? 'Change password required' : 'Change password';
  const sub = required
    ? 'Set a new private password before continuing.'
    : 'Update your account password.';
  showModal(`
    <div class="modal-head">
      <h3>${title}</h3>
      ${required ? '' : '<button class="x-btn" onclick="closeModal()">&times;</button>'}
    </div>
    <p class="sub">${sub}</p>
    <div class="field"><label>Current password</label><input id="f-current-pass" type="password" autocomplete="current-password"></div>
    <div class="field"><label>New password</label><input id="f-new-pass" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
    <div class="field"><label>Confirm new password</label><input id="f-confirm-pass" type="password" autocomplete="new-password"></div>
    <div id="password-change-error" style="color:var(--red-dark);font-size:12.5px;min-height:16px;font-weight:500;"></div>
    <div class="modal-actions">
      ${required ? '<button class="btn" onclick="doLogout()">Log out</button>' : '<button class="btn" onclick="closeModal()">Cancel</button>'}
      <button class="btn btn-fill" onclick="submitChangePassword()">Save password</button>
    </div>
  `, {required});
}

async function submitChangePassword(){
  const currentPassword = document.getElementById('f-current-pass').value;
  const newPassword = document.getElementById('f-new-pass').value;
  const confirmPassword = document.getElementById('f-confirm-pass').value;
  const err = document.getElementById('password-change-error');
  err.textContent = '';
  if(newPassword.length < 8){ err.textContent = 'New password must be at least 8 characters.'; return; }
  if(newPassword !== confirmPassword){ err.textContent = 'New passwords do not match.'; return; }

  const saveBtn = document.querySelector('.modal-actions .btn-fill');
  if(saveBtn){ saveBtn.textContent='Saving...'; saveBtn.disabled=true; }
  try{
    const data = await apiFetch('/auth/change-password', {
      method:'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    setSession(data.token, data.user);
    passwordChangeRequired = false;
    document.getElementById('modal-backdrop').classList.remove('show');
    await enterApp();
  }catch(e){
    err.textContent = e.message || 'Could not change password.';
    if(saveBtn){ saveBtn.textContent='Save password'; saveBtn.disabled=false; }
  }
}

function openCreateUserModal(){
  showModal(`
    <div class="modal-head"><h3>New user</h3><button class="x-btn" onclick="closeModal()">&times;</button></div>
    <p class="sub">Create an account for rollout. The user will be forced to change this password on first login.</p>
    <div class="field"><label>User ID</label><input id="f-user-id" placeholder="e.g. CAP-BR5"></div>
    <div class="field"><label>Name</label><input id="f-user-name" placeholder="Display name"></div>
    <div class="field"><label>Phone number</label><input id="f-user-phone" placeholder="e.g. +923001234567"></div>
    <div class="two-col">
      <div class="field"><label>Role</label><select id="f-user-role">
        <option value="captain">Captain</option>
        <option value="auditor">Auditor</option>
        <option value="coordinator">Maintenance team</option>
        <option value="reporter">Reporter</option>
        <option value="admin">Admin</option>
        <option value="ceo">CEO</option>
      </select></div>
      <div class="field"><label>Branch / location</label><select id="f-user-branch">
        <option value="">None / all</option>
        ${BRANCHES.map(b=>`<option value="${b.code}">${b.code} · ${b.name}</option>`).join('')}
      </select></div>
    </div>
    <div class="field"><label>Temporary password</label><input id="f-user-pass" type="password" placeholder="At least 8 characters"></div>
    <div id="user-action-error" style="color:var(--red-dark);font-size:12.5px;min-height:16px;font-weight:500;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-fill" onclick="submitCreateUser()">Create user</button>
    </div>
  `);
}

async function submitCreateUser(){
  const err = document.getElementById('user-action-error');
  err.textContent = '';
  const payload = {
    id: document.getElementById('f-user-id').value.trim(),
    name: document.getElementById('f-user-name').value.trim(),
    phone: document.getElementById('f-user-phone').value.trim(),
    role: document.getElementById('f-user-role').value,
    branchCode: document.getElementById('f-user-branch').value || null,
    password: document.getElementById('f-user-pass').value
  };
  if(!payload.id || !payload.name || !payload.password){ err.textContent='ID, name and password are required.'; return; }
  try{
    await apiFetch('/users', { method:'POST', body: JSON.stringify(payload) });
    closeModal();
    renderAdminUsers();
    renderSidebar();
  }catch(e){ err.textContent = e.message || 'Could not create user.'; }
}

function openResetPasswordModal(id){
  showModal(`
    <div class="modal-head"><h3>Reset password</h3><button class="x-btn" onclick="closeModal()">&times;</button></div>
    <p class="sub">${escapeHtml(id)} will be forced to change this password on next login.</p>
    <div class="field"><label>Temporary password</label><input id="f-reset-pass" type="password" placeholder="At least 8 characters"></div>
    <div id="user-action-error" style="color:var(--red-dark);font-size:12.5px;min-height:16px;font-weight:500;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-fill" onclick="submitResetPassword('${id}')">Reset password</button>
    </div>
  `);
}

async function submitResetPassword(id){
  const err = document.getElementById('user-action-error');
  err.textContent = '';
  const password = document.getElementById('f-reset-pass').value;
  if(password.length < 8){ err.textContent='Password must be at least 8 characters.'; return; }
  try{
    await apiFetch(`/users/${id}/reset-password`, { method:'POST', body: JSON.stringify({ password }) });
    closeModal();
    renderAdminUsers();
  }catch(e){ err.textContent = e.message || 'Could not reset password.'; }
}

async function toggleUserStatus(id, isActive){
  try{
    await apiFetch(`/users/${id}/status`, { method:'POST', body: JSON.stringify({ isActive }) });
    renderAdminUsers();
  }catch(e){
    alert(e.message || 'Could not update user status.');
  }
}

function openPhoneModal(id, phone){
  showModal(`
    <div class="modal-head"><h3>Phone number</h3><button class="x-btn" onclick="closeModal()">&times;</button></div>
    <p class="sub">${escapeHtml(id)}</p>
    <div class="field"><label>Phone number</label><input id="f-phone" value="${escapeHtml(phone)}" placeholder="e.g. +923001234567"></div>
    <div id="user-action-error" style="color:var(--red-dark);font-size:12.5px;min-height:16px;font-weight:500;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-fill" onclick="submitPhone('${id}')">Save phone</button>
    </div>
  `);
}

async function submitPhone(id){
  const err = document.getElementById('user-action-error');
  err.textContent = '';
  try{
    await apiFetch(`/users/${id}/phone`, { method:'POST', body: JSON.stringify({ phone: document.getElementById('f-phone').value.trim() }) });
    closeModal();
    renderAdminUsers();
  }catch(e){ err.textContent = e.message || 'Could not save phone.'; }
}

function getBrowserLocation(){
  return new Promise(resolve => {
    if(!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy:true, timeout:5000, maximumAge:60000 }
    );
  });
}

function openVisitModal(){
  const routes = (currentUser.routes || []).map(code => `<option value="${code}">${branchName(code)}</option>`).join('');
  showModal(`
    <div class="modal-head"><h3>Log branch visit</h3><button class="x-btn" onclick="closeModal()">&times;</button></div>
    <p class="sub">Record your branch visit time for admin tracking.</p>
    <div class="field"><label>Branch / location</label><select id="f-visit-branch">${routes}</select></div>
    <div class="field"><label>Visit note</label><textarea id="f-visit-note" placeholder="e.g. Checked freezer issue, met branch captain"></textarea></div>
    <div id="visit-error" style="color:var(--red-dark);font-size:12.5px;min-height:16px;font-weight:500;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-fill" onclick="submitVisit()">Save visit</button>
    </div>
  `);
}
async function submitVisit(){
  const err = document.getElementById('visit-error');
  const saveBtn = document.querySelector('.modal-actions .btn-fill');
  const payload = {
    branchCode: document.getElementById('f-visit-branch').value,
    note: document.getElementById('f-visit-note').value.trim()
  };
  if(saveBtn){ saveBtn.textContent='Saving...'; saveBtn.disabled=true; }
  try{
    const loc = await getBrowserLocation();
    if(loc) Object.assign(payload, loc);
    await apiFetch('/visits', { method:'POST', body: JSON.stringify(payload) });
    await loadVisits();
    closeModal();
    renderSidebar(); renderMain();
  }catch(e){
    err.textContent = e.message || 'Could not save visit.';
    if(saveBtn){ saveBtn.textContent='Save visit'; saveBtn.disabled=false; }
  }
}

function openIssueModal(isOld){
  const u = currentUser;
  showModal(`
    <div class="modal-head"><h3>${isOld ? 'Add old issue (backdated)' : 'New issue'}</h3><button class="x-btn" onclick="closeModal()">&times;</button></div>
    <p class="sub">${isOld ? 'Log a past issue for the record, including its current status.' : 'Highlight a maintenance issue for '+branchName(u.branch)+'.'}</p>
    <div class="field"><label>Title</label><input id="f-title" placeholder="e.g. Freezer 2 not cooling"></div>
    <div class="two-col">
      <div class="field"><label>Category</label><select id="f-cat">${CATEGORIES.map(c=>`<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Date opened</label><input id="f-date" type="date" value="${todayStr()}" ${isOld?'':'max="'+todayStr()+'"'}></div>
    </div>
    <div class="field"><label>Description</label><textarea id="f-desc" placeholder="Describe the issue in detail"></textarea></div>
    <div class="field"><label>Proof note (description)</label><textarea id="f-proof" placeholder="e.g. Freezer door hinge broken, ice buildup visible"></textarea></div>
    <div class="field">
      <label>Proof photo / video</label>
      <div class="upload-box">
        <input id="f-media-open" type="file" accept="image/*,video/*" onchange="previewMediaInput('f-media-open','f-media-open-preview')">
        <div class="upload-hint">Photos up to 15MB, videos up to 60MB.</div>
        <div class="media-preview" id="f-media-open-preview"></div>
      </div>
    </div>
    ${isOld ? `
    <div class="field"><label>Current status</label><select id="f-status" onchange="toggleOldFields()">
      <option value="open">Open \u2014 not yet verified</option>
      <option value="verified">Verified \u2014 pending closure</option>
      <option value="closed">Closed</option>
    </select></div>
    <div id="old-extra"></div>
    ` : ''}
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-fill" onclick="submitIssue(${isOld})">Save issue</button>
    </div>
  `);
  if(isOld) toggleOldFields();
}
function toggleOldFields(){
  const status = document.getElementById('f-status').value;
  let html = '';
  if(status==='verified' || status==='closed'){
    html += `<div class="two-col">
      <div class="field"><label>Verified by</label><input id="f-vname" placeholder="Auditor name"></div>
      <div class="field"><label>Verified date</label><input id="f-vdate" type="date" value="${todayStr()}"></div>
    </div>
    <div class="field"><label>Auditor note</label><textarea id="f-vnote" placeholder="Verification remarks"></textarea></div>`;
  }
  if(status==='closed'){
    html += `<div class="two-col">
      <div class="field"><label>Closed by</label><input id="f-cname" placeholder="Maintenance team name"></div>
      <div class="field"><label>Closed date</label><input id="f-cdate" type="date" value="${todayStr()}"></div>
    </div>
    <div class="field"><label>Closure proof (description)</label><textarea id="f-cnote" placeholder="Proof of repair / closure"></textarea></div>
    <div class="field">
      <label>Closure photo / video</label>
      <div class="upload-box">
        <input id="f-media-close" type="file" accept="image/*,video/*" onchange="previewMediaInput('f-media-close','f-media-close-preview')">
        <div class="upload-hint">Photos up to 15MB, videos up to 60MB.</div>
        <div class="media-preview" id="f-media-close-preview"></div>
      </div>
    </div>`;
  }
  document.getElementById('old-extra').innerHTML = html;
}
function previewMediaInput(inputId, previewId){
  const inp = document.getElementById(inputId);
  const prev = document.getElementById(previewId);
  const file = inp.files[0];
  if(!file){ prev.innerHTML=''; return; }
  if(file.type.startsWith('video/')){
    prev.innerHTML = `<div class="vid-name">Selected video: ${escapeHtml(file.name)} (${Math.round(file.size/1024/1024*10)/10}MB)</div>`;
  } else {
    const url = URL.createObjectURL(file);
    prev.innerHTML = `<img src="${url}" alt="Preview">`;
  }
}

async function submitIssue(isOld){
  const u = currentUser;
  const title = document.getElementById('f-title').value.trim();
  const desc = document.getElementById('f-desc').value.trim();
  if(!title || !desc){ alert('Please fill in the title and description.'); return; }
  const saveBtn = document.querySelector('.modal-actions .btn-fill');
  if(saveBtn){ saveBtn.textContent='Saving...'; saveBtn.disabled=true; }

  try{
    const openFile = document.getElementById('f-media-open').files[0];
    const openMedia = await uploadMediaFile(openFile);

    const payload = {
      title,
      category: document.getElementById('f-cat').value,
      description: desc,
      openProof: document.getElementById('f-proof').value.trim(),
      openedAt: document.getElementById('f-date').value || todayStr(),
      isOld: !!isOld,
      openMedia: openMedia ? [openMedia] : []
    };

    if(isOld){
      const status = document.getElementById('f-status').value;
      payload.statusOverride = status;
      if(status==='verified' || status==='closed'){
        payload.verifiedByName = document.getElementById('f-vname').value.trim() || 'Branch auditor';
        payload.verifiedAt = document.getElementById('f-vdate').value || todayStr();
        payload.auditorNote = document.getElementById('f-vnote').value.trim();
      }
      if(status==='closed'){
        payload.closedByName = document.getElementById('f-cname').value.trim() || 'Maintenance team';
        payload.closedAt = document.getElementById('f-cdate').value || todayStr();
        payload.closeProof = document.getElementById('f-cnote').value.trim();
        const closeFile = document.getElementById('f-media-close').files[0];
        const closeMedia = await uploadMediaFile(closeFile);
        payload.closeMedia = closeMedia ? [closeMedia] : [];
      }
    }

    await apiFetch('/issues', { method:'POST', body: JSON.stringify(payload) });
    await loadIssues();
    closeModal();
    renderSidebar(); renderMain();
  }catch(e){
    alert(e.message || 'Could not save the issue. Please try again.');
    if(saveBtn){ saveBtn.textContent='Save issue'; saveBtn.disabled=false; }
  }
}

function openVerifyModal(id){
  const i = ISSUES.find(x=>x.id===id);
  showModal(`
    <div class="modal-head"><h3>Verify issue</h3><button class="x-btn" onclick="closeModal()">&times;</button></div>
    <p class="sub">${escapeHtml(i.title)}</p>
    <div class="field"><label>Verification note</label><textarea id="f-vnote2" placeholder="Confirm the issue is genuine and describe what you checked"></textarea></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-fill" onclick="submitVerify('${id}')">Mark as verified</button>
    </div>
  `);
}
async function submitVerify(id){
  const note = document.getElementById('f-vnote2').value.trim();
  const saveBtn = document.querySelector('.modal-actions .btn-fill');
  if(saveBtn){ saveBtn.textContent='Saving...'; saveBtn.disabled=true; }
  try{
    await apiFetch(`/issues/${id}/verify`, { method:'POST', body: JSON.stringify({ note }) });
    await loadIssues();
    closeModal();
    renderSidebar(); renderMain();
  }catch(e){
    alert(e.message || 'Could not verify this issue.');
    if(saveBtn){ saveBtn.textContent='Mark as verified'; saveBtn.disabled=false; }
  }
}

function openDeleteIssueModal(id){
  const i = ISSUES.find(x=>x.id===id);
  if(!i) return;
  showModal(`
    <div class="modal-head"><h3>Delete issue</h3><button class="x-btn" onclick="closeModal()">&times;</button></div>
    <p class="sub">${escapeHtml(i.title)}</p>
    <div class="proof-note">This will remove the issue and its uploaded proof from the dashboard. Use this only when the issue was added by mistake.</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-fill" onclick="submitDeleteIssue('${id}')">Delete issue</button>
    </div>
  `);
}
async function submitDeleteIssue(id){
  const saveBtn = document.querySelector('.modal-actions .btn-fill');
  if(saveBtn){ saveBtn.textContent='Deleting...'; saveBtn.disabled=true; }
  try{
    await apiFetch(`/issues/${id}`, { method:'DELETE' });
    await loadIssues();
    closeModal();
    renderSidebar(); renderMain();
  }catch(e){
    alert(e.message || 'Could not delete this issue.');
    if(saveBtn){ saveBtn.textContent='Delete issue'; saveBtn.disabled=false; }
  }
}

function openCloseModal(id){
  const i = ISSUES.find(x=>x.id===id);
  showModal(`
    <div class="modal-head"><h3>Mark as resolved</h3><button class="x-btn" onclick="closeModal()">&times;</button></div>
    <p class="sub">${escapeHtml(i.title)}</p>
    <div class="field"><label>Resolution proof (description)</label><textarea id="f-cnote2" placeholder="Describe the repair completed as proof of resolution"></textarea></div>
    <div class="field">
      <label>Resolution photo / video</label>
      <div class="upload-box">
        <input id="f-media-resolve" type="file" accept="image/*,video/*" onchange="previewMediaInput('f-media-resolve','f-media-resolve-preview')">
        <div class="upload-hint">Photos up to 15MB, videos up to 60MB.</div>
        <div class="media-preview" id="f-media-resolve-preview"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-fill" onclick="submitClose('${id}')">Mark as resolved</button>
    </div>
  `);
}
async function submitClose(id){
  const note = document.getElementById('f-cnote2').value.trim();
  const file = document.getElementById('f-media-resolve').files[0];
  if(!note && !file){ alert('Please add a description or a photo / video as proof of resolution.'); return; }
  const saveBtn = document.querySelector('.modal-actions .btn-fill');
  if(saveBtn){ saveBtn.textContent='Saving...'; saveBtn.disabled=true; }
  try{
    const media = await uploadMediaFile(file);
    await apiFetch(`/issues/${id}/close`, { method:'POST', body: JSON.stringify({ note, media: media ? [media] : [] }) });
    await loadIssues();
    closeModal();
    renderSidebar(); renderMain();
  }catch(e){
    alert(e.message || 'Could not resolve this issue.');
    if(saveBtn){ saveBtn.textContent='Mark as resolved'; saveBtn.disabled=false; }
  }
}

document.getElementById('modal-backdrop').addEventListener('click', e=>{ if(e.target.id==='modal-backdrop') closeModal(); });
document.getElementById('login-pass').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
