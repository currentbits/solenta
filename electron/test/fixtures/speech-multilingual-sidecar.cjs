// Protocol fixture only: launches a real subprocess/socket, never performs ASR.
const fs = require("node:fs");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const trace = process.env.SOLENTA_SPEECH_FIXTURE_TRACE;
const record = (row) => fs.appendFileSync(trace, `${JSON.stringify(row)}\n`);
record({ args, hasKey: !!process.env.NEMO_SPEECH_HTTP_API_KEY });
const server = http.createServer((_req, res) => res.end("ready"));
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket, request) => {
  if (new URL(request.url, "http://localhost").searchParams.get("api_key") !== process.env.NEMO_SPEECH_HTTP_API_KEY) return socket.close();
  socket.send(JSON.stringify({ type: "session.created" }));
  socket.on("message", (raw, binary) => {
    if (binary) {
      socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "Goedemorgen" }));
      return;
    }
    const msg = JSON.parse(raw);
    record(msg);
    if (msg.type === "session.update") {
      if (msg.session.language === "ja-JP") {
        socket.send(JSON.stringify({ type: "error", error: { message: "Fixture: unsupported language capability" } }));
      } else socket.send(JSON.stringify({ type: "session.updated" }));
    }
    if (msg.type === "input_audio_buffer.commit") socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Goedemorgen wereld. 日本語" }));
  });
});
server.listen(port, "127.0.0.1");
