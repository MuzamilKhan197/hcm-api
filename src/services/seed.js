import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { dateInZone, payrollAmount } from "../utils/domain.js";
export const defaultLeaveTypes = [
  { name: "Annual", quota: 18, paid: true },
  { name: "Sick", quota: 10, paid: true },
  { name: "Casual", quota: 7, paid: true },
  { name: "Unpaid", quota: 260, paid: false },
];
export async function seedDemo(db) {
  if (await db.one("companies")) return;
  const password = await bcrypt.hash(randomBytes(24).toString("hex"), 10);
  const today = dateInZone();
  const relativeDate = (n) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + n);
    return date.toISOString().slice(0, 10);
  };
  await db.transaction(async (tx) => {
    await tx.insert("companies", {
      _id: "workspace",
      name: "Acme Studio",
      timezone: "Asia/Karachi",
      currency: "PKR",
      country: "Pakistan",
    });
    for (const type of defaultLeaveTypes) await tx.insert("leaveTypes", type);
    const departments = [];
    for (const [name, description, color] of [
      ["Engineering", "Building thoughtful digital products.", "#4c8e7b"],
      ["Design", "Making the complex feel simple.", "#a293cf"],
      ["People & Culture", "Helping our people do their best work.", "#e4b86d"],
      ["Marketing", "Sharing our story with the world.", "#729fc3"],
    ])
      departments.push(
        await tx.insert("departments", { name, description, color }),
      );
    const people = [
      ["Ayesha Khan", "People Partner", 2, "admin"],
      ["Omar Farooq", "HR Manager", 2, "hr"],
      ["Sara Ahmed", "Product Designer", 1, "employee"],
      ["Ali Hassan", "Frontend Engineer", 0, "employee"],
      ["Zain Malik", "Backend Engineer", 0, "employee"],
      ["Noor Fatima", "Brand Designer", 1, "employee"],
      ["Hamza Ali", "Growth Lead", 3, "employee"],
      ["Mariam Shah", "Software Engineer", 0, "employee"],
      ["Bilal Raza", "Content Strategist", 3, "employee"],
      ["Hina Aslam", "UX Researcher", 1, "employee"],
      ["Usman Tariq", "DevOps Engineer", 0, "employee"],
      ["Eman Sheikh", "Marketing Associate", 3, "employee"],
    ];
    const employees = [];
    for (const [index, [name, designation, dept, role]] of people.entries()) {
      const email = `${name.toLowerCase().replace(" ", ".")}@acme.example`;
      const user = await tx.insert("users", {
        name,
        email,
        password,
        role,
        active: true,
      });
      const employee = await tx.insert("employees", {
        userId: user._id,
        employeeCode: `AC-${String(index + 1).padStart(3, "0")}`,
        name,
        email,
        departmentId: departments[dept]._id,
        designation,
        joinDate: relativeDate(-210 + index * 11),
        employmentType: "Full-time",
        baseSalary: 85000 + index * 7500,
        allowance: 5000,
        status: "active",
        avatarColor: ["sage", "lavender", "peach", "blue"][index % 4],
      });
      employees.push(employee);
      await tx.update("users", { _id: user._id }, { employeeId: employee._id });
      if (!(await tx.one("designations", { name: designation })))
        await tx.insert("designations", { name: designation });
      for (let offset = -6; offset <= 0; offset++) {
        if ((index + offset + 12) % 7 === 0 || (offset === 0 && index > 8))
          continue;
        const date = relativeDate(offset);
        const start = `${date}T0${index % 4 === 0 ? 5 : 4}:00:00.000Z`;
        if (start > new Date().toISOString()) continue;
        await tx.insert("attendance", {
          employeeId: employee._id,
          date,
          checkIn: start,
          checkOut: offset < 0 ? `${date}T12:00:00.000Z` : null,
          status: index % 4 === 0 ? "late" : "present",
        });
      }
    }
    const nextWorkday = new Date(`${relativeDate(3)}T12:00:00Z`);
    while ([0, 6].includes(nextWorkday.getUTCDay()))
      nextWorkday.setUTCDate(nextWorkday.getUTCDate() + 1);
    const leaveDay = nextWorkday.toISOString().slice(0, 10);
    for (const i of [2, 6, 9])
      await tx.insert("leaves", {
        employeeId: employees[i]._id,
        type: i === 6 ? "Casual" : "Annual",
        startDate: leaveDay,
        endDate: leaveDay,
        days: 1,
        reason: i === 6 ? "Family commitment" : "A little time to recharge.",
        status: "pending",
      });
    const previous = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    const month = previous.toISOString().slice(0, 7);
    for (const e of employees)
      await tx.insert("payrolls", {
        employeeId: e._id,
        employeeName: e.name,
        employeeCode: e.employeeCode,
        designation: e.designation,
        department: departments.find((d) => d._id === e.departmentId).name,
        month,
        ...payrollAmount(e, month, [], [], 0),
        taxPercent: 0,
        currency: "PKR",
        status: "paid",
        paidAt: `${month}-28T12:00:00Z`,
      });
    await tx.insert("announcements", {
      title: "A little space for big ideas",
      content:
        "Our next team meetup is all about sharing what you’re working on. Bring an idea, a question, or just yourself. Details will follow from the People team.",
      author: "Ayesha Khan",
      category: "Culture",
    });
    await tx.insert("announcements", {
      title: "Your time off, made simpler",
      content:
        "You can now request leave, check your balance, and follow approvals right here in your workspace.",
      author: "Omar Farooq",
      category: "People update",
    });
    for (const e of employees)
      await tx.insert("notifications", {
        userId: e.userId,
        title: "Welcome to your workspace",
        message:
          "Your people, updates, and everyday essentials — all in one place.",
        read: false,
      });
    await tx.insert("auditLogs", {
      userId: employees[0].userId,
      action: "Demo workspace created",
      details: "Sample data for exploring HCM Lite.",
    });
  });
}
