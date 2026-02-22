/* global APP_CONFIG */
const Api = (() => {
  const CFG = (window.APP_CONFIG || {});
  const SUPABASE_URL = (CFG.SUPABASE_URL || "").replace(/\/$/, "");
  const FUNCTION_NAME = CFG.FUNCTION_NAME || "asistencia-api";
  const API_URL = CFG.API_URL || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/${FUNCTION_NAME}` : "");
  const ANON_KEY = CFG.SUPABASE_ANON_KEY || "";

  function assertConfigured() {
    if (!API_URL) throw new Error("Falta configurar APP_CONFIG.SUPABASE_URL (config.js).");
    if (!ANON_KEY) throw new Error("Falta configurar APP_CONFIG.SUPABASE_ANON_KEY (config.js).");
  }

  async function post(action, payload = {}) {
    assertConfigured();
    const token = localStorage.getItem("asistencia_token") || "";
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ANON_KEY,
        "Authorization": `Bearer ${ANON_KEY}`
      },
      body: JSON.stringify({ action, token, ...payload })
    });
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch (e) {
      throw new Error("Respuesta inválida del servidor: " + txt.slice(0, 200));
    }
    if (!data.ok) throw new Error(data.error || "Error");
    return data;
  }

  return {
    login: (email, pin) => post("login", { email, pin }),
    me: () => post("me"),
    getCourses: () => post("getCourses"),
    getStudents: (course_id) => post("getStudents", { course_id }),
    getSession: (course_id, date, context) => post("getSession", { course_id, date, context }),
    closeSession: (session_id) => post("closeSession", { session_id }),
    getRecords: (session_id) => post("getRecords", { session_id }),
    upsertMany: (session_id, course_id, date, context, records) =>
      post("upsertMany", { session_id, course_id, date, context, records }),
    updateRecord: (session_id, student_id, status, note) =>
      post("updateRecord", { session_id, student_id, status, note }),
    getStats: (course_id, from, to, context) => post("getStats", { course_id, from, to, context }),
    getStudentStats: (course_id, from, to, context) => post("getStudentStats", { course_id, from, to, context }),
    getAlerts: (course_id, to, context) => post("getAlerts", { course_id, to, context }),
    ackAlert: (student_id, course_id, to, context) => post("ackAlert", { student_id, course_id, to, context }),
    updateStudentPhone: (student_id, guardian_phone) => post("updateStudentPhone", { student_id, guardian_phone }),
    getCourseSummary: (from, to, context) => post("getCourseSummary", { from, to, context }),
    getStudentTimeline: (student_id, course_id, from, to, context) => post("getStudentTimeline", { student_id, course_id, from, to, context })
  };
})();
