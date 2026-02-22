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
    _onClose: null,
    open(title, html, opts = {}) {
      $("#modalTitle").textContent = title;
      $("#modalBody").innerHTML = html;
      modal._onClose = typeof opts.onClose === "function" ? opts.onClose : null;
      $("#modal").hidden = false;
    },
    close() {
      $("#modal").hidden = true;
      const cb = modal._onClose;
      modal._onClose = null;
      try { cb && cb(); } catch (_e) {}
    }
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


function sanitizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("549")) return d;
  if (d.startsWith("54")) return "549" + d.slice(2);
  if (d.startsWith("0")) return "549" + d.slice(1);
  return "549" + d;
}

function waUrl(phone, text) {
  const p = sanitizePhone(phone);
  if (!p) return "";
  const msg = encodeURIComponent(String(text || ""));
  return `https://wa.me/${p}?text=${msg}`;
}

async function ensureStudentPhone(student_id, currentPhone) {
  let phone = String(currentPhone || "").trim();
  if (phone) return phone;
  phone = prompt("Celular del adulto responsable (solo números o con +):", "") || "";
  phone = phone.trim();
  if (!phone) return "";
  try {
    await Api.updateStudentPhone(student_id, phone);
    return phone;
  } catch (e) {
    UI.toast(e.message);
    return "";
  }
}

function setActiveTab(view) {
  UI.$$("#tabs .tab").forEach(b => b.classList.toggle("is-active", b.dataset.view === view));
  UI.$$("#app .view").forEach(v => v.hidden = true);
  UI.$(`#view${view[0].toUpperCase()}${view.slice(1)}`).hidden = false;

  // Lazy load stats/alerts the first time
  if (view === "stats" && !UI.$('#statsDaily').dataset.loaded) {
    loadStats().then(() => { UI.$('#statsDaily').dataset.loaded = '1'; });
    loadCourseChart();
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
    opt.textContent = `${c.name} • ${c.turno}${c.owner_name ? " • Titular: " + c.owner_name : ""}${c.is_mine ? "" : " • (cobertura)"}`;
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
  const pendingStudents = State.stack
    .filter(s => (State.records.get(s.student_id) || {}).status === "VERIFICAR");

  const pending = pendingStudents.map(s => `${s.last_name}, ${s.first_name}`);
  const pendingIds = pendingStudents.map(s => String(s.student_id));

  if (!pending.length) {
    UI.toast("Lista completa ✅");
    const course_id = UI.$("#selCourse").value;
    const date = UI.$("#selDate").value || UI.todayISO();
    const context = UI.$("#selContext").value;
    showAutoAlerts(course_id, date, context);
    return;
  }

  const html = `
    <div class="callout">
      <b>Te quedan ${pending.length} para verificar</b>
      <div class="muted" style="margin-top:6px">
        Al cerrar esta ventana, te vuelvo a mostrar <b>solo</b> esos estudiantes para resolverlos.
      </div>
    </div>
    <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px">
      ${pending.map(n => `
        <div class="row">
          <div class="left"><div class="title">${escapeHtml(n)}</div></div>
          <div class="pills"><span class="tag verify">VERIFICAR</span></div>
        </div>`).join("")}
    </div>
    <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:12px">
      <button class="btn" data-close="1">Cerrar</button>
    </div>
  `;

  UI.modal.open("Pendientes de verificación", html, {
    onClose: () => {
      const map = new Set(pendingIds);
      const nextStack = State.stack.filter(s => map.has(String(s.student_id)))
        .map(s => ({ ...s, current: State.records.get(s.student_id) || { status:null, note:"" } }));
      if (!nextStack.length) return;
      State.stack = nextStack;
      State.stackIndex = 0;

      const banner = UI.$("#verifyBanner");
      if (banner) {
        banner.hidden = false;
        banner.innerHTML = `Revisando <b>${nextStack.length}</b> pendientes de verificación
          <button class="btn btn-ghost" id="btnBackFull" style="margin-left:10px">Volver al curso completo</button>`;
        const btn = UI.$("#btnBackFull");
        btn && btn.addEventListener("click", async () => {
          banner.hidden = true;
          await loadSession();
        });
      }

      renderStack();
    }
  });
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
  UI.$("#btnLoadChart").addEventListener("click", loadCourseChart);
  UI.$("#chartPeriod").addEventListener("change", () => { onChartPeriodChange(); loadCourseChart(); });
  UI.$("#chartDay").addEventListener("change", loadCourseChart);
  UI.$("#chartWeek").addEventListener("change", loadCourseChart);
  UI.$("#chartMonth").addEventListener("change", loadCourseChart);
  UI.$("#chartMetric").addEventListener("change", loadCourseChart);

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

  // init fechas por defecto
  UI.$("#selDate").value = UI.todayISO();
  UI.$("#editDate").value = UI.todayISO();
  UI.$("#statsFrom").value = UI.todayISO();
  UI.$("#statsTo").value = UI.todayISO();
  UI.$("#alertsTo").value = UI.todayISO();
  initChartSelectors();

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
    // resumen del curso debajo (acumulado)
    loadTakeSummary(course_id, date, context);
  } catch (e) {
    UI.$("#sessionMeta").textContent = "";
    UI.toast(e.message);
  }
}



