const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const path = require('path');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["https://your-app.onrender.com", "http://localhost:3000"],
    methods: ["GET", "POST"]
  }
});
// Hitelesítési middleware
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization;
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Hozzáférés megtagadva. Nincs token.' });
  }
  
  try {
    // Itt ellenőriznéd a token érvényességét
    // Most egyszerűsített változat, ahol csak ellenőrizzük, hogy van-e user a localStorage-ban
    next();
  } catch (error) {
    console.error('Hiba a token ellenőrzése során:', error);
    res.status(401).json({ success: false, message: 'Érvénytelen token.' });
  }
};

// Példa egy védett route-ra
app.get('/api/protected', authenticate, (req, res) => {
  res.json({ success: true, message: 'Védett tartalom' });
});

// Ellenőrizd a socket kapcsolatot
io.on('connection', (socket) => {
  console.log('✅ Új kapcsolat:', socket.id);
  
  socket.on('joinGame', (roomId) => {
    console.log(`🏠 ${socket.id} csatlakozott a ${roomId} szobához`);
  });
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware-ek
// Statikus fájlok kezelése
app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
app.use(bodyParser.json());

// Biztonsági fejlécek
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});


// Email küldő konfiguráció
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Játék szobák kezelése
const rooms = {};

// Kezdőoldal - átirányítás a megfelelő oldalra
app.get('/', async (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
  } catch (error) {
    console.error('Hiba a kezdőoldal betöltésekor:', error);
    res.status(500).send('Hiba történt a kezdőoldal betöltésekor.');
  }
});


// Védett route-ok (csak bejelentkezett felhasználóknak)
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/menu', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

// Regisztráció
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Módosított SQL lekérdezés - PostgreSQL kompatibilis szintaxis
    const existingUsers = await pool.query(
      'SELECT * FROM felhasznalok WHERE email = $1', 
      [email]
    );
    
    if (existingUsers.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Ez az email cím már regisztrálva van.' });
    }
    
    // Jelszó hashelése
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Felhasználó mentése az adatbázisba
    await pool.query(
      'INSERT INTO felhasznalok (email, jelszo, kod, aktivalt) VALUES ($1, $2, $3, $4)',
      [email, hashedPassword, verificationCode, false]
    );
    
    // Email küldése
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Regisztráció megerősítése - Kő-Papír-Olló Játék',
      text: `Köszönjük a regisztrációt!\n\nAz aktiváló kódod: ${verificationCode}\n\nA kódot a verify.html oldalon tudod megadni.`
    };
    
    await transporter.sendMail(mailOptions);
    
    res.json({ 
      success: true, 
      message: 'Regisztráció sikeres! Kérlek erősítsd meg az email címed az elküldött kóddal.' 
    });
  } catch (error) {
    console.error('Hiba a regisztráció során:', error);
    res.status(500).json({ success: false, message: 'Hiba történt a regisztráció során.' });
  }
});

// Kód ellenőrzése
app.post('/api/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    
    // Módosított SELECT parancs
    const users = await pool.query(
      'SELECT * FROM felhasznalok WHERE email = $1 AND kod = $2',
      [email, code]
    );
    
    if (users.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Hibás kód vagy email cím.' });
    }
    
    // Aktiváljuk a felhasználót
    await pool.query(
      'UPDATE felhasznalok SET aktivalt = true, kod = NULL WHERE email = $1',
      [email]
    );
    
    res.json({ 
      success: true, 
      message: 'Sikeres aktiválás! Most már bejelentkezhetsz.' 
    });
  } catch (error) {
    console.error('Hiba a kód ellenőrzése során:', error);
    res.status(500).json({ success: false, message: 'Hiba történt a kód ellenőrzése során.' });
  }
});

// Bejelentkezés
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Módosított SELECT parancs
    const users = await pool.query(
      'SELECT * FROM felhasznalok WHERE email = $1', 
      [email]
    );
    
    if (users.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Hibás email cím vagy jelszó.' });
    }
    
    const user = users.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.jelszo);
    
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Hibás email cím vagy jelszó.' });
    }
    
    if (!user.aktivalt) {
      return res.status(403).json({ 
        success: false, 
        message: 'A fiók nincs aktiválva. Kérlek erősítsd meg az email címed.' 
      });
    }
    
    // Sikeres bejelentkezés
    res.json({ 
      success: true, 
      message: 'Sikeres bejelentkezés!',
      user: { email: user.email }
    });
  } catch (error) {
    console.error('Hiba a bejelentkezés során:', error);
    res.status(500).json({ success: false, message: 'Hiba történt a bejelentkezés során.' });
  }
});

