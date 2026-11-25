import { useCallback, useRef } from 'react';
import type { Direction } from '../../shared/types/index.ts';

export function useAlertAudio() {
  const ctxRef = useRef<AudioContext | null>(null);

  const playChime = useCallback((direction: Direction) => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!ctxRef.current) {
        ctxRef.current = new AudioCtx();
      }
      const ctx = ctxRef.current;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const now = ctx.currentTime;
      const baseFreq = direction === 'bullish' ? 660 : direction === 'bearish' ? 440 : 550;
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.exponentialRampToValueAtTime(
        direction === 'bullish' ? 880 : direction === 'bearish' ? 330 : 587,
        now + 0.14
      );

      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.24);
    } catch {
      // Ignore audio errors when autoplay policy restricts context
    }
  }, []);

  return { playChime };
}
