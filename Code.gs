/**
 * Asistencia — Backend (Google Apps Script Web App)
 * Usa como base de datos un Google Spreadsheet con pestañas:
 * Users, Courses, CourseUsers, Students, Sessions, Records, Audit
 *
 * Deploy:
 * 1) Extensions > Apps Script (en el Spreadsheet) y pegá este archivo como Code.gs
 * 2) Deploy > New deployment > Web app:
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 3) Copiá la URL /exec y pegala en /config.js del frontend (GitHub Pages)
 *
 * Seguridad:
 * - Login con email + PIN (Users)
 * - Token temporario (CacheService, 12hs)
 * - Audit log de acciones
 */
const SHEETS = {
  USERS: "Users",
  COURSES: "Courses",
  COURSE_USERS: "CourseUsers",
  STUDENTS: "Students",
  SESSIONS: "Sessions",
  RECORDS: "Records",
  AUDIT: "Audit",
};

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12hs
const THRESHOLDS = [10, 15, 20, 25, 28];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : "{}");
    const action = body.action;

    // CORS
    const out = (obj) => ContentService
      .createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);

    if (!action) return out({ ok: false, error: "Missing action" });

    if (action === "login") return out(handleLogin(body));
    if (action === "me") return out(handleMe(body));

    // Protected actions
    const me = requireAuth(body);
    switch (action) {
      case "getCourses": return out(handleGetCourses(me));
      case "getStudents": return out(handleGetStudents(me, body));
      case "getSession": return out(handleGetSession(me, body));
      case "closeSession": return out(handleCloseSession(me, body));
      case "getRecords": return out(handleGetRecords(me, body));
      case "updateRecord": return out(handleUpdateRecord(me, body));
      case "upsertMany": return out(handleUpsertMany(me, body));
      case "getStats": return out(handleGetStats(me, body));
      case "getAlerts": return out(handleGetAlerts(me, body));
      default: return out({ ok: false, error: "Unknown action: " + action });
    }
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* ============ AUTH ============ */
function handleLogin(body) {
  const email = (body.email || "").toString().trim().toLowerCase();
  const pin = (body.pin || "").toString().trim();
  if (!email || !pin) return { ok: false, error: "Email y PIN requeridos." };

  const ss = SpreadsheetApp.getActive();
  const users = readTable(ss.getSheetByName(SHEETS.USERS));
  const user = users.find(u => String(u.email || "").toLowerCase() === email && String(u.pin || "") === pin && truthy(u.active));
  if (!user) return { ok: false, error: "Credenciales inválidas o usuario inactivo." };

  const token = Utilities.getUuid();
  CacheService.getScriptCache().put("tok:" + token, user.user_id, TOKEN_TTL_SECONDS);

  audit(ss, user.user_id, "login", { email });

  return { ok: true, token };
}

function handleMe(body) {
  const me = requireAuth(body);
  return { ok: true, me };
}

function requireAuth(body) {
  const token = (body.token || "").toString().trim();
  if (!token) throw new Error("Sin sesión. Volvé a iniciar.");
  const user_id = CacheService.getScriptCache().get("tok:" + token);
  if (!user_id) throw new Error("Sesión vencida. Volvé a iniciar.");

  const ss = SpreadsheetApp.getActive();
  const users = readTable(ss.getSheetByName(SHEETS.USERS));
  const me = users.find(u => u.user_id === user_id);
  if (!me || !truthy(me.active)) throw new Error("Usuario inválido o inactivo.");

  return {
    user_id: me.user_id,
    email: me.email,
    role: me.role,
    full_name: me.full_name || me.email,
  };
}

/* ============ DATA HELPERS ============ */
function truthy(v) {
  return v === true || v === "TRUE" || v === "true" || v === 1 || v === "1" || v === "Sí" || v === "SI";
}

