import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number.parseInt(process.env.PORT || "8787", 10);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: "ready" }));
    ws.on("message", (data, isBinary) => {
      ws.send(data, { binary: isBinary });
    });
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[echo] listening on ${port}`);
});
