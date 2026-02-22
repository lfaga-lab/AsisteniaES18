// Supabase Edge Function: asistencia-api
// Implementa el mismo contrato que el backend Apps Script (action + token)
//
// Requiere secrets:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
//
// Nota: usa tabla public.tokens para sesiones (12hs)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type Me = { user_id: string; email: string; role: string; full_name: string };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secrets");
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const JUST_MARK = "__J1__"; // marcador interno de "falta justificada" en records.note
const TOKEN_TTL_HOURS = 12;
const THRESHOLDS = [5, 10, 15, 20, 25, 28];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function errMsg(e: unknown) {
  if (e && typeof e === "object" && "message" in e) return String((e as any).message);
  return String(e);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isJustified(note: unknown): boolean {
  return String(note ?? "").startsWith(JUST_MARK);
}

async function audit(user_id: string | null, action: string, payload: unknown) {
  try {
    await db.from("audit").insert({
      user_id,
      action,
      payload: payload ?? null,
      ts: new Date().toISOString(),
    });
  } catch (_e) {
    // No bloquear la app por auditoría
  }
}

async function requireAuth(body: any): Promise<Me> {
  const token = String(body?.token ?? "").trim();
  if (!token) throw new Error("Sin sesión. Volvé a iniciar.");

  // IMPORTANTE:
  // Antes se hacía un DELETE de tokens vencidos en cada request (await),
  // y eso puede trabar el login si la tabla tokens creció mucho o no tiene índices.
  // Ahora validamos por expires_at > now y dejamos la limpieza para un job externo.
  const nowIso = new Date().toISOString();

  const { data: tok, error } = await db
    .from("tokens")
    .select("user_id, expires_at, users:user_id (user_id,email,role,full_name,active)")
    .eq("token", token)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (error || !tok) throw new Error("Sesión vencida. Volvé a iniciar.");
  const u = (tok as any).users;
  if (!u || !u.active) throw new Error("Usuario inválido o inactivo.");

  return {
    user_id: u.user_id,
    email: u.email,
    role: u.role,
    full_name: u.full_name ?? u.email,
  };
}

function sessionId(course_id: string, date: string, context: string) {
  return `SES|${course_id}|${date}|${context}`;
}

function parseSessionMeta(session_id: string) {
  // SES|{course_id}|{YYYY-MM-DD}|{context}
  const parts = String(session_id || "").split("|");
  return {
    course_id: parts[1] || "",
    date: parts[2] || "",
    context: parts[3] || "REGULAR",
  };
}

async function getMineCourseIds(user_id: string): Promise<Set<string>> {
  const { data, error } = await db
    .from("course_users")
    .select("course_id")
    .eq("user_id", user_id);

  if (error) throw new Error("No se pudieron leer cursos.");
  const set = new Set<string>();
  (data ?? []).forEach((r: any) => set.add(String(r.course_id)));
  return set;
}

function hasCourseAccess(me: Me, course_id: string, mineCourseIds: Set<string>) {
  // Para cobertura: un preceptor puede tomar lista en cualquier curso.
  if (me.role === "admin" || me.role === "preceptor") return true;
  return mineCourseIds.has(course_id);
}

async function handleLogin(body: any) {
  const email = String(body?.email ?? "").trim().toLowerCase();
  const pin = String(body?.pin ?? "").trim();
  if (!email || !pin) return { ok: false, error: "Email y PIN requeridos." };

  const { data, error } = await db.rpc("asistencia_verify_login", {
    p_email: email,
    p_pin: pin,
  });

  if (error) return { ok: false, error: "Error de login." };
  const row = (data as any[])?.[0];
  if (!row) return { ok: false, error: "Credenciales inválidas o usuario inactivo." };

  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
  const { error: e2 } = await db.from("tokens").insert({
    token,
    user_id: row.user_id,
    expires_at: expires,
  });
  if (e2) return { ok: false, error: "No se pudo iniciar sesión." };

  await audit(row.user_id, "login", { email });
  return { ok: true, token };
}

async function handleGetCourses(me: Me) {
  // Devuelve TODOS los cursos activos; marca cuáles son "míos" y quién es el preceptor titular.
  const { data: coursesRaw, error: eC } = await db
    .from("courses")
    .select("course_id,name,year,division,turno,active")
    .eq("active", true)
    .order("year", { ascending: true })
    .order("division", { ascending: true });

  if (eC) throw new Error("No se pudieron leer cursos.");

  const mine = await getMineCourseIds(me.user_id);

  // course_users para identificar titular y asignaciones
  const courseIds = (coursesRaw ?? []).map((c: any) => String(c.course_id));
  let cu: any[] = [];
  if (courseIds.length) {
    const { data: cuRows, error: eCu } = await db
      .from("course_users")
      .select("course_id,user_id")
      .in("course_id", courseIds);
    if (!eCu) cu = cuRows ?? [];
  }

  const userIds = Array.from(new Set(cu.map((r: any) => String(r.user_id))));
  let users: any[] = [];
  if (userIds.length) {
    const { data: uRows, error: eU } = await db
      .from("users")
      .select("user_id,full_name,email,role,active")
      .in("user_id", userIds);
    if (!eU) users = uRows ?? [];
  }

  const uMap: Record<string, any> = {};
  users.forEach((u: any) => { uMap[String(u.user_id)] = u; });

  // owner = primer usuario asignado al curso cuyo role sea 'preceptor'
  const owners: Record<string, any> = {};
  cu.forEach((r: any) => {
    const cid = String(r.course_id);
    if (owners[cid]) return;
    const u = uMap[String(r.user_id)];
    if (!u) return;
    if (String(u.role) !== "preceptor") return;
    if (u.active === false) return;
    owners[cid] = u;
  });

  const courses = (coursesRaw ?? []).map((c: any) => {
    const cid = String(c.course_id);
    const owner = owners[cid];
    return {
      ...c,
      is_mine: mine.has(cid),
      owner_user_id: owner ? String(owner.user_id) : null,
      owner_name: owner ? String(owner.full_name || owner.email) : null,
    };
  });

  return { ok: true, courses };
}

async function handleGetStudents(me: Me, body: any) {
  const course_id = String(body?.course_id ?? "").trim();
  if (!course_id) throw new Error("Falta course_id.");

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, course_id, mine)) throw new Error("No tenés acceso a ese curso.");

  const { data, error } = await db
    .from("students")
    .select("student_id,course_id,last_name,first_name,dni,guardian_phone,active")
    .eq("course_id", course_id)
    .eq("active", true)
    .order("last_name", { ascending: true })
    .order("first_name", { ascending: true });

  if (error) throw new Error("No se pudieron leer estudiantes.");
  return { ok: true, students: data ?? [] };
}