function shiftISODateLocal(iso, deltaDays) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + deltaDays);
  return toISODate(d);
}

async function loadTakeSummary(course_id, date, context) {
  const metaEl = UI.$("#takeSummaryMeta");
  const listEl = UI.$("#takeSummaryList");
  if (!metaEl || !listEl) return;

  // histórico hasta ayer (para sumar la sesión actual en vivo)
  const yesterday = shiftISODateLocal(date, -1);
  State.takeHistTo = yesterday;

  listEl.innerHTML = "<div class='muted'>Cargando resumen…</div>";
  try {
    const data = await Api.getStudentStats(course_id, "2000-01-01", yesterday, context);
    const hist = data.students || [];
    const map = {};
    hist.forEach(s => { map[s.student_id] = s; });
    State.takeHistMap = map;

    metaEl.textContent = `Corte: hasta ${fmtDMY(yesterday)} + sesión actual`;
    renderTakeSummary();
  } catch (e) {
    listEl.innerHTML = `<div class='callout danger'>${escapeHtml(e.message)}</div>`;
  }
}

function renderTakeSummary() {
  const listEl = UI.$("#takeSummaryList");
  if (!listEl || !State.session) return;

  const course_id = UI.$("#selCourse").value;
  const students = State.stack || [];
  const context = UI.$("#selContext").value;
  const date = UI.$("#selDate").value || UI.todayISO();

  const rows = students.map(st => {
    const h = State.takeHistMap[st.student_id] || { presentes:0, ausentes:0, tardes:0, verificar:0, total:0 };
    const cur = State.records.get(st.student_id) || { status: null };
    const hasCur = !!cur.status;
    const total = (h.total || 0) + (hasCur ? 1 : 0);

    let presentes = (h.presentes || 0);
    let ausentes = (h.ausentes || 0);
    let tardes = (h.tardes || 0);
    let verificar = (h.verificar || 0);

    if (hasCur) {
      if (cur.status === "PRESENTE") presentes++;
      else if (cur.status === "AUSENTE") ausentes++;
      else if (cur.status === "TARDE") tardes++;
      else if (cur.status === "VERIFICAR") verificar++;
    }

    const asist = presentes + tardes; // tarde cuenta como asistencia
    const pct = total ? Math.round((asist / total) * 1000) / 10 : 0;

    return {
      student_id: st.student_id,
      name: `${st.last_name}, ${st.first_name}`,
      asist, total, pct,
      ausentes, tardes, verificar
    };
  });

  // orden por % asistencia asc (para ver rápido los que están peor), luego por nombre
  rows.sort((a,b) => (a.pct - b.pct) || a.name.localeCompare(b.name));

  listEl.innerHTML = "";
  rows.forEach((r,i) => {
    const el = document.createElement("div");
    const low = r.total > 0 && r.pct < 75;
    el.className = "take-summary-row" + (low ? " low" : "");
    el.innerHTML = `
      <div class="left">
        <div class="title">${escapeHtml(r.name)}</div>
        <div class="sub muted">Asist: <b>${r.asist}/${r.total}</b> • <b>${r.pct}%</b> • Aus: ${r.ausentes} • Tar: ${r.tardes}</div>
      </div>
      <div class="pills">
        <span class="tag ${low ? "absent" : "present"}">${r.pct}%</span>
      </div>
    `;
    listEl.appendChild(el);
  });
}




