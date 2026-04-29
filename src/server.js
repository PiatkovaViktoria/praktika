const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { readDb, updateDb } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'local-quiz-secret';

const timers = new Map();
const id = (size = 12) => crypto.randomUUID().replace(/-/g, '').slice(0, size);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function createToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Сессия истекла' });
  }
}

function sanitizeQuestion(question) {
  const points = Number(question.points);
  return {
    id: question.id || id(8),
    text: String(question.text || '').trim(),
    imageUrl: String(question.imageUrl || '').trim(),
    type: question.type === 'multiple' ? 'multiple' : 'single',
    options: (question.options || []).map((option) => ({ id: option.id || id(6), text: String(option.text || '').trim() })),
    correctOptionIds: Array.isArray(question.correctOptionIds) ? question.correctOptionIds : [],
    points: Number.isFinite(points) ? Math.max(1, Math.floor(points)) : 100,
  };
}

function nextQuestionPayload(session, quiz) {
  const question = quiz.questions[session.currentQuestionIndex];
  if (!question) return null;
  return {
    sessionId: session.id,
    roomCode: session.roomCode,
    question: {
      id: question.id,
      text: question.text,
      imageUrl: question.imageUrl,
      type: question.type,
      options: question.options,
      points: question.points,
    },
    index: session.currentQuestionIndex,
    total: quiz.questions.length,
    timeLimit: quiz.timeLimit,
    startedAt: session.questionStartAt,
  };
}

function getLeaderboard(session, db) {
  const entries = Object.entries(session.scores || {}).map(([userId, score]) => {
    const user = db.users.find((u) => u.id === userId);
    return { userId, name: user?.name || 'Участник', score };
  });
  return entries.sort((a, b) => b.score - a.score);
}

async function launchNextQuestion(sessionId) {
  const db = await readDb();
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session || session.status !== 'live') return;

  const quiz = db.quizzes.find((q) => q.id === session.quizId);
  if (!quiz) return;

  if (session.currentQuestionIndex >= quiz.questions.length) {
    await finishSession(session.id);
    return;
  }

  const payload = nextQuestionPayload(session, quiz);
  if (!payload) {
    await finishSession(session.id);
    return;
  }

  io.to(session.roomCode).emit('question_started', payload);

  const timeout = setTimeout(async () => {
    await launchUpcomingQuestion(session.id);
  }, quiz.timeLimit * 1000);

  timers.set(session.id, timeout);
}

async function launchUpcomingQuestion(sessionId) {
  const db = await updateDb(async (draft) => {
    const session = draft.sessions.find((s) => s.id === sessionId);
    if (!session || session.status !== 'live') return draft;

    session.currentQuestionIndex += 1;
    session.questionStartAt = Date.now();

    const quiz = draft.quizzes.find((q) => q.id === session.quizId);
    if (!quiz || session.currentQuestionIndex >= quiz.questions.length) {
      session.status = 'finished';
      session.finishedAt = Date.now();
    }

    return draft;
  });

  const nextSession = db.sessions.find((s) => s.id === sessionId);
  if (!nextSession) return;

  if (nextSession.status === 'finished') {
    await finishSession(sessionId);
    return;
  }

  await launchNextQuestion(sessionId);
}

