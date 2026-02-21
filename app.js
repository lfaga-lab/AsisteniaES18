/* global Api */
const UI = (() => {
  const $ = (q, el = document) => el.querySelector(q);
  const $$ = (q, el = document) => Array.from(el.querySelectorAll(q));
  const fmtDate = (iso) => iso;
  const todayISO = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  };
  const toast = (msg) => {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2200);
  };
  const modal = {
    open(title, html) {
      $("#modalTitle").textContent = title;
      $("#modalBody").innerHTML = html;
      $("#modal").hidden = false;
    },
    close() { $("#modal").hidden = true; }
  };

  return { $, $$, fmtDate, todayISO, toast, modal };
})();

const State = {
  me: null,
  courses: [],
  studentsByCourse: new Map(),
  session: null,
  records: new Map(), // student_id -> {status, note}
  stack: [],
  stackIndex: 0
};

function setActiveTab(view) {
  UI.$$("#tabs .tab").forEach(b => b.classList.toggle("is-active", b.dataset.view === view));
  UI.$$("#app .view").forEach(v => v.hidden = true);
  UI.$(`#view${view[0].toUpperCase()}${view.slice(1)}`).hidden = false;
}

function bindTabs() {
  UI.$$("#tabs .tab").forEach(btn => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.view));
  });
}

function uniqCoursesForSelect(selectEl, includeAll = false) {
  selectEl.innerHTML = "";
  if (includeAll) {
    const opt = document.createElement("option");
    opt.value = "ALL";
    opt.textContent = "Todos";
    selectEl.appendChild(opt);
  }
  State.courses.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.course_id;
    opt.textContent = `${c.name} • ${c.turno}${c.is_mine ? "" : " • (cobertura)"}`;
    selectEl.appendChild(opt);
  });
}

function statusLabel(s) {
  if (s === "PRESENTE") return "PRESENTE";
  if (s === "AUSENTE") return "AUSENTE";
  if (s === "TARDE") return "TARDE";
  if (s === "VERIFICAR") return "VERIFICAR";
  return "—";
}

function statusTagClass(s) {
  if (s === "PRESENTE") return "present";
  if (s === "AUSENTE") return "absent";
  if (s === "TARDE") return "late";
  if (s === "VERIFICAR") return "verify";
  return "";
}

async function bootstrap() {
  UI.$("#selDate").value = UI.todayISO();
  UI.$("#editDate").value = UI.todayISO();
  UI.$("#statsFrom").value = UI.todayISO();
  UI.$("#statsTo").value = UI.todayISO();
  UI.$("#alertsTo").value = UI.todayISO();

  UI.$("#btnLogin").addEventListener("click", login);
  UI.$("#btnLogout").addEventListener("click", logout);

  UI.$("#btnLoadSession").addEventListener("click", loadSessionForTinder);
  UI.$("#btnPresent").addEventListener("click", () => commitCurrent("PRESENTE"));
  UI.$("#btnAbsent").addEventListener("click", () => commitCurrent("AUSENTE"));
  UI.$("#btnLate").addEventListener("click", () => commitCurrent("TARDE"));
  UI.$("#btnVerify").addEventListener("click", () => commitCurrent("VERIFICAR"));
  UI.$("#btnCloseSession").addEventListener("click", closeTodaySession);

  UI.$("#btnLoadEdit").addEventListener("click", loadEditList);
  UI.$("#btnLoadStats").addEventListener("click", loadStats);
  UI.$("#btnQuickWeek").addEventListener("click", () => quickRange(7));
  UI.$("#btnQuickMonth").addEventListener("click", () => quickRange(30));
  UI.$("#btnLoadAlerts").addEventListener("click", loadAlerts);

  UI.$("#modal").addEventListener("click", (e) => {
    const close = e.target && e.target.dataset && e.target.dataset.close;
    if (close) UI.modal.close();
  });

  bindTabs();

  // auto-login if token exists
  const token = localStorage.getItem("asistencia_token");
  if (token) {
    try {
      await afterLogin();
      return;
    } catch (e) {
      localStorage.removeItem("asistencia_token");
    }
  }
}

async function login() {
  UI.$("#loginError").hidden = true;
  const email = UI.$("#loginEmail").value.trim();
  const pin = UI.$("#loginPin").value.trim();
  if (!email || !pin) {
    UI.$("#loginError").textContent = "Completá email y PIN.";
    UI.$("#loginError").hidden = false;
    return;
  }
  try {
    const data = await Api.login(email, pin);
    localStorage.setItem("asistencia_token", data.token);
    await afterLogin();
  } catch (e) {
    UI.$("#loginError").textContent = e.message;
    UI.$("#loginError").hidden = false;
  }
}

