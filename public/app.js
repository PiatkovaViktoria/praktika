const state = {
  token: localStorage.getItem('quiz_token') || '',
  user: JSON.parse(localStorage.getItem('quiz_user') || 'null'),
  socket: null,
  roomCode: '',
  currentQuestion: null,
  currentQuestionType: 'single',
  roomStatus: 'waiting',
  isHostView: false,
  editingQuizId: null,
};

const el = {
  message: document.getElementById('message'),
  landingView: document.getElementById('landing-view'),
  loginView: document.getElementById('login-view'),
  registerView: document.getElementById('register-view'),
  dashboard: document.getElementById('dashboard-view'),
  hostView: document.getElementById('host-view'),
  cabinetView: document.getElementById('cabinet-view'),
  topbarActions: document.getElementById('topbar-actions'),
  cabinetBtn: document.getElementById('cabinet-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  cabinetBackBtn: document.getElementById('cabinet-back-btn'),
  badge: document.getElementById('user-badge'),
  organizerPanel: document.getElementById('organizer-panel'),
  participantPanel: document.getElementById('participant-panel'),
  cabinetOrganizer: document.getElementById('cabinet-organizer'),
  cabinetParticipant: document.getElementById('cabinet-participant'),
  cabinetOrganizerQuizzes: document.getElementById('cabinet-organizer-quizzes'),
  cabinetOrganizerConducted: document.getElementById('cabinet-organizer-conducted'),
  cabinetParticipantLeaderboard: document.getElementById('cabinet-participant-leaderboard'),
  quizzes: document.getElementById('my-quizzes'),
  questionsWrap: document.getElementById('questions-wrap'),
  liveRoom: document.getElementById('live-room'),
  roomCode: document.getElementById('room-code'),
  roomStatus: document.getElementById('room-status'),
  startBtn: document.getElementById('start-btn'),
  finishBtn: document.getElementById('finish-btn'),
  hostRoomCode: document.getElementById('host-room-code'),
  hostRoomStatus: document.getElementById('host-room-status'),
  hostStartBtn: document.getElementById('host-start-btn'),
  hostFinishBtn: document.getElementById('host-finish-btn'),
  hostBackBtn: document.getElementById('host-back-btn'),
  hostQuestionBox: document.getElementById('host-question-box'),
  hostLeaderboard: document.getElementById('host-leaderboard'),
  questionBox: document.getElementById('question-box'),
  submitAnswer: document.getElementById('submit-answer'),
  leaderboard: document.getElementById('leaderboard'),
  loginForm: document.getElementById('login-form'),
  registerForm: document.getElementById('register-form'),
  joinForm: document.getElementById('join-form'),
  quizForm: document.getElementById('quiz-form'),
  cancelEditBtn: document.getElementById('cancel-edit'),
};

function notify(text, isError = false) {
  el.message.textContent = text;
  el.message.style.color = isError ? '#c0395a' : '#1d5fb4';
}

function showPublicView(name = 'landing') {
  el.dashboard.classList.add('hidden');
  el.hostView.classList.add('hidden');
  el.cabinetView.classList.add('hidden');
  el.topbarActions.classList.add('hidden');
  el.landingView.classList.toggle('hidden', name !== 'landing');
  el.loginView.classList.toggle('hidden', name !== 'login');
  el.registerView.classList.toggle('hidden', name !== 'register');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(res.ok ? 'Некорректный ответ сервера' : `Ошибка сервера (${res.status})`);
  }

  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function saveAuth(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('quiz_token', token);
  localStorage.setItem('quiz_user', JSON.stringify(user));
}

function clearAuth() {
  state.token = '';
  state.user = null;
  state.roomCode = '';
  state.currentQuestion = null;
  state.currentQuestionType = 'single';
  state.roomStatus = 'waiting';
  state.isHostView = false;
  state.editingQuizId = null;
  localStorage.removeItem('quiz_token');
  localStorage.removeItem('quiz_user');
}

function exitToMainMenu() {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }

  clearAuth();

  el.liveRoom.classList.add('hidden');
  el.hostView.classList.add('hidden');
  el.cabinetView.classList.add('hidden');
  el.questionBox.classList.add('hidden');
  el.submitAnswer.classList.add('hidden');
  el.startBtn.classList.add('hidden');
  el.finishBtn.classList.add('hidden');
  el.leaderboard.innerHTML = '';
  el.hostLeaderboard.innerHTML = '';
  el.roomCode.textContent = '';
  el.roomStatus.textContent = '';
  el.loginForm?.reset();
  el.registerForm?.reset();

  showPublicView('landing');
  notify('Вы вышли в главное меню.');
}

