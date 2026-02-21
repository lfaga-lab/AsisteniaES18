/**
 * Asistencia - Backend en Google Apps Script (Google Sheets).
 * Se consume desde GitHub Pages usando JSONP (doGet con callback=...).
 *
 * Hojas:
 * - Users: user_id, email, pin, role(admin|preceptor), full_name, active, created_at
 * - Courses: course_id, name, year, division, turno, active
 * - CourseUsers: course_id, user_id (asignación de preceptores a cursos)
 * - Students: student_id, course_id, last_name, first_name, dni, active
 * - Sessions: session_id, course_id, date(YYYY-MM-DD), status(open|closed), created_by, created_at, closed_at
 * - Records: record_id, session_id, course_id, date, student_id, status, justified, justified_by, justified_at, note, updated_at
 * - Audit: ts, user_id, action, payload
 */

const SHEETS = {
  USERS: 'Users',
  COURSES: 'Courses',
  COURSE_USERS: 'CourseUsers',
  STUDENTS: 'Students',
  SESSIONS: 'Sessions',
  RECORDS: 'Records',
  AUDIT: 'Audit'
};

const TOKEN_TTL_SEC = 6 * 60 * 60; // 6hs
const LOW_ATTENDANCE_THRESHOLD = 75;
const ABSENCE_MILESTONES = [10, 15, 20, 25, 28];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📌 ASISTENCIA')
    .addItem('1) Crear estructura de hojas', 'setupSheets')
    .addItem('2) Cargar DEMO (3 admins, 3 preceptores, 6 cursos, 180 estudiantes)', 'seedDemoData')
    .addSeparator()
    .addItem('Ver ayuda de despliegue', 'showDeployHelp')
    .addToUi();
}

function showDeployHelp() {
  const html = HtmlService.createHtmlOutput(`
    <div style="font-family:system-ui;padding:12px;line-height:1.4">
      <h2>Despliegue Web App</h2>
      <ol>
        <li>En Apps Script: <b>Deploy</b> → <b>New deployment</b></li>
        <li>Type: <b>Web app</b></li>
        <li>Execute as: <b>Me</b></li>
        <li>Who has access: <b>Anyone</b> (para que GitHub Pages pueda llamar)</li>
        <li>Copiá la URL que termina en <code>/exec</code> y pegala en <code>config.js</code> (WEB_APP_URL).</li>
      </ol>
      <p><b>Nota:</b> por CORS, la app usa JSONP (callback) vía <code>doGet</code>.</p>
    </div>
  `).setWidth(520).setHeight(420);
  SpreadsheetApp.getUi().showModalDialog(html, 'Ayuda');
}

// ---------- Web API (JSONP) ----------
function doGet(e) {
  const action = (e.parameter.action || '').trim();
  const callback = (e.parameter.callback || '').trim() || null;

  let payload;
  try {
    payload = route_(action, e.parameter);
    if (!payload) payload = ok_({});
  } catch (err) {
    payload = { ok: false, error: String(err && err.message ? err.message : err) };
  }

  // JSONP response
  const body = callback ? `${callback}(${JSON.stringify(payload)});` : JSON.stringify(payload);
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function route_(action, p) {
  if (action === 'ping') return ok_({ ts: new Date().toISOString() });

  if (action === 'login') return login_(p.email, p.pin);

  // actions below require token
  const user = requireAuth_(p.token);

  switch (action) {
    case 'getCourses': return getCourses_(user);
    case 'getStudents': return getStudents_(user, p.course_id);
    case 'ensureSession': return ensureSession_(user, p.course_id, p.date);
    case 'closeSession': return closeSession_(user, p.session_id);
    case 'upsertRecord': return upsertRecord_(user, p);
    case 'getCourseStats': return getCourseStats_(user, p.course_id);
    case 'getStudentHistory': return getStudentHistory_(user, p.course_id, p.student_id, parseInt(p.limit || '120', 10));
    case 'getRecord': return getRecord_(user, p.record_id);
    case 'updateRecord': return updateRecord_(user, p);
    default: throw new Error('Acción inválida: ' + action);
  }
}

// ---------- Auth ----------
function login_(email, pin) {
  email = (email || '').toLowerCase().trim();
  pin = (pin || '').trim();

  if (!email || !pin) throw new Error('Email y PIN son obligatorios.');

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.USERS);
  if (!sh) throw new Error('Falta hoja Users. Ejecutá "Crear estructura de hojas".');

  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  const row = rows.find(r =>
    String(r[idx.email]).toLowerCase().trim() === email &&
    String(r[idx.pin]).trim() === pin &&
    String(r[idx.active]).toLowerCase().trim() !== 'false'
  );
  if (!row) throw new Error('Credenciales inválidas.');

  const user = {
    user_id: String(row[idx.user_id]),
    email: String(row[idx.email]),
    role: String(row[idx.role] || 'preceptor'),
    full_name: String(row[idx.full_name] || email)
  };

  const token = createToken_(user);
  audit_(user.user_id, 'login', { email: user.email });

  return ok_({ token, user });
}