async function afterLogin() {
  State.me = (await Api.me()).me;
  const c = await Api.getCourses();
  State.courses = c.courses;
  uniqCoursesForSelect(UI.$("#selCourse"));
  uniqCoursesForSelect(UI.$("#editCourse"));
  uniqCoursesForSelect(UI.$("#statsCourse"), true);
  uniqCoursesForSelect(UI.$("#alertsCourse"), true);

  UI.$("#btnLogout").hidden = false;
  UI.$("#tabs").hidden = false;
  UI.$("#viewLogin").hidden = true;
  UI.$("#viewTomar").hidden = false;
  setActiveTab("tomar");

  UI.toast(`Hola, ${State.me.full_name.split(" ")[0]} 👋`);
}

async function logout() {
  localStorage.removeItem("asistencia_token");
  location.reload();
}

async function getStudents(course_id) {
  if (State.studentsByCourse.has(course_id)) return State.studentsByCourse.get(course_id);
  const data = await Api.getStudents(course_id);
  State.studentsByCourse.set(course_id, data.students);
  return data.students;
}

async function loadSessionForTinder() {
  const course_id = UI.$("#selCourse").value;
  const date = UI.$("#selDate").value || UI.todayISO();
  const context = UI.$("#selContext").value;

  UI.$("#sessionMeta").textContent = "Cargando…";
  try {
    const [students, sess] = await Promise.all([
      getStudents(course_id),
      Api.getSession(course_id, date, context)
    ]);
    State.session = sess.session;
    const rec = await Api.getRecords(State.session.session_id);
    State.records = new Map((rec.records || []).map(r => [r.student_id, { status: r.status, note: r.note || "" }]));

    // Build stack
    State.stack = students.map(s => ({
      ...s,
      current: State.records.get(s.student_id) || { status: null, note: "" }
    }));
    // Put students with existing status at end (so you can “tomar lista” rápido)
    State.stack.sort((a,b) => (a.current.status ? 1 : 0) - (b.current.status ? 1 : 0));
    State.stackIndex = 0;

    UI.$("#sessionMeta").textContent =
      `Sesión: ${State.session.session_id} • Tomó: ${State.session.created_by_name || State.session.created_by}`;
    renderStack();
  } catch (e) {
    UI.$("#sessionMeta").textContent = "";
    UI.toast(e.message);
  }
}

async function closeTodaySession() {
  if (!State.session) return UI.toast("Primero cargá una sesión.");
  try {
    await Api.closeSession(State.session.session_id);
    UI.toast("Sesión cerrada.");
  } catch (e) {
    UI.toast(e.message);
  }
}

function renderStack() {
  const stackEl = UI.$("#cardStack");
  stackEl.innerHTML = "";

  const remaining = State.stack.length - State.stackIndex;
  UI.$("#progress").textContent = remaining > 0
    ? `Quedan ${remaining} • ${State.stackIndex}/${State.stack.length}`
    : "Listo ✅";

  if (remaining <= 0) return;

  // Render top 2 cards for depth
  const top = State.stack[State.stackIndex];
  const next = State.stack[State.stackIndex + 1];

  if (next) stackEl.appendChild(makeCard(next, 0.94, 8, true));
  stackEl.appendChild(makeCard(top, 1, 0, false));
}

function makeCard(student, scale=1, y=0, isBehind=false) {
  const el = document.createElement("div");
  el.className = "student-card";
  el.style.transform = `translateY(${y}px) scale(${scale})`;
  el.style.opacity = isBehind ? "0.85" : "1";

  const status = student.current.status;
  const pretty = `${student.last_name}, ${student.first_name}`;
  el.innerHTML = `
    <div>
      <div class="student-top">
        <div>
          <div class="student-name">${escapeHtml(pretty)}</div>
          <div class="small">DNI: ${escapeHtml(String(student.dni || "—"))}</div>
        </div>
        <div class="badge">${status ? statusLabel(status) : "Sin marcar"}</div>
      </div>
      <div class="kpi" style="margin-top:14px">
        <span class="chip ${status === "PRESENTE" ? "ok" : ""}">→ Presente</span>
        <span class="chip ${status === "AUSENTE" ? "danger" : ""}">← Ausente</span>
        <span class="chip ${status === "TARDE" ? "warn" : ""}">↑ Tarde</span>
        <span class="chip ${status === "VERIFICAR" ? "" : ""}">↓ Verificar</span>
      </div>
    </div>
    <div class="student-foot">
      <div class="small">Arrastrá o usá los botones</div>
      <button class="btn btn-ghost" data-edit="1">Nota</button>
    </div>
  `;

  // Note editor
  el.querySelector('[data-edit="1"]').addEventListener("click", () => openNote(student));

  // drag gesture
  let startX=0, startY=0, dx=0, dy=0, dragging=false;
  const onDown = (ev) => {
    dragging=true;
    const p = getPoint(ev);
    startX=p.x; startY=p.y;
    el.setPointerCapture?.(ev.pointerId);
  };
  const onMove = (ev) => {
    if (!dragging) return;
    const p = getPoint(ev);
    dx = p.x - startX;
    dy = p.y - startY;
    const rot = dx * 0.04;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    el.style.transition = "none";
  };
  const onUp = async () => {
    if (!dragging) return;
    dragging=false;
    el.style.transition = "transform .16s ease";
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const TH = 110;
    let chosen = null;
    if (ax > ay && ax > TH) chosen = dx > 0 ? "PRESENTE" : "AUSENTE";
    else if (ay > ax && ay > TH) chosen = dy < 0 ? "TARDE" : "VERIFICAR";
    if (chosen) {
      await commitCurrent(chosen);
    } else {
      el.style.transform = `translateY(0px) scale(1)`;
    }
    dx=dy=0;
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);

  return el;
}

