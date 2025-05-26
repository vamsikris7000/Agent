import React, { useState, useRef, useEffect } from "react";
import "./App.css";
import { FiPhoneOff } from "react-icons/fi";
import useVAD from "./useVAD";

const WS_URL = "ws://localhost:8000/ws/audio";

const PHASE_LABELS = {
  greeting: "Agent is greeting...",
  agent_speaking: "Agent is speaking... (You can interrupt)",
  user_speaking: "Listening...",
  agent_processing: "Agent is processing...",
  idle: "Ready to start conversation",
  error: "Error"
};

export default function App() {
  const [phase, setPhase] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [micPermission, setMicPermission] = useState("prompt"); // "prompt", "granted", "denied"
  const [connectionStatus, setConnectionStatus] = useState("disconnected"); // "connected", "connecting", "disconnected"
  const [interruptionAttempted, setInterruptionAttempted] = useState(false);
  const [conversationSummary, setConversationSummary] = useState(null);
  const mediaRecorderRef = useRef(null);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null); // Web Audio API context
  const decodedQueueRef = useRef([]); // Queue of decoded AudioBuffers
  const isPlayingRef = useRef(false); // Is audio currently playing
  const isGreeting = useRef(false);
  const recordingStreamRef = useRef(null);
  const chatContainerRef = useRef(null);
  const isCallActive = phase !== "idle" && phase !== "error";
  const [vadEnabled, setVadEnabled] = useState(false);
  const startTime = useRef(null);
  const vadActiveRef = useRef(false);
  const vadPauseTimeoutRef = useRef(null);
  const recordingStoppedRef = useRef(false);
  const [userTurnActive, setUserTurnActive] = useState(false);
  const silenceTimeoutMs = 2000; // 2 seconds of silence

  // Auto-scroll chat container when new messages arrive
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages, phase]);

  // Check microphone permission on mount
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(() => setMicPermission("granted"))
      .catch(() => setMicPermission("denied"));
  }, []);

  function stopAgentPlayback() {
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    decodedQueueRef.current = [];
    isPlayingRef.current = false;
  }

  // --- Web Audio API: Pre-decode and play sequentially ---
  async function enqueueDecodedChunk(buffer) {
    console.log('Enqueueing decoded chunk, duration:', buffer.duration);
    decodedQueueRef.current.push(buffer);
    // Start playback if not already playing
    if (!isPlayingRef.current) {
      playNextDecodedChunk();
    }
  }

  function playNextDecodedChunk() {
    console.log('Playing next chunk, queue length:', decodedQueueRef.current.length);
    if (decodedQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      isPlayingRef.current = true;
      const decodedBuffer = decodedQueueRef.current.shift();
      
      const source = audioContextRef.current.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(audioContextRef.current.destination);
      
      source.onended = () => {
        playNextDecodedChunk();
      };
      
      source.start();
      console.log("Started playing audio chunk, duration:", decodedBuffer.duration);
    } catch (err) {
      console.error("Error playing decoded chunk:", err);
      // If there's an error, try to play the next chunk
      setTimeout(() => playNextDecodedChunk(), 100);
    }
  }

  // --- WebSocket and conversation logic ---
  const startCall = () => {
    if (micPermission !== "granted") {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(() => {
          setMicPermission("granted");
          initializeCall();
        })
        .catch((err) => {
          setMicPermission("denied");
          setErrorMsg("Please allow microphone access to start the conversation.");
          setPhase("error");
        });
    } else {
      initializeCall();
    }
  };

  const initializeCall = () => {
    setMessages([]);
    setErrorMsg("");
    setPhase("greeting");
    setIsRecording(false);
    stopAgentPlayback();
    isGreeting.current = true;
    startTime.current = Date.now();
    setUserTurnActive(true);
    connectWebSocket();
  };

  const connectWebSocket = () => {
    setConnectionStatus("connecting");
    wsRef.current = new WebSocket(WS_URL);

    wsRef.current.onopen = () => {
      console.log("[WebSocket] Connection opened");
      setConnectionStatus("connected");
      wsRef.current.send(JSON.stringify({
        type: "start",
        message: "Hi, my name is Sandy, I am your car insurance agent. How can I help you?"
      }));
    };

    wsRef.current.onmessage = async (event) => {
      if (event.data instanceof Blob) {
        // Handle binary audio data
        const ab = await event.data.arrayBuffer();
        console.log(`[WebSocket] Received audio chunk of size: ${ab.byteLength}`);
        
        try {
          if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
          }
          
          audioContextRef.current.decodeAudioData(
            ab,
            (decodedBuffer) => {
              console.log("Decoded WAV audio chunk successfully, duration:", decodedBuffer.duration);
              enqueueDecodedChunk(decodedBuffer);
            },
            (error) => {
              console.error("Failed to decode WAV audio chunk!", error);
              const arr = new Uint8Array(ab);
              console.error("First 16 bytes of buffer:", arr.slice(0, 16));
            }
          );
        } catch (err) {
          console.error("Error processing audio chunk:", err);
        }
      } else {
        // Handle text/JSON messages
        try {
          const data = JSON.parse(event.data);
          console.log(`[WebSocket] Received message: ${JSON.stringify(data)}`);
          
          if (data.type === "greeting") {
            setMessages((msgs) => [...msgs, { role: "agent", text: data.text }]);
            setPhase("greeting");
            isGreeting.current = true;
          } else if (data.type === "greeting_end") {
            isGreeting.current = false;
            setPhase("agent_speaking");
          } else if (data.type === "transcript") {
            setMessages((msgs) => [...msgs, { role: "user", text: data.text }]);
            setPhase("agent_processing");
          } else if (data.type === "response") {
            setMessages((msgs) => [...msgs, { role: "agent", text: data.text }]);
            setPhase("agent_speaking");
          } else if (data.type === "agent_speaking") {
            setPhase("agent_speaking");
            setVadEnabled(false);
          } else if (data.type === "agent_idle" || data.type === "user_speaking") {
            setUserTurnActive(true);
            setVadEnabled(true);
          } else if (data.type === "interrupted") {
            console.log("Agent interrupted by user.");
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      }
    };

    wsRef.current.onerror = (error) => {
      console.log("[WebSocket] Connection error", error);
      setConnectionStatus("disconnected");
      setErrorMsg("Connection error. Attempting to reconnect...");
      setPhase("error");
    };

    wsRef.current.onclose = (event) => {
      console.log(`[WebSocket] Connection closed, code: ${event.code}`);
      setConnectionStatus("disconnected");
      if (phase !== "error" && isCallActive) {
        setTimeout(() => {
          connectWebSocket();
        }, 1000);
      }
      if (event.code === 1006) {
        console.log("WebSocket closed due to a connection error. Cleaning up session.");
        handleEnd();
      }
    };
  };

  // --- Recording logic ---
  async function startRecording() {
    console.log("[Recording] Starting recording");
    setPhase("user_speaking");
    setIsRecording(true);
    recordingStoppedRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = async (e) => {
        if (recordingStoppedRef.current) return;
        if (e.data.size > 0 && wsRef.current?.readyState === 1) {
          console.log(`[Recording] Sending audio chunk of size: ${e.data.size}`);
          try {
            wsRef.current.send(e.data);
            console.log("Sent audio chunk to backend");
          } catch (error) {
            console.error("Error sending audio chunk:", error);
          }
        } else {
          console.log("WebSocket not open, skipping audio chunk send.");
        }
      };

      mediaRecorder.onstop = () => {
        console.log("[Recording] MediaRecorder stopped, sending done");
        if (wsRef.current?.readyState === 1) {
          try {
            wsRef.current.send(JSON.stringify({ type: "done" }));
            console.log("Sent done message to backend");
          } catch (error) {
            console.error("Error sending done message:", error);
          }
        } else {
          console.log("WebSocket not open, skipping done send.");
        }
        // Stop the audio stream tracks to release the mic
        if (recordingStreamRef.current) {
          recordingStreamRef.current.getTracks().forEach(track => track.stop());
          recordingStreamRef.current = null;
        }
        setIsRecording(false);
      };

      mediaRecorder.start(200);
      window.stopRecording = () => {
        if (mediaRecorder.state !== "inactive") {
          mediaRecorder.stop();
        }
      };
    } catch (err) {
      setErrorMsg("Microphone access denied or unavailable.");
      setPhase("error");
      setIsRecording(false);
    }
  }

  const handleEnd = () => {
    // Generate conversation summary before ending
    if (messages.length > 0) {
      const summary = {
        timestamp: new Date().toISOString(),
        duration: Math.round((Date.now() - startTime.current) / 1000),
        messageCount: messages.length,
        topics: extractTopics(messages)
      };
      setConversationSummary(summary);
    }

    setPhase("idle");
    setMessages([]);
    setErrorMsg("");
    setIsRecording(false);
    setUserTurnActive(false);
    stopAgentPlayback();

    // Stop recording if still active
    if (window.stopRecording) window.stopRecording();
    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach(track => track.stop());
      recordingStreamRef.current = null;
    }

    // Send cleanup before closing WebSocket
    if (wsRef.current) {
      if (wsRef.current.readyState === 1) { // OPEN
        try {
          console.log("Sending cleanup message to backend before closing WebSocket");
          wsRef.current.send(JSON.stringify({ type: "cleanup" }));
        } catch (err) {
          console.error("Error sending cleanup message:", err);
        }
        // Give the backend a moment to process cleanup
        setTimeout(() => {
          if (wsRef.current && wsRef.current.readyState === 1) {
            console.log("Closing WebSocket after cleanup");
            wsRef.current.close();
          }
        }, 200);
      } else {
        console.log("WebSocket not open, skipping cleanup send. State:", wsRef.current.readyState);
      }
    }
  };

  const extractTopics = (msgs) => {
    // Simple topic extraction based on message content
    const topics = new Set();
    msgs.forEach(msg => {
      if (msg.role === "user") {
        const words = msg.text.toLowerCase().split(/\s+/);
        words.forEach(word => {
          if (word.length > 4 && !["what", "when", "where", "which", "about"].includes(word)) {
            topics.add(word);
          }
        });
      }
    });
    return Array.from(topics).slice(0, 5);
  };

  useVAD({
    isActive: vadEnabled && userTurnActive && isCallActive,
    onSpeechStart: () => {
      if (!userTurnActive || !isCallActive) return;
      console.log("[VAD] User started speaking (frontend)");
      // Cancel any pending silence timer
      if (vadPauseTimeoutRef.current) {
        clearTimeout(vadPauseTimeoutRef.current);
        vadPauseTimeoutRef.current = null;
      }
      if (!vadActiveRef.current) {
        vadActiveRef.current = true;
        recordingStoppedRef.current = false;
        console.log("VAD: User started speaking");
        if (phase === "agent_speaking") {
          stopAgentPlayback();
          setPhase("user_speaking");
          setInterruptionAttempted(true);
          setVadEnabled(false);
          setTimeout(() => {
            setVadEnabled(true);
            setInterruptionAttempted(false);
          }, 100);
          if (!isRecording) startRecording();
        } else if (!isRecording) {
          startRecording();
        }
      }
    },
    onSpeechEnd: () => {
      if (!userTurnActive || !isCallActive) return;
      console.log("[VAD] User stopped speaking (frontend)");
      // Start a silence timer
      if (vadActiveRef.current && !vadPauseTimeoutRef.current) {
        vadPauseTimeoutRef.current = setTimeout(() => {
          vadActiveRef.current = false;
          vadPauseTimeoutRef.current = null;
          if (!recordingStoppedRef.current && isRecording) {
            recordingStoppedRef.current = true;
            console.log("VAD: User stopped speaking (after pause)");
            setPhase("agent_processing");
            setIsRecording(false);
            if (window.stopRecording) window.stopRecording();
            setUserTurnActive(false); // Lock out further user input
            setVadEnabled(false);
          }
        }, silenceTimeoutMs);
      }
    },
  });

  // UI rendering
  return (
    <div className="app-container">
      <h2 className="app-title">Voice Assistant Call</h2>
      <div className="connection-status">
        <div className={`status-dot ${connectionStatus}`} />
        <span className="status-text">
          {connectionStatus === "connected" ? "Connected" :
           connectionStatus === "connecting" ? "Connecting..." :
           "Disconnected"}
        </span>
      </div>
      {micPermission === "denied" && (
        <div className="mic-error">
          Please allow microphone access in your browser settings
        </div>
      )}
      <div className="profile-container">
        <div className={`profile-circle ${phase === "user_speaking" ? "speaking" : ""} ${phase === "agent_speaking" ? "agent-speaking" : ""} ${interruptionAttempted ? "interrupted" : ""}`}>
          <div className="frequency-bars">
            {[...Array(5)].map((_, i) => (
              <div 
                key={i} 
                className="bar" 
                style={{ 
                  animationDelay: `${i * 0.1}s`,
                  height: phase === "user_speaking" ? `${32 + (16)}px` : "32px"
                }}
              />
            ))}
          </div>
          <div className="voice-indicator">
            {phase === "user_speaking" ? "You're speaking" : 
             phase === "agent_speaking" ? "Agent is speaking" : ""}
          </div>
        </div>
      </div>
      <div className={`status-label ${phase === "agent_processing" ? "processing" : ""}`}
           style={{ marginTop: 24 }}>
        {PHASE_LABELS[phase]}
        {phase === "agent_speaking" && (
          <div className="tooltip">
            <span className="tooltip-icon">ⓘ</span>
            <span className="tooltip-text">
              You can interrupt the agent at any time by speaking
            </span>
          </div>
        )}
      </div>
      <div className="chat-container" ref={chatContainerRef}>
        {messages.map((msg, idx) => (
          <div key={idx} className={`chat-bubble ${msg.role}`}>{msg.text}</div>
        ))}
        {phase === "user_speaking" && <div className="chat-bubble user typing">Listening...</div>}
        {phase === "agent_processing" && <div className="chat-bubble agent typing">Agent is processing...</div>}
        {phase === "agent_speaking" && <div className="chat-bubble agent typing">Agent is speaking...</div>}
        {phase === "greeting" && <div className="chat-bubble agent typing">Agent is greeting...</div>}
      </div>

      <div className="controls-row">
        {phase === "idle" && (
          <button className="tap-to-speak-btn main-btn" onClick={startCall}>
            Start Conversation
          </button>
        )}
        {isCallActive && (
          <button className="end-btn outlined-red" onClick={handleEnd}>
            <FiPhoneOff style={{ marginRight: 8, verticalAlign: "middle" }} />
            End Call
          </button>
        )}
      </div>

      {conversationSummary && (
        <div className="conversation-summary">
          <h3>Conversation Summary</h3>
          <div className="summary-details">
            <p>Duration: {conversationSummary.duration} seconds</p>
            <p>Messages: {conversationSummary.messageCount}</p>
            {conversationSummary.topics.length > 0 && (
              <div className="topics">
                <p>Topics discussed:</p>
                <div className="topic-tags">
                  {conversationSummary.topics.map((topic, idx) => (
                    <span key={idx} className="topic-tag">{topic}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="error-message">{errorMsg || "Something went wrong. Please try again."}</div>
      )}
    </div>
  );
}
