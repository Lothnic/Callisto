"""web_server.py — aiohttp web server to power the BrowserOS sidebar interface."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable

from aiohttp import web

log = logging.getLogger("callisto.web_server")

# Global list of active WebSocket connections
_websockets: set[web.WebSocketResponse] = set()

# Global task queue to handle tasks sent from the sidebar UI
task_queue: asyncio.Queue[str] = asyncio.Queue()


async def broadcast(message: dict[str, Any]) -> None:
    """Send a JSON message to all connected sidebars."""
    if not _websockets:
        return
    data = json.dumps(message)
    for ws in list(_websockets):
        try:
            await ws.send_str(data)
        except Exception:
            _websockets.discard(ws)


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    """Handles WebSocket communication with the sidebar UI."""
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    _websockets.add(ws)
    log.info("Sidebar UI connected via WebSocket")

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    action = data.get("action")
                    if action == "run_task":
                        task = data.get("task", "").strip()
                        if task:
                            await task_queue.put(task)
                            await broadcast({"type": "info", "message": f"Task queued: {task}"})
                except Exception as e:
                    log.error("WebSocket message processing error: %s", e)
            elif msg.type == web.WSMsgType.ERROR:
                log.warning("WebSocket connection closed with error %s", ws.exception())
    finally:
        _websockets.discard(ws)
        log.info("Sidebar UI disconnected")
    return ws


async def sidebar_html_handler(request: web.Request) -> web.Response:
    """Serves the premium Callisto Assistant Web UI."""
    html_content = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Callisto Assistant</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0b0f19;
      --panel-bg: #111827;
      --border-color: #1f2937;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #3b82f6;
      --accent-gradient: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
      --user-bubble: #1e293b;
      --bot-bubble: #1f2937;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Plus Jakarta Sans', sans-serif;
    }
    body, html {
      background-color: var(--bg-color);
      color: var(--text-main);
      height: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 14px 16px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent-gradient);
      box-shadow: 0 0 10px rgba(59, 130, 246, 0.6);
      animation: pulse 2s infinite alternate;
    }
    h1 {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.3px;
    }
    .status-container {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-badge {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 9999px;
      background: rgba(59, 130, 246, 0.1);
      color: var(--accent);
      border: 1px solid rgba(59, 130, 246, 0.2);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    #chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    #chat-container::-webkit-scrollbar {
      width: 6px;
    }
    #chat-container::-webkit-scrollbar-track {
      background: transparent;
    }
    #chat-container::-webkit-scrollbar-thumb {
      background: var(--border-color);
      border-radius: 999px;
    }
    #chat-container::-webkit-scrollbar-thumb:hover {
      background: #374151;
    }
    .msg {
      max-width: 90%;
      padding: 12px 14px;
      border-radius: 16px;
      line-height: 1.5;
      font-size: 13px;
      animation: fadeInUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      white-space: pre-wrap;
    }
    .msg.user {
      align-self: flex-end;
      background-color: var(--user-bubble);
      border-bottom-right-radius: 4px;
      border: 1px solid var(--border-color);
    }
    .msg.bot {
      align-self: flex-start;
      background-color: var(--bot-bubble);
      border-bottom-left-radius: 4px;
      border: 1px solid var(--border-color);
    }
    .step-card {
      align-self: flex-start;
      width: 100%;
      background: rgba(17, 24, 39, 0.4);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 10px 12px;
      margin-bottom: 4px;
      animation: fadeInUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    .step-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      font-weight: 500;
      font-size: 12px;
      color: var(--text-muted);
    }
    .step-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .step-icon {
      font-size: 14px;
      color: var(--accent);
    }
    .step-details {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--border-color);
      font-size: 11px;
      color: var(--text-muted);
    }
    .step-arrow {
      font-size: 10px;
      transition: transform 0.2s;
    }
    .step-arrow.open {
      transform: rotate(90deg);
    }
    pre {
      background: #070a12;
      padding: 8px;
      border-radius: 6px;
      margin-top: 4px;
      font-family: 'Courier New', Courier, monospace;
      font-size: 10.5px;
      white-space: pre-wrap;
      word-break: break-all;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .step-result {
      margin-top: 8px;
      font-weight: 500;
    }
    .step-result.success {
      color: var(--success);
    }
    .step-result.error {
      color: var(--danger);
    }
    #input-container {
      padding: 14px 16px;
      background: var(--panel-bg);
      border-top: 1px solid var(--border-color);
      display: flex;
      gap: 8px;
    }
    input {
      flex: 1;
      background: var(--bg-color);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 10px 14px;
      color: var(--text-main);
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: var(--accent);
    }
    button {
      background: var(--accent-gradient);
      border: none;
      border-radius: 10px;
      padding: 10px 18px;
      color: white;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover {
      opacity: 0.9;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      from { transform: scale(0.95); box-shadow: 0 0 10px rgba(59, 130, 246, 0.4); }
      to { transform: scale(1.05); box-shadow: 0 0 16px rgba(59, 130, 246, 0.8); }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="logo-dot"></div>
      <h1>Callisto Assistant</h1>
    </div>
    <div class="status-container">
      <div id="status-badge" class="status-badge">Idle</div>
    </div>
  </header>

  <div id="chat-container">
    <div class="msg bot">Hello! I am Callisto, your browser assistant. Type a task below to start.</div>
  </div>

  <div id="input-container">
    <input type="text" id="task-input" placeholder="Search flights, tickets, bookings..." autocomplete="off">
    <button id="send-btn">Send</button>
  </div>

  <script>
    const chatContainer = document.getElementById("chat-container");
    const taskInput = document.getElementById("task-input");
    const sendBtn = document.getElementById("send-btn");
    const statusBadge = document.getElementById("status-badge");

    let ws = null;
    let currentStepCard = null;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        statusBadge.innerText = "Connected";
        statusBadge.style.color = "var(--success)";
      };

      ws.onclose = () => {
        statusBadge.innerText = "Offline";
        statusBadge.style.color = "var(--danger)";
        setTimeout(connect, 3000);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleMessage(data);
      };
    }

    function appendMessage(text, role) {
      const msgDiv = document.createElement("div");
      msgDiv.className = `msg ${role}`;
      msgDiv.innerText = text;
      chatContainer.appendChild(msgDiv);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function handleMessage(data) {
      if (data.type === "step_start") {
        statusBadge.innerText = "Running";
        statusBadge.style.color = "var(--warning)";
        
        const card = document.createElement("div");
        card.className = "step-card";
        
        const stepNum = data.step;
        const toolName = data.call.name;
        const args = JSON.stringify(data.call.arguments, null, 2);
        
        card.innerHTML = `
          <div class="step-header" onclick="toggleDetails(this)">
            <div class="step-title">
              <span class="step-icon">⚡</span>
              <span>Step ${stepNum}: executing ${toolName}</span>
            </div>
            <span class="step-arrow">▶</span>
          </div>
          <div class="step-details" style="display: none;">
            <div>Arguments:</div>
            <pre>${escapeHtml(args)}</pre>
            <div class="step-result-placeholder"></div>
          </div>
        `;
        
        chatContainer.appendChild(card);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        currentStepCard = card;
      } 
      else if (data.type === "step_end") {
        if (currentStepCard) {
          const detailsDiv = currentStepCard.querySelector(".step-details");
          const placeholder = currentStepCard.querySelector(".step-result-placeholder");
          const arrow = currentStepCard.querySelector(".step-arrow");
          
          const resultStr = JSON.stringify(data.result, null, 2);
          const hasError = data.result.error !== undefined;
          
          placeholder.innerHTML = `
            <div class="step-result ${hasError ? 'error' : 'success'}">
              ${hasError ? '❌ Error' : '✅ Success'}
            </div>
            <pre>${escapeHtml(resultStr)}</pre>
          `;
          
          currentStepCard = null;
        }
      } 
      else if (data.type === "final") {
        statusBadge.innerText = "Idle";
        statusBadge.style.color = "var(--accent)";
        appendMessage(data.text, "bot");
        taskInput.disabled = false;
        sendBtn.disabled = false;
      } 
      else if (data.type === "info") {
        console.log("Info from server: ", data.message);
      }
    }

    function toggleDetails(header) {
      const card = header.parentElement;
      const details = card.querySelector(".step-details");
      const arrow = card.querySelector(".step-arrow");
      if (details.style.display === "none") {
        details.style.display = "block";
        arrow.classList.add("open");
      } else {
        details.style.display = "none";
        arrow.classList.remove("open");
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function sendTask() {
      const task = taskInput.value.trim();
      if (!task) return;

      appendMessage(task, "user");
      taskInput.value = "";
      taskInput.disabled = true;
      sendBtn.disabled = true;

      ws.send(JSON.stringify({
        action: "run_task",
        task: task
      }));
    }

    sendBtn.addEventListener("click", sendTask);
    taskInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !taskInput.disabled) {
        sendTask();
      }
    });

    connect();
  </script>
</body>
</html>
"""
    return web.Response(text=html_content, content_type="text/html")


async def start_server(port: int = 54321) -> web.AppRunner:
    """Start the web server runner."""
    app = web.Application()
    app.router.add_get("/ws", websocket_handler)
    app.router.add_get("/sidebar", sidebar_html_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    log.info("Callisto Web UI Server listening on http://127.0.0.1:%d/sidebar", port)
    return runner