function sheetEnsureHeaders(sheet, headers) {
  if (!sheet) throw new Error("Missing sheet");
  const first = sheet.getRange(1,1,1,Math.max(1, sheet.getLastColumn())).getValues()[0];
  const ok = headers.every((h, i) => String(first[i] || "") === h);
  if (ok) return;

  sheet.clear();
  sheet.getRange(1,1,1,headers.length).setValues([headers]);
}

function readTable(sheet) {
  if (!sheet) throw new Error("No existe la pestaña: " + sheet);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => String(h).trim());
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const obj = {};
    let empty = true;
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c];
      if (row[c] !== "" && row[c] !== null) empty = false;
    }
    if (!empty) out.push(obj);
  }
  return out;
}

function appendRow(sheet, headers, obj) {
  const row = headers.map(h => (obj[h] !== undefined ? obj[h] : ""));
  sheet.appendRow(row);
}

function audit(ss, user_id, action, payload) {
  const sheet = ss.getSheetByName(SHEETS.AUDIT);
  sheetEnsureHeaders(sheet, ["ts","user_id","action","payload"]);
  appendRow(sheet, ["ts","user_id","action","payload"], {
    ts: new Date().toISOString(),
    user_id,
    action,
    payload: JSON.stringify(payload || {})
  });
}

/* ============ COURSES / STUDENTS ============ */
function handleGetCourses(me) {
  const ss = SpreadsheetApp.getActive();
  const courses = readTable(ss.getSheetByName(SHEETS.COURSES)).filter(c => truthy(c.active));
  const cu = readTable(ss.getSheetByName(SHEETS.COURSE_USERS));
  const mineSet = new Set(cu.filter(x => x.user_id === me.user_id).map(x => x.course_id));

  let out = courses.map(c => ({
    course_id: c.course_id,
    name: c.name,
    year: c.year,
    division: c.division,
    turno: c.turno,
    is_mine: mineSet.has(c.course_id)
  }));

  // admins see all, preceptors also see all (but marked as cobertura)
  // if you want to restrict: uncomment next line
  // if (me.role !== "admin") out = out.filter(c => c.is_mine);

  // sort by year/div
  out.sort((a,b) => (Number(a.year) - Number(b.year)) || String(a.division).localeCompare(String(b.division)));
  return { ok: true, courses: out };
}

function handleGetStudents(me, body) {
  const course_id = (body.course_id || "").toString().trim();
  if (!course_id) throw new Error("Falta course_id.");

  const ss = SpreadsheetApp.getActive();
  const st = readTable(ss.getSheetByName(SHEETS.STUDENTS))
    .filter(s => truthy(s.active) && s.course_id === course_id)
    .map(s => ({
      student_id: s.student_id,
      course_id: s.course_id,
      last_name: s.last_name,
      first_name: s.first_name,
      dni: s.dni
    }))
    .sort((a,b) => String(a.last_name).localeCompare(String(b.last_name)));

  return { ok: true, students: st };
}

/* ============ SESSIONS / RECORDS ============ */
function makeSessionId(course_id, date, context) {
  // stable id (allows re-opening past days)
  return ["SES", course_id, date, context || "REGULAR"].join("|");
}

function ensureSessionsSheet(ss) {
  const sh = ss.getSheetByName(SHEETS.SESSIONS);
  sheetEnsureHeaders(sh, ["session_id","course_id","date","status","created_by","created_at","closed_at"]);
  return sh;
}

function ensureRecordsSheet(ss) {
  const sh = ss.getSheetByName(SHEETS.RECORDS);
  sheetEnsureHeaders(sh, ["record_id","session_id","course_id","date","student_id","status","justified","justified_by","justified_at","note","updated_at"]);
  return sh;
}

