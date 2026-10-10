require("dotenv").config();
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BURN_SECONDS = 15;
const MAX_LEN = 500;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "../public")));

// ---------- REST: register + login ----------
app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || "") || (password || "").length < 6)
      return res.status(400).json({ error: "Username: 3-20 letters/numbers/_. Password: min 6 chars." });
    const hash = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (username, password_hash) VALUES ($1,$2)", [username, hash]);
    res.sendStatus(201);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Username already taken" });
    console.error(e);
    res.sendStatus(500);
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const r = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(password || "", u.password_hash)))
      return res.status(401).json({ error: "Invalid username or password" });
    const token = jwt.sign({ id: u.id, username: u.username }, process.env.JWT_SECRET, { expiresIn: "8h" });
    res.json({ token, username: u.username });
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// ---------- Socket auth: no valid token = no connection ----------
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

const online = {}; // roomName -> { username: socketCount }
const presence = (room) => Object.keys(online[room] || {});

io.on("connection", (socket) => {
  const user = socket.user;
  let room = null;
  let sent = [];

  const allowed = () => {                       // max 5 messages per second
    const now = Date.now();
    sent = sent.filter((t) => now - t < 1000);
    if (sent.length >= 5) return false;
    sent.push(now);
    return true;
  };

  // wraps every handler so one bad event can't crash the server
  const safe = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) { console.error(e); socket.emit("error:msg", "Something went wrong"); }
  };

  socket.on("room:join", safe(async ({ room: name, inviteCode } = {}) => {
    if (room) return;
    const r = await pool.query("SELECT * FROM rooms WHERE name=$1", [name]);
    if (!r.rows[0] || r.rows[0].invite_code !== inviteCode)
      return socket.emit("room:denied", "Wrong room or invite code");

    room = r.rows[0];
    socket.join(room.name);
    online[room.name] = online[room.name] || {};
    online[room.name][user.username] = (online[room.name][user.username] || 0) + 1;

    const h = await pool.query(
      `SELECT m.id, u.username AS sender, m.body, m.created_at, m.burn_at
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.room_id=$1 AND (m.burn_at IS NULL OR m.burn_at > now())
       ORDER BY m.created_at ASC LIMIT 100`, [room.id]);
    socket.emit("room:history", h.rows);
    io.to(room.name).emit("presence:update", presence(room.name));
  }));

  socket.on("message:send", safe(async ({ body } = {}) => {
    if (!room) return;
    body = String(body || "").trim();
    if (!body || body.length > MAX_LEN) return;
    if (!allowed()) return socket.emit("error:msg", "Slow down");

    const r = await pool.query(
      "INSERT INTO messages (room_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, created_at",
      [room.id, user.id, body]);
    io.to(room.name).emit("message:new",
      { id: r.rows[0].id, sender: user.username, body, created_at: r.rows[0].created_at });
  }));

  // the recipient's screen showed the message -> start the 15s countdown
  socket.on("message:read", safe(async ({ id } = {}) => {
    if (!room || !/^\d+$/.test(String(id))) return;
    const r = await pool.query(
      `UPDATE messages
       SET read_at = now(), burn_at = now() + make_interval(secs => $1)
       WHERE id=$2 AND room_id=$3 AND sender_id <> $4 AND burn_at IS NULL
       RETURNING id, burn_at`,
      [BURN_SECONDS, id, room.id, user.id]);
    if (r.rows[0]) io.to(room.name).emit("message:burning", r.rows[0]);
  }));

  socket.on("disconnect", () => {
    if (!room) return;
    const o = online[room.name];
    o[user.username] = (o[user.username] || 1) - 1;
    if (o[user.username] <= 0) delete o[user.username];
    io.to(room.name).emit("presence:update", presence(room.name));
  });
});

// ---------- Burn sweeper: runs every second ----------
setInterval(async () => {
  try {
    const r = await pool.query(
      `WITH d AS (
         DELETE FROM messages WHERE burn_at IS NOT NULL AND burn_at <= now()
         RETURNING id, room_id
       )
       SELECT d.id, r.name FROM d JOIN rooms r ON r.id = d.room_id`);
    r.rows.forEach((m) => io.to(m.name).emit("message:burned", { id: m.id }));
  } catch (e) {
    console.error("sweeper:", e.message);
  }
}, 1000);

server.listen(PORT, () => console.log("Chat server on", PORT));