"""Trusted input in a disposable, independently launched debug-enabled profile.

CALLISTO_TEST_BROWSER=zen selects installed Zen Flatpak; default is Firefox.
Never connects to or restarts the user's existing browser/profile.
"""
import http.server
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import socketserver
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
kind = os.environ.get("CALLISTO_TEST_BROWSER", "firefox")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/inner'):
            data=b'<button onclick="parent.document.title=String(event.isTrusted)">Frame action</button>'
        else:
            data = b'''<title>Input probe</title><form id="probe"><label>Name<input id="name"></label><button id="send">Send</button></form>
        <div id="shadow"></div><iframe src="/inner"></iframe>
        <script>window.inputs=[];const field=document.querySelector('#name');field.addEventListener('input',e=>inputs.push(e.isTrusted));
        probe.onsubmit=e=>{e.preventDefault();document.title='submit-'+inputs.every(Boolean)+'-'+field.value;};
        shadow.attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';
        shadow.shadowRoot.querySelector('button').onclick=e=>document.title='shadow-'+e.isTrusted;
        </script>'''
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_address[1]}/"
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
base = Path.home() / (".var/app/app.zen_browser.zen/cache" if kind == "zen" else "snap/firefox/common")
base.mkdir(parents=True, exist_ok=True)
profile = tempfile.mkdtemp(prefix="callisto-bidi-probe-", dir=base)
command = ["flatpak", "run", "app.zen_browser.zen"] if kind == "zen" else [shutil.which("firefox") or "firefox"]
command += ([] if os.environ.get("CALLISTO_TEST_HEADFUL")=="1" else ["--headless"]) + ["--no-remote", "--profile", profile, f"--remote-debugging-port={port}", "about:blank"]
Path(profile,'user.js').write_text('user_pref("zen.welcome-screen.seen", true);\nuser_pref("browser.shell.checkDefaultBrowser", false);\n')
command += ['--width=1440','--height=900']
browser = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
client = None
try:
    for _ in range(150):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.2):
                break
        except OSError:
            if browser.poll() is not None:
                raise RuntimeError(f"{kind} exited before opening BiDi")
            time.sleep(.1)
    else:
        raise RuntimeError("BiDi endpoint did not open")
    env = dict(os.environ, CALLISTO_MCP_BROWSER="connected", CALLISTO_BIDI_PORT=str(port), CALLISTO_TAB="0", CALLISTO_BROWSER=kind)
    client = subprocess.Popen([str(ROOT / "target/debug/callisto-firefox-mcp")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)

    def tool(name, args=None):
        client.stdin.write(json.dumps({"id": 1, "method": "tools/call", "params": {"name": name, "arguments": args or {}}}) + "\n")
        client.stdin.flush()
        if not select.select([client.stdout], [], [], 60)[0]:
            raise RuntimeError(f"Timed out: {name}")
        result = json.loads(client.stdout.readline())["result"]
        if result.get("isError"):
            raise RuntimeError(result)
        text=result["content"][0]["text"]
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    caps = tool("callisto_capabilities")
    assert caps["capabilities"]["trustedInput"] and caps["input"]["nativeKeyDefaults"]
    print("tabs:",tool("callisto_tabs",{"action":"list"}),flush=True)
    snapshot = tool("callisto_navigate", {"url":url})
    ref = re.search(r'\[(ax-\d+)\].*textbox "Name"', snapshot["text"]).group(1)
    tool("callisto_fill", {"ref": ref, "value": "Zen input"})
    submitted = tool("callisto_press", {"key": "Enter"})
    assert submitted["title"] == "submit-true-Zen input", submitted
    shadow = tool("callisto_snapshot")
    shadow_ref = re.search(r'\[(ax-\d+)\].*button "Shadow action"', shadow["text"]).group(1)
    clicked = tool("callisto_click", {"ref": shadow_ref})
    assert clicked["title"] == "shadow-true", clicked
    frame = tool("callisto_snapshot")
    frame_ref = re.search(r'\[(ax-\d+)\].*button "Frame action"', frame["text"]).group(1)
    clicked = tool("callisto_click", {"ref": frame_ref})
    assert clicked["title"] == "true", clicked
    tool("callisto_close")
    assert browser.poll() is None, "Detach closed the independently launched browser"
    # A new MCP session must reacquire the explicitly named tab, preserving its DOM.
    reacquired = tool("callisto_snapshot")
    assert reacquired["title"] == "true", reacquired
    tool("callisto_close")
    print(f"{kind}: trusted fill, native Enter submission, open-shadow and same-origin frame clicks, detach/reacquire verified")
finally:
    if client:
        client.stdin.close()
        try:
            client.wait(timeout=10)
        except subprocess.TimeoutExpired:
            client.kill()
    try:
        browser.terminate()
    except PermissionError:
        subprocess.run(["snap", "run", "--shell", "firefox", "-c", f"kill -TERM {browser.pid}"], check=True, timeout=10)
    try:
        browser.wait(timeout=10)
    except subprocess.TimeoutExpired:
        browser.kill()
    shutil.rmtree(profile, ignore_errors=True)
    server.shutdown()
    server.server_close()