function renderLeaderboard(items = []) {
  renderLeaderboardInto(el.leaderboard, items);
}

function renderLeaderboardInto(target, items = []) {
  if (!items.length) {
    target.innerHTML = '<div class="list-item muted">Пока нет результатов</div>';
    return;
  }

  target.innerHTML = items
    .map((row, idx) => `<div class="list-item">${idx + 1}. ${row.name}: <b>${row.score}</b></div>`)
    .join('');
}

function renderOrganizerCabinet(organizedQuizzes = [], conductedHistory = []) {
  el.cabinetOrganizer.classList.remove('hidden');
  el.cabinetParticipant.classList.add('hidden');

  el.cabinetOrganizerQuizzes.innerHTML = organizedQuizzes.length
    ? organizedQuizzes.map((q) => `<div class="list-item">${q.title} <span class="muted">(${q.questions.length} вопросов)</span></div>`).join('')
    : '<div class="list-item muted">Пока нет созданных квизов</div>';

  el.cabinetOrganizerConducted.innerHTML = conductedHistory.length
    ? conductedHistory
        .map((s) => {
          const leaders = (s.top || []).map((row) => `${row.name}: ${row.score}`).join(', ');
          return `<div class="list-item"><b>${s.quizTitle}</b> · участников: ${s.participants}<br/><span class="muted">Топ: ${leaders || 'нет результатов'}</span></div>`;
        })
        .join('')
    : '<div class="list-item muted">Пока нет проведенных квизов</div>';
}

function renderParticipantCabinet(attempts = []) {
  el.cabinetOrganizer.classList.add('hidden');
  el.cabinetParticipant.classList.remove('hidden');

  if (!attempts.length) {
    el.cabinetParticipantLeaderboard.innerHTML = '<div class="list-item muted">Лидерборд появится после участия</div>';
    return;
  }

  el.cabinetParticipantLeaderboard.innerHTML = attempts
    .map((a) => `<div class="list-item">${a.quizTitle} (${a.roomCode}) · место #${a.rank} из ${a.totalPlayers} · ${a.score} баллов</div>`)
    .join('');
}

function questionBuilderTemplate(index) {
  return questionBuilderTemplateWithData(index, null);
}

function questionBuilderTemplateWithData(index, data) {
  const n = index + 1;
  const question = data || {};
  const type = question.type === 'multiple' ? 'multiple' : 'single';
  const optionsText = Array.isArray(question.options) ? question.options.map((o) => o.text).join(', ') : '';
  const correctText = Array.isArray(question.correctOptionIds) && Array.isArray(question.options)
    ? question.correctOptionIds
        .map((id) => question.options.findIndex((o) => o.id === id) + 1)
        .filter((n) => n > 0)
        .join(', ')
    : '';
  const points = Number.isFinite(Number(question.points)) ? Number(question.points) : 100;
  return `
    <div class="list-item question-builder" data-idx="${index}">
      <div class="question-builder-head">
        <strong class="question-num">Вопрос ${n}</strong>
        <button type="button" class="btn-secondary btn-small" data-remove-question>Удалить</button>
      </div>
      <label class="field">
        <span>Формулировка</span>
        <input class="q-text" type="text" placeholder="Текст вопроса" autocomplete="off" value="${String(question.text || '').replace(/"/g, '&quot;')}" />
      </label>
      <label class="field">
        <span>Картинка (URL)</span>
        <input class="q-image" type="url" placeholder="https://..." autocomplete="off" value="${String(question.imageUrl || '').replace(/"/g, '&quot;')}" />
      </label>
      <label class="field">
        <span>Тип ответа</span>
        <select class="q-type">
          <option value="single" ${type === 'single' ? 'selected' : ''}>Один вариант</option>
          <option value="multiple" ${type === 'multiple' ? 'selected' : ''}>Несколько вариантов</option>
        </select>
      </label>
      <label class="field">
        <span>Варианты</span>
        <input class="q-options" type="text" placeholder="Вариант А, Вариант Б, Вариант В" autocomplete="off" value="${String(optionsText).replace(/"/g, '&quot;')}" />
        <p class="hint">Разделяйте варианты запятой.</p>
      </label>
      <label class="field">
        <span>Правильный ответ</span>
        <input class="q-correct" type="text" placeholder="Номера: 1, 2, 3" inputmode="numeric" autocomplete="off" value="${String(correctText).replace(/"/g, '&quot;')}" />
        <p class="hint">Первый вариант = <b>1</b>, несколько правильных вводите через запятую: <b>1, 2, 3</b>.</p>
      </label>
      <label class="field">
        <span>Баллы за вопрос</span>
        <input class="q-points" type="number" min="1" step="1" value="${points}" />
      </label>
    </div>
  `;
}

