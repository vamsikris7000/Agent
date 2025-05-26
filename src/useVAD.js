import { useEffect, useRef } from "react";

/**
 * useVAD - Voice Activity Detection hook
 * @param {function} onSpeechStart - called when speech is detected
 * @param {function} onSpeechEnd - called when speech ends
 * @param {function} onSensitivity - called with sensitivity value (0-1) for visualization
 * @param {boolean} isActive - whether VAD should be running
 */
export default function useVAD({ onSpeechStart, onSpeechEnd, onSensitivity, isActive }) {
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const rafRef = useRef(null);
  const speakingRef = useRef(false);
  const streamRef = useRef(null);

  useEffect(() => {
    if (!isActive) {
      cleanup();
      return;
    }

    let cancelled = false;

    async function startVAD() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyserRef.current = analyser;
        source.connect(analyser);

        const data = new Uint8Array(analyser.fftSize);

        function checkVoice() {
          if (cancelled) return;
          analyser.getByteTimeDomainData(data);
          // Calculate RMS (root mean square) for volume
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const val = (data[i] - 128) / 128;
            sum += val * val;
          }
          const rms = Math.sqrt(sum / data.length);
          // Sensitivity: 0 (silent) to 1 (loud)
          const sensitivity = Math.min(1, rms * 5);

          if (onSensitivity) onSensitivity(sensitivity);

          const threshold = 0.08; // Adjust for your environment
          if (rms > threshold) {
            if (!speakingRef.current) {
              speakingRef.current = true;
              if (onSpeechStart) onSpeechStart();
            }
          } else {
            if (speakingRef.current) {
              speakingRef.current = false;
              if (onSpeechEnd) onSpeechEnd();
            }
          }
          rafRef.current = requestAnimationFrame(checkVoice);
        }
        rafRef.current = requestAnimationFrame(checkVoice);
      } catch (err) {
        console.error("VAD error:", err);
      }
    }

    startVAD();

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line
  }, [isActive]);

  function cleanup() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (audioContextRef.current) audioContextRef.current.close();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    speakingRef.current = false;
  }
}