async function handleGetSession(me: Me, body: any) {
  const course_id = String(body?.course_id ?? "").trim();
  const date = String(body?.date ?? "").trim(); // YYYY-MM-DD
  const context = String(body?.context ?? "REGULAR").trim(); // REGULAR|ED_FISICA
  if (!course_id || !date) throw new Error("Faltan course_id/date.");

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, course_id, mine)) throw new Error("No tenés acceso a ese curso.");

  const sid = sessionId(course_id, date, context);

  const { data: existing, error: e1 } = await db
    .from("sessions")
    .select("session_id,course_id,date,status,created_by,created_at,closed_at,context, users:created_by(full_name)")
    .eq("session_id", sid)
    .maybeSingle();

  if (e1) throw new Error("No se pudo leer sesión.");

  if (existing) {
    const session = {
      ...existing,
      created_by_name: (existing as any).users?.full_name ?? null,
    };
    return { ok: true, session };
  }

  const nowIso = new Date().toISOString();
  const { error: e2 } = await db.from("sessions").insert({
    session_id: sid,
    course_id,
    date,
    context, // ✅ IMPORTANT: guardar context
    status: "OPEN",
    created_by: me.user_id,
    created_at: nowIso,
    closed_at: null,
  });

  if (e2) throw new Error("No se pudo crear sesión.");

  await audit(me.user_id, "create_session", { session_id: sid, course_id, date, context });

  return {
    ok: true,
    session: {
      session_id: sid,
      course_id,
      date,
      context,
      status: "OPEN",
      created_by: me.user_id,
      created_by_name: me.full_name,
      created_at: nowIso,
      closed_at: null,
    },
  };
}

async function handleCloseSession(me: Me, body: any) {
  const session_id = String(body?.session_id ?? "").trim();
  if (!session_id) throw new Error("Falta session_id.");

  const { data: sess, error } = await db
    .from("sessions")
    .select("session_id, course_id, created_by")
    .eq("session_id", session_id)
    .maybeSingle();

  if (error || !sess) throw new Error("Sesión inexistente.");

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, String(sess.course_id), mine)) throw new Error("No tenés acceso a ese curso.");

  const { error: e2 } = await db
    .from("sessions")
    .update({ status: "CLOSED", closed_at: new Date().toISOString() })
    .eq("session_id", session_id);

  if (e2) throw new Error("No se pudo cerrar la sesión.");

  await audit(me.user_id, "close_session", { session_id });
  return { ok: true };
}