// Játék logika Socket.io-val
io.on('connection', (socket) => {
  console.log('Egy felhasználó csatlakozott:', socket.id);

  socket.on('joinGame', (roomId) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        scores: {},
        rematchVotes: {},
        timers: {},
      };
    }

    const room = rooms[roomId];
    room.players[socket.id] = { choice: null };
    room.scores[socket.id] = 0;

    if (Object.keys(room.players).length === 2) {
      io.to(roomId).emit('startGame');
      startRound(roomId);
    }
  });

  socket.on('result', (data) => {
  clearInterval(countdownInterval);
  document.getElementById('game').style.display = 'none';
  document.getElementById('result').style.display = 'block';
  document.getElementById('actionButtons').style.display = 'none'; // Elrejtjük a gombokat
  
  document.getElementById('resultText').textContent =
    `Te: ${data.yourChoice} | Ellenfél: ${data.opponentChoice} → ${data.outcome}`;
  document.getElementById('scoreboard').textContent =
    `Pontszám: Te ${data.yourScore} - ${data.opponentScore} Ellenfél`;
});

// Játék vége esetén
socket.on('game-over', () => {
  document.getElementById('actionButtons').style.display = 'flex'; // Megjelenítjük a gombokat
  document.getElementById('rematchBtn').disabled = false;
  document.getElementById('status').textContent = 'A játék véget ért.';

  document.getElementById('exitBtn').addEventListener('click', function() {
  if (confirm('Biztosan ki akarsz lépni a játékból?')) {
    socket.emit('leave-room', roomId);
    window.location.href = 'menu.html';
  }
});
});

// Új játék indításakor
socket.on('rematch-start', () => {
  document.getElementById('result').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  document.getElementById('actionButtons').style.display = 'none'; // Elrejtjük a gombokat
  enableButtons();
  startCountdown();
});

  socket.on('choice', ({ roomId, choice }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.players[socket.id]) {
      room.players[socket.id].choice = choice;
    }

    checkChoices(roomId);
  });

  socket.on('play-again', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    room.rematchVotes[socket.id] = true;

    if (Object.keys(room.rematchVotes).length === 2) {
      // Reset
      for (let pid in room.players) {
        room.players[pid].choice = null;
        room.scores[pid] = 0;
      }
      room.rematchVotes = {};
      io.to(roomId).emit('rematch-start');
      startRound(roomId);
    }
  });

  socket.on('leave-room', (roomId) => {
    leaveRoom(socket, roomId);
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      if (rooms[roomId].players[socket.id]) {
        leaveRoom(socket, roomId);
      }
    }
  });
});

// Segédfüggvények a játékhoz
function leaveRoom(socket, roomId) {
  const room = rooms[roomId];
  if (!room) return;
  delete room.players[socket.id];
  delete room.scores[socket.id];
  clearTimeout(room.timers[roomId]);
  io.to(roomId).emit('opponent-left');
  if (Object.keys(room.players).length === 0) delete rooms[roomId];
}

function startRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Reset choice
  for (let pid in room.players) {
    room.players[pid].choice = null;
  }

  io.to(roomId).emit('new-round');

  // 30 másodperc időzítő
  room.timers[roomId] = setTimeout(() => {
    for (let pid in room.players) {
      if (!room.players[pid].choice) {
        room.players[pid].choice = getRandomChoice();
      }
    }
    checkChoices(roomId);
  }, 30000);
}

function checkChoices(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const players = Object.entries(room.players);

  if (players.every(([_, p]) => p.choice !== null)) {
    clearTimeout(room.timers[roomId]);

    const [[id1, p1], [id2, p2]] = players;
    const result = getResult(p1.choice, p2.choice);

    if (result === 1) room.scores[id1]++;
    if (result === -1) room.scores[id2]++;

    // Eredmény küldése
    io.to(id1).emit('result', {
      yourChoice: p1.choice,
      opponentChoice: p2.choice,
      outcome: getOutcomeText(result),
      yourScore: room.scores[id1],
      opponentScore: room.scores[id2]
    });

    io.to(id2).emit('result', {
      yourChoice: p2.choice,
      opponentChoice: p1.choice,
      outcome: getOutcomeText(-result),
      yourScore: room.scores[id2],
      opponentScore: room.scores[id1]
    });

    // Játék vége?
    if (room.scores[id1] === 3 || room.scores[id2] === 3) {
      io.to(roomId).emit('game-over');
    } else {
      // Új kör 5 másodperc múlva
      setTimeout(() => startRound(roomId), 5000);
    }
  }
}

function getResult(choice1, choice2) {
  if (choice1 === choice2) return 0;
  if (
    (choice1 === 'kő' && choice2 === 'olló') ||
    (choice1 === 'papír' && choice2 === 'kő') ||
    (choice1 === 'olló' && choice2 === 'papír')
  ) return 1;
  return -1;
}

function getOutcomeText(result) {
  return result === 1 ? 'Nyertél!' : result === 0 ? 'Döntetlen!' : 'Vesztettél!';
}

function getRandomChoice() {
  const options = ['kő', 'papír', 'olló'];
  return options[Math.floor(Math.random() * options.length)];
}

// Szerver indítása
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`A szerver fut a http://localhost:${PORT} címen`);
});