function requireAuth_(token) {
  token = (token || '').trim();
  if (!token) throw new Error('Falta token.');

  const cache = CacheService.getScriptCache();
  const raw = cache.get('T:' + token);
  if (!raw) throw new Error('Sesión expirada. Volvé a ingresar.');

  return JSON.parse(raw);
}

function createToken_(user) {
  const token = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('T:' + token, JSON.stringify(user), TOKEN_TTL_SEC);
  return token;
}

// ---------- Data access helpers ----------
function setupSheets() {
  const ss = SpreadsheetApp.getActive();

  ensureSheet_(ss, SHEETS.USERS, ['user_id','email','pin','role','full_name','active','created_at']);
  ensureSheet_(ss, SHEETS.COURSES, ['course_id','name','year','division','turno','active']);
  ensureSheet_(ss, SHEETS.COURSE_USERS, ['course_id','user_id']);
  ensureSheet_(ss, SHEETS.STUDENTS, ['student_id','course_id','last_name','first_name','dni','active']);
  ensureSheet_(ss, SHEETS.SESSIONS, ['session_id','course_id','date','status','created_by','created_at','closed_at']);
  ensureSheet_(ss, SHEETS.RECORDS, ['record_id','session_id','course_id','date','student_id','status','justified','justified_by','justified_at','note','updated_at']);
  ensureSheet_(ss, SHEETS.AUDIT, ['ts','user_id','action','payload']);

  SpreadsheetApp.getUi().alert('Listo ✅ Hojas creadas/actualizadas.');
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.setFrozenRows(1);
}

function indexMap_(header) {
  const m = {};
  header.forEach((h, i) => m[String(h).trim()] = i);
  return m;
}

function getCourses_(user) {
  const ss = SpreadsheetApp.getActive();
  const cSh = ss.getSheetByName(SHEETS.COURSES);
  const cuSh = ss.getSheetByName(SHEETS.COURSE_USERS);
  if (!cSh || !cuSh) throw new Error('Faltan hojas. Ejecutá setupSheets.');

  const cRows = cSh.getDataRange().getValues();
  const cHeader = cRows.shift();
  const ci = indexMap_(cHeader);

  let allowed = null;
  if (user.role !== 'admin') {
    const cuRows = cuSh.getDataRange().getValues();
    const cuHeader = cuRows.shift();
    const cui = indexMap_(cuHeader);
    allowed = new Set(cuRows.filter(r => String(r[cui.user_id]) === user.user_id).map(r => String(r[cui.course_id])));
  }

  const courses = cRows
    .filter(r => String(r[ci.active]).toLowerCase() !== 'false')
    .filter(r => !allowed || allowed.has(String(r[ci.course_id])))
    .map(r => ({
      course_id: String(r[ci.course_id]),
      name: String(r[ci.name]),
      year: Number(r[ci.year] || 0),
      division: String(r[ci.division] || ''),
      turno: String(r[ci.turno] || ''),
      active: true
    }));

  return ok_({ courses });
}

function getStudents_(user, courseId) {
  courseId = String(courseId || '').trim();
  if (!courseId) throw new Error('Falta course_id.');
  requireCourseAccess_(user, courseId);

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.STUDENTS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  const students = rows
    .filter(r => String(r[idx.course_id]) === courseId)
    .filter(r => String(r[idx.active]).toLowerCase() !== 'false')
    .map(r => ({
      student_id: String(r[idx.student_id]),
      course_id: String(r[idx.course_id]),
      last_name: String(r[idx.last_name]),
      first_name: String(r[idx.first_name]),
      dni: String(r[idx.dni] || ''),
      active: true
    }))
    .sort((a,b) => (a.last_name + a.first_name).localeCompare(b.last_name + b.first_name));

  return ok_({ students });
}

function requireCourseAccess_(user, courseId) {
  if (user.role === 'admin') return true;

  const ss = SpreadsheetApp.getActive();
  const cuSh = ss.getSheetByName(SHEETS.COURSE_USERS);
  const rows = cuSh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  const ok = rows.some(r => String(r[idx.user_id]) === user.user_id && String(r[idx.course_id]) === courseId);
  if (!ok) throw new Error('No tenés acceso a este curso.');
  return true;
}

