/* global APP_CONFIG */
const Api = (() => {
  const API_URL = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || "";

  function assertApiUrl() {
    if (!API_URL || API_URL.includes("PASTE_YOUR")) {
      throw new Error("Falta configurar APP_CONFIG.API_URL (config.js).");
    }
  }

  async function post(action, payload = {}) {
    assertApiUrl();
    const token = localStorage.getItem("asistencia_token") || "";
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
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
    getAlerts: (course_id, to, context) => post("getAlerts", { course_id, to, context })
  };
})();