async function handleGetRecords(me: Me, body: any) {
  const session_id = String(body?.session_id ?? "").trim();
  if (!session_id) throw new Error("Falta session_id.");

  const { data: sess, error } = await db
    .from("sessions")
    .select("session_id, course_id")
    .eq("session_id", session_id)
    .maybeSingle();
  if (error || !sess) throw new Error("Sesión inexistente.");

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, String(sess.course_id), mine)) throw new Error("No tenés acceso a ese curso.");

  const { data, error: e2 } = await db
    .from("records")
    .select("student_id,status,note,updated_at")
    .eq("session_id", session_id);

  if (e2) throw new Error("No se pudieron leer registros.");
  return { ok: true, records: data ?? [] };
}

async function handleUpdateRecord(me: Me, body: any) {
  const session_id = String(body?.session_id ?? "").trim();
  const student_id = String(body?.student_id ?? "").trim();
  const status = body?.status === null || body?.status === "" ? null : String(body?.status);
  const note = String(body?.note ?? "").trim() || null;
  if (!session_id || !student_id) throw new Error("Faltan session_id/student_id.");

  const { data: sess, error } = await db
    .from("sessions")
    .select("session_id, course_id, date")
    .eq("session_id", session_id)
    .maybeSingle();
  if (error || !sess) throw new Error("Sesión inexistente.");

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, String(sess.course_id), mine)) throw new Error("No tenés acceso a ese curso.");

  const row = {
    session_id,
    course_id: String(sess.course_id),
    date: sess.date,
    student_id,
    status,
    note,
    updated_at: new Date().toISOString(),
  };

  const { error: e2 } = await db
    .from("records")
    .upsert(row, { onConflict: "session_id,student_id" });

  if (e2) throw new Error("No se pudo guardar.");

  await audit(me.user_id, "update_record", { session_id, student_id, status });
  return { ok: true };
}

async function handleUpsertMany(me: Me, body: any) {
  const session_id = String(body?.session_id ?? "").trim();
  const course_id = String(body?.course_id ?? "").trim();
  const date = String(body?.date ?? "").trim();
  const context = String(body?.context ?? "REGULAR").trim();
  const records = Array.isArray(body?.records) ? body.records : [];
  if (!session_id || !course_id || !date) throw new Error("Faltan datos.");

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, course_id, mine)) throw new Error("No tenés acceso a ese curso.");

  const nowIso = new Date().toISOString();
  const rows = records.map((r: any) => ({
    session_id,
    course_id,
    date,
    student_id: String(r.student_id),
    status: r.status === "" ? null : r.status,
    note: r.note ? String(r.note) : null,
    updated_at: nowIso,
  }));

  if (!rows.length) return { ok: true };

  const { error } = await db.from("records").upsert(rows, { onConflict: "session_id,student_id" });
  if (error) throw new Error("No se pudo guardar.");

  await audit(me.user_id, "upsert_many", { session_id, course_id, date, context, n: rows.length });
  return { ok: true };
}

function countInit() {
  return {
    total: 0, // ✅ FALTABA y se usa
    presentes: 0,
    ausentes: 0,
    justificadas: 0,
    tardes: 0,
    verificar: 0,
    total_records: 0,
    sessions: 0,
    // equivalencias: REGULAR=1, ED_FISICA=0.5, TARDE=0.25
    total_equiv: 0,
    faltas_equiv: 0,
    ausentes_equiv: 0,
    tardes_equiv: 0,
    justificadas_equiv: 0,
  };
}

function sessionWeight(context: string) {
  const c = String(context || "REGULAR").toUpperCase();
  return c === "ED_FISICA" ? 0.5 : 1;
}

function faltaEquiv(status: string, context: string) {
  const st = String(status || "").toUpperCase();
  if (st === "AUSENTE") return sessionWeight(context);
  if (st === "TARDE") return 0.25;
  return 0;
}

// Regla: si el/la estudiante está AUSENTE en REGULAR y ED_FISICA el mismo día, cuenta 1 sola falta (no 1.5).
function capAbsenceDay(regAbsent: boolean, edAbsent: boolean) {
  return Math.max(regAbsent ? 1 : 0, edAbsent ? 0.5 : 0);
}
function capJustifiedDay(regJust: boolean, edJust: boolean, absenceCapped: number) {
  const sum = (regJust ? 1 : 0) + (edJust ? 0.5 : 0);
  return Math.min(absenceCapped, sum);
}

