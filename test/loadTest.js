const path = require("path");
const { io } = require(path.join(__dirname, "../server/node_modules/socket.io-client"));

const URL = process.env.URL || "http://localhost:3000";
const USERS = 20;       // simultaneous users
const MSGS_EACH = 5;    // messages each user sends

const H = { "Content-Type": "application/json" };

async function getToken(username) {
  const body = JSON.stringify({ username, password: "secret123" });
  await fetch(URL + "/api/register", { method: "POST", headers: H, body });  // 409 is fine
  const r = await fetch(URL + "/api/login", { method: "POST", headers: H, body });
  return (await r.json()).token;
}

(async () => {
  console.log(`Creating ${USERS} users...`);
  const tokens = [];
  for (let i = 1; i <= USERS; i++) tokens.push(await getToken("load" + i));

  const stats = { received: 0, errors: 0, burned: 0 };
  const sockets = tokens.map((token, i) => {
    const s = io(URL, { auth: { token } });
    s.on("connect", () => s.emit("room:join", { room: "vip", inviteCode: "VIP2026" }));
    s.on("message:new", (m) => {
      stats.received++;
      if (i === 0 && m.sender !== "load1") s.emit("message:read", { id: m.id }); // load1 reads everything
    });
    s.on("message:burned", () => stats.burned++);
    s.on("error:msg", () => stats.errors++);
    s.on("connect_error", () => stats.errors++);
    return s;
  });

  await new Promise((r) => setTimeout(r, 3000));   // let everyone join
  console.log("Sending...");

  sockets.forEach((s, i) => {
    for (let n = 0; n < MSGS_EACH; n++)
      setTimeout(() => s.emit("message:send", { body: `load${i + 1} message ${n + 1}` }), n * 400);
  });

  setTimeout(() => {
    const sent = USERS * MSGS_EACH;
    console.log("\n=== RESULT ===");
    console.log("Users connected:   ", USERS);
    console.log("Messages sent:     ", sent);
    console.log("Expected received: ", sent * USERS, "(every user gets every message)");
    console.log("Actually received: ", stats.received);
    console.log("Errors:            ", stats.errors);
    console.log("Burned so far:     ", stats.burned);
    process.exit(0);
  }, 12000);
})();