function renumberQuestionBuilders() {
  el.questionsWrap.querySelectorAll('.question-builder').forEach((block, i) => {
    block.dataset.idx = String(i);
    const title = block.querySelector('.question-num');
    if (title) title.textContent = `Вопрос ${i + 1}`;
  });
}

function addQuestionBuilder() {
  const idx = el.questionsWrap.querySelectorAll('.question-builder').length;
  el.questionsWrap.insertAdjacentHTML('beforeend', questionBuilderTemplate(idx));
}

function resetQuizFormToCreateMode() {
  state.editingQuizId = null;
  el.quizForm?.reset();
  el.questionsWrap.innerHTML = '';
  addQuestionBuilder();
  const submitBtn = el.quizForm?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = 'Сохранить квиз';
  el.cancelEditBtn?.classList.add('hidden');
}

function enterEditMode(quiz) {
  state.editingQuizId = quiz.id;
  el.quizForm.title.value = quiz.title || '';
  el.quizForm.categories.value = Array.isArray(quiz.categories) ? quiz.categories.join(', ') : '';
  el.quizForm.timeLimit.value = quiz.timeLimit || 20;
  el.quizForm.rules.value = quiz.rules || '';
  el.questionsWrap.innerHTML = '';
  (quiz.questions || []).forEach((q, i) => {
    el.questionsWrap.insertAdjacentHTML('beforeend', questionBuilderTemplateWithData(i, q));
  });
  if (!(quiz.questions || []).length) addQuestionBuilder();
  const submitBtn = el.quizForm?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = 'Обновить квиз';
  el.cancelEditBtn?.classList.remove('hidden');
  el.quizForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  notify(`Редактирование квиза: ${quiz.title}`);
}

el.questionsWrap?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-question]');
  if (!btn) return;

  const block = btn.closest('.question-builder');
  const all = el.questionsWrap.querySelectorAll('.question-builder');
  if (all.length <= 1) {
    notify('Нужен хотя бы один вопрос.', true);
    return;
  }

  block.remove();
  renumberQuestionBuilders();
});

function optionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `o${Math.random().toString(16).slice(2, 10)}`;
}

function buildQuestionsFromForm() {
  const blocks = [...el.questionsWrap.querySelectorAll('.question-builder')];
  const questions = [];
  let blockIndex = 0;

  for (const block of blocks) {
    blockIndex += 1;
    const text = block.querySelector('.q-text').value.trim();
    const imageUrl = block.querySelector('.q-image').value.trim();
    const type = block.querySelector('.q-type').value;
    const rawOptions = block.querySelector('.q-options').value;
    const rawCorrect = block.querySelector('.q-correct').value.trim();
    const rawPoints = Number(block.querySelector('.q-points').value || 100);

    const options = rawOptions.split(',').map((s) => s.trim()).filter(Boolean);
    const correctIndexes = rawCorrect
      .split(',')
      .map((s) => Number(String(s).trim()) - 1)
      .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);

    const touched = text || imageUrl || rawOptions.trim() || rawCorrect;
    if (!touched) continue;

    if (!text) throw new Error(`Вопрос ${blockIndex}: укажите текст.`);
    if (options.length < 2) throw new Error(`Вопрос ${blockIndex}: нужно минимум два варианта ответа (через запятую).`);
    if (correctIndexes.length === 0) {
      throw new Error(`Вопрос ${blockIndex}: укажите номер(а) правильного варианта (от 1 до ${options.length}).`);
    }
    if (type === 'single' && correctIndexes.length > 1) {
      throw new Error(`Вопрос ${blockIndex}: для одиночного выбора укажите только один номер.`);
    }
    if (!Number.isFinite(rawPoints) || rawPoints < 1) {
      throw new Error(`Вопрос ${blockIndex}: баллы должны быть числом от 1.`);
    }

    const optionObjects = options.map((t) => ({ id: optionId(), text: t }));
    const correctOptionIds = [...new Set(correctIndexes)].map((i) => optionObjects[i].id);

    questions.push({ text, imageUrl, type, options: optionObjects, correctOptionIds, points: Math.floor(rawPoints) });
  }

  if (!questions.length) throw new Error('Добавьте хотя бы один заполненный вопрос.');

  return questions;
}

