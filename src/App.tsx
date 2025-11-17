import React, { useCallback, useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import {
  connect,
  disconnect as disconnectSocket,
  getSocket,
  send,
  DEFAULT_SIGNALING_URL,
} from "./ws";
import "./App.css";

type ConnectionState = "idle" | "connecting" | "connected";

export default function App() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [serverUrl, setServerUrl] = useState(DEFAULT_SIGNALING_URL);
  const [roomId, setRoomId] = useState("test-room");
  const [peerId, setPeerId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);

  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const sendTransport = useRef<mediasoupClient.types.Transport | null>(null);
  const recvTransport = useRef<mediasoupClient.types.Transport | null>(null);
  const producerRef = useRef<mediasoupClient.types.Producer | null>(null);
  const consumersRef = useRef<mediasoupClient.types.Consumer[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioElementsRef = useRef<HTMLAudioElement[]>([]);

  const cleanupMedia = useCallback(() => {
    producerRef.current?.close();
    producerRef.current = null;

    consumersRef.current.forEach((consumer) => consumer.close());
    consumersRef.current = [];

    audioElementsRef.current.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    });
    audioElementsRef.current = [];

    sendTransport.current?.close();
    sendTransport.current = null;
    recvTransport.current?.close();
    recvTransport.current = null;

    deviceRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    setMediaReady(false);
    setMuted(false);
  }, []);

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      const msg = JSON.parse(event.data);

      if (msg.action === "peer-id") {
        setPeerId(msg.peerId);
        return;
      }

      if (msg.action === "error") {
        setError(msg.message ?? "Unknown error from signaling server");
        return;
      }

      const device = deviceRef.current;

      if (msg.action === "router-rtp-capabilities") {
        try {
          const newDevice = new mediasoupClient.Device();
          await newDevice.load({ routerRtpCapabilities: msg.data });
          deviceRef.current = newDevice;
          setStatus("Router loaded. Creating send transport…");
          send({ action: "create-transport", direction: "send" });
        } catch (err) {
          console.error(err);
          setError("Failed to load router capabilities");
        }
        return;
      }

      if (msg.action === "transport-created" && device) {
        if (msg.direction === "send") {
          const transport = device.createSendTransport(msg);

          transport.on("connect", async ({ dtlsParameters }, callback, err) => {
            try {
              send({
                action: "connect-transport",
                dtlsParameters,
                transportId: transport.id,
              });
              callback();
            } catch (error) {
              err(error as Error);
            }
          });

          transport.on(
            "produce",
            async ({ kind, rtpParameters }, callback, err) => {
              try {
                send({
                  action: "produce",
                  transportId: transport.id,
                  kind,
                  rtpParameters,
                });
                callback({ id: `producer-${transport.id}` });
              } catch (error) {
                err(error as Error);
              }
            }
          );

          sendTransport.current = transport;

          try {
            setStatus("Requesting microphone access…");
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
            });
            localStreamRef.current = stream;
            const track = stream.getAudioTracks()[0];
            const producer = await transport.produce({ track });
            producerRef.current = producer;
            setStatus("Microphone streaming");
            setMediaReady(true);
            setMuted(false);

            producer.on("transportclose", () => {
              producer.close();
              producerRef.current = null;
              setMediaReady(false);
            });
          } catch (err) {
            console.error(err);
            setError("Unable to access microphone");
            setStatus("Microphone access denied");
            return;
          }

          send({ action: "create-transport", direction: "recv" });
        } else if (msg.direction === "recv") {
          const transport = device.createRecvTransport(msg);
          transport.on(
            "connect",
            async ({ dtlsParameters }, callback, err) => {
              try {
                send({
                  action: "connect-transport",
                  transportId: transport.id,
                  dtlsParameters,
                });
                callback();
              } catch (error) {
                err(error as Error);
              }
            }
          );
          recvTransport.current = transport;
          setStatus("Ready to receive remote audio");
        }
        return;
      }

      if (msg.action === "new-producer" && device) {
        send({
          action: "consume",
          producerId: msg.producerId,
          rtpCapabilities: device.rtpCapabilities,
        });
        return;
      }

      if (msg.action === "consumer-created") {
        const transport = recvTransport.current;
        if (!transport) {
          console.warn("Receive transport missing");
          return;
        }

        const consumer = await transport.consume({
          id: msg.id,
          producerId: msg.producerId,
          kind: msg.kind,
          rtpParameters: msg.rtpParameters,
        });

        consumersRef.current.push(consumer);

        const audio = new Audio();
        audio.autoplay = true;
        audio.srcObject = new MediaStream([consumer.track]);
        document.body.appendChild(audio);
        audioElementsRef.current.push(audio);
        setStatus("Playing remote audio");
        return;
      }
    },
    []
  );

  useEffect(() => {
    const ws = socket ?? getSocket();
    if (!ws) return;

    const onClose = () => {
      setStatus("Disconnected");
      setConnectionState("idle");
      setPeerId(null);
      cleanupMedia();
      disconnectSocket();
      setSocket(null);
    };

    const onError = () => {
      setError("WebSocket error");
    };

    ws.addEventListener("message", handleMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);

    return () => {
      ws.removeEventListener("message", handleMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
  }, [socket, handleMessage, cleanupMedia]);

  useEffect(() => () => cleanupMedia(), [cleanupMedia]);

  const connectToRoom = () => {
    if (connectionState !== "idle") return;
    if (!roomId.trim()) {
      setError("Room ID is required");
      return;
    }

    setStatus("Connecting…");
    setError(null);
    setConnectionState("connecting");

    const targetUrl = serverUrl.trim() || DEFAULT_SIGNALING_URL;
    setServerUrl(targetUrl);
    const ws = connect(targetUrl);
    setSocket(ws);

    ws.addEventListener(
      "open",
      () => {
        setConnectionState("connected");
        setStatus("Connected. Joining room…");
        send({ action: "join-room", roomId: roomId.trim() });
      },
      { once: true }
    );
  };

  const disconnectCall = useCallback(() => {
    disconnectSocket();
    setSocket(null);
    setConnectionState("idle");
    setStatus("Disconnected");
    setPeerId(null);
    cleanupMedia();
  }, [cleanupMedia]);

  const toggleMute = () => {
    const producer = producerRef.current;
    if (!producer) return;
    if (muted) {
      producer.resume();
      setMuted(false);
      setStatus("Microphone unmuted");
    } else {
      producer.pause();
      setMuted(true);
      setStatus("Microphone muted");
    }
  };

  return (
    <div className="app">
      <header>
        <h1>Mediasoup Audio Call</h1>
        <p>Join a room ID from any device to test group audio.</p>
      </header>

      <section className="panel">
        <h2>Connection</h2>
        <label>
          Signaling URL
          <input
            type="text"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            disabled={connectionState !== "idle"}
            placeholder="wss://your-domain/ws"
          />
        </label>
        <label>
          Room ID
          <input
            type="text"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={connectionState !== "idle"}
          />
        </label>

        <div className="actions">
          <button
            onClick={connectToRoom}
            disabled={connectionState !== "idle"}
          >
            Join Room
          </button>
          <button
            className="danger"
            onClick={disconnectCall}
            disabled={connectionState === "idle"}
          >
            Disconnect
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Call Controls</h2>
        <div className="status-line">
          <strong>Peer ID:</strong> {peerId ?? "—"}
        </div>
        <div className="status-line">
          <strong>Status:</strong> {status}
        </div>
        <div className="status-line">
          <strong>Connection:</strong> {connectionState}
        </div>
        <button
          onClick={toggleMute}
          disabled={!mediaReady}
          className="secondary"
        >
          {muted ? "Unmute Mic 🎤" : "Mute Mic 🔇"}
        </button>
      </section>

      {error && <div className="error">{error}</div>}

      <footer>
        <p>
          If you have trouble connecting from another network, double-check that
          the backend ports listed in the README are reachable and that your
          TLS certificates are valid.
        </p>
      </footer>
    </div>
  );
}
