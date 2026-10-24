export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const assert = (condition, message, status = 400) => { if (!condition) throw new HttpError(status, message); };
export const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
export const dateInZone = (date = new Date(), timezone = 'Asia/Karachi') => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export function validTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function workdays(start, end, holidays = []) {
  assert(validDate(start) && validDate(end) && end >= start, 'Enter a valid date range.');
  const dates = [];
  const excluded = new Set(holidays.map(h => h.date));
  for (let cursor = new Date(`${start}T12:00:00Z`); cursor <= new Date(`${end}T12:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (![0, 6].includes(cursor.getUTCDay()) && !excluded.has(date)) dates.push(date);
  }
  return dates;
}
export function payrollAmount(employee, month, leaves, holidays, taxPercent = 0) {
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
  const days = workdays(`${month}-01`, end, holidays);
  const eligible = days.filter(day => day >= employee.joinDate);
  const unpaidInMonth = eligible.filter(day => leaves.some(l => l.employeeId === employee._id && l.type === 'Unpaid' && l.status === 'approved' && l.startDate <= day && l.endDate >= day)).length;
  const gross = money((employee.baseSalary + (employee.allowance || 0)) * eligible.length / (days.length || 1));
  const deduction = money((employee.baseSalary + (employee.allowance || 0)) * unpaidInMonth / (days.length || 1));
  const tax = money(Math.max(0, gross - deduction) * taxPercent / 100);
  return { gross, deduction, tax, net: money(Math.max(0, gross - deduction - tax)), workingDays: days.length, paidDays: eligible.length - unpaidInMonth };
}
export function publicUser(user) {
  return { _id: user._id, name: user.name, email: user.email, role: user.role, employeeId: user.employeeId || null };
}