async function finishSession(sessionId) {
  const timeout = timers.get(sessionId);
  if (timeout) {
    clearTimeout(timeout);
    timers.delete(sessionId);
  }

  const db = await updateDb(async (draft) => {
    const session = draft.sessions.find((s) => s.id === sessionId);
    if (!session) return draft;
    if (session.status === 'finished' && session.finishedAt) return draft;

    session.status = 'finished';
    session.finishedAt = Date.now();

    const leaderboard = getLeaderboard(session, draft);
    const quiz = draft.quizzes.find((q) => q.id === session.quizId);
    for (const row of leaderboard) {
      draft.attempts.push({
        id: id(12),
        quizId: session.quizId,
        quizTitle: quiz?.title || 'Квиз',
        userId: row.userId,
        score: row.score,
        roomCode: session.roomCode,
        createdAt: Date.now(),
      });
    }

    return draft;
  });

  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  io.to(session.roomCode).emit('quiz_finished', { leaderboard: getLeaderboard(session, db) });
}

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (!['participant', 'organizer'].includes(role)) {
    return res.status(400).json({ error: 'Некорректная роль' });
  }

  const db = await readDb();
  if (db.users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: 'Email уже зарегистрирован' });
  }

  const user = {
    id: id(12),
    name: String(name).trim(),
    email: String(email).trim().toLowerCase(),
    passwordHash: await bcrypt.hash(password, 10),
    role,
    createdAt: Date.now(),
  };

  await updateDb(async (draft) => {
    draft.users.push(user);
    return draft;
  });

  const token = createToken(user);
  return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const db = await readDb();
  const user = db.users.find((u) => u.email === String(email || '').toLowerCase());

  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const token = createToken(user);
  return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const db = await readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const organizedQuizzes = db.quizzes.filter((q) => q.createdBy === user.id);
  const participationHistory = db.attempts
    .filter((a) => a.userId === user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((attempt) => {
      const roomEntries = db.attempts
        .filter((a) => a.roomCode === attempt.roomCode)
        .sort((a, b) => b.score - a.score);
      const rank = roomEntries.findIndex((a) => a.userId === attempt.userId) + 1;
      return {
        ...attempt,
        rank: rank > 0 ? rank : roomEntries.length || 1,
        totalPlayers: roomEntries.length || 1,
      };
    });

  const organizerConductedHistory = db.sessions
    .filter((s) => s.hostId === user.id && s.status === 'finished')
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, 20)
    .map((session) => {
      const quiz = db.quizzes.find((q) => q.id === session.quizId);
      return {
        roomCode: session.roomCode,
        quizTitle: quiz?.title || 'Квиз',
        participants: session.participantIds?.length || 0,
        finishedAt: session.finishedAt,
        top: getLeaderboard(session, db).slice(0, 3),
      };
    });

  return res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    organizedQuizzes,
    organizerConductedHistory,
    participationHistory,
  });
});

app.post('/api/quizzes', authMiddleware, async (req, res) => {
  if (req.user.role !== 'organizer') return res.status(403).json({ error: 'Только для организаторов' });

  const { title, categories, timeLimit, rules, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Укажите название и минимум один вопрос' });
  }

  const normalized = questions.map(sanitizeQuestion);
  if (normalized.some((q) => !q.text || q.options.length < 2 || q.correctOptionIds.length === 0)) {
    return res.status(400).json({ error: 'Каждый вопрос должен содержать текст, 2+ варианта и правильный ответ' });
  }

  const quiz = {
    id: id(12),
    createdBy: req.user.id,
    title: String(title).trim(),
    categories: Array.isArray(categories) ? categories.map((c) => String(c).trim()).filter(Boolean) : [],
    timeLimit: Math.max(5, Number(timeLimit) || 20),
    rules: String(rules || '').trim(),
    questions: normalized,
    createdAt: Date.now(),
  };

  await updateDb(async (draft) => {
    draft.quizzes.push(quiz);
    return draft;
  });

  return res.json({ quiz });
});

app.put('/api/quizzes/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'organizer') return res.status(403).json({ error: 'Только для организаторов' });

  const quizId = String(req.params.id || '');
  const { title, categories, timeLimit, rules, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Укажите название и минимум один вопрос' });
  }

  const normalized = questions.map(sanitizeQuestion);
  if (normalized.some((q) => !q.text || q.options.length < 2 || q.correctOptionIds.length === 0)) {
    return res.status(400).json({ error: 'Каждый вопрос должен содержать текст, 2+ варианта и правильный ответ' });
  }

  const db = await readDb();
  const exists = db.quizzes.find((q) => q.id === quizId && q.createdBy === req.user.id);
  if (!exists) return res.status(404).json({ error: 'Квиз не найден' });

  const quiz = {
    ...exists,
    title: String(title).trim(),
    categories: Array.isArray(categories) ? categories.map((c) => String(c).trim()).filter(Boolean) : [],
    timeLimit: Math.max(5, Number(timeLimit) || 20),
    rules: String(rules || '').trim(),
    questions: normalized,
    updatedAt: Date.now(),
  };

  await updateDb(async (draft) => {
    const idx = draft.quizzes.findIndex((q) => q.id === quizId && q.createdBy === req.user.id);
    if (idx >= 0) draft.quizzes[idx] = quiz;
    return draft;
  });

  return res.json({ quiz });
});