async function loadProfile() {
  const data = await api('/api/me');
  const { user, organizedQuizzes, organizerConductedHistory, participationHistory } = data;

  el.badge.textContent = `${user.name} (${user.role === 'organizer' ? 'Организатор' : 'Участник'})`;
  el.organizerPanel.classList.toggle('hidden', user.role !== 'organizer');
  el.participantPanel.classList.toggle('hidden', user.role !== 'participant');

  if (user.role === 'organizer') {
    renderOrganizerCabinet(organizedQuizzes || [], organizerConductedHistory || []);
    const my = organizedQuizzes || [];
    el.quizzes.innerHTML = my.length
      ? my
          .map(
            (q) =>
              `<div class="list-item row"><div>${q.title} <span class="muted">(${q.questions.length} вопросов)</span></div><div class="row"><button class="btn-secondary btn-small" data-edit-quiz="${q.id}">Редактировать</button><button data-launch="${q.id}">Запустить</button><button class="btn-secondary btn-small" data-delete-quiz="${q.id}">Удалить</button></div></div>`
          )
          .join('')
      : '<div class="list-item muted">Создайте первый квиз</div>';
    return;
  }

  renderParticipantCabinet(participationHistory || []);
}

function initSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('room_state', (payload) => {
    state.roomStatus = payload.status;
    el.roomStatus.textContent = `Статус: ${payload.status}. Участников: ${payload.participants}`;
    el.hostRoomStatus.textContent = `Статус: ${payload.status}. Участников: ${payload.participants}`;
    el.hostStartBtn.disabled = payload.status !== 'waiting';
    el.hostFinishBtn.disabled = payload.status === 'finished';
    renderLeaderboard(payload.leaderboard);
    renderLeaderboardInto(el.hostLeaderboard, payload.leaderboard);
  });

  state.socket.on('question_started', (payload) => {
    state.currentQuestion = payload.question;
    state.currentQuestionType = payload.question.type === 'multiple' ? 'multiple' : 'single';
    const isOrganizer = state.user?.role === 'organizer';

    el.questionBox.classList.remove('hidden');
    if (isOrganizer) el.submitAnswer.classList.add('hidden');
    else el.submitAnswer.classList.remove('hidden');

    const questionHtml = `
      <div class="muted">Вопрос ${payload.index + 1} / ${payload.total}. На ответ: ${payload.timeLimit} сек.</div>
      <div class="muted">Баллы за вопрос: ${payload.question.points || 100}</div>
      <h3>${payload.question.text}</h3>
      ${payload.question.imageUrl ? `<img src="${payload.question.imageUrl}" style="max-width:280px;border-radius:12px;border:1px solid var(--line)"/>` : ''}
      ${isOrganizer ? '<p class="hint organizer-hint">Вы ведете квиз - ответы отправляют только участники.</p>' : ''}
      <div class="answers-grid ${isOrganizer ? 'answers-readonly' : ''}">
      ${payload.question.options
        .map((o) => `<button type="button" class="answer-btn" data-option-id="${o.id}">${o.text}</button>`)
        .join('')}
      </div>
    `;
    el.questionBox.innerHTML = questionHtml;
    el.hostQuestionBox.innerHTML = questionHtml;

    notify(isOrganizer ? 'Вопрос показан участникам.' : 'Новый вопрос открыт. Отвечайте сейчас!');
    el.hostStartBtn.disabled = true;
  });

  state.socket.on('score_update', ({ leaderboard, participants }) => {
    renderLeaderboard(leaderboard);
    renderLeaderboardInto(el.hostLeaderboard, leaderboard);
    el.roomStatus.textContent = `Статус: ${state.roomStatus}. Участников: ${participants}`;
    el.hostRoomStatus.textContent = `Статус: ${state.roomStatus}. Участников: ${participants}`;
  });

  state.socket.on('quiz_finished', ({ leaderboard }) => {
    renderLeaderboard(leaderboard);
    renderLeaderboardInto(el.hostLeaderboard, leaderboard);
    el.questionBox.classList.add('hidden');
    el.hostQuestionBox.innerHTML = '<div class="list-item muted">Квиз завершен.</div>';
    el.submitAnswer.classList.add('hidden');
    el.startBtn.classList.add('hidden');
    el.finishBtn.classList.add('hidden');
    el.hostStartBtn.disabled = true;
    el.hostFinishBtn.disabled = true;
    notify('Квиз завершен, итоговый лидерборд обновлен.');
    loadProfile().catch(() => {});
  });

  state.socket.on('error_notice', (msg) => notify(msg, true));
}

