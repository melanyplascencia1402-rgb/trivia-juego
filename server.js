const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// RUTAS DE LA PÁGINA PRINCIPAL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/host.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'host.html'));
});

app.get('/player.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'player.html'));
});

app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'style.css'));
});

// ========== PREGUNTAS FIJAS (edita aquí) ==========
const QUESTIONS = [
  { q: "¿Qué herramienta utilizó el equipo para organizar las ideas y repartir las tareas del proyecto?", a: ["Render", "Trello", "Jira", "Miro"], correct: 1 },
  { q: "¿En qué programa se escribió y editó el código de la página web?", a: ["Canva", "Trello", "Visual Studio Code", "Render"], correct: 2 },
  { q: "¿Qué framework se utilizó para desarrollar la aplicación web?", a: ["React", "Bootstrap", "Django", "Flask"], correct: 3 },
  { q: "¿Qué lenguajes y tecnologías se utilizaron para crear la página web?", a: ["HTML, CSS y Python", "Java, C++ y PHP", "Kotlin, Swift y Ruby", "SQL, Java y C#"], correct: 0 },
  { q: "¿Qué significa probar una página web en localhost?", a: ["Publicarla directamente en internet", "Probarla localmente desde la propia computadora antes de publicarla", "Guardarla permanentemente en GitHub", "Compartirla mediante un enlace público"], correct: 1 },
  { q: "¿Qué función tuvo GitHub durante la publicación del proyecto?", a: ["Diseñar las imágenes de la página", "Organizar las tareas del equipo", "Almacenar el código y conectarlo con la plataforma de despliegue", "Crear automáticamente los lenguajes de programación"], correct: 2 },
  { q: "¿Para qué se utilizó Render en el proyecto?", a: ["Para editar el tablero de actividades", "Para editar los archivos HTML", "Para probar la página en localhost", "Para desplegar la página y permitir que otras personas accedan mediante un enlace"], correct: 3 }
];

const QUESTION_TIME = 15; // segundos por pregunta

// Salas en memoria
const rooms = {}; // codigo -> { hostId, players:{id:{name,score}}, state, currentQ, timer, answers:{} }

function genCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); }
  while (rooms[code]);
  return code;
}

function getIP() {
  const nets = os.networkInterfaces();
  for (const name in nets) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

io.on('connection', (socket) => {

  // --- MODERADOR CREA SALA ---
  socket.on('createRoom', async () => {
    const code = genCode();
    rooms[code] = {
      hostId: socket.id,
      players: {},
      state: 'lobby',
      currentQ: -1,
      timer: null,
      answers: {}
    };
    socket.join(code);
    socket.roomCode = code;

    // Corrección para Render: si estamos en la nube usamos su URL, si no, la IP local
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://${getIP()}:3000`;
    const url = `${baseUrl}/player.html?room=${code}`;
    const qr = await QRCode.toDataURL(url);

    socket.emit('roomCreated', { code, qr, url });
  });

  // --- JUGADOR SE UNE ---
  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('joinError', 'La sala no existe');
    if (room.state !== 'lobby') return socket.emit('joinError', 'La partida ya empezó');

    room.players[socket.id] = { name, score: 0 };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;

    io.to(code).emit('updatePlayers', getPlayerList(room));
    socket.emit('joined', { code, name });
  });

  // --- MODERADOR INICIA PARTIDA ---
  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.state = 'playing';
    room.currentQ = 0;
    sendQuestion(socket.roomCode, room);
  });

  // --- JUGADOR RESPONDE ---
  socket.on('answer', ({ answerIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.state !== 'question') return;
    if (room.answers[socket.id] !== undefined) return; // ya respondió
    room.answers[socket.id] = answerIndex;
  });

  // --- MODERADOR PASA A SIGUIENTE PREGUNTA ---
  socket.on('nextQuestion', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.hostId !== socket.id) return;
    clearTimeout(room.timer);
    room.currentQ++;
    if (room.currentQ >= QUESTIONS.length) return endGame(socket.roomCode);
    sendQuestion(socket.roomCode, room);
  });

  // --- DESCONEXIÓN ---
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.hostId === socket.id) {
      io.to(code).emit('hostLeft');
      clearTimeout(room.timer);
      delete rooms[code];
    } else {
      delete room.players[socket.id];
      io.to(code).emit('updatePlayers', getPlayerList(room));
    }
  });
});

function getPlayerList(room) {
  return Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score }));
}

function sendQuestion(code, room) {
  room.state = 'question';
  room.answers = {};
  const q = QUESTIONS[room.currentQ];

  io.to(code).emit('newQuestion', {
    index: room.currentQ,
    total: QUESTIONS.length,
    question: q.q,
    answers: q.a,
    time: QUESTION_TIME
  });

  room.timer = setTimeout(() => {
    scoreQuestion(code, room);
  }, QUESTION_TIME * 1000);
}

function scoreQuestion(code, room) {
  if (room.state !== 'question') return;
  room.state = 'reveal';
  const q = QUESTIONS[room.currentQ];

  // Calcular puntos
  for (const pid in room.answers) {
    if (room.answers[pid] === q.correct && room.players[pid]) {
      room.players[pid].score += 100;
    }
  }

  io.to(code).emit('revealAnswer', {
    correct: q.correct,
    players: getPlayerList(room)
  });

  clearTimeout(room.timer);
}

function endGame(code) {
  const room = rooms[code];
  if (!room) return;
  room.state = 'ended';
  io.to(code).emit('gameOver', { players: getPlayerList(room) });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});