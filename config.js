// Pegá acá la URL del Web App de Apps Script (termina en /exec)
// Ej: https://script.google.com/macros/s/AKfycb....../exec
window.APP_CONFIG = {
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbz1rA-pcJ2h3zjgTwP0WnpkZ7LBuLMoWAdsbt34Pz-I5o6Y0HFL9KogOIOTjBPK2vmx7g/exec",
  LOW_ATTENDANCE_THRESHOLD: 75,
  ABSENCE_MILESTONES: [10, 15, 20, 25, 28],
  MESSAGE_TEMPLATES: {
    consecutive3: (ctx) => `Hola, te informamos que ${ctx.student} (${ctx.course}) registra 3 inasistencias consecutivas.\n\nFaltas totales: ${ctx.absences} (Asistencia: ${ctx.attendancePct}%).\n\nPor favor, comunicarse con la preceptoría.`,
    milestone: (ctx) => `Hola, te informamos que ${ctx.student} (${ctx.course}) alcanzó ${ctx.milestone} inasistencias.\n\nAsistencia: ${ctx.attendancePct}%.\n\nPor favor, comunicarse con la preceptoría.`,
    lowAttendance: (ctx) => `Hola, te informamos que ${ctx.student} (${ctx.course}) se encuentra por debajo del ${ctx.threshold}% de asistencia.\n\nFaltas totales: ${ctx.absences}. Asistencia actual: ${ctx.attendancePct}%.\n\nPor favor, comunicarse con la preceptoría.`
  }
};