async function handleGetStats(me: Me, body: any) {
  const course_id = String(body?.course_id ?? "ALL").trim();
  const from = String(body?.from ?? "").trim();
  const to = String(body?.to ?? "").trim();
  const context = String(body?.context ?? "ALL").trim();
  if (!from || !to) throw new Error("Faltan from/to.");

  const mine = await getMineCourseIds(me.user_id);

  // sesiones en rango
  let q = db.from("sessions").select("session_id,course_id,date,context").gte("date", from).lte("date", to);
  if (course_id !== "ALL") q = q.eq("course_id", course_id);
  if (context !== "ALL") q = q.eq("context", context);
  const { data: sessions, error: e1 } = await q;
  if (e1) throw new Error("No se pudieron leer sesiones.");

  const allowedSessions = (sessions ?? []).filter((s: any) => hasCourseAccess(me, String(s.course_id), mine));
  const sessionIds = allowedSessions.map((s: any) => String(s.session_id));
  const sessionMeta: Record<string, any> = {};
  allowedSessions.forEach((s: any) => {
    const sid = String(s.session_id);
    sessionMeta[sid] = { date: String(s.date || ""), context: String(s.context || "REGULAR") };
  });

  const summary = countInit();
  summary.sessions = sessionIds.length;

  if (!sessionIds.length) return { ok: true, summary, daily: [] };

  const { data: recs, error: e2 } = await db
    .from("records")
    .select("session_id,student_id,status,note")
    .in("session_id", sessionIds);

  if (e2) throw new Error("No se pudieron leer registros.");

  const dailyMap: Record<string, any> = {};
  const absByDayStudent: Record<string, Record<string, { reg: boolean; ed: boolean; regJ: boolean; edJ: boolean }>> = {};

  (recs ?? []).forEach((r: any) => {
    const sessId = String(r.session_id ?? "");
    const meta = sessionMeta[sessId] || { date: "", context: "REGULAR" };
    const date = String(meta.date || "");
    if (!date) return;

    if (!dailyMap[date]) dailyMap[date] = { date, ...countInit() };
    const day = dailyMap[date];

    const status = String(r.status ?? "");
    if (!status) return;

    const ctx = String(meta.context || "REGULAR");
    const w = sessionWeight(ctx);

    summary.total++;
    summary.total_equiv += w;

    day.total++;
    day.total_equiv += w;

    if (status === "PRESENTE") { summary.presentes++; day.presentes++; return; }
    if (status === "VERIFICAR") { summary.verificar++; day.verificar++; return; }

    if (status === "TARDE") {
      summary.tardes++; day.tardes++;
      summary.tardes_equiv += 0.25; day.tardes_equiv += 0.25;
      summary.faltas_equiv += 0.25; day.faltas_equiv += 0.25;
      return;
    }

    if (status === "AUSENTE") {
      const sid = String(r.student_id ?? "");
      if (!absByDayStudent[date]) absByDayStudent[date] = {};
      if (!absByDayStudent[date][sid]) absByDayStudent[date][sid] = { reg: false, ed: false, regJ: false, edJ: false };

      const upper = String(ctx).toUpperCase();
      const just = isJustified(r.note);
      if (upper === "ED_FISICA") { absByDayStudent[date][sid].ed = true; if (just) absByDayStudent[date][sid].edJ = true; }
      else { absByDayStudent[date][sid].reg = true; if (just) absByDayStudent[date][sid].regJ = true; }
      return;
    }
  });

  Object.keys(absByDayStudent).forEach((date) => {
    const students = absByDayStudent[date] || {};
    const day = dailyMap[date];
    if (!day) return;

    Object.keys(students).forEach((sid) => {
      const v = students[sid];
      const a = capAbsenceDay(!!v.reg, !!v.ed);
      const j = capJustifiedDay(!!v.regJ, !!v.edJ, a);

      summary.ausentes += a;
      summary.ausentes_equiv += a;
      summary.justificadas += j;
      summary.justificadas_equiv += j;
      summary.faltas_equiv += a;

      day.ausentes += a;
      day.ausentes_equiv += a;
      day.justificadas += j;
      day.justificadas_equiv += j;
      day.faltas_equiv += a;
    });
  });

  const daily = Object.keys(dailyMap).sort().map((k) => dailyMap[k]);
  return { ok: true, summary, daily };
}

