/* global Api */
const UI = (() => {
  const $ = (q, el = document) => el.querySelector(q);
  const $$ = (q, el = document) => Array.from(el.querySelectorAll(q));

  const todayISO = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

  return { $, $$, todayISO, toast, modal };
})();

const State = {
  me: null,
  courses: [],
  studentsByCourse: new Map(),
  session: null,
  records: new Map(), // student_id -> {status, note}
  stack: [],
  stackIndex: 0,
  // stats view memory
  lastStats: { course_id: "ALL", from: null, to: null, context: "ALL" },
  lastStudentStats: []
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function setActiveTab(view) {
  UI.$$("#tabs .tab").forEach(b => b.classList.toggle("is-active", b.dataset.view === view));
  UI.$$("#app .view").forEach(v => v.hidden = true);
  UI.$(`#view${view[0].toUpperCase()}${view.slice(1)}`).hidden = false;

  // Lazy load stats/alerts the first time
  if (view === "stats" && !UI.$('#statsDaily').dataset.loaded) {
    loadStats().then(() => { UI.$('#statsDaily').dataset.loaded = '1'; });
  }
  if (view === "alertas" && !UI.$('#alertsList').dataset.loaded) {
    loadAlerts().then(() => { UI.$('#alertsList').dataset.loaded = '1'; });
  }
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

function showVerifyRemainder() {
  const pending = State.stack
    .filter(s => (State.records.get(s.student_id) || {}).status === "VERIFICAR")
    .map(s => `${s.last_name}, ${s.first_name}`);

  if (!pending.length) {
    UI.toast("Lista completa ✅");
    return;
  }

  const html = `
    <div class="callout">
      <b>Te quedan ${pending.length} para verificar</b>
      <div class="muted" style="margin-top:6px">Tip: andá a <b>Editar</b> y filtrá por la misma fecha para resolverlos.</div>
    </div>
    <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px">
      ${pending.map(n => `
        <div class="row">
          <div class="left"><div class="title">${escapeHtml(n)}</div></div>
          <div class="pills"><span class="tag verify">VERIFICAR</span></div>
        </div>`).join("")}
    </div>
  `;
  UI.modal.open("Pendientes de verificación", html);
}

async function bootstrap() {
  UI.$("#selDate").value = UI.todayISO();
  UI.$("#editDate").value = UI.todayISO();

  // Default stats: last 7 days
  {
    const to = new Date();
    const from = new Date(Date.now() - 6 * 24 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    UI.$("#statsFrom").value = iso(from);
    UI.$("#statsTo").value = iso(to);
  }
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") UI.modal.close();
  });

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.close) UI.modal.close();
  });

  bindTabs();

  // auto-login if token exists
  const token = localStorage.getItem("asistencia_token");
  if (token) {
    try {
      await afterLogin();
      return;
    } catch (_e) {
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
  State.courses = c.courses || [];

  uniqCoursesForSelect(UI.$("#selCourse"));
  uniqCoursesForSelect(UI.$("#editCourse"));
  uniqCoursesForSelect(UI.$("#statsCourse"), true);
  uniqCoursesForSelect(UI.$("#alertsCourse"), true);

  UI.$("#btnLogout").hidden = false;
  UI.$("#tabs").hidden = false;
  UI.$("#viewLogin").hidden = true;
  UI.$("#viewTomar").hidden = false;
  setActiveTab("tomar");

  UI.toast(`Hola, ${String(State.me.full_name).split(" ")[0]} 👋`);
}

async function logout() {
  localStorage.removeItem("asistencia_token");
  location.reload();
}

async function getStudents(course_id) {
  if (State.studentsByCourse.has(course_id)) return State.studentsByCourse.get(course_id);
  const data = await Api.getStudents(course_id);
  State.studentsByCourse.set(course_id, data.students || []);
  return data.students || [];
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

    // Put students with existing status at end
    State.stack.sort((a, b) => (a.current.status ? 1 : 0) - (b.current.status ? 1 : 0));
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
    : (() => {
      const pending = State.stack.filter(s => (State.records.get(s.student_id) || {}).status === "VERIFICAR").length;
      return pending ? `Listo ✅ • ${pending} para verificar` : "Listo ✅";
    })();

  if (remaining <= 0) { showVerifyRemainder(); return; }

  const top = State.stack[State.stackIndex];
  const next = State.stack[State.stackIndex + 1];

  if (next) stackEl.appendChild(makeCard(next, 0.94, 8));
  stackEl.appendChild(makeCard(top, 1, 0));
}

function makeCard(student, scale = 1, y = 0) {
  const el = document.createElement("div");
  el.className = "student-card";
  el.style.transform = `translateY(${y}px) scale(${scale})`;
  el.style.opacity = "1";

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
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

  const getPoint = (ev) => {
    if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    return { x: ev.clientX, y: ev.clientY };
  };

  const onDown = (ev) => {
    dragging = true;
    const p = getPoint(ev);
    startX = p.x; startY = p.y;
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
    dragging = false;
    el.style.transition = "transform .16s ease";
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const TH = 110;
    let chosen = null;
    if (ax > ay && ax > TH) chosen = dx > 0 ? "PRESENTE" : "AUSENTE";
    else if (ay > ax && ay > TH) chosen = dy < 0 ? "TARDE" : "VERIFICAR";

    if (chosen) await commitCurrent(chosen);
    else el.style.transform = `translateY(0px) scale(1)`;

    dx = dy = 0;
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);

  return el;
}

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
    const st = (State.records.get(sid) || {}).status || null;
    if (!State.session) return UI.toast("Cargá una sesión primero.");
    try {
      await Api.updateRecord(State.session.session_id, sid, st, note);
      State.records.set(sid, { status: st, note });
      const idx = State.stack.findIndex(x => x.student_id === sid);
      if (idx >= 0) State.stack[idx].current = { status: st, note };
      UI.toast("Nota guardada.");
      UI.modal.close();
      renderStack();
    } catch (e) {
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
  try {
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
    rows.forEach(({ student, status, note }) => {
      const el = document.createElement("div");
      el.className = "row";
      el.innerHTML = `
        <div class="left">
          <div class="title">${escapeHtml(student.last_name)}, ${escapeHtml(student.first_name)}</div>
          <div class="sub">${note ? "📝 " + escapeHtml(note) : " "}</div>
        </div>
        <div class="pills">
          <span class="tag ${statusTagClass(status)} click">${status ? statusLabel(status) : "Sin marcar"}</span>
        </div>
      `;
      el.addEventListener("click", () => openEditModal(session_id, student, status, note));
      UI.$("#editList").appendChild(el);
    });
  } catch (e) {
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
      <textarea id="editNote" rows="3" placeholder="Opcional">${escapeHtml(note || "")}</textarea>
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
    try {
      await Api.updateRecord(session_id, student.student_id, st, nt);
      UI.toast("Actualizado.");
      UI.modal.close();
      loadEditList();
    } catch (e) {
      UI.toast(e.message);
    }
  });
}