function handleGetSession(me, body) {
  const course_id = (body.course_id || "").toString().trim();
  const date = (body.date || "").toString().trim(); // YYYY-MM-DD
  const context = (body.context || "REGULAR").toString().trim();
  if (!course_id || !date) throw new Error("Faltan course_id o date.");

  const ss = SpreadsheetApp.getActive();
  const sh = ensureSessionsSheet(ss);
  const sessions = readTable(sh);

  const session_id = makeSessionId(course_id, date, context);
  let sess = sessions.find(s => s.session_id === session_id);

  if (!sess) {
    const now = new Date().toISOString();
    const created_by = me.user_id;
    appendRow(sh, ["session_id","course_id","date","status","created_by","created_at","closed_at"], {
      session_id,
      course_id,
      date,
      status: "OPEN",
      created_by,
      created_at: now,
      closed_at: ""
    });
    sess = { session_id, course_id, date, status:"OPEN", created_by, created_at: now, closed_at:"" };
    audit(ss, me.user_id, "create_session", { session_id, course_id, date, context });
  }

  // enrich created_by name
  const users = readTable(ss.getSheetByName(SHEETS.USERS));
  const u = users.find(x => x.user_id === sess.created_by);
  sess.created_by_name = u ? (u.full_name || u.email) : "";

  return { ok: true, session: sess };
}

function handleCloseSession(me, body) {
  const session_id = (body.session_id || "").toString().trim();
  if (!session_id) throw new Error("Falta session_id.");

  const ss = SpreadsheetApp.getActive();
  const sh = ensureSessionsSheet(ss);
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  const idx = headers.indexOf("session_id");
  const statusIdx = headers.indexOf("status");
  const closedIdx = headers.indexOf("closed_at");

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idx]) === session_id) {
      sh.getRange(r+1, statusIdx+1).setValue("CLOSED");
      sh.getRange(r+1, closedIdx+1).setValue(new Date().toISOString());
      audit(ss, me.user_id, "close_session", { session_id });
      return { ok: true };
    }
  }
  throw new Error("No existe la sesión: " + session_id);
}

function handleGetRecords(me, body) {
  const session_id = (body.session_id || "").toString().trim();
  if (!session_id) throw new Error("Falta session_id.");

  const ss = SpreadsheetApp.getActive();
  const sh = ensureRecordsSheet(ss);
  const rows = readTable(sh).filter(r => r.session_id === session_id);

  // Only fields needed by frontend
  const out = rows.map(r => ({
    student_id: r.student_id,
    status: r.status || null,
    note: r.note || ""
  }));
  return { ok: true, records: out };
}

function handleUpdateRecord(me, body) {
  const session_id = (body.session_id || "").toString().trim();
  const student_id = (body.student_id || "").toString().trim();
  const status = body.status ? String(body.status).trim() : "";
  const note = (body.note || "").toString();

  if (!session_id || !student_id) throw new Error("Faltan session_id o student_id.");

  const ss = SpreadsheetApp.getActive();
  const recordsSh = ensureRecordsSheet(ss);
  const sessions = readTable(ensureSessionsSheet(ss));
  const sess = sessions.find(s => s.session_id === session_id);
  if (!sess) throw new Error("Sesión inválida.");

  // upsert
  const values = recordsSh.getDataRange().getValues();
  const headers = values[0].map(String);
  const sidIdx = headers.indexOf("session_id");
  const stIdx = headers.indexOf("student_id");
  const statusIdx = headers.indexOf("status");
  const noteIdx = headers.indexOf("note");
  const updIdx = headers.indexOf("updated_at");

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][sidIdx]) === session_id && String(values[r][stIdx]) === student_id) {
      recordsSh.getRange(r+1, statusIdx+1).setValue(status || "");
      recordsSh.getRange(r+1, noteIdx+1).setValue(note || "");
      recordsSh.getRange(r+1, updIdx+1).setValue(new Date().toISOString());
      audit(ss, me.user_id, "update_record", { session_id, student_id, status, note });
      return { ok: true };
    }
  }

  // append
  const record_id = Utilities.getUuid();
  appendRow(recordsSh, headers, {
    record_id,
    session_id,
    course_id: sess.course_id,
    date: sess.date,
    student_id,
    status: status || "",
    justified: "",
    justified_by: "",
    justified_at: "",
    note: note || "",
    updated_at: new Date().toISOString()
  });
  audit(ss, me.user_id, "create_record", { session_id, student_id, status, note });
  return { ok: true };
}

