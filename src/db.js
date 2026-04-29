const fs = require('fs/promises');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const initialData = {
  users: [],
  quizzes: [],
  sessions: [],
  attempts: []
};

async function ensureDb() {
  try {
    await fs.access(DB_PATH);
  } catch {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    await fs.writeFile(DB_PATH, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(next) {
  await fs.writeFile(DB_PATH, JSON.stringify(next, null, 2), 'utf8');
}

async function updateDb(mutator) {
  const db = await readDb();
  const next = await mutator(db);
  await writeDb(next || db);
  return next || db;
}

module.exports = {
  readDb,
  writeDb,
  updateDb,
};
