import { createMongoStore } from './src/config/database.js';
import { createApp } from './src/app.js';

const jwtSecret = process.env.JWT_SECRET;
const mongoUri = process.env.MONGODB_URI;
const production = process.env.NODE_ENV === 'production';
const clientUrl = process.env.CLIENT_URL;

if (!mongoUri) throw new Error('MONGODB_URI must be configured.');
if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.includes('replace-with')) {
  throw new Error('JWT_SECRET must be a random value with at least 32 characters.');
}
if (production && !clientUrl) throw new Error('CLIENT_URL must be configured in production.');

let clientOrigin = '';
if (clientUrl) {
  const parsedClientUrl = new URL(clientUrl);
  if (parsedClientUrl.pathname !== '/' || parsedClientUrl.search || parsedClientUrl.hash || parsedClientUrl.username || parsedClientUrl.password) {
    throw new Error('CLIENT_URL must contain only the frontend origin.');
  }
  if (production && parsedClientUrl.protocol !== 'https:') {
    throw new Error('CLIENT_URL must use HTTPS in production.');
  }
  clientOrigin = parsedClientUrl.origin;
}

let storePromise;
function getStore() {
  if (!storePromise) {
    storePromise = createMongoStore(mongoUri).catch(error => {
      storePromise = undefined;
      throw error;
    });
  }
  return storePromise;
}

const db = {
  mode: 'mongodb',
  health: () => getStore().then(store => store.health()),
  all: (...args) => getStore().then(store => store.all(...args)),
  one: (...args) => getStore().then(store => store.one(...args)),
  insert: (...args) => getStore().then(store => store.insert(...args)),
  update: (...args) => getStore().then(store => store.update(...args)),
  transaction: fn => getStore().then(store => store.transaction(fn)),
};

const config = {
  jwtSecret,
  production,
  clientUrl: clientOrigin,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  serveFrontend: false,
};

export const app = createApp(db, config);
export default app;