function handleUpsertMany(me, body) {
  const session_id = (body.session_id || "").toString().trim();
  const course_id = (body.course_id || "").toString().trim();
  const date = (body.date || "").toString().trim();
  const context = (body.context || "REGULAR").toString().trim();
  const records = Array.isArray(body.records) ? body.records : [];
  if (!session_id || !course_id || !date) throw new Error("Faltan session_id/course_id/date.");

  const ss = SpreadsheetApp.getActive();
  const recordsSh = ensureRecordsSheet(ss);

  // Build map of existing rows for this session
  const values = recordsSh.getDataRange().getValues();
  const headers = values[0].map(String);
  const sidIdx = headers.indexOf("session_id");
  const stIdx = headers.indexOf("student_id");
  const statusIdx = headers.indexOf("status");
  const noteIdx = headers.indexOf("note");
  const updIdx = headers.indexOf("updated_at");

  const rowByStudent = {};
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][sidIdx]) === session_id) {
      rowByStudent[String(values[r][stIdx])] = r + 1; // 1-based row in sheet
    }
  }

  const now = new Date().toISOString();
  const toAppend = [];
  records.forEach(rec => {
    const student_id = String(rec.student_id || "").trim();
    if (!student_id) return;
    const status = rec.status ? String(rec.status).trim() : "";
    const note = (rec.note || "").toString();
    const row = rowByStudent[student_id];
    if (row) {
      recordsSh.getRange(row, statusIdx+1).setValue(status);
      recordsSh.getRange(row, noteIdx+1).setValue(note);
      recordsSh.getRange(row, updIdx+1).setValue(now);
    } else {
      toAppend.push({
        record_id: Utilities.getUuid(),
        session_id,
        course_id,
        date,
        student_id,
        status,
        justified: "",
        justified_by: "",
        justified_at: "",
        note,
        updated_at: now
      });
    }
  });

  if (toAppend.length) {
    const rows = toAppend.map(o => headers.map(h => o[h] !== undefined ? o[h] : ""));
    recordsSh.getRange(recordsSh.getLastRow()+1, 1, rows.length, headers.length).setValues(rows);
  }

  audit(ss, me.user_id, "upsert_many", { session_id, count: records.length, appended: toAppend.length });
  return { ok: true };
}

/* ============ STATS ============ */
function handleGetStats(me, body) {
  const course_id = (body.course_id || "ALL").toString().trim();
  const from = (body.from || "").toString().trim();
  const to = (body.to || "").toString().trim();
  const context = (body.context || "ALL").toString().trim(); // ALL|REGULAR|ED_FISICA
  if (!from || !to) throw new Error("Faltan from/to.");

  const ss = SpreadsheetApp.getActive();
  const sessions = readTable(ensureSessionsSheet(ss));
  const records = readTable(ensureRecordsSheet(ss));

  const inRange = (d) => d >= from && d <= to;
  const sessionOk = (s) => {
    if (!inRange(String(s.date))) return false;
    if (course_id !== "ALL" && String(s.course_id) !== course_id) return false;
    if (context !== "ALL" && !String(s.session_id).endsWith("|" + context)) return false;
    return true;
  };

  const sessionIds = new Set(sessions.filter(sessionOk).map(s => String(s.session_id)));
  let filtered = records.filter(r => sessionIds.has(String(r.session_id)));

  const c = { presentes:0, ausentes:0, tardes:0, verificar:0, total_records:0, sessions: sessionIds.size };
  const dailyMap = {};
  filtered.forEach(r => {
    const st = String(r.status || "");
    if (!st) return;
    c.total_records++;
    if (st === "PRESENTE") c.presentes++;
    else if (st === "AUSENTE") c.ausentes++;
    else if (st === "TARDE") c.tardes++;
    else if (st === "VERIFICAR") c.verificar++;

    const day = String(r.date || "");
    if (!dailyMap[day]) dailyMap[day] = { date: day, presentes:0, ausentes:0, tardes:0, verificar:0 };
    if (st === "PRESENTE") dailyMap[day].presentes++;
    else if (st === "AUSENTE") dailyMap[day].ausentes++;
    else if (st === "TARDE") dailyMap[day].tardes++;
    else if (st === "VERIFICAR") dailyMap[day].verificar++;
  });

  const daily = Object.keys(dailyMap).sort().map(k => dailyMap[k]);

  return { ok:true, summary: c, daily };
}