app.get('/api/quizzes/mine', authMiddleware, async (req, res) => {
  if (req.user.role !== 'organizer') return res.status(403).json({ error: 'Только для организаторов' });
  const db = await readDb();
  return res.json({ quizzes: db.quizzes.filter((q) => q.createdBy === req.user.id) });
});

app.delete('/api/quizzes/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'organizer') return res.status(403).json({ error: 'Только для организаторов' });

  const quizId = String(req.params.id || '');
  const db = await readDb();
  const quiz = db.quizzes.find((q) => q.id === quizId && q.createdBy === req.user.id);
  if (!quiz) return res.status(404).json({ error: 'Квиз не найден' });

  const relatedSessions = db.sessions.filter((s) => s.quizId === quizId);
  for (const session of relatedSessions) {
    const timeout = timers.get(session.id);
    if (timeout) {
      clearTimeout(timeout);
      timers.delete(session.id);
    }
    io.to(session.roomCode).emit('error_notice', 'Квиз удален организатором.');
    io.to(session.roomCode).emit('quiz_finished', { leaderboard: [] });
  }

  await updateDb(async (draft) => {
    draft.quizzes = draft.quizzes.filter((q) => q.id !== quizId);
    draft.sessions = draft.sessions.filter((s) => s.quizId !== quizId);
    draft.attempts = draft.attempts.filter((a) => a.quizId !== quizId);
    return draft;
  });

  return res.json({ success: true });
});

app.post('/api/quizzes/:id/launch', authMiddleware, async (req, res) => {
  if (req.user.role !== 'organizer') return res.status(403).json({ error: 'Только для организаторов' });

  const db = await readDb();
  const quiz = db.quizzes.find((q) => q.id === req.params.id && q.createdBy === req.user.id);
  if (!quiz) return res.status(404).json({ error: 'Квиз не найден' });

  const session = {
    id: id(12),
    quizId: quiz.id,
    hostId: req.user.id,
    roomCode: id(6).toUpperCase(),
    status: 'waiting',
    currentQuestionIndex: -1,
    questionStartAt: null,
    participantIds: [],
    scores: {},
    answerLog: {},
    createdAt: Date.now(),
    finishedAt: null,
  };

  await updateDb(async (draft) => {
    draft.sessions.push(session);
    return draft;
  });

  return res.json({ session });
});

app.post('/api/rooms/join', authMiddleware, async (req, res) => {
  const roomCode = String(req.body.roomCode || '').trim().toUpperCase();
  if (!roomCode) return res.status(400).json({ error: 'Введите код комнаты' });

  const db = await updateDb(async (draft) => {
    const session = draft.sessions.find((s) => s.roomCode === roomCode && s.status !== 'finished');
    if (!session) return draft;
    if (!session.participantIds.includes(req.user.id)) session.participantIds.push(req.user.id);
    return draft;
  });

  const session = db.sessions.find((s) => s.roomCode === roomCode && s.status !== 'finished');
  if (!session) return res.status(404).json({ error: 'Активная комната не найдена' });

  return res.json({ session: { id: session.id, roomCode: session.roomCode, status: session.status } });
});

