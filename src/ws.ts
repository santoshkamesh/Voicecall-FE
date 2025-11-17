const DEFAULT_URL =
  import.meta.env.VITE_SIGNALING_URL ?? "ws://localhost:5001";

let socket: WebSocket | null = null;

export function connect(url?: string) {
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close();
  }

  const targetUrl = (url ?? DEFAULT_URL).trim();
  socket = new WebSocket(targetUrl);
  return socket;
}

export function getSocket() {
  return socket;
}

export function send(payload: any) {
  if (!socket) {
    throw new Error("WebSocket has not been initialised");
  }

  const data = JSON.stringify(payload);
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  } else {
    socket.addEventListener(
      "open",
      () => socket?.send(data),
      { once: true }
    );
  }
}

export function disconnect() {
  socket?.close();
  socket = null;
}

export const DEFAULT_SIGNALING_URL = DEFAULT_URL;