async function handleGetStudentStats(me: Me, body: any) {
  const course_id = String(body?.course_id ?? "ALL").trim();
  const from = String(body?.from ?? "").trim();
  const to = String(body?.to ?? "").trim();
  const context = String(body?.context ?? "ALL").trim();
  if (!from || !to) throw new Error("Faltan from/to.");

  const mine = await getMineCourseIds(me.user_id);

  let qs = db.from("sessions").select("session_id,course_id,context").gte("date", from).lte("date", to);
  if (course_id !== "ALL") qs = qs.eq("course_id", course_id);
  if (context !== "ALL") qs = qs.eq("context", context);
  const { data: sessions, error: e1 } = await qs;
  if (e1) throw new Error("No se pudieron leer sesiones.");

  const allowedSessions = (sessions ?? []).filter((s: any) => hasCourseAccess(me, String(s.course_id), mine));
  const sessionIds = new Set<string>(allowedSessions.map((s: any) => String(s.session_id)));
  const sessionCtx: Record<string, string> = {};
  allowedSessions.forEach((s: any) => { sessionCtx[String(s.session_id)] = String(s.context || "REGULAR"); });

  let qst = db.from("students").select("student_id,course_id,last_name,first_name,guardian_phone").eq("active", true);
  if (course_id !== "ALL") qst = qst.eq("course_id", course_id);
  const { data: students, error: e2 } = await qst;
  if (e2) throw new Error("No se pudieron leer estudiantes.");

  const stMap: Record<string, any> = {};
  (students ?? []).forEach((s: any) => {
    if (course_id === "ALL" && !hasCourseAccess(me, String(s.course_id), mine)) return;
    stMap[String(s.student_id)] = {
      student_id: String(s.student_id),
      course_id: String(s.course_id),
      student_name: `${s.last_name}, ${s.first_name}`,
      guardian_phone: s.guardian_phone ?? null,
      presentes: 0,
      ausentes: 0,
      justificadas: 0,
      tardes: 0,
      verificar: 0,
      total: 0,
      total_equiv: 0,
      faltas_equiv: 0,
      ausentes_equiv: 0,
      tardes_equiv: 0,
      justificadas_equiv: 0,
    };
  });

  if (!sessionIds.size) return { ok: true, students: Object.values(stMap), sessions: 0 };

  let qr = db
    .from("records")
    .select("session_id,student_id,status,note, sessions!inner(date,context)")
    .gte("sessions.date", from)
    .lte("sessions.date", to);

  if (course_id !== "ALL") qr = qr.eq("course_id", course_id);
  if (context !== "ALL") qr = qr.eq("sessions.context", context);

  const { data: recs, error: e3 } = await qr;
  if (e3) throw new Error("No se pudieron leer registros: " + e3.message);

  const absByStudentDay: Record<string, Record<string, { reg: boolean; ed: boolean; regJ: boolean; edJ: boolean }>> = {};

  (recs ?? []).forEach((r: any) => {
    const sid = String(r.student_id ?? "");
    const st = stMap[sid];
    if (!st) return;

    const sessId = String(r.session_id ?? "");
    if (!sessionIds.has(sessId)) return;

    const status = String(r.status ?? "");
    if (!status) return;

    const s = (r as any).sessions ?? {};
    const date = String(s.date ?? parseSessionMeta(sessId).date ?? "");
    const ctx = String(s.context ?? sessionCtx[sessId] ?? parseSessionMeta(sessId).context ?? "REGULAR");

    st.total++;
    const w = sessionWeight(ctx);
    st.total_equiv += w;

    if (status === "PRESENTE") st.presentes++;
    else if (status === "TARDE") { st.tardes++; st.tardes_equiv += 0.25; st.faltas_equiv += 0.25; }
    else if (status === "VERIFICAR") st.verificar++;
    else if (status === "AUSENTE") {
      if (!absByStudentDay[sid]) absByStudentDay[sid] = {};
      if (!absByStudentDay[sid][date]) absByStudentDay[sid][date] = { reg: false, ed: false, regJ: false, edJ: false };

      const upper = String(ctx || "REGULAR").toUpperCase();
      const just = isJustified(r.note);
      if (upper === "ED_FISICA") { absByStudentDay[sid][date].ed = true; if (just) absByStudentDay[sid][date].edJ = true; }
      else { absByStudentDay[sid][date].reg = true; if (just) absByStudentDay[sid][date].regJ = true; }
    }
  });

  Object.keys(absByStudentDay).forEach((sid) => {
    const st = stMap[sid];
    if (!st) return;
    const byDay = absByStudentDay[sid] || {};
    Object.keys(byDay).forEach((d) => {
      const v = byDay[d];
      const a = capAbsenceDay(!!v.reg, !!v.ed);
      const j = capJustifiedDay(!!v.regJ, !!v.edJ, a);

      st.ausentes += a;
      st.ausentes_equiv += a;
      st.justificadas += j;
      st.justificadas_equiv += j;
      st.faltas_equiv += a;
    });
  });

  const list = Object.values(stMap).sort((a: any, b: any) =>
    (b.faltas_equiv - a.faltas_equiv) || (b.tardes - a.tardes) || a.student_name.localeCompare(b.student_name)
  );

  return { ok: true, students: list, sessions: sessionIds.size };
}