// ---------- Sessions ----------
function ensureSession_(user, courseId, date) {
  courseId = String(courseId || '').trim();
  date = String(date || '').trim(); // YYYY-MM-DD
  if (!courseId || !date) throw new Error('Falta course_id o date.');
  requireCourseAccess_(user, courseId);

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.SESSIONS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  // find existing
  for (let i=0; i<rows.length; i++) {
    if (String(rows[i][idx.course_id]) === courseId && String(rows[i][idx.date]) === date) {
      const session_id = String(rows[i][idx.session_id]);
      return ok_({ session_id });
    }
  }

  const session_id = Utilities.getUuid();
  sh.appendRow([session_id, courseId, date, 'open', user.user_id, new Date().toISOString(), '']);
  audit_(user.user_id, 'ensureSession', { courseId, date, session_id });

  return ok_({ session_id });
}

function closeSession_(user, sessionId) {
  sessionId = String(sessionId || '').trim();
  if (!sessionId) throw new Error('Falta session_id.');

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.SESSIONS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  for (let r=0; r<rows.length; r++) {
    if (String(rows[r][idx.session_id]) === sessionId) {
      const courseId = String(rows[r][idx.course_id]);
      requireCourseAccess_(user, courseId);

      sh.getRange(r+2, idx.status+1).setValue('closed');
      sh.getRange(r+2, idx.closed_at+1).setValue(new Date().toISOString());
      audit_(user.user_id, 'closeSession', { sessionId });
      return ok_({});
    }
  }
  throw new Error('Session no encontrada.');
}

// ---------- Records ----------
function upsertRecord_(user, p) {
  const sessionId = String(p.session_id || '').trim();
  const courseId = String(p.course_id || '').trim();
  const date = String(p.date || '').trim();
  const studentId = String(p.student_id || '').trim();
  const status = String(p.status || '').trim();
  const justified = String(p.justified || '0') === '1';
  const note = String(p.note || '');

  if (!sessionId || !courseId || !date || !studentId || !status) throw new Error('Parámetros incompletos.');
  requireCourseAccess_(user, courseId);

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.RECORDS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  // find record by (session_id + student_id)
  let rowIndex = -1;
  for (let i=0; i<rows.length; i++) {
    if (String(rows[i][idx.session_id]) === sessionId && String(rows[i][idx.student_id]) === studentId) {
      rowIndex = i;
      break;
    }
  }

  const now = new Date().toISOString();
  if (rowIndex >= 0) {
    const sheetRow = rowIndex + 2;
    sh.getRange(sheetRow, idx.status+1).setValue(status);
    sh.getRange(sheetRow, idx.justified+1).setValue(justified ? true : false);
    sh.getRange(sheetRow, idx.note+1).setValue(note);
    sh.getRange(sheetRow, idx.updated_at+1).setValue(now);
  } else {
    const record_id = Utilities.getUuid();
    sh.appendRow([record_id, sessionId, courseId, date, studentId, status, justified, justified ? user.user_id : '', justified ? now : '', note, now]);
  }

  audit_(user.user_id, 'upsertRecord', { sessionId, courseId, date, studentId, status, justified });

  return ok_({});
}

function getRecord_(user, recordId) {
  recordId = String(recordId || '').trim();
  if (!recordId) throw new Error('Falta record_id.');

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.RECORDS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  for (let i=0; i<rows.length; i++) {
    if (String(rows[i][idx.record_id]) === recordId) {
      const courseId = String(rows[i][idx.course_id]);
      requireCourseAccess_(user, courseId);
      return ok_({ record: rowToRecord_(rows[i], idx) });
    }
  }
  throw new Error('Record no encontrado.');
}

function updateRecord_(user, p) {
  const recordId = String(p.record_id || '').trim();
  const status = String(p.status || '').trim();
  const note = String(p.note || '');
  const justified = String(p.justified || '0') === '1';

  if (!recordId || !status) throw new Error('Faltan parámetros.');

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.RECORDS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  for (let i=0; i<rows.length; i++) {
    if (String(rows[i][idx.record_id]) === recordId) {
      const courseId = String(rows[i][idx.course_id]);
      requireCourseAccess_(user, courseId);

      const now = new Date().toISOString();
      const sheetRow = i + 2;
      sh.getRange(sheetRow, idx.status+1).setValue(status);
      sh.getRange(sheetRow, idx.note+1).setValue(note);
      sh.getRange(sheetRow, idx.justified+1).setValue(justified ? true : false);
      sh.getRange(sheetRow, idx.justified_by+1).setValue(justified ? user.user_id : '');
      sh.getRange(sheetRow, idx.justified_at+1).setValue(justified ? now : '');
      sh.getRange(sheetRow, idx.updated_at+1).setValue(now);

      audit_(user.user_id, 'updateRecord', { recordId, status, justified });
      return ok_({});
    }
  }
  throw new Error('Record no encontrado.');
}

