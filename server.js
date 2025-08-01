const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// MySQL kapcsolat létrehozása
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'rps',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Middleware-ek
app.use(express.static('public'));
app.use(bodyParser.json());

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

// Regisztráció
app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Ellenőrizzük, hogy létezik-e már a felhasználó
    const [existingUsers] = await pool.query('SELECT * FROM felhasznalok WHERE email = ?', [email]);
    
    if (existingUsers.length > 0) {
      return res.status(400).json({ success: false, message: 'Ez az email cím már regisztrálva van.' });
    }
    
    // Jelszó hashelése
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Felhasználó mentése az adatbázisba
    await pool.query(
      'INSERT INTO felhasznalok (email, jelszo, kod, aktivalt) VALUES (?, ?, ?, 0)',
      [email, hashedPassword, verificationCode]
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
    
    // Ellenőrizzük a kódot
    const [users] = await pool.query(
      'SELECT * FROM felhasznalok WHERE email = ? AND kod = ?',
      [email, code]
    );
    
    if (users.length === 0) {
      return res.status(400).json({ success: false, message: 'Hibás kód vagy email cím.' });
    }
    
    // Aktiváljuk a felhasználót
    await pool.query(
      'UPDATE felhasznalok SET aktivalt = 1, kod = NULL WHERE email = ?',
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
    
    // Felhasználó keresése
    const [users] = await pool.query('SELECT * FROM felhasznalok WHERE email = ?', [email]);
    
    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'Hibás email cím vagy jelszó.' });
    }
    
    const user = users[0];
    
    // Jelszó ellenőrzése
    const passwordMatch = await bcrypt.compare(password, user.jelszo);
    
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Hibás email cím vagy jelszó.' });
    }
    
    // Ellenőrizzük, hogy aktivált-e a fiók
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