// Pegá acá la URL del Web App de Apps Script (termina en /exec)
// Ej: https://script.google.com/macros/s/AKfycb....../exec
window.APP_CONFIG = {
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbzlvpbtl9pvDi4uj9kkZIYoZlFNmSTfwNsZgwlL5zPSHoU1q_3eWSvDzV_NY1A6DCfh1g/exec",
  LOW_ATTENDANCE_THRESHOLD: 75,
  ABSENCE_MILESTONES: [10, 15, 20, 25, 28],
  MESSAGE_TEMPLATES: {
    consecutive3: (ctx) => `Hola, te informamos que ${ctx.student} (${ctx.course}) registra 3 inasistencias consecutivas.\n\nFaltas totales: ${ctx.absences} (Asistencia: ${ctx.attendancePct}%).\n\nPor favor, comunicarse con la preceptoría.`,
    milestone: (ctx) => `Hola, te informamos que ${ctx.student} (${ctx.course}) alcanzó ${ctx.milestone} inasistencias.\n\nAsistencia: ${ctx.attendancePct}%.\n\nPor favor, comunicarse con la preceptoría.`,
    lowAttendance: (ctx) => `Hola, te informamos que ${ctx.student} (${ctx.course}) se encuentra por debajo del ${ctx.threshold}% de asistencia.\n\nFaltas totales: ${ctx.absences}. Asistencia actual: ${ctx.attendancePct}%.\n\nPor favor, comunicarse con la preceptoría.`
  }
};