function rowToRecord_(r, idx) {
  return {
    record_id: String(r[idx.record_id]),
    session_id: String(r[idx.session_id]),
    course_id: String(r[idx.course_id]),
    date: String(r[idx.date]),
    student_id: String(r[idx.student_id]),
    status: String(r[idx.status]),
    justified: Boolean(r[idx.justified]),
    justified_by: String(r[idx.justified_by] || ''),
    justified_at: String(r[idx.justified_at] || ''),
    note: String(r[idx.note] || ''),
    updated_at: String(r[idx.updated_at] || '')
  };
}

// ---------- History + Stats ----------
function getStudentHistory_(user, courseId, studentId, limit) {
  courseId = String(courseId || '').trim();
  studentId = String(studentId || '').trim();
  if (!courseId || !studentId) throw new Error('Faltan parámetros.');
  requireCourseAccess_(user, courseId);

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.RECORDS);
  const rows = sh.getDataRange().getValues();
  const header = rows.shift();
  const idx = indexMap_(header);

  const records = rows
    .filter(r => String(r[idx.course_id]) === courseId && String(r[idx.student_id]) === studentId)
    .map(r => rowToRecord_(r, idx))
    .sort((a,b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, Math.max(1, limit || 120));

  return ok_({ records });
}

function getCourseStats_(user, courseId) {
  courseId = String(courseId || '').trim();
  if (!courseId) throw new Error('Falta course_id.');
  requireCourseAccess_(user, courseId);

  // stats computed from Records
  const ss = SpreadsheetApp.getActive();
  const stuSh = ss.getSheetByName(SHEETS.STUDENTS);
  const recSh = ss.getSheetByName(SHEETS.RECORDS);

  const stuRows = stuSh.getDataRange().getValues();
  const stuHeader = stuRows.shift();
  const si = indexMap_(stuHeader);

  const students = stuRows
    .filter(r => String(r[si.course_id]) === courseId)
    .filter(r => String(r[si.active]).toLowerCase() !== 'false')
    .map(r => ({ student_id: String(r[si.student_id]), last_name: String(r[si.last_name]), first_name: String(r[si.first_name]) }));

  const recRows = recSh.getDataRange().getValues();
  const recHeader = recRows.shift();
  const ri = indexMap_(recHeader);

  // collect dates for this course (sessions basis = distinct dates in Sessions)
  const sessSh = ss.getSheetByName(SHEETS.SESSIONS);
  const sessRows = sessSh.getDataRange().getValues();
  const sessHeader = sessRows.shift();
  const xi = indexMap_(sessHeader);
  const dates = sessRows.filter(r => String(r[xi.course_id]) === courseId).map(r => String(r[xi.date]));
  const totalSessions = dates.length || 0;
  const dateSet = new Set(dates);

  // records map
  const map = {}; // student -> array of {date,status}
  students.forEach(s => map[s.student_id] = []);

  recRows.forEach(r => {
    if (String(r[ri.course_id]) !== courseId) return;
    const d = String(r[ri.date]);
    if (!dateSet.has(d)) return; // only count recorded sessions for this course
    const sid = String(r[ri.student_id]);
    if (!map[sid]) return;
    map[sid].push({ date: d, status: String(r[ri.status]) });
  });

  // compute consecutive absences from last dates
  const sortedDates = dates.slice().sort(); // asc
  const milestones = ABSENCE_MILESTONES.slice().sort((a,b)=>a-b);

  const stats = students.map(s => {
    const arr = map[s.student_id] || [];
    let absences = 0;
    const byDate = {};
    arr.forEach(x => byDate[x.date] = x.status);

    sortedDates.forEach(d => {
      const st = byDate[d];
      if (st === 'absent' || st === 'pe_absent') absences += 1;
    });

    const attendancePct = totalSessions ? Math.max(0, Math.round(((totalSessions - absences) / totalSessions) * 100)) : 100;

    // streak from end
    let streak = 0;
    for (let i=sortedDates.length-1; i>=0; i--) {
      const st = byDate[sortedDates[i]];
      if (st === 'absent' || st === 'pe_absent') streak += 1;
      else break;
    }

    const milestone = milestones.includes(absences) ? absences : null;
    const lowAttendance = attendancePct < LOW_ATTENDANCE_THRESHOLD;

    return {
      student_id: s.student_id,
      absences: absences,
      attendance_pct: attendancePct,
      consecutive_absences: streak,
      milestone: milestone,
      low_attendance: lowAttendance
    };
  });

  return ok_({ stats });
}

