// Drives the test window over the Chrome DevTools Protocol. The window often can't
// take OS focus (macOS won't let a background app activate itself), and VS Code only
// accepts ghost text in a focused editor, so we emulate focus and send real key presses.

export interface DevTools {
  /** The ghost text currently rendered in the editor, if any. */
  ghostText(): Promise<string | undefined>;
  /** The text of Pawl's status bar item. */
  statusText(): Promise<string | undefined>;
  /** Presses a key; `mod` is Cmd on macOS and Ctrl elsewhere. */
  pressKey(key: Key, modifiers?: { alt?: boolean; mod?: boolean }): Promise<void>;
  close(): void;
}

const KEYS = {
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  "=": { code: "Equal", keyCode: 187 },
  "-": { code: "Minus", keyCode: 189 },
  "0": { code: "Digit0", keyCode: 48 },
} as const;
type Key = keyof typeof KEYS;
// CDP modifier bits.
const ALT = 1;
const CTRL = 2;
const META = 4;

export async function connectDevTools(): Promise<DevTools> {
  const port = process.env.PAWL_DEVTOOLS_PORT;
  if (!port) throw new Error("PAWL_DEVTOOLS_PORT is not set; run the smoke tests via runTest");
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = (await res.json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const workbench = targets.find((t) => t.type === "page" && t.url.includes("workbench.html"));
  if (!workbench) throw new Error("No workbench page among DevTools targets");

  const socket = new WebSocket(workbench.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map<number, (msg: { error?: unknown; result?: any }) => void>();
  socket.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  const send = (method: string, params: object = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  return {
    async ghostText() {
      const { result } = await send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".ghost-text-decoration")].map((e) => e.textContent).join("")`,
        returnByValue: true,
      });
      return result.value || undefined;
    },
    async statusText() {
      const { result } = await send("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(".statusbar-item")].map((e) => e.textContent.trim()).find((t) => t.startsWith("Pawl"))`,
        returnByValue: true,
      });
      return result.value;
    },
    async pressKey(key, { alt = false, mod = false } = {}) {
      const { code, keyCode } = KEYS[key];
      const event = {
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers: (alt ? ALT : 0) | (mod ? (process.platform === "darwin" ? META : CTRL) : 0),
      };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    },
    close: () => socket.close(),
  };
}