/* ============ ALERTS ============ */
function handleGetAlerts(me, body) {
  const course_id = (body.course_id || "ALL").toString().trim();
  const to = (body.to || "").toString().trim();
  const context = (body.context || "ALL").toString().trim();
  if (!to) throw new Error("Falta to.");

  const ss = SpreadsheetApp.getActive();
  const students = readTable(ss.getSheetByName(SHEETS.STUDENTS)).filter(s => truthy(s.active));
  const sessions = readTable(ensureSessionsSheet(ss));
  const records = readTable(ensureRecordsSheet(ss));

  const studentMap = {};
  students.forEach(s => {
    if (course_id !== "ALL" && String(s.course_id) !== course_id) return;
    studentMap[String(s.student_id)] = {
      student_id: String(s.student_id),
      course_id: String(s.course_id),
      student_name: `${s.last_name}, ${s.first_name}`,
    };
  });

  const inScopeSession = (s) => {
    if (String(s.date) > to) return false;
    if (course_id !== "ALL" && String(s.course_id) !== course_id) return false;
    if (context !== "ALL" && !String(s.session_id).endsWith("|" + context)) return false;
    return true;
  };

  const scopeSessions = sessions.filter(inScopeSession).sort((a,b)=> String(a.date).localeCompare(String(b.date)));
  const scopeIds = new Set(scopeSessions.map(s => String(s.session_id)));

  // Build per-student day list of absences
  const absencesByStudent = {};
  records.forEach(r => {
    const sid = String(r.student_id || "");
    if (!studentMap[sid]) return;
    if (!scopeIds.has(String(r.session_id))) return;
    if (String(r.status) !== "AUSENTE") return;
    const day = String(r.date || "");
    if (!absencesByStudent[sid]) absencesByStudent[sid] = [];
    absencesByStudent[sid].push(day);
  });

  // total absences + streak ending at "to"
  const alerts = [];
  Object.keys(studentMap).forEach(sid => {
    const days = (absencesByStudent[sid] || []).sort();
    if (!days.length) return;

    const total = days.length;

    // streak: count consecutive days up to 'to'
    const daySet = new Set(days);
    let streak = 0;
    let cur = to;
    while (daySet.has(cur)) {
      streak++;
      cur = shiftDate(cur, -1);
    }

    let reasons = [];
    if (streak >= 3) reasons.push(`${streak} días consecutivos ausente`);
    THRESHOLDS.forEach(t => { if (total === t) reasons.push(`llegó a ${t} faltas`); });

    if (reasons.length) {
      alerts.push({
        student_id: sid,
        student_name: studentMap[sid].student_name,
        absences_total: total,
        absences_streak: streak,
        reason: reasons.join(" • ")
      });
    }
  });

  // Sort: streak desc then total desc
  alerts.sort((a,b) => (b.absences_streak - a.absences_streak) || (b.absences_total - a.absences_total) || a.student_name.localeCompare(b.student_name));

  return { ok:true, alerts };
}

function shiftDate(iso, deltaDays) {
  const parts = iso.split("-").map(Number);
  const d = new Date(parts[0], parts[1]-1, parts[2]);
  d.setDate(d.getDate() + deltaDays);
  const pad = (n) => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