el.questionBox.addEventListener('click', (e) => {
  const button = e.target.closest('.answer-btn');
  if (!button) return;
  if (state.user?.role === 'organizer') return;

  if (state.currentQuestionType === 'single') {
    el.questionBox.querySelectorAll('.answer-btn.is-selected').forEach((btn) => btn.classList.remove('is-selected'));
    button.classList.add('is-selected');
    return;
  }

  button.classList.toggle('is-selected');
});

function enterDashboard() {
  el.landingView.classList.add('hidden');
  el.loginView.classList.add('hidden');
  el.registerView.classList.add('hidden');
  el.dashboard.classList.remove('hidden');
  el.hostView.classList.add('hidden');
  el.cabinetView.classList.add('hidden');
  el.topbarActions.classList.remove('hidden');
  el.liveRoom.classList.add('hidden');

  loadProfile().catch((e) => notify(e.message, true));
  initSocket();
}

function enterHostView(roomCode) {
  state.isHostView = true;
  el.dashboard.classList.add('hidden');
  el.liveRoom.classList.add('hidden');
  el.hostView.classList.remove('hidden');
  el.cabinetView.classList.add('hidden');
  el.hostRoomCode.textContent = roomCode;
  el.hostRoomStatus.textContent = `Статус: waiting. Код комнаты: ${roomCode}`;
  el.hostQuestionBox.innerHTML = '<div class="list-item muted">Квиз еще не запущен.</div>';
  el.hostStartBtn.disabled = false;
  el.hostFinishBtn.disabled = false;
  renderLeaderboardInto(el.hostLeaderboard, []);
}

el.logoutBtn.addEventListener('click', exitToMainMenu);
el.cabinetBtn.addEventListener('click', () => {
  if (!state.token || !state.user) return;
  el.dashboard.classList.add('hidden');
  el.hostView.classList.add('hidden');
  el.cabinetView.classList.remove('hidden');
  state.isHostView = false;
  loadProfile().catch((e) => notify(e.message, true));
});
el.cabinetBackBtn.addEventListener('click', () => {
  el.cabinetView.classList.add('hidden');
  el.dashboard.classList.remove('hidden');
});

document.getElementById('go-login').addEventListener('click', () => showPublicView('login'));
document.getElementById('go-register').addEventListener('click', () => showPublicView('register'));
document.getElementById('back-from-login').addEventListener('click', () => showPublicView('landing'));
document.getElementById('back-from-register').addEventListener('click', () => showPublicView('landing'));

el.registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);

  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    saveAuth(data.token, data.user);
    enterDashboard();
    notify('Аккаунт создан.');
  } catch (err) {
    notify(err.message, true);
  }
});

el.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    saveAuth(data.token, data.user);
    enterDashboard();
    notify('Вход выполнен.');
  } catch (err) {
    notify(err.message, true);
  }
});

document.getElementById('add-question')?.addEventListener('click', addQuestionBuilder);

if (el.quizForm) {
  resetQuizFormToCreateMode();

  el.quizForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    try {
      const form = new FormData(e.target);
      const title = String(form.get('title') || '').trim();
      if (!title) {
        notify('Укажите название квиза.', true);
        return;
      }

      const questions = buildQuestionsFromForm();

      const isEditing = Boolean(state.editingQuizId);
      await api(isEditing ? `/api/quizzes/${state.editingQuizId}` : '/api/quizzes', {
        method: isEditing ? 'PUT' : 'POST',
        body: JSON.stringify({
          title,
          categories: String(form.get('categories') || '').split(',').map((s) => s.trim()).filter(Boolean),
          timeLimit: Number(form.get('timeLimit')),
          rules: form.get('rules'),
          questions,
        }),
      });

      notify(isEditing ? 'Квиз обновлен.' : 'Квиз создан.');
      resetQuizFormToCreateMode();
      await loadProfile();
    } catch (err) {
      notify(err.message, true);
    }
  });
}

el.cancelEditBtn?.addEventListener('click', () => {
  resetQuizFormToCreateMode();
  notify('Редактирование отменено.');
});