async function showAutoAlerts(course_id, to, context) {
  // evita repetir
  const key = `${course_id}|${to}|${context}`;
  if (State.autoAlertKey === key) return;
  State.autoAlertKey = key;

  try {
    const data = await Api.getAlerts(course_id, to, context);
    const rows = data.alerts || [];
    if (!rows.length) return;

    const wrapId = "autoAlertsWrap";
    const html = `
      <div id="${wrapId}">
        <div class="callout" style="margin-bottom:10px">
          <b>Alertas para avisar (${rows.length})</b>
          <div class="muted" style="margin-top:4px">Tocá <b>AVISADO</b> para resolver cada una.</div>
        </div>
        <div id="autoAlertsList" class="list"></div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:12px">
          <button class="btn" id="btnCloseAutoAlerts">Cerrar</button>
        </div>
      </div>
    `;
    UI.modal.open("Alertas", html);

    const listEl = UI.$("#autoAlertsList");
    listEl.innerHTML = "";
    rows.forEach((r,i) => {
      const el = document.createElement("div");
      el.className = "row " + (i % 2 ? "alt-a" : "alt-b");
      el.innerHTML = `
        <div class="left">
          <div class="title">${escapeHtml(r.student_name)}</div>
          <div class="sub">${escapeHtml(r.reason || "")}</div>
          <div class="sub muted">${r.guardian_phone ? ("📱 " + escapeHtml(String(r.guardian_phone))) : "📱 Sin celular cargado"}</div>
        </div>
        <div class="pills" style="display:flex; gap:8px; align-items:center">
          <button class="btn btn-ghost" data-wa="1">WhatsApp</button>
          <button class="btn btn-ghost" data-ack="1">AVISADO</button>
        </div>
      `;
      el.querySelector('[data-wa="1"]').addEventListener("click", async () => {
        const course = State.courses.find(c => c.course_id === (r.course_id || course_id));
        const courseName = course ? `${course.name}${course.turno ? " ("+course.turno+")" : ""}` : "el curso";
        const msg = `Hola, soy ${State.me?.full_name || "preceptor/a"}. Te escribo por ${r.student_name} de ${courseName}. ` +
          `Registramos ${r.absences_total} inasistencias${r.absences_streak >= 3 ? `, incluyendo ${r.absences_streak} días consecutivos` : ""}. ` +
          `¿Podemos coordinar para acompañar la asistencia? Gracias.`;
        const phone = await ensureStudentPhone(r.student_id, r.guardian_phone);
        if (!phone) return;
        const url = waUrl(phone, msg);
        if (!url) return;
        window.open(url, "_blank");
      });

      el.querySelector('[data-ack="1"]').addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          await Api.ackAlert(r.student_id, r.course_id || course_id, to, context);
          el.remove();
          const remaining = listEl.querySelectorAll(".row").length;
          if (!remaining) UI.$("#autoAlertsList").innerHTML = "<div class='muted'>Listo ✅</div>";
        } catch (e) {
          btn.disabled = false;
          UI.toast(e.message);
        }
      });
      listEl.appendChild(el);
    });

    UI.$("#btnCloseAutoAlerts").addEventListener("click", () => UI.modal.close());
  } catch (_e) {
    // no bloquear
  }
}