async function handleGetStudentTimeline(me: Me, body: any) {
  const course_id = String(body?.course_id ?? "").trim();
  const student_id = String(body?.student_id ?? "").trim();
  let from = String(body?.from ?? "").trim();
  let to = String(body?.to ?? "").trim();
  const context = String(body?.context ?? "ALL").trim();

  if (!course_id || !student_id) throw new Error("Faltan course_id/student_id.");

  if (!to) to = todayISO();
  if (!from) from = "1900-01-01";

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, course_id, mine)) throw new Error("Sin acceso a ese curso.");

  let qr = db
    .from("records")
    .select("status,note,session_id, sessions!inner(date,context)")
    .eq("course_id", course_id)
    .eq("student_id", student_id)
    .gte("sessions.date", from)
    .lte("sessions.date", to);

  if (context !== "ALL") qr = qr.eq("sessions.context", context);

  const { data, error } = await qr;
  if (error) throw new Error("No se pudieron leer registros: " + error.message);

  const list = (data ?? [])
    .map((r: any) => {
      const meta = parseSessionMeta(String(r.session_id ?? ""));
      const s = (r as any).sessions ?? {};
      const date = String(s.date ?? meta.date ?? "");
      const ctx = String(s.context ?? meta.context ?? "REGULAR");
      const status = String(r.status ?? "");
      const w = sessionWeight(ctx);
      const fe = faltaEquiv(status, ctx);
      return {
        date,
        context: ctx,
        status,
        note: r.note ?? "",
        justified: (status === "AUSENTE" && isJustified(r.note)),
        session_id: r.session_id,
        session_weight: w,
        falta_equiv: fe,
      };
    })
    .filter((x: any) => !!x.date)
    .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));

  return { ok: true, records: list };
}

async function handleGetCourseSummary(me: Me, body: any) {
  const from = String(body?.from ?? "").trim();
  const to = String(body?.to ?? "").trim();
  const context = String(body?.context ?? "ALL").trim();
  if (!from || !to) throw new Error("Faltan from/to.");

  const mine = await getMineCourseIds(me.user_id);

  const { data: courses, error: e0 } = await db
    .from("courses")
    .select("course_id,name,turno")
    .eq("active", true);
  if (e0) throw new Error("No se pudieron leer cursos.");

  const courseMap: Record<string, any> = {};
  (courses ?? []).forEach((c: any) => {
    courseMap[String(c.course_id)] = {
      course_id: String(c.course_id),
      name: String(c.name ?? c.course_id),
      turno: String(c.turno ?? ""),
      total: 0,
      presentes: 0,
      ausentes: 0,
      justificadas: 0,
      tardes: 0,
      verificar: 0,
      total_equiv: 0,
      faltas_equiv: 0,
      ausentes_equiv: 0,
      tardes_equiv: 0,
      justificadas_equiv: 0,
    };
  });

  let qs = db.from("sessions").select("session_id,course_id,date,context").gte("date", from).lte("date", to);
  if (context !== "ALL") qs = qs.eq("context", context);
  if (me.role !== "admin") qs = qs.in("course_id", Array.from(mine));
  const { data: sessions, error: e1 } = await qs;
  if (e1) throw new Error("No se pudieron leer sesiones.");

  const allowed = (sessions ?? []).filter((s: any) => hasCourseAccess(me, String(s.course_id), mine));
  const sessionIds = allowed.map((s: any) => String(s.session_id));
  const sessionMeta: Record<string, any> = {};
  allowed.forEach((s: any) => {
    const sid = String(s.session_id);
    sessionMeta[sid] = parseSessionMeta(sid);
    if (s.course_id) sessionMeta[sid].course_id = String(s.course_id);
    if (s.date) sessionMeta[sid].date = String(s.date);
    if (s.context) sessionMeta[sid].context = String(s.context);
  });

  if (!sessionIds.length) return { ok: true, courses: Object.values(courseMap) };

  const { data: recs, error: e2 } = await db
    .from("records")
    .select("session_id,course_id,student_id,status,note, sessions!inner(date,context)")
    .in("session_id", sessionIds);

  if (e2) throw new Error("No se pudieron leer registros.");

  const absByKey: Record<string, { reg: boolean; ed: boolean; regJ: boolean; edJ: boolean }> = {};
  const keyOf = (cid: string, sid: string, date: string) => `${cid}||${sid}||${date}`;

  (recs ?? []).forEach((r: any) => {
    const sessId = String(r.session_id ?? "");
    const meta = sessionMeta[sessId] || parseSessionMeta(sessId);

    const cid = String(r.course_id ?? meta.course_id ?? "");
    if (!cid || !courseMap[cid]) return;

    const st = String(r.status ?? "");
    if (!st) return;

    courseMap[cid].total++;

    const s = (r as any).sessions ?? {};
    const date = String(s.date ?? meta.date ?? "");
    const ctx = String(s.context ?? meta.context ?? "REGULAR");
    const w = sessionWeight(ctx);
    courseMap[cid].total_equiv += w;

    if (st === "PRESENTE") { courseMap[cid].presentes++; return; }
    if (st === "TARDE") {
      courseMap[cid].tardes++;
      courseMap[cid].tardes_equiv += 0.25;
      courseMap[cid].faltas_equiv += 0.25;
      return;
    }
    if (st === "VERIFICAR") { courseMap[cid].verificar++; return; }

    if (st === "AUSENTE") {
      const sid = String((r as any).student_id ?? "");
      const k = keyOf(cid, sid, date);
      if (!absByKey[k]) absByKey[k] = { reg: false, ed: false, regJ: false, edJ: false };

      const upper = String(ctx || "REGULAR").toUpperCase();
      const just = isJustified(r.note);
      if (upper === "ED_FISICA") { absByKey[k].ed = true; if (just) absByKey[k].edJ = true; }
      else { absByKey[k].reg = true; if (just) absByKey[k].regJ = true; }
      return;
    }
  });

  Object.keys(absByKey).forEach((k) => {
    const parts = k.split("||");
    const cid = parts[0];
    if (!cid || !courseMap[cid]) return;
    const v = absByKey[k];
    const a = capAbsenceDay(!!v.reg, !!v.ed);
    const j = capJustifiedDay(!!v.regJ, !!v.edJ, a);

    courseMap[cid].ausentes += a;
    courseMap[cid].ausentes_equiv += a;
    courseMap[cid].justificadas += j;
    courseMap[cid].justificadas_equiv += j;
    courseMap[cid].faltas_equiv += a;
  });

  return { ok: true, courses: Object.values(courseMap) };
}