el.quizzes.addEventListener('click', async (e) => {
  const editButton = e.target.closest('button[data-edit-quiz]');
  if (editButton) {
    const quizId = editButton.dataset.editQuiz;
    try {
      const data = await api('/api/quizzes/mine');
      const quiz = (data.quizzes || []).find((q) => q.id === quizId);
      if (!quiz) {
        notify('Квиз не найден.', true);
        return;
      }
      enterEditMode(quiz);
    } catch (err) {
      notify(err.message, true);
    }
    return;
  }

  const deleteButton = e.target.closest('button[data-delete-quiz]');
  if (deleteButton) {
    const quizId = deleteButton.dataset.deleteQuiz;
    const ok = window.confirm('Удалить квиз? Это также удалит его сессии и результаты.');
    if (!ok) return;
    try {
      await api(`/api/quizzes/${quizId}`, { method: 'DELETE' });
      el.liveRoom.classList.add('hidden');
      el.hostView.classList.add('hidden');
      el.questionBox.classList.add('hidden');
      el.submitAnswer.classList.add('hidden');
      state.isHostView = false;
      notify('Квиз удален.');
      await loadProfile();
    } catch (err) {
      notify(err.message, true);
    }
    return;
  }

  const button = e.target.closest('button[data-launch]');
  if (!button) return;

  try {
    const data = await api(`/api/quizzes/${button.dataset.launch}/launch`, { method: 'POST' });
    state.roomCode = data.session.roomCode;
    enterHostView(state.roomCode);
    state.socket.emit('join_room', { roomCode: state.roomCode });
    notify(`Комната создана. Код: ${state.roomCode}`);
  } catch (err) {
    notify(err.message, true);
  }
});

el.joinForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const roomCode = String(form.get('roomCode') || '').toUpperCase();

  try {
    await api('/api/rooms/join', {
      method: 'POST',
      body: JSON.stringify({ roomCode }),
    });

    state.roomCode = roomCode;
    el.liveRoom.classList.remove('hidden');
    el.roomCode.textContent = roomCode;
    el.startBtn.classList.add('hidden');
    el.finishBtn.classList.add('hidden');
    state.socket.emit('join_room', { roomCode });
    notify('Вы подключились к активному квизу.');
  } catch (err) {
    notify(err.message, true);
  }
});

el.startBtn.addEventListener('click', () => {
  if (!state.roomCode) return;
  state.socket.emit('start_quiz', { roomCode: state.roomCode });
  notify('Квиз запущен.');
});

el.hostStartBtn.addEventListener('click', () => {
  if (!state.roomCode) return;
  if (state.user?.role !== 'organizer') return;
  state.socket.emit('start_quiz', { roomCode: state.roomCode });
  notify('Квиз запущен.');
});

el.finishBtn.addEventListener('click', () => {
  if (!state.roomCode) return;
  if (state.user?.role !== 'organizer') return;
  const ok = window.confirm('Завершить квиз сейчас?');
  if (!ok) return;
  api(`/api/rooms/${state.roomCode}/finish`, { method: 'POST' })
    .then(() => {
      notify('Квиз завершен.');
      return loadProfile();
    })
    .catch((err) => notify(err.message, true));
});

el.hostFinishBtn.addEventListener('click', () => {
  if (!state.roomCode) return;
  if (state.user?.role !== 'organizer') return;
  const ok = window.confirm('Завершить квиз сейчас?');
  if (!ok) return;
  api(`/api/rooms/${state.roomCode}/finish`, { method: 'POST' })
    .then(() => {
      notify('Квиз завершен.');
      return loadProfile();
    })
    .catch((err) => notify(err.message, true));
});

el.hostBackBtn.addEventListener('click', () => {
  el.hostView.classList.add('hidden');
  el.dashboard.classList.add('hidden');
  el.cabinetView.classList.remove('hidden');
  state.isHostView = false;
  loadProfile().catch((e) => notify(e.message, true));
});

el.submitAnswer.addEventListener('click', () => {
  if (!state.currentQuestion || !state.roomCode) return;
  if (state.user?.role === 'organizer') return;

  const selected = [...el.questionBox.querySelectorAll('.answer-btn.is-selected')].map((btn) => btn.dataset.optionId);
  if (!selected.length) {
    notify('Выберите хотя бы один вариант.', true);
    return;
  }

  state.socket.emit('submit_answer', {
    roomCode: state.roomCode,
    questionId: state.currentQuestion.id,
    selectedOptionIds: selected,
  });

  el.submitAnswer.classList.add('hidden');
  notify('Ответ принят. Ждем следующий вопрос.');
});

if (state.token && state.user) enterDashboard();
else showPublicView('landing');
