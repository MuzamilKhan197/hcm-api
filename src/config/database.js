import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { models, collections } from '../models/index.js';

const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
const stamp = data => ({ _id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...data });
const uniqueKeys = { companies: [['_id']], users: [['email']], departments: [['name']], designations: [['name']], employees: [['email'], ['userId'], ['employeeCode']], attendance: [['employeeId', 'date']], payrolls: [['employeeId', 'month']], leaveTypes: [['name']], holidays: [['date']] };

export async function createDemoStore(file) {
  let state = Object.fromEntries(collections.map(name => [name, []]));
  if (file) { try { state = { ...state, ...JSON.parse(await readFile(file, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  let queue = Promise.resolve();
  const api = {
    mode: 'demo',
    async health() {},
    async all(name, filter = {}) { return structuredClone(state[name].filter(row => matches(row, filter))); },
    async one(name, filter = {}) { return structuredClone(state[name].find(row => matches(row, filter)) || null); },
    async insert(name, data) {
      const row = stamp(data);
      for (const keys of uniqueKeys[name] || []) if (state[name].some(item => keys.every(key => item[key] === row[key]))) { const error = new Error('This record already exists.'); error.code = 11000; throw error; }
      state[name].push(row); return structuredClone(row);
    },
    async update(name, filter, changes) {
      const row = state[name].find(item => matches(item, filter));
      if (!row) return null;
      Object.assign(row, changes, { updatedAt: new Date().toISOString() }); return structuredClone(row);
    },
    async delete(name, filter) {
      const matching = state[name].filter(row => matches(row, filter));
      state[name] = state[name].filter(row => !matches(row, filter));
      return matching.length;
    },
    async transaction(fn) {
      const run = queue.then(async () => {
        const backup = structuredClone(state);
        try {
          const result = await fn(api);
          if (file) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2)); await rename(`${file}.tmp`, file); }
          return result;
        } catch (error) { state = backup; throw error; }
      });
      queue = run.catch(() => {}); return run;
    },
    async close() {},
  };
  return api;
}

export async function createMongoStore(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB must use a replica set for atomic setup and payroll. Use MongoDB Atlas or a local replica set; see README.');
  await Promise.all(Object.values(models).map(model => model.init()));
  const repository = session => ({
    mode: 'mongodb',
    async health() { await mongoose.connection.db.admin().ping(); },
    all: (name, filter = {}) => models[name].find(filter).session(session || null).lean(),
    one: (name, filter = {}) => models[name].findOne(filter).session(session || null).lean(),
    async insert(name, data) { const [record] = await models[name].create([stamp(data)], { session }); return record.toObject(); },
    update: (name, filter, changes) => models[name].findOneAndUpdate(filter, { $set: changes }, { new: true, runValidators: true, session }).lean(),
    async delete(name, filter) { return (await models[name].deleteMany(filter, { session })).deletedCount; },
  });
  return { ...repository(), transaction: fn => mongoose.connection.transaction(session => fn(repository(session))), close: () => mongoose.disconnect() };
}