async function closeTodaySession() {
  if (!State.session) return UI.toast("Primero cargá una sesión.");
  try {
    await Api.closeSession(State.session.session_id);
    UI.toast("Sesión cerrada.");
    // mostrar alertas automáticamente
    const course_id = UI.$("#selCourse").value;
    const date = UI.$("#selDate").value || UI.todayISO();
    const context = UI.$("#selContext").value;
    showAutoAlerts(course_id, date, context);
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
  // alternancia visual
  const h = Array.from(String(student.student_id||"")).reduce((a,c)=>a + c.charCodeAt(0),0);
  el.classList.add((h % 2) ? "tone-a" : "tone-b");
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
  renderTakeSummary();

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
    rows.forEach(({ student, status, note }, i) => {
      const el = document.createElement("div");
      el.className = "row " + (i % 2 ? "alt-a" : "alt-b");
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


function fmtDMY(iso) {
  const [y,m,d] = iso.split("-").map(x=>parseInt(x,10));
  const pad = (n)=>String(n).padStart(2,"0");
  return `${pad(d)}/${pad(m)}/${y}`;
}

function weekStartMonday(d) {
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  return m;
}

function toISODate(d) {
  const pad = (n)=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function initChartSelectors() {
  const day = UI.$("#chartDay");
  if (day) day.value = UI.todayISO();

  // Weeks (last 16)
  const selW = UI.$("#chartWeek");
  if (selW) {
    selW.innerHTML = "";
    const now = new Date();
    let curMon = weekStartMonday(now);
    for (let i=0;i<16;i++){
      const mon = new Date(curMon);
      mon.setDate(curMon.getDate() - i*7);
      const fri = new Date(mon); fri.setDate(mon.getDate()+4);
      const v = `${toISODate(mon)}|${toISODate(fri)}`;
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = `Lun ${fmtDMY(toISODate(mon))} – Vie ${fmtDMY(toISODate(fri))}`;
      selW.appendChild(opt);
    }
  }

  // Months (last 12)
  const selM = UI.$("#chartMonth");
  if (selM) {
    selM.innerHTML = "";
    const now = new Date();
    const months = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
    for (let i=0;i<12;i++){
      const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
      const y=d.getFullYear(); const m=d.getMonth();
      const first=new Date(y,m,1);
      const last=new Date(y,m+1,0);
      const v = `${toISODate(first)}|${toISODate(last)}`;
      const opt=document.createElement("option");
      opt.value=v;
      opt.textContent=`${months[m]} ${y}`;
      selM.appendChild(opt);
    }
  }

  onChartPeriodChange();
}

function onChartPeriodChange() {
  const period = UI.$("#chartPeriod")?.value || "dia";
  const wDay = UI.$("#chartDayWrap");
  const wWeek = UI.$("#chartWeekWrap");
  const wMonth = UI.$("#chartMonthWrap");
  if (wDay) wDay.hidden = period !== "dia";
  if (wWeek) wWeek.hidden = period !== "semana";
  if (wMonth) wMonth.hidden = period !== "mes";
}

function getChartRange() {
  const period = UI.$("#chartPeriod")?.value || "dia";
  if (period === "general") {
    return { from: "2000-01-01", to: UI.todayISO() };
  }
  if (period === "dia") {
    const d = UI.$("#chartDay")?.value || UI.todayISO();
    return { from: d, to: d };
  }
  if (period === "semana") {
    const v = UI.$("#chartWeek")?.value || "";
    const [from,to] = v.split("|");
    return { from, to };
  }
  if (period === "mes") {
    const v = UI.$("#chartMonth")?.value || "";
    const [from,to] = v.split("|");
    return { from, to };
  }
  const d = UI.todayISO();
  return { from: d, to: d };
}

function calcPct(ausentes, total) {
  if (!total) return 0;
  return Math.round((ausentes / total) * 1000) / 10;
}

async function loadCourseChart() {
  const chartEl = UI.$("#courseChart");
  if (!chartEl) return;

  const { from, to } = getChartRange();
  const context = UI.$("#statsContext")?.value || "ALL";
  chartEl.innerHTML = "<div class='muted'>Cargando…</div>";

  try {
    const data = await Api.getCourseSummary(from, to, context);
    const courses = data.courses || [];

    const metric = UI.$("#chartMetric")?.value || "attendance_pct";
    // ordenar según métrica
    courses.sort((a,b) => {
      if (metric === "absences_count") return (b.ausentes - a.ausentes) || String(a.name).localeCompare(String(b.name));
      const aPct = calcPct(a.ausentes, a.total);
      const bPct = calcPct(b.ausentes, b.total);
      const aAtt = Math.round((100 - aPct) * 10) / 10;
      const bAtt = Math.round((100 - bPct) * 10) / 10;
      return (bAtt - aAtt) || String(a.name).localeCompare(String(b.name));
    });

    chartEl.innerHTML = "";
    if (!courses.length) {
      chartEl.innerHTML = "<div class='muted'>Sin datos para graficar.</div>";
      return;
    }

    const maxAbs = metric === "absences_count"
      ? Math.max(...courses.map(c => Number(c.ausentes || 0)), 0)
      : 0;

    courses.forEach(c => {
      const total = Number(c.total || 0);
      const aus = Number(c.ausentes || 0);

      let fillPct = 0;
      let val = "";
      if (metric === "absences_count") {
        fillPct = maxAbs ? Math.round((aus / maxAbs) * 100) : 0;
        val = String(aus);
      } else {
        const absPct = calcPct(aus, total);
        const attPct = total ? (100 - absPct) : 0;
        fillPct = Math.round(attPct * 10) / 10;
        val = `${fillPct}%`;
      }

      const el = document.createElement("div");
      el.className = "course-bar";
      el.innerHTML = `
        <div class="val">${escapeHtml(val)}</div>
        <div class="bar"><div class="fill" style="--pct:${fillPct}"></div></div>
        <div class="lbl">${escapeHtml(c.name)}<span class="muted">${escapeHtml(c.turno || "")}</span></div>
      `;
      chartEl.appendChild(el);
    });
  } catch (e) {
    chartEl.innerHTML = `<div class='callout danger'>${escapeHtml(e.message)}</div>`;
  }
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

  const listEl = UI.$("#alertsList");
  listEl.innerHTML = "<div class='muted'>Cargando…</div>";

  try {
    const data = await Api.getAlerts(course_id, to, context);
    const rows = data.alerts || [];
    listEl.innerHTML = "";

    if (!rows.length) {
      listEl.innerHTML = "<div class='muted'>Sin alertas.</div>";
      return;
    }

    rows.forEach(r => {
      const el = document.createElement("div");
      el.className = "row";
      el.innerHTML = `
        <div class="left">
          <div class="title">${escapeHtml(r.student_name)}</div>
          <div class="sub">${escapeHtml(r.reason || "")}</div>
          <div class="sub muted">${r.guardian_phone ? ("📱 " + escapeHtml(String(r.guardian_phone))) : "📱 Sin celular cargado"}</div>
        </div>
        <div class="pills" style="display:flex; gap:8px; align-items:center">
          <button class="btn btn-ghost" data-wa="1">WhatsApp</button>
          <button class="btn btn-ghost" data-ack="1">AVISADO</button>
        </div>
      `;
      el.querySelector('[data-wa="1"]').addEventListener("click", async () => {
        const course = State.courses.find(c => c.course_id === (r.course_id || course_id));
        const courseName = course ? `${course.name}${course.turno ? " ("+course.turno+")" : ""}` : "el curso";
        const msg = `Hola, soy ${State.me?.full_name || "preceptor/a"}. Te escribo por ${r.student_name} de ${courseName}. ` +
          `Registramos ${r.absences_total} inasistencias${r.absences_streak >= 3 ? `, incluyendo ${r.absences_streak} días consecutivos` : ""}. ` +
          `¿Podemos coordinar para acompañar la asistencia? Gracias.`;
        const phone = await ensureStudentPhone(r.student_id, r.guardian_phone);
        if (!phone) return;
        const url = waUrl(phone, msg);
        if (!url) return;
        window.open(url, "_blank");
      });

      el.querySelector('[data-ack="1"]').addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          await Api.ackAlert(r.student_id, r.course_id || course_id, to, context);
          el.remove();
          if (!listEl.querySelector(".row")) listEl.innerHTML = "<div class='muted'>Sin alertas.</div>";
        } catch (e) {
          btn.disabled = false;
          UI.toast(e.message);
        }
      });
      listEl.appendChild(el);
    });
  } catch (e) {
    listEl.innerHTML = `<div class='callout danger'>${escapeHtml(e.message)}</div>`;
  }
}


document.addEventListener("DOMContentLoaded", bootstrap);