app.post('/api/rooms/:roomCode/finish', authMiddleware, async (req, res) => {
  if (req.user.role !== 'organizer') return res.status(403).json({ error: 'Только для организаторов' });
  const code = String(req.params.roomCode || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Код комнаты обязателен' });

  const db = await readDb();
  const session = db.sessions.find((s) => s.roomCode === code);
  if (!session) return res.status(404).json({ error: 'Комната не найдена' });
  if (session.hostId !== req.user.id) return res.status(403).json({ error: 'Нет доступа к этой комнате' });
  if (session.status === 'finished') return res.json({ success: true, alreadyFinished: true });

  await finishSession(session.id);
  return res.json({ success: true });
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('auth required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return next(new Error('invalid token'));
  }
});

io.on('connection', (socket) => {
  socket.on('join_room', async ({ roomCode }) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const db = await readDb();
    const session = db.sessions.find((s) => s.roomCode === code);
    if (!session) {
      socket.emit('error_notice', 'Комната не найдена');
      return;
    }

    socket.join(code);

    const leaderboard = getLeaderboard(session, db);
    socket.emit('room_state', {
      roomCode: code,
      status: session.status,
      leaderboard,
      participants: session.participantIds.length,
    });

    if (session.status === 'live') {
      const quiz = db.quizzes.find((q) => q.id === session.quizId);
      const payload = nextQuestionPayload(session, quiz);
      if (payload) socket.emit('question_started', payload);
    }

    if (session.status === 'finished') {
      socket.emit('quiz_finished', { leaderboard });
    }
  });

  socket.on('start_quiz', async ({ roomCode }) => {
    const code = String(roomCode || '').trim().toUpperCase();

    const db = await updateDb(async (draft) => {
      const session = draft.sessions.find((s) => s.roomCode === code);
      if (!session || session.hostId !== socket.user.id || session.status !== 'waiting') return draft;
      session.status = 'live';
      session.currentQuestionIndex = 0;
      session.questionStartAt = Date.now();
      return draft;
    });

    const session = db.sessions.find((s) => s.roomCode === code);
    if (!session || session.hostId !== socket.user.id || session.status !== 'live') return;

    await launchNextQuestion(session.id);
  });

  socket.on('submit_answer', async ({ roomCode, questionId, selectedOptionIds }) => {
    const code = String(roomCode || '').trim().toUpperCase();

    if (socket.user.role === 'organizer') {
      socket.emit('error_notice', 'Организатор не может отвечать на вопросы.');
      return;
    }

    const db = await updateDb(async (draft) => {
      const session = draft.sessions.find((s) => s.roomCode === code && s.status === 'live');
      if (!session) return draft;

      const quiz = draft.quizzes.find((q) => q.id === session.quizId);
      if (!quiz) return draft;

      const question = quiz.questions[session.currentQuestionIndex];
      if (!question || question.id !== questionId) return draft;

      const elapsedMs = Date.now() - (session.questionStartAt || 0);
      if (elapsedMs > quiz.timeLimit * 1000) return draft;

      const key = `${session.id}:${question.id}`;
      session.answerLog[key] = session.answerLog[key] || [];

      if (session.answerLog[key].some((entry) => entry.userId === socket.user.id)) return draft;

      const picked = Array.isArray(selectedOptionIds) ? selectedOptionIds : [];
      const correct = [...question.correctOptionIds].sort().join('|') === [...picked].sort().join('|');
      const points = Number(question.points);

      session.answerLog[key].push({ userId: socket.user.id, selectedOptionIds: picked, correct });
      session.scores[socket.user.id] = session.scores[socket.user.id] || 0;
      if (correct) session.scores[socket.user.id] += Number.isFinite(points) && points > 0 ? points : 100;

      return draft;
    });

    const session = db.sessions.find((s) => s.roomCode === code);
    if (!session) return;

    io.to(code).emit('score_update', {
      leaderboard: getLeaderboard(session, db),
      participants: session.participantIds.length,
    });
  });

  socket.on('finish_quiz', async ({ roomCode }) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const db = await readDb();
    const session = db.sessions.find((s) => s.roomCode === code);
    if (!session) return;
    if (session.hostId !== socket.user.id) return;
    if (session.status === 'finished') return;
    await finishSession(session.id);
  });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Quiz MVP is running on http://localhost:${PORT}`);
});
