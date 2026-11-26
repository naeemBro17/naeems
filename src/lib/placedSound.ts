// Fix 69.1: the Order Placed sounds, made in code (no audio files): a soft
// "ting" when the parcel lands in the van and a short soft engine as the
// van drives off. Quiet on purpose. The customer can switch it off with the
// speaker button; the choice is remembered on this phone. Any browser that
// refuses audio simply stays silent.
const KEY = 'naeems.placedSound';

type AudioCtor = typeof AudioContext;
let context: AudioContext | null = null;

export function isPlacedSoundOn(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setPlacedSoundOn(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Private mode or blocked storage: the switch still works for this visit.
  }
}

function audio(): AudioContext | null {
  try {
    if (!context) {
      const Ctor: AudioCtor | undefined =
        window.AudioContext ?? (window as Window & { webkitAudioContext?: AudioCtor }).webkitAudioContext;
      if (!Ctor) return null;
      context = new Ctor();
    }
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

/** Call from a tap (the speaker button) so phones allow sound afterwards. */
export function wakePlacedSound(): void {
  audio();
}

export function playTing(): void {
  const a = audio();
  if (!a) return;
  try {
    const t = a.currentTime;
    const tones: Array<[number, number]> = [
      [1046.5, 0.1],
      [1568, 0.045],
    ];
    for (const [frequency, volume] of tones) {
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      osc.connect(gain).connect(a.destination);
      osc.start(t);
      osc.stop(t + 0.6);
    }
  } catch {
    // Silent if the browser refuses.
  }
}

export function playVroom(): void {
  const a = audio();
  if (!a) return;
  try {
    const t = a.currentTime;
    const filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(380, t);
    filter.frequency.linearRampToValueAtTime(900, t + 0.5);
    filter.frequency.linearRampToValueAtTime(420, t + 1.2);
    const gain = a.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.07, t + 0.12);
    gain.gain.setValueAtTime(0.07, t + 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
    filter.connect(gain).connect(a.destination);
    for (const detune of [0, 70]) {
      const osc = a.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(58, t);
      osc.frequency.exponentialRampToValueAtTime(118, t + 0.5);
      osc.frequency.exponentialRampToValueAtTime(84, t + 1.2);
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + 1.3);
    }
  } catch {
    // Silent if the browser refuses.
  }
}
