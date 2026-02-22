/*
  Asistencia PWA — Frontend (GitHub Pages)
  Backend: Supabase Edge Function via Api.* (api.js)
*/

(() => {
  "use strict";

  /* =====================
     UI helpers
  ===================== */

  const UI = {
    $(q, root = document) {
      return root.querySelector(q);
    },
    $all(q, root = document) {
      return Array.from(root.querySelectorAll(q));
    },
    escapeHtml(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    },
    todayISO() {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    },
    addDays(isoDate, days) {
      const d = new Date(isoDate + "T00:00:00");
      d.setDate(d.getDate() + days);
      return UI.toISO(d);
    },
    toISO(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    },
    toastTimer: null,
    toast(msg, ms = 2200) {
      const el = UI.$("#toast");
      if (!el) return;
      el.textContent = String(msg ?? "");
      el.hidden = false;
      clearTimeout(UI.toastTimer);
      UI.toastTimer = setTimeout(() => {
        el.hidden = true;
      }, ms);
    },
    modal: {
      open(title, html) {
        const modal = UI.$("#modal");
        if (!modal) return;
        UI.$("#modalTitle").textContent = String(title ?? "");
        UI.$("#modalBody").innerHTML = html;
        modal.hidden = false;
      },
      close() {
        const modal = UI.$("#modal");
        if (!modal) return;
        modal.hidden = true;
        UI.$("#modalTitle").textContent = "";
        UI.$("#modalBody").innerHTML = "";
      },
    },
  };

  /* =====================
     Constants + helpers
  ===================== */

  const JUST_MARK = "__J1__"; // debe coincidir con el backend

  const STATUS_LABEL = {
    PRESENTE: "PRESENTE",
    AUSENTE: "AUSENTE",
    TARDE: "TARDE",
    VERIFICAR: "VERIFICAR",
    "": "—",
    null: "—",
    undefined: "—",
  };

  const STATUS_CLASS = {
    PRESENTE: "present",
    AUSENTE: "absent",
    TARDE: "late",
    VERIFICAR: "verify",
  };

  const STATUS_ORDER_CYCLE = [null, "PRESENTE", "AUSENTE", "TARDE", "VERIFICAR"];

  const CTX_LABEL = {
    REGULAR: "Regular",
    ED_FISICA: "Ed. Física",
    ALL: "Todos",
  };

  function fmt1(x) {
    const n = Number(x ?? 0);
    if (!isFinite(n)) return "0";
    const s = (Math.round(n * 10) / 10).toFixed(1);
    return s.replace(/\.0$/, "");
  }

  function fmtPct(x) {
    const n = Number(x ?? 0);
    if (!isFinite(n)) return "0%";
    const s = (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");
    return `${s}%`;
  }

  function clamp(n, a, b) {
    n = Number(n);
    if (!isFinite(n)) return a;
    return Math.max(a, Math.min(b, n));
  }

  function noteIsJustified(note) {
    return String(note ?? "").startsWith(JUST_MARK);
  }

  function stripJustMarker(note) {
    const s = String(note ?? "");
    return s.startsWith(JUST_MARK) ? s.slice(JUST_MARK.length) : s;
  }

  function applyJustMarker(note, isJust) {
    const base = stripJustMarker(note).trim();
    if (!isJust) return base;
    return JUST_MARK + base;
  }

  function ctxLabel(ctx) {
    const k = String(ctx || "REGULAR").toUpperCase();
    return CTX_LABEL[k] || k;
  }

  function sessionWeight(context) {
    return String(context || "REGULAR").toUpperCase() === "ED_FISICA" ? 0.5 : 1;
  }

  // WhatsApp helper (Argentina-friendly, best-effort)
  function normalizePhoneAR(raw) {
    let d = String(raw ?? "").replace(/\D/g, "");
    if (!d) return "";

    // remove leading 00
    if (d.startsWith("00")) d = d.slice(2);

    // remove leading 0
    if (d.startsWith("0")) d = d.slice(1);

    // remove legacy leading 15
    if (d.startsWith("15")) d = d.slice(2);

    if (d.startsWith("54")) {
      // ensure mobile prefix 9 if it looks like AR number
      if (!d.startsWith("549") && d.length >= 10) d = "549" + d.slice(2);
      return d;
    }

    // assume AR
    if (!d.startsWith("9")) d = "9" + d;
    return "54" + d;
  }

  function waUrl(phone, text) {
    const p = normalizePhoneAR(phone);
    if (!p) return "";
    const t = encodeURIComponent(String(text ?? "").trim());
    return `https://wa.me/${p}${t ? `?text=${t}` : ""}`;
  }

  function calcInasistenciaPct(totalEquiv, faltasEquiv) {
    const t = Number(totalEquiv ?? 0);
    const f = Number(faltasEquiv ?? 0);
    if (!isFinite(t) || t <= 0) return 0;
    return clamp((f / t) * 100, 0, 100);
  }

  /*
    Tally de un timeline de estudiante
    - coincide con la lógica del backend (cap REGULAR+ED_FISICA por día)
  */
  function computeTally(records) {
    const recs = Array.isArray(records) ? records : [];

    const tally = {
      total: 0,
      total_equiv: 0,

      presentes: 0,
      tardes: 0,
      verificar: 0,

      // equivalencias y conteos cap (pueden ser decimales)
      ausentes: 0,
      justificadas: 0,
      faltas_equiv: 0,
      ausentes_equiv: 0,
      tardes_equiv: 0,
      justificadas_equiv: 0,
    };

    const absByDay = Object.create(null); // date -> { reg, ed, regJ, edJ }

    for (const r of recs) {
      const status = String(r?.status ?? "").toUpperCase();
      if (!status) continue;

      const date = String(r?.date ?? "");
      if (!date) continue;

      const ctx = String(r?.context ?? "REGULAR").toUpperCase();
      const w = Number(r?.session_weight ?? sessionWeight(ctx));

      tally.total += 1;
      tally.total_equiv += w;

      if (status === "PRESENTE") {
        tally.presentes += 1;
        continue;
      }

      if (status === "VERIFICAR") {
        tally.verificar += 1;
        continue;
      }

      if (status === "TARDE") {
        tally.tardes += 1;
        tally.tardes_equiv += 0.25;
        tally.faltas_equiv += 0.25;
        continue;
      }

      if (status === "AUSENTE") {
        if (!absByDay[date]) absByDay[date] = { reg: false, ed: false, regJ: false, edJ: false };
        const just = !!(r?.justified ?? (status === "AUSENTE" && noteIsJustified(r?.note)));
        if (ctx === "ED_FISICA") {
          absByDay[date].ed = true;
          if (just) absByDay[date].edJ = true;
        } else {
          absByDay[date].reg = true;
          if (just) absByDay[date].regJ = true;
        }
      }
    }

    // aplicar cap por día
    const dates = Object.keys(absByDay);
    for (const date of dates) {
      const v = absByDay[date];
      const a = Math.max(v.reg ? 1 : 0, v.ed ? 0.5 : 0);
      const j = Math.min(a, (v.regJ ? 1 : 0) + (v.edJ ? 0.5 : 0));

      tally.ausentes += a;
      tally.ausentes_equiv += a;
      tally.justificadas += j;
      tally.justificadas_equiv += j;
      tally.faltas_equiv += a;
    }

    // redondeo suave (evitar 0.30000000000000004)
    const round10 = (x) => Math.round((Number(x) || 0) * 10) / 10;
    tally.total_equiv = round10(tally.total_equiv);
    tally.faltas_equiv = round10(tally.faltas_equiv);
    tally.ausentes = round10(tally.ausentes);
    tally.ausentes_equiv = round10(tally.ausentes_equiv);
    tally.justificadas = round10(tally.justificadas);
    tally.justificadas_equiv = round10(tally.justificadas_equiv);
    tally.tardes_equiv = round10(tally.tardes_equiv);

    return tally;
  }

  /* =====================
     State
  ===================== */

  const State = {
    me: null,
    courses: [],
    studentsByCourse: new Map(),

    // tomar lista
    take: {
      course_id: "",
      date: "",
      context: "REGULAR",
      session: null,
      students: [],
      recordMap: new Map(), // student_id -> {status, note}
      stack: [],
      stackIndex: 0,
      dirty: new Set(),
      saveTimer: null,
      saving: false,
    },

    // stats
    stats: {
      from: "",
      to: "",
      context: "ALL",
      course_id: "ALL",
      studentRows: [],
    },

    // reports
    reportsInit: false,

    // alerts
    alerts: {
      course_id: "ALL",
      to: "",
      context: "ALL",
    },
  };

  /* =====================
     Navigation
  ===================== */

  function setView(view) {
    const views = {
      login: "#viewLogin",
      tomar: "#viewTomar",
      editar: "#viewEditar",
      stats: "#viewStats",
      reportes: "#viewReportes",
      alertas: "#viewAlertas",
    };

    Object.keys(views).forEach((k) => {
      const el = UI.$(views[k]);
      if (!el) return;
      el.hidden = k !== view;
    });

    // tabs active
    const tabs = UI.$all("#tabs .tab");
    tabs.forEach((b) => {
      b.classList.toggle("is-active", b.dataset.view === view);
      if (b.dataset.view === view) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
  }

  function bindTabs() {
    const tabs = UI.$all("#tabs .tab");
    tabs.forEach((b) => {
      b.addEventListener("click", async () => {
        const v = b.dataset.view;
        if (!v) return;
        setView(v);

        // lazy-init views
        if (v === "stats") {
          await ensureStatsDefaults();
          await loadStats();
        }
        if (v === "reportes") {
          await initReportsView();
        }
        if (v === "alertas") {
          initAlertsDefaults();
        }
      });
    });
  }

  /* =====================
     Login / session
  ===================== */

  async function tryRestoreSession() {
    try {
      const res = await Api.me();
      if (res && res.ok && res.me) {
        State.me = res.me;
        return true;
      }
    } catch (_e) {
      // ignore
    }
    return false;
  }

  async function doLogin() {
    const email = (UI.$("#loginEmail").value || "").trim();
    const pin = (UI.$("#loginPin").value || "").trim();
    const err = UI.$("#loginError");
    err.hidden = true;
    err.textContent = "";

    if (!email || !pin) {
      err.textContent = "Completá email y PIN.";
      err.hidden = false;
      return;
    }

    UI.$("#btnLogin").disabled = true;

    try {
      const res = await Api.login(email, pin);
      if (!res || !res.ok) {
        err.textContent = (res && res.error) ? res.error : "No se pudo ingresar.";
        err.hidden = false;
        return;
      }

      // Guardar token para las llamadas autenticadas
      try { localStorage.setItem("asistencia_token", String(res.token || "")); } catch (_e) {}

      const ok = await tryRestoreSession();
      if (!ok) {
        err.textContent = "Ingresaste, pero no pude validar la sesión. Reintentá.";
        err.hidden = false;
        return;
      }

      await enterApp();

    } catch (e) {
      err.textContent = String(e?.message || e || "Error de login");
      err.hidden = false;
    } finally {
      UI.$("#btnLogin").disabled = false;
    }
  }

  function logout() {
    try { localStorage.removeItem("asistencia_token"); } catch (_e) {}
    location.reload();
  }

  async function enterApp() {
    UI.$("#viewLogin").hidden = true;
    UI.$("#tabs").hidden = false;
    UI.$("#btnLogout").hidden = false;

    // show mobile title/menu controls (mobile-nav.js will also handle)
    const sectionTitle = UI.$("#sectionTitle");
    if (sectionTitle) sectionTitle.hidden = false;
    const btnMenu = UI.$("#btnMenu");
    if (btnMenu) btnMenu.hidden = false;

    await loadCourses();

    setView("tomar");

    // defaults
    UI.$("#selDate").value = UI.todayISO();
    UI.$("#editDate").value = UI.todayISO();

    // load take summary (lazy, after courses)
    await renderTakeSummary();
  }

  /* =====================
     Courses / students
  ===================== */

  function courseLabel(c) {
    const name = String(c?.name ?? c?.course_id ?? "Curso");
    const turno = c?.turno ? ` • ${c.turno}` : "";
    const owner = c?.owner_name ? ` • ${c.owner_name}` : "";
    return `${name}${turno}${owner}`;
  }

  function populateSelect(sel, options, { includeAll = false, allLabel = "Todos" } = {}) {
    if (!sel) return;
    sel.innerHTML = "";
    if (includeAll) {
      const o = document.createElement("option");
      o.value = "ALL";
      o.textContent = allLabel;
      sel.appendChild(o);
    }
    options.forEach((opt) => {
      const o = document.createElement("option");
      o.value = String(opt.course_id);
      o.textContent = courseLabel(opt);
      sel.appendChild(o);
    });
  }

  function defaultCourseId(courses) {
    const mine = courses.find((c) => c.is_mine);
    if (mine) return String(mine.course_id);
    return courses[0] ? String(courses[0].course_id) : "";
  }

  async function loadCourses() {
    let res;
    try { res = await Api.getCourses(); } catch (e) { UI.toast(String(e?.message || e || "No se pudieron leer cursos")); return; }
    if (!res || !res.ok) {
      UI.toast((res && res.error) ? res.error : "No se pudieron leer cursos");
      return;
    }

    State.courses = res.courses || [];

    const cid = defaultCourseId(State.courses);

    populateSelect(UI.$("#selCourse"), State.courses);
    populateSelect(UI.$("#editCourse"), State.courses);
    populateSelect(UI.$("#repCourse"), State.courses);
    populateSelect(UI.$("#alertsCourse"), State.courses, { includeAll: true, allLabel: "Todos los cursos" });
    populateSelect(UI.$("#statsCourse"), State.courses, { includeAll: true, allLabel: "Todos los cursos" });

    // set defaults
    if (cid) {
      UI.$("#selCourse").value = cid;
      UI.$("#editCourse").value = cid;
      UI.$("#repCourse").value = cid;
      UI.$("#alertsCourse").value = cid; // can be ALL later
      UI.$("#statsCourse").value = cid;
    }

    // init chart options after courses are known
    initCourseChartControls();

    // initial report student list
    if (State.reportsInit) {
      await onReportCourseChange();
    }
  }

  async function getStudents(course_id) {
    const cid = String(course_id || "");
    if (!cid) return [];
    if (State.studentsByCourse.has(cid)) return State.studentsByCourse.get(cid);

    let res;
    try { res = await Api.getStudents(cid); } catch (e) {
      UI.toast(String(e?.message || e || "No se pudieron leer estudiantes"));
      return [];
    }
    if (!res || !res.ok) {
      UI.toast((res && res.error) ? res.error : "No se pudieron leer estudiantes");
      return [];
    }
    const list = res.students || [];
    State.studentsByCourse.set(cid, list);
    return list;
  }

  function getCourseName(course_id) {
    const c = State.courses.find((x) => String(x.course_id) === String(course_id));
    return c ? `${c.name}${c.turno ? " • " + c.turno : ""}` : String(course_id);
  }

  /* =====================
     Tomar lista
  ===================== */

  function setSessionMeta(session) {
    const el = UI.$("#sessionMeta");
    if (!el) return;
    if (!session) {
      el.textContent = "";
      return;
    }

    const s = session;
    const status = s.status || "";
    const who = s.created_by_name ? `• Creado por ${s.created_by_name}` : "";
    const closed = s.closed_at ? `• Cerrado ${String(s.closed_at).slice(0, 10)}` : "";
    el.textContent = `Sesión: ${status} ${who} ${closed}`.replace(/\s+/g, " ").trim();
  }

  function buildCard(student, idx) {
    const card = document.createElement("div");
    card.className = `student-card ${idx % 2 === 0 ? "tone-a" : "tone-b"}`;
    card.dataset.studentId = String(student.student_id);

    const rec = State.take.recordMap.get(String(student.student_id)) || { status: null, note: "" };
    const status = rec.status ? String(rec.status).toUpperCase() : "";

    const badge = status ? `<span class="tag ${STATUS_CLASS[status] || ""}">${UI.escapeHtml(STATUS_LABEL[status])}</span>` : `<span class="badge">Pendiente</span>`;

    card.innerHTML = `
      <div class="student-top">
        <div>
          <div class="student-name">${UI.escapeHtml(student.last_name)}, ${UI.escapeHtml(student.first_name)}</div>
          <div class="small">${UI.escapeHtml(getCourseName(student.course_id))}</div>
        </div>
        <div>${badge}</div>
      </div>

      <div class="kpi">
        <span class="chip">→ Presente</span>
        <span class="chip danger">← Ausente</span>
        <span class="chip warn">↑ Tarde</span>
        <span class="chip">↓ Verificar</span>
      </div>

      <div class="student-foot">
        <div class="small muted">Arrastrá o usá los botones</div>
        <div class="small muted">${UI.escapeHtml(String(student.dni || ""))}</div>
      </div>
    `;

    return card;
  }

  function attachSwipe(card) {
    let startX = 0;
    let startY = 0;
    let dragging = false;

    const onDown = (e) => {
      if (!card || card.dataset.locked === "1") return;
      dragging = true;
      const p = e.touches ? e.touches[0] : e;
      startX = p.clientX;
      startY = p.clientY;
      card.setPointerCapture && card.setPointerCapture(e.pointerId);
      card.style.transition = "none";
    };

    const onMove = (e) => {
      if (!dragging) return;
      const p = e.touches ? e.touches[0] : e;
      const dx = p.clientX - startX;
      const dy = p.clientY - startY;
      const rot = clamp(dx / 20, -12, 12);
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;

      const p = e.changedTouches ? e.changedTouches[0] : e;
      const dx = p.clientX - startX;
      const dy = p.clientY - startY;

      card.style.transition = "transform .12s ease";

      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      const threshold = 70;

      if (absX < threshold && absY < threshold) {
        card.style.transform = "";
        return;
      }

      if (absX >= absY) {
        if (dx > 0) markCurrent("PRESENTE");
        else markCurrent("AUSENTE");
      } else {
        if (dy < 0) markCurrent("TARDE");
        else markCurrent("VERIFICAR");
      }

      card.style.transform = "";
    };

    // pointer events
    card.addEventListener("pointerdown", onDown);
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);

    // touch fallback (older iOS)
    card.addEventListener("touchstart", onDown, { passive: true });
    card.addEventListener("touchmove", onMove, { passive: true });
    card.addEventListener("touchend", onUp, { passive: true });
  }

  function renderCardStack() {
    const stackEl = UI.$("#cardStack");
    if (!stackEl) return;

    stackEl.innerHTML = "";

    const t = State.take;
    const remaining = t.stack.slice(t.stackIndex);

    if (!remaining.length) {
      stackEl.innerHTML = `<div class="muted" style="padding:14px">No hay estudiantes para mostrar. Cargá una sesión.</div>`;
      updateProgress();
      updateVerifyBanner();
      return;
    }

    // show up to 3 cards
    const show = remaining.slice(0, 3);
    show.forEach((student, i) => {
      const card = buildCard(student, t.stackIndex + i);
      card.style.transform = `translateY(${i * 6}px) scale(${1 - i * 0.02})`;
      card.style.zIndex = String(10 - i);
      if (i === 0) attachSwipe(card);
      stackEl.appendChild(card);
    });

    updateProgress();
    updateVerifyBanner();
  }

  function updateProgress() {
    const el = UI.$("#progress");
    if (!el) return;
    const t = State.take;
    if (!t.stack.length) {
      el.textContent = "";
      return;
    }

    const total = t.stack.length;
    const idx = t.stackIndex;
    const pending = t.stack.filter((s) => {
      const r = t.recordMap.get(String(s.student_id));
      return !r || !r.status;
    }).length;

    el.textContent = `Tarjetas: ${Math.min(idx + 1, total)} / ${total} • Pendientes: ${pending}`;
  }

  function updateVerifyBanner() {
    const el = UI.$("#verifyBanner");
    if (!el) return;

    const t = State.take;
    const ver = t.students
      .filter((s) => String(t.recordMap.get(String(s.student_id))?.status || "") === "VERIFICAR")
      .map((s) => `${s.last_name}, ${s.first_name}`);

    if (!ver.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }

    el.hidden = false;
    el.innerHTML = `<b>Para verificar luego (${ver.length}):</b> ${UI.escapeHtml(ver.join(" • "))}`;
  }

  function currentStudent() {
    const t = State.take;
    return t.stack[t.stackIndex] || null;
  }

  function markStudent(student_id, status) {
    const sid = String(student_id);
    const st = status ? String(status).toUpperCase() : null;
    const cur = State.take.recordMap.get(sid) || { status: null, note: "" };
    cur.status = st;
    State.take.recordMap.set(sid, cur);
    State.take.dirty.add(sid);
    scheduleSave();
  }

  function scheduleSave() {
    const t = State.take;
    clearTimeout(t.saveTimer);
    t.saveTimer = setTimeout(saveDirty, 450);
  }

  async function saveDirty() {
    const t = State.take;
    if (t.saving) return;
    if (!t.session || !t.session.session_id) return;
    if (!t.dirty.size) return;

    t.saving = true;

    try {
      const ids = Array.from(t.dirty);
      const rows = ids.map((sid) => {
        const r = t.recordMap.get(String(sid)) || { status: null, note: "" };
        return {
          student_id: String(sid),
          status: r.status || null,
          note: r.note ? String(r.note) : null,
        };
      });

      const res = await Api.upsertMany(t.session.session_id, t.course_id, t.date, t.context, rows);
      if (!res || !res.ok) {
        UI.toast((res && res.error) ? res.error : "No se pudo guardar");
        return;
      }
      ids.forEach((sid) => t.dirty.delete(sid));

    } catch (e) {
      UI.toast(String(e?.message || e || "Error guardando"));
    } finally {
      t.saving = false;
    }
  }

  function markCurrent(status) {
    const s = currentStudent();
    if (!s) return;

    markStudent(s.student_id, status);

    // move to next
    State.take.stackIndex += 1;
    renderCardStack();
  }

  async function loadTakeSession() {
    const course_id = UI.$("#selCourse").value;
    const date = UI.$("#selDate").value || UI.todayISO();
    const context = UI.$("#selContext").value || "REGULAR";

    if (!course_id) {
      UI.toast("Elegí un curso");
      return;
    }

    // reset state
    const t = State.take;
    t.course_id = String(course_id);
    t.date = String(date);
    t.context = String(context);
    t.session = null;
    t.students = [];
    t.recordMap = new Map();
    t.stack = [];
    t.stackIndex = 0;
    t.dirty = new Set();

    setSessionMeta(null);
    UI.$("#cardStack").innerHTML = `<div class="muted" style="padding:14px">Cargando…</div>`;

    try {
      const [sessRes, students] = await Promise.all([
        Api.getSession(t.course_id, t.date, t.context),
        getStudents(t.course_id),
      ]);

      if (!sessRes || !sessRes.ok || !sessRes.session) {
        UI.toast((sessRes && sessRes.error) ? sessRes.error : "No se pudo cargar la sesión");
        return;
      }

      t.session = sessRes.session;
      setSessionMeta(t.session);
      t.students = students || [];

      // records existentes
      const recRes = await Api.getRecords(t.session.session_id);
      if (recRes && recRes.ok && Array.isArray(recRes.records)) {
        recRes.records.forEach((r) => {
          t.recordMap.set(String(r.student_id), {
            status: r.status ? String(r.status).toUpperCase() : null,
            note: r.note ? String(r.note) : "",
          });
        });
      }

      // ordenar: pendientes primero
      const pending = t.students.filter((s) => {
        const r = t.recordMap.get(String(s.student_id));
        return !r || !r.status;
      });
      const done = t.students.filter((s) => {
        const r = t.recordMap.get(String(s.student_id));
        return r && r.status;
      });

      t.stack = pending.concat(done);
      t.stackIndex = 0;

      renderCardStack();
      await renderTakeSummary();

    } catch (e) {
      UI.toast(String(e?.message || e || "Error"));
    }
  }

  async function closeTakeSession() {
    const t = State.take;
    if (!t.session || !t.session.session_id) {
      UI.toast("Primero cargá una sesión");
      return;
    }

    await saveDirty();

    try {
      const res = await Api.closeSession(t.session.session_id);
      if (!res || !res.ok) {
        UI.toast((res && res.error) ? res.error : "No se pudo cerrar");
        return;
      }

      // recargar meta
      const sessRes = await Api.getSession(t.course_id, t.date, t.context);
      if (sessRes && sessRes.ok && sessRes.session) {
        t.session = sessRes.session;
        setSessionMeta(t.session);
      }
    } catch (e) {
      UI.toast(String((e && e.message) || e || "Error"));
      return;
    }

    UI.toast("Día cerrado");
  }

  // keyboard shortcuts while in tomar view
  function onKeydownTomar(e) {
    const tomarVisible = !UI.$("#viewTomar").hidden;
    if (!tomarVisible) return;

    // ignore if typing
    const tag = String(document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    if (e.key === "ArrowRight") { e.preventDefault(); markCurrent("PRESENTE"); }
    if (e.key === "ArrowLeft") { e.preventDefault(); markCurrent("AUSENTE"); }
    if (e.key === "ArrowUp") { e.preventDefault(); markCurrent("TARDE"); }
    if (e.key === "ArrowDown") { e.preventDefault(); markCurrent("VERIFICAR"); }
  }

  /* ===== Resumen debajo de Tomar lista ===== */

  async function renderTakeSummary() {
    const panel = UI.$("#takeSummaryPanel");
    if (!panel || panel.hidden) {
      // even if not hidden, it exists
    }

    const course_id = UI.$("#selCourse")?.value || "";
    if (!course_id) return;

    // período: últimos 30 días
    const to = UI.todayISO();
    const from = UI.addDays(to, -29);
    const metaEl = UI.$("#takeSummaryMeta");
    if (metaEl) metaEl.textContent = `Período: ${from} → ${to}`;

    const listEl = UI.$("#takeSummaryList");
    if (!listEl) return;
    listEl.innerHTML = `<div class="muted" style="padding:8px 6px">Cargando…</div>`;

    let res;
    try { res = await Api.getStudentStats(course_id, from, to, "ALL"); } catch (e) {
      listEl.innerHTML = "<div class=\"muted\" style=\"padding:8px 6px\">" + UI.escapeHtml(String((e && e.message) || e || "No se pudo cargar")) + "</div>";
      return;
    }
    if (!res || !res.ok) {
      listEl.innerHTML = `<div class="muted" style="padding:8px 6px">${UI.escapeHtml((res && res.error) ? res.error : "No se pudo cargar")}</div>`;
      return;
    }

    const rows = (res.students || []).map((r) => {
      const pct = calcInasistenciaPct(r.total_equiv, r.faltas_equiv);
      return {
        ...r,
        pct,
      };
    });

    // render list
    listEl.innerHTML = "";

    rows
      .sort((a, b) => (b.pct - a.pct) || a.student_name.localeCompare(b.student_name))
      .forEach((r) => {
        const row = document.createElement("div");
        row.className = `take-summary-row ${r.pct >= 20 ? "low" : ""}`;
        row.innerHTML = `
          <div class="left">
            <div class="title">${UI.escapeHtml(r.student_name)}</div>
            <div class="sub muted">Inasistencia: <b>${fmtPct(r.pct)}</b> • Faltas eq: <b>${fmt1(r.faltas_equiv)}</b> • Reg: <b>${fmt1(r.total_equiv)}</b></div>
          </div>
          <div class="pills">
            <span class="tag present">P ${r.presentes}</span>
            <span class="tag absent">A ${fmt1(r.ausentes)}</span>
            <span class="tag">J ${fmt1(r.justificadas)}</span>
            <span class="tag late">T ${r.tardes}</span>
          </div>
        `;
        row.addEventListener("click", () => {
          openStudentTimeline(course_id, r.student_id, from, to, "ALL");
        });
        listEl.appendChild(row);
      });
  }

  /* =====================
     Timeline modal
  ===================== */

  async function openStudentTimeline(course_id, student_id, from, to, context) {
    try {
      const students = await getStudents(course_id);
      const st = students.find((s) => String(s.student_id) === String(student_id));
      const title = st ? `${st.last_name}, ${st.first_name}` : `Estudiante ${student_id}`;

      const res = await Api.getStudentTimeline(course_id, student_id, from, to, context || "ALL");
      if (!res || !res.ok) {
        UI.toast((res && res.error) ? res.error : "No se pudo cargar la trayectoria");
        return;
      }

      const recs = res.records || [];
      const tally = computeTally(recs);

      const summary = `
        <div class="muted" style="margin-bottom:10px">
          Período: <b>${UI.escapeHtml(from)}</b> → <b>${UI.escapeHtml(to)}</b> • Tipo: <b>${UI.escapeHtml(ctxLabel(context || "ALL"))}</b>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px">
          <span class="tag present">P ${tally.presentes}</span>
          <span class="tag absent">A ${fmt1(tally.ausentes)}</span>
          <span class="tag">J ${fmt1(tally.justificadas)}</span>
          <span class="tag late">T ${tally.tardes}</span>
          <span class="tag">Faltas eq ${fmt1(tally.faltas_equiv)}</span>
          <span class="tag">Just. eq ${fmt1(tally.justificadas_equiv)}</span>
          <span class="tag verify">V ${tally.verificar}</span>
          <span class="tag">Reg ${fmt1(tally.total_equiv)}</span>
        </div>
      `;

      const rowsHtml = recs.length ? `
        <table style="width:100%; border-collapse:collapse; font-size:13px">
          <thead>
            <tr>
              <th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.08)">Fecha</th>
              <th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.08)">Tipo</th>
              <th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.08)">Estado</th>
              <th style="text-align:left; padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.08)">Nota</th>
            </tr>
          </thead>
          <tbody>
            ${recs.map((r) => {
              const stt = String(r.status || "—");
              const just = (stt === "AUSENTE" && (r.justified || noteIsJustified(r.note)));
              const stTxt = stt + (just ? " • JUST." : "");
              const nt = stripJustMarker(r.note || "");
              return `
                <tr>
                  <td style="padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.06)">${UI.escapeHtml(r.date || "")}</td>
                  <td style="padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.06)">${UI.escapeHtml(ctxLabel(r.context || ""))}</td>
                  <td style="padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.06)"><b>${UI.escapeHtml(stTxt)}</b></td>
                  <td style="padding:8px 6px; border-bottom:1px solid rgba(0,0,0,.06)">${nt ? UI.escapeHtml(nt) : "<span class='muted'>—</span>"}</td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      ` : "<div class='muted'>Sin registros en el período.</div>";

      UI.modal.open(title, summary + rowsHtml);

    } catch (e) {
      UI.toast(String(e?.message || e || "Error"));
    }
  }

  /* =====================
     Editar
  ===================== */

  function renderEditList(course_id, session_id, students, recordMap) {
    const list = UI.$("#editList");
    if (!list) return;

    list.innerHTML = "";

    students.forEach((s, idx) => {
      const sid = String(s.student_id);
      const rec = recordMap.get(sid) || { status: null, note: "" };
      const st = rec.status ? String(rec.status).toUpperCase() : "";
      const noteTxt = stripJustMarker(rec.note || "");
      const isJust = st === "AUSENTE" && noteIsJustified(rec.note || "");

      const row = document.createElement("div");
      row.className = `row ${idx % 2 === 0 ? "alt-a" : "alt-b"}`;
      row.innerHTML = `
        <div class="left">
          <div class="title">${UI.escapeHtml(s.last_name)}, ${UI.escapeHtml(s.first_name)}</div>
          <div class="sub">${st ? `<b>${UI.escapeHtml(STATUS_LABEL[st])}</b>${isJust ? " • <span class='muted'>JUST.</span>" : ""}` : "<span class='muted'>Sin registro</span>"}
          ${noteTxt ? ` • <span class='muted'>${UI.escapeHtml(noteTxt)}</span>` : ""}</div>
        </div>
        <div class="pills">
          ${st ? `<span class="tag ${STATUS_CLASS[st] || ""}">${UI.escapeHtml(STATUS_LABEL[st])}</span>` : `<span class="tag">—</span>`}
          <span class="tag click" data-action="edit" title="Editar nota / justificación">✏️</span>
        </div>
      `;

      // click row cycles status
      row.addEventListener("click", async (e) => {
        const act = e.target && e.target.dataset && e.target.dataset.action;
        if (act === "edit") {
          e.preventDefault();
          e.stopPropagation();
          openEditModal({
            course_id,
            session_id,
            student: s,
            current: rec,
            onSaved: (newRec) => {
              recordMap.set(sid, newRec);
              renderEditList(course_id, session_id, students, recordMap);
            },
          });
          return;
        }

        const next = nextStatus(rec.status);
        rec.status = next;
        recordMap.set(sid, rec);
        renderEditList(course_id, session_id, students, recordMap);

        try {
          const res = await Api.updateRecord(session_id, sid, next, rec.note || "");
          if (!res || !res.ok) {
            UI.toast((res && res.error) ? res.error : "No se pudo guardar");
          }
        } catch (e) {
          UI.toast(String((e && e.message) || e || "Error"));
        }
      });

      list.appendChild(row);
    });
  }

  function nextStatus(current) {
    const cur = current ? String(current).toUpperCase() : null;
    const i = STATUS_ORDER_CYCLE.indexOf(cur);
    const next = STATUS_ORDER_CYCLE[(i >= 0 ? i + 1 : 0) % STATUS_ORDER_CYCLE.length];
    return next;
  }

  function openEditModal({ course_id, session_id, student, current, onSaved }) {
    const sid = String(student.student_id);
    const st0 = current?.status ? String(current.status).toUpperCase() : "";
    const nt0 = stripJustMarker(current?.note || "");
    const just0 = st0 === "AUSENTE" && noteIsJustified(current?.note || "");

    const html = `
      <div class="field">
        <span>Estudiante</span>
        <div><b>${UI.escapeHtml(student.last_name)}, ${UI.escapeHtml(student.first_name)}</b></div>
      </div>

      <label class="field">
        <span>Estado</span>
        <select id="mStatus">
          <option value="">—</option>
          <option value="PRESENTE" ${st0 === "PRESENTE" ? "selected" : ""}>PRESENTE</option>
          <option value="AUSENTE" ${st0 === "AUSENTE" ? "selected" : ""}>AUSENTE</option>
          <option value="TARDE" ${st0 === "TARDE" ? "selected" : ""}>TARDE</option>
          <option value="VERIFICAR" ${st0 === "VERIFICAR" ? "selected" : ""}>VERIFICAR</option>
        </select>
      </label>

      <label class="field">
        <span>Nota</span>
        <textarea id="mNote" rows="3" placeholder="(opcional)">${UI.escapeHtml(nt0)}</textarea>
      </label>

      <label class="field" style="flex-direction:row; align-items:center; gap:10px">
        <input type="checkbox" id="mJust" ${just0 ? "checked" : ""} />
        <span style="font-size:13px">Falta justificada (solo AUSENTE)</span>
      </label>

      <div class="controls" style="justify-content:flex-end; gap:10px">
        <button class="btn btn-ghost" id="mCancel">Cancelar</button>
        <button class="btn btn-primary" id="mSave">Guardar</button>
      </div>
    `;

    UI.modal.open("Editar registro", html);

    const close = () => UI.modal.close();

    UI.$("#mCancel")?.addEventListener("click", close);

    UI.$("#mSave")?.addEventListener("click", async () => {
      const st = (UI.$("#mStatus").value || "") || null;
      const note = (UI.$("#mNote").value || "").trim();
      const just = !!UI.$("#mJust").checked;

      const noteStored = (st === "AUSENTE") ? applyJustMarker(note, just) : note;

      try {
        const res = await Api.updateRecord(session_id, sid, st, noteStored);
        if (!res || !res.ok) {
          UI.toast((res && res.error) ? res.error : "No se pudo guardar");
          return;
        }
      } catch (e) {
        UI.toast(String((e && e.message) || e || "Error"));
        return;
      }

      onSaved && onSaved({ status: st, note: noteStored });
      UI.toast("Guardado");
      close();
    });
  }

  async function loadEdit() {
    const course_id = UI.$("#editCourse").value;
    const date = UI.$("#editDate").value || UI.todayISO();
    const context = UI.$("#editContext").value || "REGULAR";

    if (!course_id) {
      UI.toast("Elegí un curso");
      return;
    }

    const list = UI.$("#editList");
    list.innerHTML = `<div class="muted" style="padding:8px 6px">Cargando…</div>`;

    try {
      const [sessRes, students] = await Promise.all([
        Api.getSession(course_id, date, context),
        getStudents(course_id),
      ]);

      if (!sessRes || !sessRes.ok || !sessRes.session) {
        UI.toast((sessRes && sessRes.error) ? sessRes.error : "No se pudo cargar la sesión");
        return;
      }

      const session_id = sessRes.session.session_id;
      const recRes = await Api.getRecords(session_id);

      const map = new Map();
      (recRes?.records || []).forEach((r) => {
        map.set(String(r.student_id), {
          status: r.status ? String(r.status).toUpperCase() : null,
          note: r.note ? String(r.note) : "",
        });
      });

      renderEditList(course_id, session_id, students || [], map);

    } catch (e) {
      UI.toast(String(e?.message || e || "Error"));
    }
  }

  /* =====================
     Estadísticas
  ===================== */

  async function ensureStatsDefaults() {
    if (State.stats.from && State.stats.to) return;
    const to = UI.todayISO();
    const from = UI.addDays(to, -29);
    State.stats.from = from;
    State.stats.to = to;
    UI.$("#statsFrom").value = from;
    UI.$("#statsTo").value = to;
  }

  function setStatsRange(days) {
    const to = UI.todayISO();
    const from = UI.addDays(to, -(days - 1));
    State.stats.from = from;
    State.stats.to = to;
    UI.$("#statsFrom").value = from;
    UI.$("#statsTo").value = to;
  }

  function renderStatsCards(summary) {
    const el = UI.$("#statsCards");
    if (!el) return;

    const s = summary || {};
    const pct = 100 - calcInasistenciaPct(s.total_equiv, s.faltas_equiv);

    const cards = [
      { title: "Asistencia", value: fmtPct(pct), sub: `Faltas eq: ${fmt1(s.faltas_equiv)} / Reg: ${fmt1(s.total_equiv)}` },
      { title: "Presentes", value: String(s.presentes ?? 0), sub: "" },
      { title: "Ausentes", value: fmt1(s.ausentes ?? 0), sub: `Just.: ${fmt1(s.justificadas ?? 0)}` },
      { title: "Tardes", value: String(s.tardes ?? 0), sub: `Verificar: ${String(s.verificar ?? 0)}` },
    ];

    el.innerHTML = "";
    cards.forEach((c) => {
      const card = document.createElement("div");
      card.className = "stat";
      card.innerHTML = `
        <div class="k">${UI.escapeHtml(c.title)}</div>
        <div class="v">${UI.escapeHtml(c.value)}</div>
        <div class="s muted">${UI.escapeHtml(c.sub || "")}</div>
      `;
      el.appendChild(card);
    });
  }

  function renderDailyBars(daily) {
    const el = UI.$("#statsDaily");
    if (!el) return;

    const rows = Array.isArray(daily) ? daily : [];
    if (!rows.length) {
      el.innerHTML = `<div class="muted" style="padding:10px">Sin datos en el período.</div>`;
      return;
    }

    // max faltas equiv for scaling
    const maxF = Math.max(1, ...rows.map((r) => Number(r.faltas_equiv || 0)));

    el.innerHTML = rows.map((r) => {
      const f = Number(r.faltas_equiv || 0);
      const pct = clamp((f / maxF) * 100, 0, 100);
      return `
        <div class="bar-row">
          <div class="bar-label">${UI.escapeHtml(r.date)}</div>
          <div class="bar-wrap" title="Faltas eq: ${fmt1(f)}">
            <div class="bar-fill" style="width:${pct}%"></div>
          </div>
          <div class="bar-val">${fmt1(f)}</div>
        </div>
      `;
    }).join("");
  }

  function sortStudentRows(rows, mode) {
    const m = String(mode || "ausentes");
    const arr = [...rows];

    const byName = (a, b) => a.student_name.localeCompare(b.student_name);

    if (m === "nombre") return arr.sort(byName);
    if (m === "presentes") return arr.sort((a, b) => (b.presentes - a.presentes) || byName(a, b));
    if (m === "tardes") return arr.sort((a, b) => (b.tardes - a.tardes) || byName(a, b));
    if (m === "verificar") return arr.sort((a, b) => (b.verificar - a.verificar) || byName(a, b));
    if (m === "pct") return arr.sort((a, b) => (b.pct - a.pct) || byName(a, b));

    // default: ausentes
    return arr.sort((a, b) => (Number(b.ausentes || 0) - Number(a.ausentes || 0)) || (b.pct - a.pct) || byName(a, b));
  }

  function renderStudentsStatsList() {
    const el = UI.$("#studentsStats");
    if (!el) return;

    const q = (UI.$("#studentsSearch")?.value || "").trim().toLowerCase();
    const sort = UI.$("#studentsSort")?.value || "ausentes";

    let rows = State.stats.studentRows || [];

    if (q) rows = rows.filter((r) => String(r.student_name).toLowerCase().includes(q));

    rows = sortStudentRows(rows, sort);

    el.innerHTML = "";

    const from = State.stats.from;
    const to = State.stats.to;
    const ctx = State.stats.context;
    const course_id = State.stats.course_id;

    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `
        <div class="left">
          <div class="title">${UI.escapeHtml(r.student_name)}</div>
          <div class="sub muted">Inasistencia: <b>${fmtPct(r.pct)}</b> • Faltas eq: <b>${fmt1(r.faltas_equiv)}</b> • Reg: <b>${fmt1(r.total_equiv)}</b></div>
        </div>
        <div class="counts">
          <span class="tag present">P ${r.presentes}</span>
          <span class="tag absent">A ${fmt1(r.ausentes)}</span>
          <span class="tag">J ${fmt1(r.justificadas)}</span>
          <span class="tag late">T ${r.tardes}</span>
          <span class="tag verify">V ${r.verificar}</span>
        </div>
      `;

      row.addEventListener("click", () => {
        const cid = course_id === "ALL" ? String(r.course_id) : course_id;
        openStudentTimeline(cid, r.student_id, from, to, ctx);
      });

      el.appendChild(row);
    });
  }

  async function loadStats() {
    const course_id = UI.$("#statsCourse").value || "ALL";
    const context = UI.$("#statsContext").value || "ALL";
    const from = UI.$("#statsFrom").value || State.stats.from;
    const to = UI.$("#statsTo").value || State.stats.to;

    State.stats.course_id = String(course_id);
    State.stats.context = String(context);
    State.stats.from = String(from);
    State.stats.to = String(to);

    renderStatsCards(null);
    UI.$("#statsDaily").innerHTML = `<div class="muted" style="padding:10px">Cargando…</div>`;
    UI.$("#studentsStats").innerHTML = `<div class="muted" style="padding:10px">Cargando…</div>`;

    try {
      const [statsRes, studentsRes] = await Promise.all([
        Api.getStats(course_id, from, to, context),
        Api.getStudentStats(course_id, from, to, context),
      ]);

      if (!statsRes || !statsRes.ok) {
        UI.toast((statsRes && statsRes.error) ? statsRes.error : "No se pudo cargar estadísticas");
        return;
      }

      renderStatsCards(statsRes.summary);
      renderDailyBars(statsRes.daily);

      if (!studentsRes || !studentsRes.ok) {
        UI.toast((studentsRes && studentsRes.error) ? studentsRes.error : "No se pudo cargar estudiantes");
        return;
      }

      State.stats.studentRows = (studentsRes.students || []).map((r) => {
        const pct = calcInasistenciaPct(r.total_equiv, r.faltas_equiv);
        return { ...r, pct };
      });

      renderStudentsStatsList();

    } catch (e) {
      UI.toast(String(e?.message || e || "Error"));
    }
  }

  /* =====================
     Comparativo por curso (chart)
  ===================== */

  function initCourseChartControls() {
    const chartDay = UI.$("#chartDay");
    if (chartDay && !chartDay.value) chartDay.value = UI.todayISO();

    // build week + month selects (last 12)
    buildWeekOptions();
    buildMonthOptions();

    // period change
    const period = UI.$("#chartPeriod");
    if (period && !period.dataset.bound) {
      period.dataset.bound = "1";
      period.addEventListener("change", () => {
        updateChartPeriodVisibility();
      });
    }

    updateChartPeriodVisibility();

    // load chart button
    const btn = UI.$("#btnLoadChart");
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", loadCourseChart);
    }
  }

  function updateChartPeriodVisibility() {
    const p = UI.$("#chartPeriod")?.value || "dia";
    const dayWrap = UI.$("#chartDayWrap");
    const weekWrap = UI.$("#chartWeekWrap");
    const monthWrap = UI.$("#chartMonthWrap");

    if (dayWrap) dayWrap.hidden = p !== "dia";
    if (weekWrap) weekWrap.hidden = p !== "semana";
    if (monthWrap) monthWrap.hidden = p !== "mes";
  }

  function startOfWeek(d) {
    // Monday
    const day = d.getDay(); // 0 Sun ... 6 Sat
    const diff = (day === 0 ? -6 : 1 - day);
    const x = new Date(d);
    x.setDate(d.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function buildWeekOptions() {
    const sel = UI.$("#chartWeek");
    if (!sel) return;

    const today = new Date();
    const base = startOfWeek(today);

    const opts = [];
    for (let i = 0; i < 12; i++) {
      const d1 = new Date(base);
      d1.setDate(base.getDate() - i * 7);
      const from = UI.toISO(d1);
      const to = UI.toISO(new Date(d1.getFullYear(), d1.getMonth(), d1.getDate() + 4)); // Lun-Vie
      opts.push({ from, to });
    }

    sel.innerHTML = "";
    opts.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = `${o.from}|${o.to}`;
      opt.textContent = `${o.from} → ${o.to}`;
      sel.appendChild(opt);
    });
  }

  function buildMonthOptions() {
    const sel = UI.$("#chartMonth");
    if (!sel) return;

    const d = new Date();
    const opts = [];
    for (let i = 0; i < 12; i++) {
      const md = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const y = md.getFullYear();
      const m = String(md.getMonth() + 1).padStart(2, "0");
      const from = `${y}-${m}-01`;
      const last = new Date(y, md.getMonth() + 1, 0);
      const to = UI.toISO(last);
      opts.push({ y, m, from, to });
    }

    sel.innerHTML = "";
    opts.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = `${o.from}|${o.to}`;
      opt.textContent = `${o.y}-${o.m}`;
      sel.appendChild(opt);
    });
  }

  function computeChartRange() {
    const p = UI.$("#chartPeriod")?.value || "dia";

    if (p === "general") {
      return { from: "1900-01-01", to: UI.todayISO() };
    }

    if (p === "dia") {
      const d = UI.$("#chartDay")?.value || UI.todayISO();
      return { from: d, to: d };
    }

    if (p === "semana") {
      const v = UI.$("#chartWeek")?.value || "";
      const parts = v.split("|");
      if (parts.length === 2) return { from: parts[0], to: parts[1] };
      const base = startOfWeek(new Date());
      const from = UI.toISO(base);
      const to = UI.toISO(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 4));
      return { from, to };
    }

    // mes
    const v = UI.$("#chartMonth")?.value || "";
    const parts = v.split("|");
    if (parts.length === 2) return { from: parts[0], to: parts[1] };

    const now = new Date();
    const from = UI.toISO(new Date(now.getFullYear(), now.getMonth(), 1));
    const to = UI.toISO(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    return { from, to };
  }

  function metricValue(courseRow, metric) {
    const r = courseRow || {};
    const m = String(metric || "attendance_pct");

    if (m === "absences_equiv") return Number(r.faltas_equiv || 0);
    if (m === "absences_count") return Number(r.ausentes || 0);

    // attendance_pct
    const pctInas = calcInasistenciaPct(r.total_equiv, r.faltas_equiv);
    return clamp(100 - pctInas, 0, 100);
  }

  function metricLabel(metric, value) {
    const m = String(metric || "attendance_pct");
    if (m === "absences_equiv") return fmt1(value);
    if (m === "absences_count") return fmt1(value);
    return fmtPct(value);
  }

  async function loadCourseChart() {
    const wrap = UI.$("#courseChart");
    if (!wrap) return;

    wrap.innerHTML = `<div class="muted" style="padding:10px">Cargando…</div>`;

    const { from, to } = computeChartRange();
    const metric = UI.$("#chartMetric")?.value || "attendance_pct";

    try {
      const res = await Api.getCourseSummary(from, to, "ALL");
      if (!res || !res.ok) {
        wrap.innerHTML = `<div class="muted" style="padding:10px">${UI.escapeHtml((res && res.error) ? res.error : "No se pudo cargar")}</div>`;
        return;
      }

      const courses = res.courses || [];

      const rows = courses.map((c) => {
        const value = metricValue(c, metric);
        return { ...c, _value: value };
      });

      // sort desc
      rows.sort((a, b) => (b._value - a._value) || String(a.name).localeCompare(String(b.name)));

      // scaling
      const max = Math.max(1, ...rows.map((r) => Number(r._value || 0)));

      wrap.innerHTML = "";

      rows.forEach((r) => {
        const bar = document.createElement("div");
        bar.className = "course-bar";

        const fillPct = metric === "attendance_pct" ? clamp(r._value, 0, 100) : clamp((r._value / max) * 100, 0, 100);

        bar.innerHTML = `
          <div class="bar"><div class="fill" style="--pct:${fillPct}"></div></div>
          <div class="val">${UI.escapeHtml(metricLabel(metric, r._value))}</div>
          <div class="lbl">
            ${UI.escapeHtml(String(r.name || r.course_id))}
            ${r.turno ? `<span class="muted">${UI.escapeHtml(String(r.turno))}</span>` : ""}
          </div>
        `;

        wrap.appendChild(bar);
      });

    } catch (e) {
      wrap.innerHTML = `<div class="muted" style="padding:10px">${UI.escapeHtml(String(e?.message || e || "Error"))}</div>`;
    }
  }

  /* =====================
     Reportes
  ===================== */

  async function initReportsView() {
    if (State.reportsInit) return;
    State.reportsInit = true;

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
    (students || []).forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.student_id;
      opt.textContent = `${s.last_name}, ${s.first_name}`;
      sel.appendChild(opt);
    });
  }

  async function buildReportPreview(ev) {
    ev && ev.preventDefault && ev.preventDefault();
    const type = UI.$("#repType").value;
    const course_id = UI.$("#repCourse").value;
    let from = UI.$("#repFrom").value || UI.todayISO();
    let to = UI.$("#repTo").value || UI.todayISO();
    const context = UI.$("#repContext").value || "ALL";
    if (from > to) {
      const tmp = from;
      from = to;
      to = tmp;
      UI.$("#repFrom").value = from;
      UI.$("#repTo").value = to;
    }

    const title = (UI.$("#repTitle").value || "Reporte").trim();
    const subtitle = (UI.$("#repSubtitle").value || "").trim();
    const includeDetail = !!UI.$("#repIncludeDetail").checked;
    const includeNotes = !!UI.$("#repIncludeNotes").checked;
    const includeSig = !!UI.$("#repIncludeSignature").checked;
    const foot = (UI.$("#repFootnote").value || "").trim();

    const preview = UI.$("#reportPreview");
    preview.innerHTML = `<div class="muted">Generando…</div>`;

    try {
      if (type === "student") {
        const student_id = UI.$("#repStudent").value;
        const students = await getStudents(course_id);
        const st = students.find((x) => String(x.student_id) === String(student_id));
        const student_name = st ? `${st.last_name}, ${st.first_name}` : `Estudiante ${student_id}`;

        const res = await Api.getStudentTimeline(course_id, student_id, from, to, context);
        if (!res || !res.ok) throw new Error(res?.error || "No se pudo leer registros");

        preview.innerHTML = renderStudentReport({
          title,
          subtitle,
          foot,
          includeDetail,
          includeNotes,
          includeSig,
          course_name: getCourseName(course_id),
          student_name,
          from,
          to,
          context,
          records: res.records || [],
        });

      } else {
        // course report
        const students = await getStudents(course_id);
        const res = await Api.getStudentStats(course_id, from, to, context);
        if (!res || !res.ok) throw new Error(res?.error || "No se pudo leer estadísticas");

        preview.innerHTML = renderCourseReport({
          title,
          subtitle,
          foot,
          includeDetail,
          includeNotes,
          includeSig,
          course_name: getCourseName(course_id),
          from,
          to,
          context,
          students,
          stats: res.students || [],
        });
      }

      UI.toast("Vista previa lista");

    } catch (e) {
      preview.innerHTML = `<div class="muted">${UI.escapeHtml(String(e?.message || e || "Error"))}</div>`;
    }
  }

  function printReport() {
    // imprime solo el contenido del preview
    const preview = UI.$("#reportPreview");
    if (!preview) return;

    const html = preview.innerHTML;
    const win = window.open("", "_blank");
    if (!win) {
      UI.toast("Tu navegador bloqueó la ventana de impresión.");
      return;
    }

    win.document.open();
    win.document.write(`
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Reporte</title>
          <link rel="stylesheet" href="./styles.css" />
          <style>
            body{background:#fff !important;}
            .report-preview{box-shadow:none !important; border:none !important;}
          </style>
        </head>
        <body>
          <div class="report-preview">${html}</div>
          <script>
            window.addEventListener('load', () => { window.print(); });
          <\/script>
        </body>
      </html>
    `);
    win.document.close();
  }

  function renderHeaderBlock({ title, subtitle, course_name, student_name, from, to, context }) {
    const ctx = ctxLabel(context);
    const sub2 = [
      course_name ? `Curso: <b>${UI.escapeHtml(course_name)}</b>` : "",
      student_name ? `Estudiante: <b>${UI.escapeHtml(student_name)}</b>` : "",
      `Período: <b>${UI.escapeHtml(from)}</b> → <b>${UI.escapeHtml(to)}</b>`,
      `Tipo: <b>${UI.escapeHtml(ctx)}</b>`,
    ].filter(Boolean).join(" • ");

    return `
      <div class="rep-head">
        <div class="rep-title">${UI.escapeHtml(title || "Reporte")}</div>
        ${subtitle ? `<div class="rep-sub">${UI.escapeHtml(subtitle)}</div>` : ""}
        <div class="rep-meta">${sub2}</div>
      </div>
    `;
  }

  function renderStudentReport({
    title,
    subtitle,
    foot,
    includeDetail,
    includeNotes,
    includeSig,
    course_name,
    student_name,
    from,
    to,
    context,
    records,
  }) {
    const recs = Array.isArray(records) ? records : [];
    const tally = computeTally(recs);

    const inas = calcInasistenciaPct(tally.total_equiv, tally.faltas_equiv);
    const asis = 100 - inas;

    const detailTable = includeDetail ? `
      <table class="rep-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Estado</th>
            ${includeNotes ? "<th>Nota</th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${recs.map((r) => {
            const st = String(r.status || "");
            const just = (st === "AUSENTE" && (r.justified || noteIsJustified(r.note)));
            const stTxt = st ? (st + (just ? " (Just.)" : "")) : "—";
            const note = includeNotes ? stripJustMarker(r.note || "") : "";
            return `
              <tr>
                <td>${UI.escapeHtml(r.date || "")}</td>
                <td>${UI.escapeHtml(ctxLabel(r.context || ""))}</td>
                <td><b>${UI.escapeHtml(stTxt)}</b></td>
                ${includeNotes ? `<td>${note ? UI.escapeHtml(note) : "—"}</td>` : ""}
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    ` : "";

    return `
      ${renderHeaderBlock({ title, subtitle, course_name, student_name, from, to, context })}

      <div class="rep-kpis">
        <div class="rep-kpi"><div class="k">Asistencia</div><div class="v">${fmtPct(asis)}</div></div>
        <div class="rep-kpi"><div class="k">Inasistencia</div><div class="v">${fmtPct(inas)}</div></div>
        <div class="rep-kpi"><div class="k">Faltas (eq.)</div><div class="v">${fmt1(tally.faltas_equiv)}</div></div>
        <div class="rep-kpi"><div class="k">Registros (eq.)</div><div class="v">${fmt1(tally.total_equiv)}</div></div>
      </div>

      <div class="rep-badges">
        <span class="tag present">P ${tally.presentes}</span>
        <span class="tag absent">A ${fmt1(tally.ausentes)}</span>
        <span class="tag">J ${fmt1(tally.justificadas)}</span>
        <span class="tag late">T ${tally.tardes}</span>
        <span class="tag verify">V ${tally.verificar}</span>
      </div>

      ${detailTable}

      ${foot ? `<div class="rep-foot">${UI.escapeHtml(foot)}</div>` : ""}
      ${includeSig ? `<div class="rep-sign">Firma: ____________________________________</div>` : ""}
    `;
  }

  function renderCourseReport({
    title,
    subtitle,
    foot,
    includeDetail,
    includeNotes,
    includeSig,
    course_name,
    from,
    to,
    context,
    students,
    stats,
  }) {
    const stMap = new Map();
    (students || []).forEach((s) => stMap.set(String(s.student_id), s));

    const rows = (stats || []).map((r) => {
      const st = stMap.get(String(r.student_id));
      const name = st ? `${st.last_name}, ${st.first_name}` : (r.student_name || `Estudiante ${r.student_id}`);
      const pctInas = calcInasistenciaPct(r.total_equiv, r.faltas_equiv);
      const pctAsis = 100 - pctInas;
      return { ...r, name, pctAsis, pctInas };
    });

    rows.sort((a, b) => (b.pctInas - a.pctInas) || a.name.localeCompare(b.name));

    const table = `
      <table class="rep-table">
        <thead>
          <tr>
            <th>Estudiante</th>
            <th>Asistencia</th>
            <th>Faltas eq</th>
            <th>P</th>
            <th>A</th>
            <th>J</th>
            <th>T</th>
            <th>V</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${UI.escapeHtml(r.name)}</b></td>
              <td>${fmtPct(r.pctAsis)}</td>
              <td>${fmt1(r.faltas_equiv)}</td>
              <td>${r.presentes}</td>
              <td>${fmt1(r.ausentes)}</td>
              <td>${fmt1(r.justificadas)}</td>
              <td>${r.tardes}</td>
              <td>${r.verificar}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    return `
      ${renderHeaderBlock({ title, subtitle, course_name, student_name: "", from, to, context })}
      ${table}
      ${foot ? `<div class="rep-foot">${UI.escapeHtml(foot)}</div>` : ""}
      ${includeSig ? `<div class="rep-sign">Firma: ____________________________________</div>` : ""}
    `;
  }

  /* =====================
     Alertas
  ===================== */

  function initAlertsDefaults() {
    const today = UI.todayISO();
    const to = UI.$("#alertsTo");
    if (to && !to.value) to.value = today;
  }

  async function ensureStudentPhone(student_id, currentPhone) {
    const existing = String(currentPhone || "").trim();
    if (existing) return existing;

    return new Promise((resolve) => {
      const html = `
        <div class="muted" style="margin-bottom:10px">Este estudiante no tiene teléfono cargado. Ingresalo para poder enviar WhatsApp.</div>
        <label class="field">
          <span>Teléfono (solo números)</span>
          <input id="phIn" type="tel" inputmode="numeric" placeholder="11 1234 5678" />
        </label>
        <div class="controls" style="justify-content:flex-end; gap:10px">
          <button class="btn btn-ghost" id="phCancel">Cancelar</button>
          <button class="btn btn-primary" id="phSave">Guardar</button>
        </div>
      `;

      UI.modal.open("Cargar teléfono", html);

      const close = () => { UI.modal.close(); resolve(""); };
      UI.$("#phCancel")?.addEventListener("click", close);

      UI.$("#phSave")?.addEventListener("click", async () => {
        const v = (UI.$("#phIn")?.value || "").trim();
        const digits = v.replace(/\D/g, "");
        if (digits.length < 8) {
          UI.toast("Ingresá un teléfono válido");
          return;
        }

        const res = await Api.updateStudentPhone(String(student_id), digits);
        if (!res || !res.ok) {
          UI.toast((res && res.error) ? res.error : "No se pudo guardar");
          return;
        }

        UI.modal.close();
        resolve(digits);
      });
    });
  }

  async function loadAlerts() {
    const course_id = UI.$("#alertsCourse").value || "ALL";
    const to = UI.$("#alertsTo").value || UI.todayISO();
    const context = UI.$("#alertsContext").value || "ALL";

    const list = UI.$("#alertsList");
    list.innerHTML = `<div class="muted" style="padding:8px 6px">Cargando…</div>`;

    try {
      const res = await Api.getAlerts(course_id, to, context);
      if (!res || !res.ok) {
        list.innerHTML = `<div class="muted" style="padding:8px 6px">${UI.escapeHtml((res && res.error) ? res.error : "No se pudo cargar")}</div>`;
        return;
      }

      const alerts = res.alerts || [];
      if (!alerts.length) {
        list.innerHTML = `<div class="muted" style="padding:8px 6px">Sin alertas pendientes.</div>`;
        return;
      }

      list.innerHTML = "";

      alerts.forEach((a) => {
        const row = document.createElement("div");
        row.className = "row";

        const phone = a.guardian_phone || "";
        const msg = `Hola. Te escribimos desde Preceptoría por asistencia de ${a.student_name}. (${a.reason})`;

        row.innerHTML = `
          <div class="left">
            <div class="title">${UI.escapeHtml(a.student_name)}</div>
            <div class="sub muted">${UI.escapeHtml(getCourseName(a.course_id))} • ${UI.escapeHtml(a.reason || "")}</div>
          </div>
          <div class="pills">
            <span class="tag absent" title="Ausencias acumuladas">Tot ${fmt1(a.absences_total)}</span>
            <span class="tag" title="Racha">Racha ${fmt1(a.absences_streak)}</span>
            <span class="tag click" data-act="wa">WhatsApp</span>
            <span class="tag click" data-act="ack">AVISADO</span>
          </div>
        `;

        row.querySelector('[data-act="wa"]').addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();

          const ph = await ensureStudentPhone(a.student_id, phone);
          if (!ph) return;

          const url = waUrl(ph, msg);
          if (!url) {
            UI.toast("Teléfono inválido");
            return;
          }
          window.open(url, "_blank");
        });

        row.querySelector('[data-act="ack"]').addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = await Api.ackAlert(a.student_id, a.course_id, context);
          if (!r || !r.ok) {
            UI.toast((r && r.error) ? r.error : "No se pudo marcar como avisado");
            return;
          }
          UI.toast("Marcado como avisado");
          // remove row
          row.remove();
          if (!list.children.length) {
            list.innerHTML = `<div class="muted" style="padding:8px 6px">Sin alertas pendientes.</div>`;
          }
        });

        list.appendChild(row);
      });

    } catch (e) {
      list.innerHTML = `<div class="muted" style="padding:8px 6px">${UI.escapeHtml(String(e?.message || e || "Error"))}</div>`;
    }
  }

  /* =====================
     Bootstrap / bindings
  ===================== */

  function bindModalClose() {
    const modal = UI.$("#modal");
    if (!modal) return;

    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.close === "1") UI.modal.close();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) UI.modal.close();
    });
  }

  function bindCoreButtons() {
    // login
    UI.$("#btnLogin")?.addEventListener("click", doLogin);
    UI.$("#loginPin")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });

    // logout
    UI.$("#btnLogout")?.addEventListener("click", logout);

    // tomar
    UI.$("#btnLoadSession")?.addEventListener("click", loadTakeSession);
    UI.$("#btnCloseSession")?.addEventListener("click", closeTakeSession);
    UI.$("#btnPresent")?.addEventListener("click", () => markCurrent("PRESENTE"));
    UI.$("#btnAbsent")?.addEventListener("click", () => markCurrent("AUSENTE"));
    UI.$("#btnLate")?.addEventListener("click", () => markCurrent("TARDE"));
    UI.$("#btnVerify")?.addEventListener("click", () => markCurrent("VERIFICAR"));

    // take: update summary when course changes
    UI.$("#selCourse")?.addEventListener("change", () => {
      renderTakeSummary();
    });

    // editar
    UI.$("#btnLoadEdit")?.addEventListener("click", loadEdit);

    // stats
    UI.$("#btnLoadStats")?.addEventListener("click", loadStats);
    UI.$("#btnQuickWeek")?.addEventListener("click", () => { setStatsRange(7); loadStats(); });
    UI.$("#btnQuickMonth")?.addEventListener("click", () => { setStatsRange(30); loadStats(); });

    UI.$("#studentsSearch")?.addEventListener("input", () => renderStudentsStatsList());
    UI.$("#studentsSort")?.addEventListener("change", () => renderStudentsStatsList());

    // alerts
    UI.$("#btnLoadAlerts")?.addEventListener("click", loadAlerts);

    // global keydown
    document.addEventListener("keydown", onKeydownTomar);
  }

  async function bootstrap() {
    bindModalClose();
    bindTabs();
    bindCoreButtons();

    // date defaults
    const today = UI.todayISO();
    const els = ["#selDate", "#editDate", "#alertsTo", "#chartDay"]; 
    els.forEach((id) => {
      const el = UI.$(id);
      if (el && !el.value) el.value = today;
    });

    // initial chart
    initCourseChartControls();

    // session restore
    const ok = await tryRestoreSession();
    if (ok) {
      await enterApp();
    } else {
      setView("login");
    }
  }

  document.addEventListener("DOMContentLoaded", bootstrap);
})();