function shiftDateISO(iso: string, deltaDays: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function handleAckAlert(me: Me, body: any) {
  const student_id = String(body?.student_id ?? "").trim();
  const course_id = String(body?.course_id ?? "").trim();
  const to = String(body?.to ?? "").trim();
  const context = String(body?.context ?? "ALL").trim();
  if (!student_id || !course_id || !to) throw new Error("Faltan datos.");

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, course_id, mine)) throw new Error("Sin permiso para ese curso.");

  const { error } = await db.from("alerts_ack").upsert({
    student_id,
    course_id,
    context,
    acked_until_date: to,
    acked_by: me.user_id,
    acked_at: new Date().toISOString(),
  }, { onConflict: "student_id,course_id,context" });

  if (error) throw new Error("No se pudo marcar como avisado.");
  await audit(me.user_id, "ackAlert", { student_id, course_id, context, to });
  return { ok: true };
}

async function handleUpdateStudentPhone(me: Me, body: any) {
  const student_id = String(body?.student_id ?? "").trim();
  const guardian_phone = String(body?.guardian_phone ?? "").trim();
  if (!student_id) throw new Error("Falta student_id.");

  const { error } = await db
    .from("students")
    .update({ guardian_phone })
    .eq("student_id", student_id);

  if (error) throw new Error("No se pudo guardar el celular.");
  await audit(me.user_id, "updateStudentPhone", { student_id });
  return { ok: true };
}

