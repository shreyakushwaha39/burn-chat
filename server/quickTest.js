const { io } = require("socket.io-client");
const URL = "http://localhost:3000";

async function auth(username) {
  const body = JSON.stringify({ username, password: "secret123" });
  const h = { "Content-Type": "application/json" };
  await fetch(URL + "/api/register", { method: "POST", headers: h, body }); // 409 if exists is fine
  const r = await fetch(URL + "/api/login", { method: "POST", headers: h, body });
  return (await r.json()).token;
}

function connect(name, token) {
  const s = io(URL, { auth: { token } });
  s.on("connect", () => s.emit("room:join", { room: "vip", inviteCode: "VIP2026" }));
  s.on("message:new", (m) => {
    console.log(`[${name}] new message from ${m.sender}: ${m.body}`);
    if (m.sender !== name) s.emit("message:read", { id: m.id }); // recipient reads it
  });
  s.on("message:burning", (m) => console.log(`[${name}] countdown started for #${m.id}`));
  s.on("message:burned", (m) => console.log(`[${name}] BURNED #${m.id}`));
  return s;
}

(async () => {
  const ta = await auth("alice");
  const tb = await auth("bob");
  const a = connect("alice", ta);
  connect("bob", tb);
  setTimeout(() => a.emit("message:send", { body: "hello bob, this will burn" }), 1500);
  setTimeout(() => process.exit(0), 20000);
})();