function getPoint(ev) {
  if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
  return { x: ev.clientX, y: ev.clientY };
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function openNote(student) {
  const sid = student.student_id;
  const cur = (State.records.get(sid) || {}).note || "";
  const html = `
    <div class="field">
      <span>Nota / Observación</span>
      <textarea id="noteText" rows="4" placeholder="Ej: llegó con certificado…">${escapeHtml(cur)}</textarea>
    </div>
    <div style="display:flex; gap:10px; justify-content:flex-end">
      <button class="btn" id="btnSaveNote">Guardar</button>
    </div>
  `;
  UI.modal.open(`Nota — ${escapeHtml(student.last_name)}, ${escapeHtml(student.first_name)}`, html);
  UI.$("#btnSaveNote").addEventListener("click", async () => {
    const note = UI.$("#noteText").value.trim();
    // keep status unchanged
    const st = (State.records.get(sid) || {}).status || null;
    if (!State.session) return UI.toast("Cargá una sesión primero.");
    try{
      await Api.updateRecord(State.session.session_id, sid, st, note);
      State.records.set(sid, { status: st, note });
      // update local stack item
      const idx = State.stack.findIndex(x => x.student_id === sid);
      if (idx >= 0) State.stack[idx].current = { status: st, note };
      UI.toast("Nota guardada.");
      UI.modal.close();
      renderStack();
    }catch(e){
      UI.toast(e.message);
    }
  });
}

async function commitCurrent(status) {
  if (!State.session) return UI.toast("Primero cargá un curso y fecha.");
  if (State.stackIndex >= State.stack.length) return;

  const student = State.stack[State.stackIndex];
  const prev = State.records.get(student.student_id) || { status: null, note: "" };
  State.records.set(student.student_id, { status, note: prev.note || "" });

  // optimistic UI
  State.stack[State.stackIndex].current = { status, note: prev.note || "" };
  State.stackIndex += 1;
  renderStack();

  // async save (single)
  try {
    await Api.updateRecord(State.session.session_id, student.student_id, status, prev.note || "");
  } catch (e) {
    UI.toast("No se pudo guardar: " + e.message);
  }
}

async function loadEditList() {
  const course_id = UI.$("#editCourse").value;
  const date = UI.$("#editDate").value || UI.todayISO();
  const context = UI.$("#editContext").value;

  UI.$("#editList").innerHTML = "<div class='muted'>Cargando…</div>";
  try{
    const sess = await Api.getSession(course_id, date, context);
    const session_id = sess.session.session_id;
    const [students, rec] = await Promise.all([
      getStudents(course_id),
      Api.getRecords(session_id)
    ]);
    const map = new Map((rec.records || []).map(r => [r.student_id, r]));
    const rows = students.map(s => {
      const r = map.get(s.student_id);
      return {
        student: s,
        status: r ? r.status : null,
        note: r ? (r.note || "") : ""
      };
    });

    UI.$("#editList").innerHTML = "";
    rows.forEach(({student, status, note}) => {
      const el = document.createElement("div");
      el.className = "row";
      el.innerHTML = `
        <div class="left">
          <div class="title">${escapeHtml(student.last_name)}, ${escapeHtml(student.first_name)}</div>
          <div class="sub">${note ? "📝 " + escapeHtml(note) : " "}</div>
        </div>
        <div class="pills">
          <span class="tag ${statusTagClass(status)} click" data-st="${status||""}">${status ? statusLabel(status) : "Sin marcar"}</span>
        </div>
      `;
      el.addEventListener("click", () => openEditModal(session_id, student, status, note));
      UI.$("#editList").appendChild(el);
    });
  }catch(e){
    UI.$("#editList").innerHTML = `<div class='callout danger'>${escapeHtml(e.message)}</div>`;
  }
}

function openEditModal(session_id, student, status, note) {
  const html = `
    <div class="field">
      <span>Estado</span>
      <select id="editStatus">
        <option value="">Sin marcar</option>
        <option value="PRESENTE">PRESENTE</option>
        <option value="AUSENTE">AUSENTE</option>
        <option value="TARDE">TARDE</option>
        <option value="VERIFICAR">VERIFICAR</option>
      </select>
    </div>
    <div class="field">
      <span>Nota</span>
      <textarea id="editNote" rows="3" placeholder="Opcional">${escapeHtml(note||"")}</textarea>
    </div>
    <div style="display:flex; gap:10px; justify-content:flex-end">
      <button class="btn" id="btnSaveEdit">Guardar</button>
    </div>
  `;
  UI.modal.open(`Editar — ${escapeHtml(student.last_name)}, ${escapeHtml(student.first_name)}`, html);
  UI.$("#editStatus").value = status || "";
  UI.$("#btnSaveEdit").addEventListener("click", async () => {
    const st = UI.$("#editStatus").value || null;
    const nt = UI.$("#editNote").value.trim();
    try{
      await Api.updateRecord(session_id, student.student_id, st, nt);
      UI.toast("Actualizado.");
      UI.modal.close();
      loadEditList();
    }catch(e){
      UI.toast(e.message);
    }
  });
}

function quickRange(daysBack) {
  const to = new Date();
  const from = new Date(Date.now() - (daysBack-1)*24*3600*1000);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  UI.$("#statsFrom").value = iso(from);
  UI.$("#statsTo").value = iso(to);
  loadStats();
}

async function loadStats() {
  const course_id = UI.$("#statsCourse").value;
  const from = UI.$("#statsFrom").value || UI.todayISO();
  const to = UI.$("#statsTo").value || UI.todayISO();
  const context = UI.$("#statsContext").value;

  UI.$("#statsCards").innerHTML = "";
  UI.$("#statsDaily").innerHTML = "<div class='muted'>Cargando…</div>";
  try{
    const data = await Api.getStats(course_id, from, to, context);
    const s = data.summary;

    const cards = [
      { v: s.total_records, k: "Registros" },
      { v: s.presentes, k: "Presentes" },
      { v: s.ausentes, k: "Ausentes" },
      { v: s.tardes, k: "Tardes" },
      { v: s.verificar, k: "Verificar" },
      { v: s.sessions, k: "Sesiones" }
    ];

    UI.$("#statsCards").innerHTML = cards.map(c => `
      <div class="stat">
        <div class="v">${c.v}</div>
        <div class="k">${c.k}</div>
      </div>
    `).join("");

    const daily = data.daily || [];
    const max = Math.max(1, ...daily.map(d => d.ausentes));
    UI.$("#statsDaily").innerHTML = "";
    daily.forEach(d => {
      const el = document.createElement("div");
      el.className = "bar";
      const pct = Math.round((d.ausentes / max) * 100);
      el.innerHTML = `
        <div class="bar-head">
          <span>${escapeHtml(d.date)}</span>
          <span>Ausentes: <b>${d.ausentes}</b> • Pres: ${d.presentes} • Tar: ${d.tardes}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      `;
      UI.$("#statsDaily").appendChild(el);
    });
  }catch(e){
    UI.$("#statsDaily").innerHTML = `<div class='callout danger'>${escapeHtml(e.message)}</div>`;
  }
}

async function loadAlerts() {
  const course_id = UI.$("#alertsCourse").value;
  const to = UI.$("#alertsTo").value || UI.todayISO();
  const context = UI.$("#alertsContext").value;

  UI.$("#alertsList").innerHTML = "<div class='muted'>Cargando…</div>";
  try{
    const data = await Api.getAlerts(course_id, to, context);
    const rows = data.alerts || [];
    UI.$("#alertsList").innerHTML = "";
    if (!rows.length) {
      UI.$("#alertsList").innerHTML = "<div class='muted'>Sin alertas en este rango.</div>";
      return;
    }
    rows.forEach(r => {
      const el = document.createElement("div");
      el.className = "row";
      el.innerHTML = `
        <div class="left">
          <div class="title">${escapeHtml(r.student_name)}</div>
          <div class="sub">${escapeHtml(r.reason)}</div>
        </div>
        <div class="pills">
          <span class="tag absent">${r.absences_total} faltas</span>
          <span class="tag verify">${r.absences_streak} seguidas</span>
        </div>
      `;
      UI.$("#alertsList").appendChild(el);
    });
  }catch(e){
    UI.$("#alertsList").innerHTML = `<div class='callout danger'>${escapeHtml(e.message)}</div>`;
  }
}

document.addEventListener("DOMContentLoaded", bootstrap);
