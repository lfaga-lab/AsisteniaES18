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

type Json = Record<string, unknown>;
type Me = { user_id: string; email: string; role: string; full_name: string };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secrets");
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TOKEN_TTL_HOURS = 12;
const THRESHOLDS = [10, 15, 20, 25, 28];

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

  // limpiar tokens vencidos (best effort)
  await db.from("tokens").delete().lt("expires_at", new Date().toISOString());

  const { data: tok, error } = await db
    .from("tokens")
    .select("user_id, expires_at, users:user_id (user_id,email,role,full_name,active)")
    .eq("token", token)
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

function hasCourseAccess(me: Me, course_id: string, mineCourseIds: Set<string>) {
  if (me.role === "admin") return true;
  return mineCourseIds.has(course_id);
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
  if (me.role === "admin") {
    const { data, error } = await db
      .from("courses")
      .select("course_id,name,year,division,turno,active")
      .eq("active", true)
      .order("year", { ascending: true })
      .order("division", { ascending: true });

    if (error) throw new Error("No se pudieron leer cursos.");
    const mine = await getMineCourseIds(me.user_id);
    const courses = (data ?? []).map((c: any) => ({
      ...c,
      is_mine: mine.has(String(c.course_id)),
    }));
    return { ok: true, courses };
  }

  const mine = await getMineCourseIds(me.user_id);
  if (!mine.size) return { ok: true, courses: [] };

  const { data, error } = await db
    .from("courses")
    .select("course_id,name,year,division,turno,active")
    .in("course_id", Array.from(mine))
    .eq("active", true)
    .order("year", { ascending: true })
    .order("division", { ascending: true });

  if (error) throw new Error("No se pudieron leer cursos.");
  const courses = (data ?? []).map((c: any) => ({ ...c, is_mine: true }));
  return { ok: true, courses };
}