function quickRange(daysBack) {
  const to = new Date();
  const from = new Date(Date.now() - (daysBack - 1) * 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  UI.$("#statsFrom").value = iso(from);
  UI.$("#statsTo").value = iso(to);
  loadStats();
}

function calcPctAbs(ausentes, total) {
  if (!total) return 0;
  return Math.round((ausentes / total) * 1000) / 10; // 1 decimal
}

function sortStudents(list, key) {
  const byName = (a, b) => a.student_name.localeCompare(b.student_name);
  if (key === "nombre") return [...list].sort(byName);
  if (key === "presentes") return [...list].sort((a, b) => (b.presentes - a.presentes) || byName(a, b));
  if (key === "tardes") return [...list].sort((a, b) => (b.tardes - a.tardes) || byName(a, b));
  if (key === "verificar") return [...list].sort((a, b) => (b.verificar - a.verificar) || byName(a, b));
  if (key === "pct") return [...list].sort((a, b) => (calcPctAbs(b.ausentes, b.total) - calcPctAbs(a.ausentes, a.total)) || (b.ausentes - a.ausentes) || byName(a, b));
  return [...list].sort((a, b) => (b.ausentes - a.ausentes) || (b.tardes - a.tardes) || byName(a, b));
}

function renderStudentStats(list) {
  const wrap = UI.$("#studentsStats");
  if (!wrap) return;

  const q = (UI.$("#studentsSearch")?.value || "").trim().toLowerCase();
  const sortKey = UI.$("#studentsSort")?.value || "ausentes";

  let filtered = list;
  if (q) filtered = list.filter(s => s.student_name.toLowerCase().includes(q));

  filtered = sortStudents(filtered, sortKey);

  if (!filtered.length) {
    wrap.innerHTML = "<div class='muted'>Sin resultados.</div>";
    return;
  }

  wrap.innerHTML = "";
  filtered.forEach(s => {
    const pct = calcPctAbs(s.ausentes, s.total);
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="left">
        <div class="title">${escapeHtml(s.student_name)}</div>
        <div class="sub">
          Total: ${s.total} • Pres: ${s.presentes} • Aus: ${s.ausentes} • Tar: ${s.tardes} • Ver: ${s.verificar}
          • <b>Inasist: ${pct}%</b>
        </div>
      </div>
      <div class="counts">
        <span class="tag absent">${pct}%</span>
        <span class="tag present">P ${s.presentes}</span>
        <span class="tag absent">A ${s.ausentes}</span>
        <span class="tag late">T ${s.tardes}</span>
        <span class="tag verify">V ${s.verificar}</span>
      </div>
    `;
    wrap.appendChild(el);
  });
}

function bindStudentStatsFiltersOnce() {
  const sInp = UI.$('#studentsSearch');
  const sSel = UI.$('#studentsSort');
  if (sInp && !sInp.dataset.bound) {
    sInp.dataset.bound = '1';
    sInp.addEventListener('input', () => renderStudentStats(State.lastStudentStats));
  }
  if (sSel && !sSel.dataset.bound) {
    sSel.dataset.bound = '1';
    sSel.addEventListener('change', () => renderStudentStats(State.lastStudentStats));
  }
}

async function loadStats() {
  let course_id = UI.$("#statsCourse").value || "ALL";
  let from = UI.$("#statsFrom").value || UI.todayISO();
  let to = UI.$("#statsTo").value || UI.todayISO();
  const context = UI.$("#statsContext").value;

  if (from > to) { const tmp = from; from = to; to = tmp; UI.$('#statsFrom').value = from; UI.$('#statsTo').value = to; }

  State.lastStats = { course_id, from, to, context };

  UI.$("#statsCards").innerHTML = "";
  UI.$("#statsDaily").innerHTML = "<div class='muted'>Cargando…</div>";

  try {
    const data = await Api.getStats(course_id, from, to, context);
    const s = data.summary;

    const pctGlobal = calcPctAbs(s.ausentes, s.total_records);

    const cards = [
      { v: s.total_records, k: "Registros" },
      { v: s.presentes, k: "Presentes" },
      { v: s.ausentes, k: "Ausentes" },
      { v: `${pctGlobal}%`, k: "Inasistencia" },
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
      const pctDay = calcPctAbs(d.ausentes, (d.presentes + d.ausentes + d.tardes + d.verificar));
      el.innerHTML = `
        <div class="bar-head">
          <span>${escapeHtml(d.date)}</span>
          <span>Ausentes: <b>${d.ausentes}</b> • Pres: ${d.presentes} • Tar: ${d.tardes} • Inasist: <b>${pctDay}%</b></span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      `;
      UI.$("#statsDaily").appendChild(el);
    });

    const stData = await Api.getStudentStats(course_id, from, to, context);
    State.lastStudentStats = stData.students || [];
    bindStudentStatsFiltersOnce();
    renderStudentStats(State.lastStudentStats);
  } catch (e) {
    UI.$("#statsDaily").innerHTML = `<div class='callout danger'>${escapeHtml(e.message)}</div>`;
  }
}

async function loadAlerts() {
  const course_id = UI.$("#alertsCourse").value;
  const to = UI.$("#alertsTo").value || UI.todayISO();
  const context = UI.$("#alertsContext").value;

  UI.$("#alertsList").innerHTML = "<div class='muted'>Cargando…</div>";
  try {
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
  } catch (e) {
    UI.$("#alertsList").innerHTML = `<div class='callout danger'>${escapeHtml(e.message)}</div>`;
  }
}

document.addEventListener("DOMContentLoaded", bootstrap);
