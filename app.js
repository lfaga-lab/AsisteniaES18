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
const JUST_MARK = "__J1__"; // marcador interno para "falta justificada" dentro de note

function noteIsJustified(note) {
  return String(note || "").startsWith(JUST_MARK);
}
function stripJustMarker(note) {
  const s = String(note || "");
  return s.startsWith(JUST_MARK) ? s.slice(JUST_MARK.length).trimStart() : s;
}

function ctxLabel(ctx) {
  const c = String(ctx || "REGULAR").toUpperCase();
  if (c === "ED_FISICA") return "Ed. Física";
  if (c === "REGULAR") return "Regular";
  return c;
}

// equivalencias: REGULAR=1, ED_FISICA=0.5, TARDE=0.25
function sessionWeight(ctx) {
  const c = String(ctx || "REGULAR").toUpperCase();
  return c === "ED_FISICA" ? 0.5 : 1;
}
function faltaEquiv(status, ctx) {
  const st = String(status || "").toUpperCase();
  if (st === "AUSENTE") return sessionWeight(ctx);
  if (st === "TARDE") return 0.25;
  return 0;
}

// Calcula totales aplicando regla: si AUSENTE en REGULAR y ED_FISICA el mismo día -> cuenta 1 sola falta (no 1.5)
function computeTally(records) {
  const tally = computeTally(recs);

  if (!st) return;
    const ctx = String(r.context || "REGULAR");
    const w = Number(r.session_weight ?? sessionWeight(ctx));
    const fe = Number(r.falta_equiv ?? faltaEquiv(st, ctx));

    tally.total++;
    tally.total_equiv += w;
    tally.faltas_equiv += fe;

    if (st === "PRESENTE") tally.presentes++;
    else if (st === "AUSENTE") {
      tally.ausentes++;
      tally.ausentes_equiv += w;
      if (noteIsJustified(r.note || "")) { tally.justificadas++; tally.justificadas_equiv += w; }
    } else if (st === "TARDE") { tally.tardes++; tally.tardes_equiv += 0.25; }
    else if (st === "VERIFICAR") tally.verificar++;
  });

  const rowsHtml = recs.length ? `
    <table style="width:100%; border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left; padding:8px 6px; border-bottom:1px solid var(--line)">Fecha</th>
          <th style="text-align:left; padding:8px 6px; border-bottom:1px solid var(--line)">Tipo</th>
          <th style="text-align:left; padding:8px 6px; border-bottom:1px solid var(--line)">Estado</th>
          <th style="text-align:left; padding:8px 6px; border-bottom:1px solid var(--line)">Nota</th>
        </tr>
      </thead>
      <tbody>
        ${recs.map(r => {
          const st = String(r.status || "—");
          const just = (st === "AUSENTE" && noteIsJustified(r.note || ""));
          const stTxt = st + (just ? " • JUST." : "");
          const nt = stripJustMarker(r.note || "");
          return `
            <tr>
              <td style="padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.06)">${escapeHtml(r.date || "")}</td>
              <td style="padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.06)">${escapeHtml(ctxLabel(r.context || ""))}</td>
              <td style="padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.06)"><b>${escapeHtml(stTxt)}</b></td>
              <td style="padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.06)">${nt ? escapeHtml(nt) : "<span class='muted'>—</span>"}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>
  ` : "<div class='muted'>Sin registros en el período.</div>";

  const summary = `
    <div class="muted" style="margin-bottom:10px">
      Período: <b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b> • Tipo: <b>${escapeHtml(context)}</b>
    </div>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px">
      <span class="tag present">P ${tally.presentes}</span>
      <span class="tag absent">A ${tally.ausentes}</span>
      <span class="tag">J ${tally.justificadas}</span>
      <span class="tag late">T ${tally.tardes}</span>
      <span class="tag">Faltas eq ${fmt1(tally.faltas_equiv)}</span>
      <span class="tag">Just. eq ${fmt1(tally.justificadas_equiv)}</span>
      <span class="tag verify">V ${tally.verificar}</span>
      <span class="tag">Reg ${tally.total}</span>
    </div>
  `;

  UI.modal.open(title, summary + rowsHtml);
}

/* ===== Reportes (PDF) ===== */

async function initReportsView() {
  const today = UI.todayISO();
  UI.$("#repFrom").value = today;
  UI.$("#repTo").value = today;
  UI.$("#repTitle").value = "Reporte de asistencia";
  UI.$("#repSubtitle").value = "";
  UI.$("#repFootnote").value = "Emitido por Preceptoría";

  const bindOnce = (id, ev, fn) => {
    const el = UI.$(id);
    if (!el || el.dataset.bound) return;
    el.dataset.bound = "1";
    el.addEventListener(ev, fn);
  };

  bindOnce("#repType", "change", onReportTypeChange);
  bindOnce("#repCourse", "change", onReportCourseChange);
  bindOnce("#btnBuildReport", "click", buildReportPreview);
  bindOnce("#btnPrintReport", "click", printReport);

  onReportTypeChange();
  await onReportCourseChange();
}

function onReportTypeChange() {
  const type = UI.$("#repType").value;
  UI.$("#repStudentWrap").hidden = (type !== "student");
}

async function onReportCourseChange() {
  const course_id = UI.$("#repCourse").value;
  if (!course_id) return;
  const students = await getStudents(course_id);
  const sel = UI.$("#repStudent");
  sel.innerHTML = "";
  students.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.student_id;
    opt.textContent = `${s.last_name}, ${s.first_name}`;
    sel.appendChild(opt);
  });
}

function getCourseName(course_id) {
  const c = State.courses.find(x => String(x.course_id) === String(course_id));
  return c ? `${c.name}${c.turno ? " • " + c.turno : ""}` : String(course_id);
}

async function buildReportPreview(ev) {
  ev && ev.preventDefault && ev.preventDefault();
  const type = UI.$("#repType").value;
  const course_id = UI.$("#repCourse").value;
  let from = UI.$("#repFrom").value || UI.todayISO();
  let to = UI.$("#repTo").value || UI.todayISO();
  const context = UI.$("#repContext").value || "ALL";
  if (from > to) { const tmp = from; from = to; to = tmp; UI.$("#repFrom").value = from; UI.$("#repTo").value = to; }

  const title = (UI.$("#repTitle").value || "Reporte").trim();
  const subtitle = (UI.$("#repSubtitle").value || "").trim();
  const includeDetail = !!UI.$("#repIncludeDetail").checked;
  const includeNotes = !!UI.$("#repIncludeNotes").checked;
  const includeSig = !!UI.$("#repIncludeSignature").checked;
  const foot = (UI.$("#repFootnote").value || "").trim();

  const wrap = UI.$("#reportPreview");
  wrap.innerHTML = "<div class='muted'>Generando…</div>";

  if (!course_id) { wrap.innerHTML = "<div class='callout danger'>Elegí un curso.</div>"; return; }

  if (type === "student") {
    const student_id = UI.$("#repStudent").value;
    if (!student_id) { wrap.innerHTML = "<div class='callout danger'>Elegí un estudiante.</div>"; return; }

    const students = await getStudents(course_id);
    const st = students.find(x => String(x.student_id) === String(student_id));
    const studentName = st ? `${st.last_name}, ${st.first_name}` : "Estudiante";

    const data = await Api.getStudentTimeline(course_id, student_id, from, to, context);
    wrap.innerHTML = renderStudentReport({
      title, subtitle,
      course: getCourseName(course_id),
      student: studentName,
      from, to, context,
      includeDetail, includeNotes, includeSig, foot,
      records: data.records || []
    });
  } else {
    const [stats, stStats] = await Promise.all([
      Api.getStats(course_id, from, to, context),
      Api.getStudentStats(course_id, from, to, context)
    ]);
    wrap.innerHTML = renderCourseReport({
      title, subtitle,
      course: getCourseName(course_id),
      from, to, context,
      includeDetail, includeSig, foot,
      summary: stats.summary,
      daily: stats.daily || [],
      students: stStats.students || []
    });
  }
}

function printReport(ev) {
  ev && ev.preventDefault && ev.preventDefault();
  const wrap = UI.$("#reportPreview");
  if (!wrap || !wrap.innerText.trim() || wrap.innerText.includes("Generá una vista previa")) {
    buildReportPreview();
    setTimeout(() => window.print(), 350);
    return;
  }
  window.print();
}

function renderStudentReport(opts) {
  const { title, subtitle, course, student, from, to, context, includeDetail, includeNotes, includeSig, foot, records } = opts;

  const tally = computeTally(records);

  if (!st) return;
    const ctx = String(r.context || "REGULAR");
    const w = Number(r.session_weight ?? sessionWeight(ctx));
    const fe = Number(r.falta_equiv ?? faltaEquiv(st, ctx));

    tally.total++;
    tally.total_equiv += w;
    tally.faltas_equiv += fe;

    if (st === "PRESENTE") tally.presentes++;
    else if (st === "AUSENTE") {
      tally.ausentes++;
      tally.ausentes_equiv += w;
      if (noteIsJustified(r.note || "")) { tally.justificadas++; tally.justificadas_equiv += w; }
    } else if (st === "TARDE") { tally.tardes++; tally.tardes_equiv += 0.25; }
    else if (st === "VERIFICAR") tally.verificar++;
  });

  const header = `
    <div class="r-head">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="sub">${subtitle ? escapeHtml(subtitle) + " • " : ""}<b>${escapeHtml(course)}</b></div>
        <div class="sub">Estudiante: <b>${escapeHtml(student)}</b></div>
        <div class="sub">Período: <b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b> • Tipo: <b>${escapeHtml(context)}</b></div>
      </div>
      <div class="sub">Emitido: <b>${escapeHtml(UI.todayISO())}</b></div>
    </div>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px">
      <span class="tag present">P ${tally.presentes}</span>
      <span class="tag absent">A ${tally.ausentes}</span>
      <span class="tag">J ${tally.justificadas}</span>
      <span class="tag late">T ${tally.tardes}</span>
      <span class="tag">Faltas eq ${fmt1(tally.faltas_equiv)}</span>
      <span class="tag">Just. eq ${fmt1(tally.justificadas_equiv)}</span>
      <span class="tag verify">V ${tally.verificar}</span>
      <span class="tag">Reg ${tally.total}</span>
    </div>
  `;

  const table = includeDetail ? `
    <table>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Tipo</th>
          <th>Estado</th>
          ${includeNotes ? "<th>Nota</th>" : ""}
        </tr>
      </thead>
      <tbody>
        ${(records || []).map(r => {
          const st = String(r.status || "—");
          const just = (st === "AUSENTE" && noteIsJustified(r.note || ""));
          const stTxt = st + (just ? " • JUST." : "");
          const nt = stripJustMarker(r.note || "");
          return `<tr>
            <td>${escapeHtml(r.date || "")}</td>
            <td>${escapeHtml(ctxLabel(r.context || ""))}</td>
            <td><b>${escapeHtml(stTxt)}</b></td>
            ${includeNotes ? `<td>${nt ? escapeHtml(nt) : "<span class='muted'>—</span>"}</td>` : ""}
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  ` : "";

  const footHtml = foot ? `<div class="foot">${escapeHtml(foot)}</div>` : "";
  const sig = includeSig ? `<div class="sig"><div class="line">Firma / sello</div></div>` : "";

  return header + table + footHtml + sig;
}

function renderCourseReport(opts) {
  const { title, subtitle, course, from, to, context, includeDetail, includeSig, foot, summary, daily, students } = opts;

  const s = summary || {};
  const header = `
    <div class="r-head">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="sub">${subtitle ? escapeHtml(subtitle) + " • " : ""}<b>${escapeHtml(course)}</b></div>
        <div class="sub">Período: <b>${escapeHtml(from)}</b> → <b>${escapeHtml(to)}</b> • Tipo: <b>${escapeHtml(context)}</b></div>
      </div>
      <div class="sub">Emitido: <b>${escapeHtml(UI.todayISO())}</b></div>
    </div>
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px">
      <span class="tag">Reg ${s.total_records ?? 0}</span>
      <span class="tag present">P ${s.presentes ?? 0}</span>
      <span class="tag absent">A ${s.ausentes ?? 0}</span>
      <span class="tag">Faltas eq ${fmt1(s.faltas_equiv ?? 0)}</span>
      <span class="tag">J ${s.justificadas ?? 0}</span>
      <span class="tag late">T ${s.tardes ?? 0}</span>
      <span class="tag verify">V ${s.verificar ?? 0}</span>
      <span class="tag">Ses ${s.sessions ?? 0}</span>
    </div>
  `;

  const dailyTable = includeDetail ? `
    <table>
      <thead>
        <tr><th>Fecha</th><th>Presentes</th><th>Ausentes</th><th>Just.</th><th>Tardes</th><th>Faltas eq</th><th>Verificar</th></tr>
      </thead>
      <tbody>
        ${(daily || []).map(d => `
          <tr>
            <td>${escapeHtml(d.date || "")}</td>
            <td>${d.presentes ?? 0}</td>
            <td>${d.ausentes ?? 0}</td>
            <td>${d.justificadas ?? 0}</td>
            <td>${d.tardes ?? 0}</td>
            <td>${fmt1(d.faltas_equiv ?? 0)}</td>
            <td>${d.verificar ?? 0}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : "";

  const studentsTable = `
    <table>
      <thead>
        <tr><th>Estudiante</th><th>Total</th><th>Pres</th><th>Aus</th><th>Just</th><th>Tar</th><th>Ver</th></tr>
      </thead>
      <tbody>
        ${(students || []).map(st => `
          <tr>
            <td>${escapeHtml(st.student_name || "")}</td>
            <td>${st.total ?? 0}</td>
            <td>${st.presentes ?? 0}</td>
            <td>${st.ausentes ?? 0}</td>
            <td>${st.justificadas ?? 0}</td>
            <td>${st.tardes ?? 0}</td>
            <td>${st.verificar ?? 0}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  const footHtml = foot ? `<div class="foot">${escapeHtml(foot)}</div>` : "";
  const sig = includeSig ? `<div class="sig"><div class="line">Firma / sello</div></div>` : "";

  return header + dailyTable + studentsTable + footHtml + sig;
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
  let from = UI.$("#statsFrom").value || "";
  let to = UI.$("#statsTo").value || "";
  const context = UI.$("#statsContext").value || "ALL";

  // Si no hay rango cargado (ahora se maneja con botones), usamos los últimos 30 días por defecto
  if (!from || !to) {
    const pad = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dTo = new Date();
    const dFrom = new Date(Date.now() - (30 - 1) * 24 * 3600 * 1000);
    from = iso(dFrom);
    to = iso(dTo);
    UI.$("#statsFrom").value = from;
    UI.$("#statsTo").value = to;
  }

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
      { v: s.justificadas || 0, k: "Justificadas" },
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
          <span>Ausentes: <b>${fmt1(d.ausentes)}</b> • Just: ${d.justificadas || 0} • Pres: ${d.presentes} • Tar: ${d.tardes} • Inasist: <b>${pctDay}%</b></span>
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