async function handleGetAlerts(me: Me, body: any) {
  const course_id = String(body?.course_id ?? "ALL").trim();
  const to = String(body?.to ?? "").trim();
  const context = String(body?.context ?? "ALL").trim();
  if (!to) throw new Error("Falta to.");

  const mine = await getMineCourseIds(me.user_id);

  let qst = db.from("students").select("student_id,course_id,last_name,first_name,guardian_phone").eq("active", true);
  if (course_id !== "ALL") qst = qst.eq("course_id", course_id);
  const { data: students, error: e1 } = await qst;
  if (e1) throw new Error("No se pudieron leer estudiantes.");

  const stMap: Record<string, any> = {};
  (students ?? []).forEach((s: any) => {
    if (course_id === "ALL" && !hasCourseAccess(me, String(s.course_id), mine)) return;
    stMap[String(s.student_id)] = {
      student_id: String(s.student_id),
      course_id: String(s.course_id),
      student_name: `${s.last_name}, ${s.first_name}`,
      guardian_phone: s.guardian_phone ?? null,
    };
  });

  const courseIds = Array.from(new Set(Object.values(stMap).map((s: any) => String(s.course_id))));
  let ackMap: Record<string, any> = {};
  if (courseIds.length) {
    const { data: acks, error: eAck } = await db
      .from("alerts_ack")
      .select("student_id,course_id,context,acked_until_date")
      .in("course_id", courseIds)
      .gte("acked_until_date", to);

    if (!eAck) {
      (acks ?? []).forEach((a: any) => {
        const key = `${a.student_id}|${a.course_id}|${a.context}`;
        ackMap[key] = String(a.acked_until_date ?? "");
      });
    }
  }

  let qs = db.from("sessions").select("session_id,course_id,date,context").lte("date", to);
  if (course_id !== "ALL") qs = qs.eq("course_id", course_id);
  if (context !== "ALL") qs = qs.eq("context", context);
  const { data: sessions, error: e2 } = await qs;
  if (e2) throw new Error("No se pudieron leer sesiones.");

  const allowed = (sessions ?? []).filter((s: any) => hasCourseAccess(me, String(s.course_id), mine));
  const scopeIds = new Set<string>(allowed.map((s: any) => String(s.session_id)));

  // records tiene date (se guarda al upsert/updateRecord)
  let qr = db.from("records").select("session_id,student_id,date,status").lte("date", to).eq("status", "AUSENTE");
  if (course_id !== "ALL") qr = qr.eq("course_id", course_id);
  const { data: recs, error: e3 } = await qr;
  if (e3) throw new Error("No se pudieron leer registros.");

  const absencesByStudent: Record<string, string[]> = {};
  (recs ?? []).forEach((r: any) => {
    if (!scopeIds.has(String(r.session_id))) return;
    const sid = String(r.student_id ?? "");
    if (!stMap[sid]) return;
    const day = String(r.date ?? "");
    if (!absencesByStudent[sid]) absencesByStudent[sid] = [];
    absencesByStudent[sid].push(day);
  });

  const alerts: any[] = [];
  Object.keys(stMap).forEach((sid) => {
    const days = (absencesByStudent[sid] ?? []).sort();
    if (!days.length) return;
    const total = days.length;

    const set = new Set(days);
    let streak = 0;
    let cur = to;
    while (set.has(cur)) {
      streak++;
      cur = shiftDateISO(cur, -1);
    }

    const reasons: string[] = [];
    if (streak >= 3) reasons.push(`${streak} días consecutivos ausente`);
    if (total >= 5 && total < 10) reasons.push(`tiene ${total} faltas`);
    THRESHOLDS.forEach((t) => {
      if (t >= 10 && total >= t) reasons.push(`llegó a ${t} faltas`);
    });

    if (reasons.length) {
      const cid = stMap[sid].course_id;
      const k1 = `${sid}|${cid}|${context}`;
      const k2 = `${sid}|${cid}|ALL`;
      if (ackMap[k1] || ackMap[k2]) return;
      alerts.push({
        student_id: sid,
        course_id: cid,
        student_name: stMap[sid].student_name,
        absences_total: total,
        absences_streak: streak,
        reason: reasons.join(" • "),
        guardian_phone: stMap[sid].guardian_phone ?? null,
      });
    }
  });

  alerts.sort((a, b) =>
    (b.absences_streak - a.absences_streak) ||
    (b.absences_total - a.absences_total) ||
    a.student_name.localeCompare(b.student_name)
  );

  return { ok: true, alerts };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  // ✅ leer body UNA sola vez (evita errores por doble lectura del stream)
  let body: any = {};
  try {
    const txt = await req.text();
    body = txt ? JSON.parse(txt) : {};
  } catch (_e) {
    body = {};
  }

  const action = String(body?.action ?? "").trim();

  try {
    if (!action) return json({ ok: false, error: "Missing action" });

    if (action === "login") return json(await handleLogin(body));
    if (action === "me") {
      const me = await requireAuth(body);
      return json({ ok: true, me });
    }

    const me = await requireAuth(body);
    switch (action) {
      case "getCourses": return json(await handleGetCourses(me));
      case "getStudents": return json(await handleGetStudents(me, body));
      case "getSession": return json(await handleGetSession(me, body));
      case "closeSession": return json(await handleCloseSession(me, body));
      case "getRecords": return json(await handleGetRecords(me, body));
      case "updateRecord": return json(await handleUpdateRecord(me, body));
      case "upsertMany": return json(await handleUpsertMany(me, body));
      case "getStats": return json(await handleGetStats(me, body));
      case "getStudentStats": return json(await handleGetStudentStats(me, body));
      case "getStudentTimeline": return json(await handleGetStudentTimeline(me, body));
      case "getCourseSummary": return json(await handleGetCourseSummary(me, body));
      case "getAlerts": return json(await handleGetAlerts(me, body));
      case "ackAlert": return json(await handleAckAlert(me, body));
      case "updateStudentPhone": return json(await handleUpdateStudentPhone(me, body));
      default:
        return json({ ok: false, error: "Unknown action: " + action });
    }
  } catch (e) {
    const message = errMsg(e);
    // mantenemos status 200 para que el frontend siempre pueda parsear JSON
    return json({ ok: false, error: message });
  }
});