(() => {
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const screens = { login: $("screenLogin"), courses: $("screenCourses"), take: $("screenTake") };

  const state = {
    token: null,
    user: null,
    courses: [],
    course: null,
    sessionDate: new Date(),
    sessionId: null,
    students: [],
    idx: 0,
    deferred: new Set(),
    statsCache: new Map(),
  };

  // ---------- UI helpers ----------
  function setSubtitle(t){ $("brandSubtitle").textContent = t; }
  function showScreen(name){ Object.values(screens).forEach(s => s.hidden = true); screens[name].hidden = false; }
  function veil(show, text="Cargando…"){ $("veilText").textContent = text; $("veil").hidden = !show; }

  let toastTimer=null;
  function toast(msg){
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=> el.hidden = true, 2200);
  }

  function fatal(message, details=""){
    veil(false);
    showScreen("login");
    setSubtitle("Revisá configuración");
    const box = $("loginError");
    box.hidden = false;
    box.textContent = details ? `${message} — ${details}` : message;
  }

  // Global error traps (prevents infinite-loading)
  window.addEventListener("error", (e) => fatal("Error en la app", e?.message || "Ver consola"));
  window.addEventListener("unhandledrejection", (e) => fatal("Promesa rechazada", e?.reason?.message || String(e?.reason || "Error")));


  // Prevent scroll (except inside modal)
  document.addEventListener("touchmove", (e) => {
    const sheetBody = $("sheetBody");
    if ($("overlay").hidden) e.preventDefault();
    else if (!sheetBody.contains(e.target)) e.preventDefault();
  }, { passive:false });

  // ---------- Bottom sheet ----------
  function openSheet({ title, subtitle="", bodyHTML="", footerHTML="", onMount=null }){
    $("sheetTitle").textContent = title;
    $("sheetSubtitle").textContent = subtitle;
    $("sheetBody").innerHTML = bodyHTML;
    const footer = $("sheetFooter");
    if (footerHTML){ footer.hidden = false; footer.innerHTML = footerHTML; }
    else { footer.hidden = true; footer.innerHTML = ""; }
    $("overlay").hidden = false;
    if (onMount) onMount();
  }
  function closeSheet(){
    $("overlay").hidden = true;
    $("sheetBody").innerHTML = "";
    $("sheetFooter").innerHTML = "";
    $("sheetFooter").hidden = true;
  }
  $("btnCloseSheet").addEventListener("click", closeSheet);
  $("overlay").addEventListener("click", (e)=>{ if (e.target === $("overlay")) closeSheet(); });

  // ---------- JSONP API (Apps Script) ----------
  function jsonp(action, params={}, timeoutMs=15000){
    return new Promise((resolve, reject) => {
      if (!cfg.WEB_APP_URL || cfg.WEB_APP_URL.includes("PASTE_")){
        reject(new Error("Falta WEB_APP_URL en config.js"));
        return;
      }
      const cb = "cb_" + Math.random().toString(36).slice(2);
      const url = new URL(cfg.WEB_APP_URL);
      url.searchParams.set("action", action);
      url.searchParams.set("callback", cb);
      Object.entries(params).forEach(([k,v]) => {
        if (v === undefined || v === null) return;
        url.searchParams.set(k, String(v));
      });

      const script = document.createElement("script");
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout: Apps Script no respondió. (¿Deploy Web App / permisos Anyone / URL /exec?)"));
      }, timeoutMs);

      function cleanup(){
        clearTimeout(timeout);
        delete window[cb];
        script.remove();
      }

      window[cb] = (payload) => {
        cleanup();
        if (!payload || payload.ok === false){
          reject(new Error(payload?.error || "Error API"));
          return;
        }
        resolve(payload);
      };

      script.onerror = () => {
        cleanup();
        reject(new Error("No se pudo cargar el script (¿URL correcta?)"));
      };
      script.src = url.toString();
      document.body.appendChild(script);
    });
  }

  // ---------- Date helpers ----------
  function fmtDate(d){
    const pad = (n)=> String(n).padStart(2,"0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }
  function friendlyDate(d){
    const now = new Date();
    if (now.toDateString() === d.toDateString()) return "Hoy";
    return d.toLocaleDateString("es-AR", { weekday:"short", day:"2-digit", month:"2-digit" });
  }

  // ---------- Init ----------
  async function init(){
    veil(true, "Conectando…");
    try{
      const info = document.getElementById("backendInfo");
      if (info) info.textContent = `Backend: ${cfg.WEB_APP_URL || "(sin configurar)"}`;

      // Ping con reintentos (para diagnosticar URL/permisos)
      const tries = 3;
      let lastErr = null;
      for (let i=1; i<=tries; i++){
        setSubtitle(`Conectando al backend… (${i}/${tries})`);
        try{
          await jsonp("ping", { t: Date.now() }, 9000);
          lastErr = null;
          break;
        } catch(err){
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;

      showScreen("login");
      setSubtitle("Listo ✅ Ingresá para empezar");
      document.getElementById("sessionDateLabel").textContent = friendlyDate(state.sessionDate);
      veil(false);
    } catch(err){
      fatal("No pude conectar", err.message);
    }
  }

  // ---------- Auth ----------
  $("loginForm").addEventListener("submit", async (e)=>{
    e.preventDefault();
    $("loginError").hidden = true;
    veil(true, "Ingresando…");
    try{
      const email = $("loginEmail").value.trim();
      const pin = $("loginPin").value.trim();
      const res = await jsonp("login", { email, pin });
      state.token = res.token;
      state.user = res.user;
      setSubtitle(`Hola, ${res.user.full_name}`);
      await loadCourses();
      showScreen("courses");
      renderCourses();
      veil(false);
    } catch(err){
      fatal("No pude ingresar", err.message);
    }
  });

  $("btnLogout").addEventListener("click", ()=>{ location.reload(); });
  $("btnSync").addEventListener("click", async ()=>{
    if (!state.token) return;
    toast("Actualizando…");
    await loadCourses();
    renderCourses();
  });

  // ---------- Courses ----------
  async function loadCourses(){
    const res = await jsonp("getCourses", { token: state.token });
    state.courses = res.courses || [];
  }

  function escapeHtml(str){
    return String(str ?? "").replace(/[&<>"']/g, (m) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[m]));
  }

  function renderCourses(){
    $("sessionDateLabel").textContent = friendlyDate(state.sessionDate);
    const grid = $("coursesGrid");
    grid.innerHTML = "";
    if (!state.courses.length){
      grid.innerHTML = `<div class="muted">No tenés cursos asignados (o no están cargados).</div>`;
      return;
    }
    for (const c of state.courses){
      const el = document.createElement("button");
      el.className = "courseCard";
      el.type = "button";
      el.innerHTML = `
        <div class="courseTitle">${escapeHtml(c.name)}</div>
        <div class="courseMeta">${escapeHtml(c.turno || "")}</div>
      `;
      el.addEventListener("click", ()=> startCourse(c));
      grid.appendChild(el);
    }
  }

  $("btnPickDate").addEventListener("click", ()=>{
    const current = fmtDate(state.sessionDate);
    openSheet({
      title: "Elegir fecha",
      subtitle: "La asistencia se guardará con esta fecha.",
      bodyHTML: `
        <div class="list">
          <label class="field">
            <span>Fecha</span>
            <input id="dateInput" type="date" value="${current}" />
          </label>
          <button id="btnToday" class="pill" type="button">📅 Hoy</button>
        </div>
      `,
      footerHTML: `
        <button id="btnCancelDate" class="pill" type="button">Cancelar</button>
        <button id="btnSaveDate" class="pill pillPrimary" type="button">Guardar</button>
      `,
      onMount: ()=>{
        $("btnToday").onclick = ()=> $("dateInput").value = fmtDate(new Date());
        $("btnCancelDate").onclick = closeSheet;
        $("btnSaveDate").onclick = ()=>{
          const v = $("dateInput").value;
          const d = v ? new Date(v + "T12:00:00") : new Date();
          state.sessionDate = d;
          $("sessionDateLabel").textContent = friendlyDate(d);
          closeSheet();
        };
      }
    });
  });

  $("btnOpenAlerts").addEventListener("click", ()=>{
    openSheet({
      title: "Alertas",
      subtitle: "Aparecen en cada estudiante durante la toma.",
      bodyHTML: `<div class="muted">Cuando un estudiante cumple condiciones (3 consecutivas, hitos o &lt;${cfg.LOW_ATTENDANCE_THRESHOLD||75}% asistencia), verás un badge y podrás copiar un mensaje automático.</div>`
    });
  });

  // ---------- Attendance flow ----------
  async function startCourse(course){
    state.course = course;
    state.idx = 0;
    state.deferred = new Set();
    state.statsCache = new Map();

    $("courseTitle").textContent = course.name;
    $("sessionDateTake").textContent = friendlyDate(state.sessionDate);
    showScreen("take");

    veil(true, "Cargando estudiantes…");
    try{
      const date = fmtDate(state.sessionDate);
      const sess = await jsonp("ensureSession", { token: state.token, course_id: course.course_id, date });
      state.sessionId = sess.session_id;
      const stu = await jsonp("getStudents", { token: state.token, course_id: course.course_id });
      state.students = stu.students || [];
      const stats = await jsonp("getCourseStats", { token: state.token, course_id: course.course_id });
      (stats.stats || []).forEach(s => state.statsCache.set(s.student_id, s));
      renderCurrentCard();
      updateProgress();
      veil(false);
    } catch(err){
      fatal("No pude cargar el curso", err.message);
    }
  }

  function currentStudent(){ return state.students[state.idx] || null; }

  function updateProgress(){
    const total = state.students.length || 0;
    const done = Math.min(state.idx, total);
    $("progressText").textContent = `${done}/${total}`;
    const pct = total ? Math.round((done/total)*100) : 0;
    $("progressFill").style.width = pct + "%";
    $("deferredCount").textContent = String(state.deferred.size);
  }

  function statusLabel(st){
    return st === "present" ? "Presente ✅" :
           st === "absent"  ? "Falta ❌" :
           st === "tardy"   ? "Tarde ⏰" :
           st === "pe_present" ? "EF Presente 🏃‍♂️" :
           st === "pe_absent"  ? "EF Falta ❌🏃‍♂️" : "—";
  }

  function buildBadges(stats){
    const parts = [];
    if ((stats.consecutive_absences||0) >= 3) parts.push(`<div class="badge badgeDanger">⚠ 3 consecutivas</div>`);
    if (stats.milestone) parts.push(`<div class="badge badgeWarn">🎯 ${stats.milestone} faltas</div>`);
    if (stats.low_attendance) parts.push(`<div class="badge badgeDanger">⬇ &lt;${(cfg.LOW_ATTENDANCE_THRESHOLD||75)}%</div>`);
    if (!parts.length) parts.push(`<div class="badge badgeGood">✅ OK</div>`);
    return parts.join("");
  }

  function renderCurrentCard(){
    const s = currentStudent();
    const stage = $("cardStage");
    stage.innerHTML = "";

    if (!s){
      stage.innerHTML = `
        <div class="studentCard" style="max-height:420px; display:grid; place-items:center; text-align:center">
          <div>
            <div class="h2">Listo ✅</div>
            <div class="muted">Podés cerrar la toma o revisar “Después”.</div>
          </div>
        </div>`;
      return;
    }

    const stats = state.statsCache.get(s.student_id) || { absences:0, attendance_pct:100, consecutive_absences:0, milestone:null, low_attendance:false };
    const el = document.createElement("div");
    el.className = "studentCard";
    el.innerHTML = `
      <div class="studentTop">
        <div>
          <div class="studentName">${escapeHtml(s.last_name)}<br/>${escapeHtml(s.first_name)}</div>
          <div class="studentSub">DNI: ${escapeHtml(s.dni || "—")}</div>
        </div>
        <div class="badges">${buildBadges(stats)}</div>
      </div>

      <div class="studentBottom">
        <div class="quickStats">
          <div class="stat"><div class="statVal">${stats.absences||0}</div><div class="statLab">Faltas</div></div>
          <div class="stat"><div class="statVal">${stats.attendance_pct||100}%</div><div class="statLab">Asistencia</div></div>
          <div class="stat"><div class="statVal">${stats.consecutive_absences||0}</div><div class="statLab">Consecutivas</div></div>
        </div>

        <div class="cardButtons">
          <button class="smallBtn" id="btnHistory">📒 Ver faltas</button>
          <button class="smallBtn" id="btnCopyMsg">✉️ Copiar mensaje</button>
        </div>
      </div>
    `;
    stage.appendChild(el);
    attachSwipe(el);

    el.querySelector("#btnHistory").addEventListener("click", ()=> openHistory(s.student_id, `${s.last_name} ${s.first_name}`));
    el.querySelector("#btnCopyMsg").addEventListener("click", ()=> copyAutoMessage(`${s.last_name} ${s.first_name}`, stats));
  }

  function attachSwipe(cardEl){
    let startX=0, startY=0, active=false;
    cardEl.addEventListener("pointerdown", (e)=>{
      active = true; startX = e.clientX; startY = e.clientY;
      cardEl.setPointerCapture(e.pointerId);
    });
    cardEl.addEventListener("pointermove", (e)=>{
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      cardEl.style.transform = `translate(${dx}px, ${dy*0.3}px) rotate(${dx/25}deg)`;
      cardEl.style.transition = "none";
    });
    cardEl.addEventListener("pointerup", (e)=>{
      if (!active) return;
      active = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      cardEl.style.transition = "transform 180ms ease";
      cardEl.style.transform = "";
      if (dx > 110) return decide("present");
      if (dx < -110) return decide("absent");
      if (dy < -90) return decide("tardy");
    });
  }

  $("btnPresent").addEventListener("click", ()=> decide("present"));
  $("btnAbsent").addEventListener("click", ()=> decide("absent"));
  $("btnTardy").addEventListener("click", ()=> decide("tardy"));
  $("btnLater").addEventListener("click", ()=> decide("later"));

  async function decide(status){
    const s = currentStudent();
    if (!s) return;

    if (status === "later"){
      state.deferred.add(s.student_id);
      toast("Marcado para después → se cargará como TARDE al cerrar");
    } else {
      state.deferred.delete(s.student_id);
      await saveRecord(s.student_id, status);
      toast(statusLabel(status));
    }

    state.idx += 1;
    updateProgress();
    renderCurrentCard();
  }

  async function saveRecord(student_id, status, opts={}){
    const date = fmtDate(state.sessionDate);
    await jsonp("upsertRecord", {
      token: state.token,
      session_id: state.sessionId,
      course_id: state.course.course_id,
      date,
      student_id,
      status,
      justified: opts.justified ? 1 : 0,
      note: opts.note || ""
    });
  }

  $("btnOpenDeferred").addEventListener("click", ()=>{
    const items = state.students.filter(s => state.deferred.has(s.student_id));
    if (!items.length){ toast("No hay estudiantes en “Después”"); return; }

    openSheet({
      title: "Después",
      subtitle: "Al cerrar toma, se cargan como TARDE.",
      bodyHTML: `
        <div class="list">
          ${items.map(s => `
            <div class="listItem">
              <div class="listMain">
                <div class="listTitle">${escapeHtml(s.last_name)}, ${escapeHtml(s.first_name)}</div>
                <div class="listSub">Tocá para marcar presente ahora</div>
              </div>
              <button class="pill" data-id="${s.student_id}" type="button">✅ Presente</button>
            </div>
          `).join("")}
        </div>
      `,
      onMount: ()=>{
        $("sheetBody").querySelectorAll("button[data-id]").forEach(btn => {
          btn.addEventListener("click", async ()=>{
            const id = btn.getAttribute("data-id");
            state.deferred.delete(id);
            await saveRecord(id, "present");
            $("deferredCount").textContent = String(state.deferred.size);
            btn.closest(".listItem")?.remove();
            toast("Actualizado a Presente ✅");
            if (!state.deferred.size) closeSheet();
          });
        });
      }
    });
  });

  $("btnFinishSession").addEventListener("click", async ()=>{
    try{
      const pending = [...state.deferred];
      if (pending.length){
        veil(true, "Cerrando toma…");
        for (const sid of pending) await saveRecord(sid, "tardy");
      }
      await jsonp("closeSession", { token: state.token, session_id: state.sessionId });
      state.deferred.clear();
      veil(false);
      toast("Toma cerrada ✅");
      showScreen("courses");
      await loadCourses();
      renderCourses();
    } catch(err){
      fatal("No pude cerrar la toma", err.message);
    }
  });

  // ---------- History + justify ----------
  async function openHistory(student_id, studentName){
    veil(true, "Cargando faltas…");
    try{
      const res = await jsonp("getStudentHistory", { token: state.token, course_id: state.course.course_id, student_id, limit: 120 });
      const rows = res.records || [];
      veil(false);

      openSheet({
        title: `Faltas de ${studentName}`,
        subtitle: "Tocá una fila para justificar o cambiar estado.",
        bodyHTML: `
          <div class="list">
            <div class="muted">Para Educación Física de hoy, usá el botón abajo.</div>
            ${rows.length ? rows.map(r => `
              <div class="listItem" data-rid="${r.record_id}">
                <div class="listMain">
                  <div class="listTitle">${escapeHtml(r.date)} · ${escapeHtml(statusLabel(r.status))}</div>
                  <div class="listSub">${r.justified ? "Justificada ✅" : "Sin justificar"}${r.note ? " · " + escapeHtml(r.note) : ""}</div>
                </div>
                <span class="muted">›</span>
              </div>
            `).join("") : `<div class="muted">Todavía no hay registros para este estudiante.</div>`}
          </div>
        `,
        footerHTML: `
          <button id="btnMarkPE" class="pill" type="button">🏃‍♂️ EF (hoy)</button>
          <button id="btnCloseHist" class="pill pillPrimary" type="button">Listo</button>
        `,
        onMount: ()=>{
          $("btnCloseHist").onclick = closeSheet;
          $("btnMarkPE").onclick = ()=> openPEForToday(student_id);

          $("sheetBody").querySelectorAll(".listItem[data-rid]").forEach(item => {
            item.addEventListener("click", ()=> openEditRecord(item.getAttribute("data-rid")));
          });
        }
      });
    } catch(err){
      veil(false);
      toast("No pude cargar historial");
    }
  }

  function openPEForToday(student_id){
    openSheet({
      title: "Educación Física (hoy)",
      subtitle: "Se guarda para la fecha actual.",
      bodyHTML: `
        <div class="list">
          <div class="listItem">
            <div class="listMain">
              <div class="listTitle">🏃‍♂️ Asistió a EF</div>
              <div class="listSub">Marca el registro como EF presente</div>
            </div>
            <button id="btnPEPresent" class="pill pillPrimary" type="button">Guardar</button>
          </div>
          <div class="listItem">
            <div class="listMain">
              <div class="listTitle">❌ Faltó a EF</div>
              <div class="listSub">Marca el registro como EF falta</div>
            </div>
            <button id="btnPEAbsent" class="pill" type="button">Guardar</button>
          </div>
        </div>
      `,
      onMount: ()=>{
        $("btnPEPresent").onclick = async ()=>{ veil(true, "Guardando…"); await saveRecord(student_id, "pe_present"); veil(false); toast("EF presente ✅"); closeSheet(); };
        $("btnPEAbsent").onclick  = async ()=>{ veil(true, "Guardando…"); await saveRecord(student_id, "pe_absent");  veil(false); toast("EF falta ❌"); closeSheet(); };
      }
    });
  }

  async function openEditRecord(record_id){
    veil(true, "Cargando registro…");
    try{
      const res = await jsonp("getRecord", { token: state.token, record_id });
      const r = res.record;
      veil(false);

      openSheet({
        title: "Editar registro",
        subtitle: `${r.date} · ${statusLabel(r.status)}`,
        bodyHTML: `
          <div class="list">
            <label class="field">
              <span>Estado</span>
              <select id="editStatus">
                ${["present","tardy","absent","pe_present","pe_absent"].map(s => `
                  <option value="${s}" ${s===r.status ? "selected":""}>${statusLabel(s)}</option>
                `).join("")}
              </select>
            </label>
            <label class="field">
              <span>Nota (opcional)</span>
              <input id="editNote" type="text" placeholder="Ej: Certificado médico" value="${escapeHtml(r.note||"")}" />
            </label>
            <div class="listItem">
              <div class="listMain">
                <div class="listTitle">Justificar</div>
                <div class="listSub">No se borra: queda marcado como justificado</div>
              </div>
              <input id="editJust" type="checkbox" ${r.justified ? "checked":""} />
            </div>
          </div>
        `,
        footerHTML: `
          <button id="btnCancelEdit" class="pill" type="button">Cancelar</button>
          <button id="btnSaveEdit" class="pill pillPrimary" type="button">Guardar</button>
        `,
        onMount: ()=>{
          const sel = $("editStatus");
          sel.style.width = "100%";
          sel.style.height = "44px";
          sel.style.borderRadius = "14px";
          sel.style.border = "1px solid rgba(11,18,32,.08)";
          sel.style.padding = "0 12px";
          sel.style.background = "#fff";
          sel.style.fontSize = "14px";

          $("btnCancelEdit").onclick = closeSheet;
          $("btnSaveEdit").onclick = async ()=>{
            const status = $("editStatus").value;
            const note = $("editNote").value.trim();
            const justified = $("editJust").checked;
            veil(true, "Guardando…");
            await jsonp("updateRecord", { token: state.token, record_id, status, note, justified: justified ? 1 : 0 });
            veil(false);
            toast("Actualizado ✅");
            closeSheet();
          };
        }
      });
    } catch(err){
      veil(false);
      toast("No pude abrir el registro");
    }
  }

  // ---------- Alerts + message copy ----------
  function copy(text){
    try{ navigator.clipboard.writeText(text); toast("Mensaje copiado 📋"); }
    catch(e){
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      toast("Mensaje copiado 📋");
    }
  }

  function copyAutoMessage(studentName, stats){
    const courseName = state.course?.name || "curso";
    const ctx = {
      student: studentName,
      course: courseName,
      absences: stats.absences || 0,
      attendancePct: stats.attendance_pct || 100,
      threshold: cfg.LOW_ATTENDANCE_THRESHOLD || 75,
      milestone: stats.milestone || null
    };

    let msg = null;
    if ((stats.consecutive_absences||0) >= 3) msg = cfg.MESSAGE_TEMPLATES?.consecutive3?.(ctx);
    else if (ctx.milestone) msg = cfg.MESSAGE_TEMPLATES?.milestone?.(ctx);
    else if (stats.low_attendance) msg = cfg.MESSAGE_TEMPLATES?.lowAttendance?.(ctx);
    else msg = `Hola, te compartimos el estado de asistencia de ${ctx.student} (${ctx.course}).\n\nFaltas: ${ctx.absences}. Asistencia: ${ctx.attendancePct}%.`;

    copy(msg);
  }

  // Manual test button
  const btnTest = document.getElementById("btnTest");
  if (btnTest){
    btnTest.addEventListener("click", async ()=>{
      veil(true, "Probando conexión…");
      try{
        const res = await jsonp("ping", { t: Date.now() }, 9000);
        veil(false);
        openSheet({
          title: "Conexión OK ✅",
          subtitle: "El backend respondió.",
          bodyHTML: `<div class="muted">Respuesta: <code>${escapeHtml(JSON.stringify(res))}</code></div>`
        });
      } catch(err){
        veil(false);
        fatal("Falló el ping", err.message);
      }
    });
  }

  init();
})();
