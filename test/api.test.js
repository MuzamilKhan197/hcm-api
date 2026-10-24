import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createDemoStore } from '../src/config/database.js';
import { seedDemo } from '../src/services/seed.js';
import { createApp } from '../src/app.js';
import { cookieOptions } from '../src/middleware/auth.js';
import { dateInZone, payrollAmount, workdays, validDate } from '../src/utils/domain.js';
const config = { jwtSecret: 'test-only-secret-at-least-thirty-two-characters', production: false, clientUrl: 'http://localhost:5173' };
async function fixture(role = 'admin') {
  const db = await createDemoStore(); await seedDemo(db);
  const app = createApp(db, config); const agent = request.agent(app);
  const response = await agent.post('/api/auth/demo').send({ role }).expect(200);
  return { db, app, agent, user: response.body.user };
}
function futureWorkday(offset = 5) { const date = new Date(`${dateInZone()}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); while ([0,6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate()+1); return date.toISOString().slice(0,10); }

test('authentication is required and unsafe cross-origin writes are rejected', async () => {
  const { app, agent } = await fixture();
  await request(app).get('/api/workspace').expect(401);
  await agent.post('/api/departments').set('Origin','https://untrusted.example').send({name:'Blocked'}).expect(403);
  await agent.get('/api/health').expect(200);
});
test('production CORS trusts only the configured frontend origin', async () => {
  const db = await createDemoStore();
  const app = createApp(db, { ...config, production: true, clientUrl: 'https://hcm-lite-frontend.vercel.app' });
  const blocked = await request(app).options('/api/auth/login')
    .set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'POST')
    .expect(403);
  assert.equal(blocked.headers['access-control-allow-origin'], undefined);
  const allowed = await request(app).options('/api/auth/login')
    .set('Origin', 'https://hcm-lite-frontend.vercel.app')
    .set('Access-Control-Request-Method', 'POST')
    .expect(204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://hcm-lite-frontend.vercel.app');
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  await request(app).post('/api/auth/setup')
    .set('Origin', 'http://localhost:5173')
    .send({})
    .expect(403);
  await request(app).post('/api/auth/setup').send({}).expect(403);
  assert.equal(cookieOptions(true).sameSite, 'none');
  assert.equal(cookieOptions(true).secure, true);
});
test('first setup is atomic and permanently closes public registration', async () => {
  const db = await createDemoStore(); db.mode = 'mongodb'; const app = createApp(db,config); const agent=request.agent(app);
  const details={companyName:'Test Company',name:'Test Admin',email:'admin@example.com',password:'Strong-password-123'};
  await request(app).post('/api/auth/setup').send({...details,password:'1234567'}).expect(400);
  await request(app).post('/api/auth/setup').send({...details, timezone:'Definitely/Not_A_Timezone'}).expect(400);
  const responses=await Promise.all([agent.post('/api/auth/setup').send(details),request(app).post('/api/auth/setup').send({...details,email:'other@example.com'})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
  assert.equal((await db.all('companies')).length,1);assert.equal((await db.all('users')).length,1);
  assert.equal((await db.one('users')).role,'admin');assert.notEqual((await db.one('users')).password,details.password);
  assert.equal((await db.one('companies')).timezone,'Asia/Karachi');
  await request(app).post('/api/auth/demo').send({role:'admin'}).expect(404);
});
test('employee cannot escalate role or see another person’s private records', async () => {
  const {agent,user,db}=await fixture('employee');const {body}=await agent.get('/api/workspace').expect(200);
  assert.equal(body.employees.length,1);assert.equal(body.employees[0]._id,user.employeeId);
  for(const key of ['attendance','leaves','payrolls'])assert.ok(body[key].every(r=>r.employeeId===user.employeeId));
  assert.equal(body.auditLogs.length,0);assert.ok(body.notifications.every(n=>n.userId===user._id));
  await agent.post('/api/departments').send({name:'Privileged'}).expect(403);
  await agent.post('/api/employees').send({role:'admin'}).expect(403);
  await agent.post('/api/payrolls/generate').send({month:dateInZone().slice(0,7)}).expect(403);
  const other=(await db.all('payrolls')).find(p=>p.employeeId!==user.employeeId);
  await agent.get(`/api/payrolls/${other._id}/pdf`).expect(404);
});
test('HR can register employees but cannot set salaries or promote HR', async () => {
  const {agent,db}=await fixture('hr');const data=(await agent.get('/api/workspace')).body;
  assert.ok(data.employees.every(e=>e.baseSalary===undefined&&e.allowance===undefined));assert.equal(data.payrolls.length,0);
  const input={name:'New Teammate',email:'new@example.com',designation:'Engineer',departmentId:data.departments[0]._id,joinDate:dateInZone(),password:'Temp1234'};
  await agent.post('/api/employees').send({...input,role:'hr'}).expect(403);
  await agent.post('/api/employees').send({...input,baseSalary:1000}).expect(403);
  const created=await agent.post('/api/employees').send(input).expect(201);
  assert.equal(created.body.baseSalary,undefined);assert.equal((await db.one('employees',{email:input.email})).baseSalary,0);
});
test('HR can maintain employee contact and job details without changing compensation', async () => {
  const {agent,db}=await fixture('hr');
  const employee=await db.one('employees',{employeeCode:'AC-003'});
  const updated=await agent.patch(`/api/employees/${employee._id}`).send({
    name:'Updated Teammate',
    email:'updated.teammate@example.com',
    phone:'+1 555 0100',
    address:'100 Example Street',
    emergencyContact:'Trusted Contact · +1 555 0101',
    designation:'Senior Designer',
  }).expect(200);
  assert.equal(updated.body.name,'Updated Teammate');
  assert.equal(updated.body.baseSalary,undefined);
  assert.equal((await db.one('employees',{_id:employee._id})).phone,'+1 555 0100');
  const linkedUser=await db.one('users',{_id:employee.userId});
  assert.equal(linkedUser.name,'Updated Teammate');
  assert.equal(linkedUser.email,'updated.teammate@example.com');
  await agent.patch(`/api/employees/${employee._id}`).send({baseSalary:1}).expect(403);
  await agent.patch(`/api/employees/${employee._id}`).send({status:'inactive'}).expect(403);
});
test('company settings validate and save contact details and timezone', async () => {
  const {agent,db}=await fixture('admin');
  await agent.patch('/api/company').send({timezone:'Invalid/Timezone'}).expect(400);
  const updated=await agent.patch('/api/company').send({
    name:'Updated Company',
    email:'hello@updated.example',
    phone:'+1 555 0110',
    address:'10 Main Street',
    timezone:'UTC',
  }).expect(200);
  assert.equal(updated.body.timezone,'UTC');
  assert.equal(updated.body.email,'hello@updated.example');
  assert.equal((await db.one('companies')).name,'Updated Company');
});
test('real password login uses a cookie, rejects bad passwords and supports logout', async () => {
  const {db,app}=await fixture();const employee=await db.one('users',{role:'employee'});
  await db.transaction(tx=>tx.update('users',{_id:employee._id},{password:bcrypt.hashSync('Secure-test-pass-1',10)}));
  const agent=request.agent(app);
  await agent.post('/api/auth/login').send({email:employee.email,password:'incorrect'}).expect(401);
  const signed=await agent.post('/api/auth/login').send({email:employee.email,password:'Secure-test-pass-1'}).expect(200);
  assert.ok(signed.headers['set-cookie'][0].includes('HttpOnly'));assert.ok(signed.headers['set-cookie'][0].includes('SameSite=Strict'));
  assert.equal(signed.body.user.password,undefined);await agent.get('/api/auth/me').expect(200);
  const duplicateEmail=(await db.one('users',{role:'admin'})).email;
  await agent.patch('/api/auth/profile').send({email:duplicateEmail}).expect(409);
  const updatedProfile=await agent.patch('/api/auth/profile').send({name:'Updated Employee',email:'updated.employee@example.com'}).expect(200);
  assert.equal(updatedProfile.body.user.name,'Updated Employee');
  assert.equal(updatedProfile.body.user.email,'updated.employee@example.com');
  assert.equal(updatedProfile.body.user.password,undefined);
  assert.equal((await db.one('employees',{_id:employee.employeeId})).name,'Updated Employee');
  await agent.post('/api/auth/logout').send({}).expect(200);await agent.get('/api/auth/me').expect(401);
});
test('password changes require the current password and invalidate existing sessions', async () => {
  const {agent,db,user}=await fixture('employee');
  await agent.patch('/api/auth/password').send({currentPassword:'wrong',newPassword:'New-secure-pass-123'}).expect(400);
  await agent.patch('/api/auth/password').send({currentPassword:'anything',newPassword:'1234567'}).expect(400);
  await db.transaction(tx=>tx.update('users',{_id:user._id},{password:bcrypt.hashSync('Current-secure-pass-123',10)}));
  await agent.patch('/api/auth/password').send({
    currentPassword:'Current-secure-pass-123',
    newPassword:'Newpass8',
  }).expect(200);
  await agent.get('/api/auth/me').expect(401);
  const next=request.agent(createApp(db,config));
  await next.post('/api/auth/login').send({email:user.email,password:'Current-secure-pass-123'}).expect(401);
  await next.post('/api/auth/login').send({email:user.email,password:'Newpass8'}).expect(200);
});
test('admin permanent deletion removes employee data everywhere and invalidates sessions', async () => {
  const {agent,app,db}=await fixture('admin');
  const employee=await db.one('employees',{employeeCode:'AC-003'});
  const user=await db.one('users',{_id:employee.userId});
  const password='Employee-test-pass-123';
  await db.transaction(tx=>tx.update('users',{_id:user._id},{password:bcrypt.hashSync(password,10)}));
  const employeeAgent=request.agent(app);
  await employeeAgent.post('/api/auth/login').send({email:user.email,password}).expect(200);
  await db.transaction(async tx=>{
    await tx.insert('aiLogs',{userId:user._id,question:'Private question',answer:'Private answer',mode:'local'});
    await tx.insert('auditLogs',{userId:user._id,action:'Private action',details:''});
    await tx.insert('auditLogs',{userId:(await tx.one('users',{role:'admin'}))._id,action:'Employee updated',details:employee.name});
    await tx.insert('announcements',{title:'Employee announcement',content:'Private content',author:employee.name});
    await tx.insert('notifications',{userId:(await tx.one('users',{role:'admin'}))._id,title:'Leave request needs review',message:`${employee.name} requested leave.`});
    const otherEmployee=await tx.one('employees',{employeeCode:'AC-004'});
    await tx.insert('leaves',{employeeId:otherEmployee._id,type:'Annual',startDate:dateInZone(),endDate:dateInZone(),days:1,reason:'Test leave',status:'approved',reviewedBy:user._id});
  });

  await agent.delete(`/api/employees/${employee._id}`).expect(204);
  await employeeAgent.get('/api/workspace').expect(401);
  assert.equal(await db.one('employees',{_id:employee._id}),null);
  assert.equal(await db.one('users',{_id:user._id}),null);
  for (const collection of ['attendance','leaves','payrolls']) {
    assert.equal(await db.one(collection,{employeeId:employee._id}),null);
  }
  assert.equal(await db.one('notifications',{userId:user._id}),null);
  assert.equal((await db.all('notifications')).some(notification => notification.message.includes(employee.name)),false);
  assert.equal(await db.one('aiLogs',{userId:user._id}),null);
  assert.equal(await db.one('auditLogs',{userId:user._id}),null);
  assert.equal(await db.one('auditLogs',{details:employee.name}),null);
  assert.equal(await db.one('announcements',{author:employee.name}),null);
  assert.equal(await db.one('leaves',{reviewedBy:user._id}),null);
  assert.ok(await db.one('employees',{employeeCode:'AC-004'}));
  assert.equal((await db.all('auditLogs')).at(-1).action,'Employee permanently deleted');
});
test('only administrators can permanently delete employees', async () => {
  const {db,agent}=await fixture('hr');
  const employee=await db.one('employees',{employeeCode:'AC-003'});
  await agent.delete(`/api/employees/${employee._id}`).expect(403);
  assert.ok(await db.one('employees',{_id:employee._id}));
});
test('attendance allows one check-in per day and only one check-out', async () => {
  const {agent,db,user}=await fixture('employee');
  const existing=await db.one('attendance',{employeeId:user.employeeId,date:dateInZone()});
  if(existing)await db.transaction(tx=>tx.update('attendance',{_id:existing._id},{date:'2020-01-01',checkOut:'2020-01-01T12:00:00Z'}));
  const results=await Promise.all([agent.post('/api/attendance/check-in').send({}),agent.post('/api/attendance/check-in').send({})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  await agent.post('/api/attendance/check-out').send({}).expect(200);
  await agent.post('/api/attendance/check-out').send({}).expect(409);
});
test('leave rejects invalid ranges, overlap, excess quota and self approval', async () => {
  const {agent,db,user}=await fixture('employee');const date=futureWorkday(18);
  const input={type:'Annual',startDate:date,endDate:date,reason:'A planned family day.'};
  await agent.post('/api/leaves').send({...input,startDate:'2026-02-30'}).expect(400);
  const created=await agent.post('/api/leaves').send(input).expect(201);
  await agent.post('/api/leaves').send(input).expect(409);
  const year=String(Number(dateInZone().slice(0,4))+1);
  await agent.post('/api/leaves').send({...input,startDate:`${year}-01-01`,endDate:`${year}-03-31`}).expect(400);
  await db.transaction(tx=>tx.update('users',{_id:user._id},{role:'hr'}));
  await agent.patch(`/api/leaves/${created.body._id}`).send({status:'approved'}).expect(403);
});
test('an open overnight shift prevents another check-in', async () => {
  const {agent,db,user}=await fixture('employee');
  const today=await db.one('attendance',{employeeId:user.employeeId,date:dateInZone()});
  if(today)await db.transaction(tx=>tx.update('attendance',{_id:today._id},{date:'2020-01-01',checkOut:null}));
  else await db.transaction(tx=>tx.insert('attendance',{employeeId:user.employeeId,date:'2020-01-01',checkIn:'2020-01-01T09:00:00Z',checkOut:null,status:'present'}));
  await agent.post('/api/attendance/check-in').send({}).expect(409);
});
test('review is final and sends a private notification to the requester', async () => {
  const {agent,db}=await fixture();const leave=await db.one('leaves',{status:'pending'});
  await agent.patch(`/api/leaves/${leave._id}`).send({status:'approved'}).expect(200);
  await agent.patch(`/api/leaves/${leave._id}`).send({status:'rejected'}).expect(409);
  const employee=await db.one('employees',{_id:leave.employeeId});
  assert.ok(await db.one('notifications',{userId:employee.userId,title:'Leave approved'}));
});
test('announcements notify active users and notification reads are private', async () => {
  const {agent,db}=await fixture('admin');
  const users=await db.all('users',{active:true});
  const announcement=await agent.post('/api/announcements').send({
    title:'A team update',
    content:'The office will be closed this Friday.',
  }).expect(201);
  for(const user of users) {
    assert.ok(await db.one('notifications',{userId:user._id,title:'New company announcement',message:announcement.body.title}));
  }
  const employee=users.find(user=>user.role==='employee');
  const privateNotification=await db.one('notifications',{userId:employee._id,title:'New company announcement'});
  await agent.patch(`/api/notifications/${privateNotification._id}/read`).send({}).expect(404);
  const employeeAgent=request.agent(createApp(db,config));
  await employeeAgent.post('/api/auth/demo').send({role:'employee'}).expect(200);
  await employeeAgent.patch(`/api/notifications/${privateNotification._id}/read`).send({}).expect(200);
  assert.equal((await db.one('notifications',{_id:privateNotification._id})).read,true);
});
test('payroll is idempotent, remains a snapshot, and produces a PDF', async () => {
  const {agent,db}=await fixture();const month=dateInZone().slice(0,7);
  const {body}=await agent.post('/api/payrolls/generate').send({month,taxPercent:10}).expect(201);
  assert.equal(body.length,12);assert.ok(body.every(p=>p.net>=0&&p.tax>0&&p.status==='draft'));
  const employee=await db.one('employees',{_id:body[0].employeeId});
  assert.ok(await db.one('notifications',{userId:employee.userId,title:'Payroll generated'}));
  await agent.post('/api/payrolls/generate').send({month}).expect(409);
  const original=body[0];await agent.patch(`/api/employees/${original.employeeId}`).send({baseSalary:999999}).expect(200);
  assert.equal((await db.one('payrolls',{_id:original._id})).net,original.net);
  const pdf=await agent.get(`/api/payrolls/${original._id}/pdf`).expect(200);
  assert.match(pdf.headers['content-type'],/application\/pdf/);assert.ok(pdf.body.length>500);assert.equal(pdf.body.subarray(0,4).toString(),'%PDF');
  await agent.patch(`/api/payrolls/${original._id}/pay`).send({}).expect(200);
  await agent.patch(`/api/payrolls/${original._id}/pay`).send({}).expect(409);
});
test('transaction failure rolls back every write', async () => {
  const db=await createDemoStore();
  await assert.rejects(db.transaction(async tx=>{await tx.insert('departments',{name:'Temporary'});throw new Error('fail');}));
  assert.equal((await db.all('departments')).length,0);
});
test('working-day payroll handles joining midmonth, holidays, and unpaid leave', () => {
  assert.equal(validDate('2026-02-30'),false);assert.equal(validDate('2028-02-29'),true);
  const holidays=[{date:'2026-10-05'}];
  const employee={_id:'employee',joinDate:'2026-10-15',baseSalary:22000,allowance:0};
  const result=payrollAmount(employee,'2026-10',[{employeeId:'employee',type:'Unpaid',status:'approved',startDate:'2026-10-19',endDate:'2026-10-20'}],holidays,10);
  assert.equal(result.workingDays,21);assert.equal(result.paidDays,10);assert.equal(result.gross,12571.43);assert.equal(result.deduction,2095.24);assert.equal(result.net,9428.57);
  assert.equal(workdays('2026-10-24','2026-10-25').length,0);
});
test('assistant enforces role scope and clearly identifies local insights', async () => {
  const {agent,user,db}=await fixture('employee');
  const {body}=await agent.post('/api/assistant').send({question:'What is my leave balance?'}).expect(200);
  assert.equal(body.mode,'local-insights');assert.match(body.answer,/Annual:/);assert.match(body.note,/No generative AI/);
  assert.equal((await db.all('aiLogs'))[0].userId,user._id);
});
