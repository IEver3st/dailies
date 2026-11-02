export {};
const port = Number(process.env.CDP_PORT ?? 9333);
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[];
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
};
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result))),
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expr: string) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function mouse(type: string, x: number, y: number, buttons = 1) {
  await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" });
}
async function click(x: number, y: number) {
  await mouse("mouseMoved", x, y, 0);
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y, 0);
}
async function drag(x1: number, y1: number, x2: number, y2: number) {
  await mouse("mouseMoved", x1, y1, 0);
  await mouse("mousePressed", x1, y1);
  for (let i = 1; i <= 12; i++) {
    await mouse("mouseMoved", x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12);
    await sleep(12);
  }
  await mouse("mouseReleased", x2, y2, 0);
}
async function key(k: string, code = k, keyCode = 0, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
}
async function shot(path: string) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(path, Buffer.from(r.data, "base64"));
}

const steps = JSON.parse(process.argv[2] ?? "[]") as any[];
for (const s of steps) {
  const [op, ...a] = s;
  if (op === "eval") console.log(JSON.stringify(await evaluate(a[0])));
  else if (op === "click") await click(a[0], a[1]);
  else if (op === "drag") await drag(a[0], a[1], a[2], a[3]);
  else if (op === "type") await send("Input.insertText", { text: a[0] });
  else if (op === "key") await key(a[0], a[1], a[2], a[3]);
  else if (op === "wait") await sleep(a[0]);
  else if (op === "shot") await shot(a[0]);
  else if (op === "clickText") {
    const pos = await evaluate(
      `(() => { const want = ${JSON.stringify(a[0])}; const els = [...document.querySelectorAll('button,[role=tab],[role=menuitem],a')]; const el = els.find(e => e.textContent.trim() === want) ?? els.find(e => e.textContent.trim().startsWith(want)) ?? els.find(e => e.getAttribute('aria-label') === want); if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()`,
    );
    if (!pos) throw new Error(`no element with text ${a[0]}`);
    await click(pos[0], pos[1]);
  }
}
ws.close();
