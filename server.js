const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 3000 });  // ✅ This is where port is set
const clients = new Set();

wss.on('connection', ws => {
    clients.add(ws);
    console.log("New client connected.");

    ws.on('message', message => {
        console.log("Received:", message.toString());
        // Broadcast to everyone except the sender
        for (let client of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log("Client disconnected.");
    });
});

console.log("WebSocket server running on ws://localhost:3000");
