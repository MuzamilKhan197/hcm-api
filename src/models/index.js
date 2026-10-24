import mongoose from 'mongoose';
const { Schema } = mongoose;
const str = { type: String, required: true };
const number = { type: Number, min: 0, required: true };
const definitions = {
  companies: { name: str, email: String, phone: String, address: String, timezone: str, currency: str, country: String },
  users: { name: str, email: { ...str, unique: true }, password: str, role: { ...str, enum: ['admin', 'hr', 'employee'] }, employeeId: String, active: { type: Boolean, default: true }, sessionVersion: { type: Number, default: 0 } },
  departments: { name: { ...str, unique: true }, description: String, color: String },
  designations: { name: { ...str, unique: true } },
  employees: { userId: { ...str, unique: true }, employeeCode: { ...str, unique: true }, name: str, email: { ...str, unique: true }, phone: String, address: String, emergencyContact: String, departmentId: str, designation: str, joinDate: str, employmentType: String, baseSalary: number, allowance: { type: Number, default: 0, min: 0 }, status: { type: String, enum: ['active', 'inactive'], default: 'active' }, avatarColor: String },
  attendance: { employeeId: str, date: str, checkIn: str, checkOut: String, status: { type: String, enum: ['present', 'late'], default: 'present' } },
  leaves: { employeeId: str, type: str, startDate: str, endDate: str, days: number, reason: str, status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, reviewedBy: String },
  leaveTypes: { name: { ...str, unique: true }, quota: number, paid: Boolean },
  holidays: { name: str, date: { ...str, unique: true } },
  payrolls: { employeeId: str, month: str, employeeName: str, employeeCode: str, designation: str, department: String, gross: number, deduction: number, tax: number, net: number, taxPercent: number, workingDays: number, paidDays: number, currency: str, status: { type: String, enum: ['draft', 'paid'], default: 'draft' }, paidAt: String },
  notifications: { userId: str, title: str, message: str, read: { type: Boolean, default: false } },
  announcements: { title: str, content: str, author: str, category: String },
  auditLogs: { userId: str, action: str, details: String },
  aiLogs: { userId: str, question: str, answer: str, mode: String },
};
export const models = Object.fromEntries(Object.entries(definitions).map(([name, fields]) => {
  const schema = new Schema({ _id: str, ...fields }, { timestamps: true, versionKey: false, collection: name });
  if (name === 'attendance') schema.index({ employeeId: 1, date: 1 }, { unique: true });
  if (name === 'payrolls') schema.index({ employeeId: 1, month: 1 }, { unique: true });
  return [name, mongoose.models[name] || mongoose.model(name, schema)];
}));
export const collections = Object.keys(definitions);