// ---------- Audit ----------
function audit_(userId, action, payload) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.AUDIT);
  if (!sh) return;
  sh.appendRow([new Date().toISOString(), userId, action, JSON.stringify(payload || {})]);
}

function ok_(data) {
  const out = data || {};
  out.ok = true;
  return out;
}

// ---------- DEMO seed ----------
function seedDemoData() {
  setupSheets();

  const ss = SpreadsheetApp.getActive();
  const uSh = ss.getSheetByName(SHEETS.USERS);
  const cSh = ss.getSheetByName(SHEETS.COURSES);
  const cuSh = ss.getSheetByName(SHEETS.COURSE_USERS);
  const sSh = ss.getSheetByName(SHEETS.STUDENTS);

  // Users
  const users = [
    ['U-ADMIN-1','admin1@demo.edu.ar','1234','admin','Admin Demo 1',true,new Date().toISOString()],
    ['U-ADMIN-2','admin2@demo.edu.ar','1234','admin','Admin Demo 2',true,new Date().toISOString()],
    ['U-ADMIN-3','admin3@demo.edu.ar','1234','admin','Admin Demo 3',true,new Date().toISOString()],
    ['U-PREC-1','preceptor1@demo.edu.ar','1111','preceptor','Preceptor Demo 1',true,new Date().toISOString()],
    ['U-PREC-2','preceptor2@demo.edu.ar','2222','preceptor','Preceptor Demo 2',true,new Date().toISOString()],
    ['U-PREC-3','preceptor3@demo.edu.ar','3333','preceptor','Preceptor Demo 3',true,new Date().toISOString()],
  ];
  uSh.getRange(2,1,users.length,users[0].length).setValues(users);

  // Courses
  const courses = [
    ['C-1A','1°A',1,'A','Mañana',true],
    ['C-1B','1°B',1,'B','Mañana',true],
    ['C-2A','2°A',2,'A','Tarde',true],
    ['C-2B','2°B',2,'B','Tarde',true],
    ['C-3A','3°A',3,'A','Mañana',true],
    ['C-3B','3°B',3,'B','Tarde',true],
  ];
  cSh.getRange(2,1,courses.length,courses[0].length).setValues(courses);

  // Assignments (2 cursos por preceptor)
  const assigns = [
    ['C-1A','U-PREC-1'], ['C-1B','U-PREC-1'],
    ['C-2A','U-PREC-2'], ['C-2B','U-PREC-2'],
    ['C-3A','U-PREC-3'], ['C-3B','U-PREC-3'],
  ];
  cuSh.getRange(2,1,assigns.length,assigns[0].length).setValues(assigns);

  // Students 180
  const first = ['Sofía','Martina','Valentina','Camila','Lucía','Jazmín','Mía','Emma','Catalina','Abril','Mateo','Benjamín','Thiago','Joaquín','Santino','Tomás','Felipe','Nicolás','Bruno','Franco','Agustín','Dylan','Lautaro','Ian','Ramiro','Facundo','Bautista','Simón','Ezequiel','Gael'];
  const last  = ['González','Rodríguez','Gómez','Fernández','López','Martínez','Pérez','Sánchez','Romero','Díaz','Torres','Ruiz','Ramírez','Flores','Acosta','Benítez','Herrera','Medina','Castro','Ortiz','Silva','Molina','Rojas','Vega','Méndez','Ponce','Cabrera','Figueroa','Peralta','Aguirre'];

  let dni = 42000000;
  const out = [];
  for (let i=0; i<courses.length; i++) {
    const courseId = courses[i][0];
    for (let n=0; n<30; n++) {
      const fn = first[(i*7+n) % first.length];
      const ln = last[(i*11+n) % last.length];
      out.push([`S-${courseId}-${dni}`, courseId, ln, fn, String(dni), true]);
      dni++;
    }
  }
  sSh.getRange(2,1,out.length,out[0].length).setValues(out);

  SpreadsheetApp.getUi().alert('DEMO cargado ✅\\n\\nLogin demo:\\n- preceptor1@demo.edu.ar / 1111\\n- preceptor2@demo.edu.ar / 2222\\n- preceptor3@demo.edu.ar / 3333\\n- admin1@demo.edu.ar / 1234');
}