async function handleGetStudents(me: Me, body: any) {
  const course_id = String(body?.course_id ?? "").trim();
  if (!course_id) throw new Error("Falta course_id.");

  const mine = await getMineCourseIds(me.user_id);
  if (!hasCourseAccess(me, course_id, mine)) throw new Error("No tenés acceso a ese curso.");

  const { data, error } = await db
    .from("students")
    .select("student_id,course_id,last_name,first_name,dni,active")
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
    status: "OPEN",
    created_by: me.user_id,
    created_at: nowIso,
    closed_at: null,
  });

  if (e2) throw new Error("No se pudo crear sesión.");

  await audit(me.user_id, "create_session", { session_id: sid, course_id, date, context });

  // devolver la sesión recién creada
  return {
    ok: true,
    session: {
      session_id: sid,
      course_id,
      date,
      status: "OPEN",
      created_by: me.user_id,
      created_by_name: me.full_name,
      created_at: nowIso,
      closed_at: null,
      context,
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
  return { presentes: 0, ausentes: 0, tardes: 0, verificar: 0, total_records: 0, sessions: 0 };
}

function tally(c: any, status: string) {
  if (!status) return;
  c.total_records++;
  if (status === "PRESENTE") c.presentes++;
  else if (status === "AUSENTE") c.ausentes++;
  else if (status === "TARDE") c.tardes++;
  else if (status === "VERIFICAR") c.verificar++;
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
  const summary = countInit();
  summary.sessions = sessionIds.length;

  if (!sessionIds.length) return { ok: true, summary, daily: [] };

  // registros de esas sesiones
  const { data: recs, error: e2 } = await db
    .from("records")
    .select("session_id,date,status")
    .in("session_id", sessionIds);

  if (e2) throw new Error("No se pudieron leer registros.");

  const dailyMap: Record<string, any> = {};
  (recs ?? []).forEach((r: any) => {
    const st = String(r.status ?? "");
    if (!st) return;
    tally(summary, st);

    const day = String(r.date ?? "");
    if (!dailyMap[day]) dailyMap[day] = { date: day, presentes: 0, ausentes: 0, tardes: 0, verificar: 0 };
    if (st === "PRESENTE") dailyMap[day].presentes++;
    else if (st === "AUSENTE") dailyMap[day].ausentes++;
    else if (st === "TARDE") dailyMap[day].tardes++;
    else if (st === "VERIFICAR") dailyMap[day].verificar++;
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

  // sesiones en rango (para filtrar contexto de forma correcta)
  let qs = db.from("sessions").select("session_id,course_id,context").gte("date", from).lte("date", to);
  if (course_id !== "ALL") qs = qs.eq("course_id", course_id);
  if (context !== "ALL") qs = qs.eq("context", context);
  const { data: sessions, error: e1 } = await qs;
  if (e1) throw new Error("No se pudieron leer sesiones.");

  const allowedSessions = (sessions ?? []).filter((s: any) => hasCourseAccess(me, String(s.course_id), mine));
  const sessionIds = new Set<string>(allowedSessions.map((s: any) => String(s.session_id)));

  // estudiantes
  let qst = db.from("students").select("student_id,course_id,last_name,first_name").eq("active", true);
  if (course_id !== "ALL") qst = qst.eq("course_id", course_id);
  const { data: students, error: e2 } = await qst;
  if (e2) throw new Error("No se pudieron leer estudiantes.");

  const stMap: Record<string, any> = {};
  (students ?? []).forEach((s: any) => {
    // filtrar cursos no permitidos si es ALL
    if (course_id === "ALL" && !hasCourseAccess(me, String(s.course_id), mine)) return;
    stMap[String(s.student_id)] = {
      student_id: String(s.student_id),
      course_id: String(s.course_id),
      student_name: `${s.last_name}, ${s.first_name}`,
      presentes: 0,
      ausentes: 0,
      tardes: 0,
      verificar: 0,
      total: 0,
    };
  });

  if (!sessionIds.size) return { ok: true, students: Object.values(stMap), sessions: 0 };

  // registros en rango (por performance: filtro por date + status non-null)
  let qr = db.from("records").select("session_id,student_id,status").gte("date", from).lte("date", to);
  if (course_id !== "ALL") qr = qr.eq("course_id", course_id);
  const { data: recs, error: e3 } = await qr;
  if (e3) throw new Error("No se pudieron leer registros.");

  (recs ?? []).forEach((r: any) => {
    const sid = String(r.student_id ?? "");
    const st = stMap[sid];
    if (!st) return;
    if (!sessionIds.has(String(r.session_id))) return;
    const status = String(r.status ?? "");
    if (!status) return;
    st.total++;
    if (status === "PRESENTE") st.presentes++;
    else if (status === "AUSENTE") st.ausentes++;
    else if (status === "TARDE") st.tardes++;
    else if (status === "VERIFICAR") st.verificar++;
  });

  const list = Object.values(stMap).sort((a: any, b: any) =>
    (b.ausentes - a.ausentes) || (b.tardes - a.tardes) || a.student_name.localeCompare(b.student_name)
  );

  return { ok: true, students: list, sessions: sessionIds.size };
}

function shiftDateISO(iso: string, deltaDays: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function handleGetAlerts(me: Me, body: any) {
  const course_id = String(body?.course_id ?? "ALL").trim();
  const to = String(body?.to ?? "").trim();
  const context = String(body?.context ?? "ALL").trim();
  if (!to) throw new Error("Falta to.");

  const mine = await getMineCourseIds(me.user_id);

  // estudiantes
  let qst = db.from("students").select("student_id,course_id,last_name,first_name").eq("active", true);
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
    };
  });

  // sesiones hasta 'to'
  let qs = db.from("sessions").select("session_id,course_id,date,context").lte("date", to);
  if (course_id !== "ALL") qs = qs.eq("course_id", course_id);
  if (context !== "ALL") qs = qs.eq("context", context);
  const { data: sessions, error: e2 } = await qs;
  if (e2) throw new Error("No se pudieron leer sesiones.");

  const allowed = (sessions ?? []).filter((s: any) => hasCourseAccess(me, String(s.course_id), mine));
  const scopeIds = new Set<string>(allowed.map((s: any) => String(s.session_id)));

  // ausencias (AUSENTE) en esas sesiones
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
    THRESHOLDS.forEach((t) => {
      if (total === t) reasons.push(`llegó a ${t} faltas`);
    });

    if (reasons.length) {
      alerts.push({
        student_id: sid,
        student_name: stMap[sid].student_name,
        absences_total: total,
        absences_streak: streak,
        reason: reasons.join(" • "),
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

  let body: any = {};
  try {
    body = await req.json();
  } catch (_e) {
    // también soporta Content-Type text/plain (por compatibilidad)
    try {
      const txt = await req.text();
      body = txt ? JSON.parse(txt) : {};
    } catch (_e2) {
      body = {};
    }
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
      case "getAlerts": return json(await handleGetAlerts(me, body));
      default:
        return json({ ok: false, error: "Unknown action: " + action });
    }
  } catch (e) {
    const message = errMsg(e);
    // mantenemos status 200 para que el frontend siempre pueda parsear JSON
    return json({ ok: false, error: message });
  }
});
