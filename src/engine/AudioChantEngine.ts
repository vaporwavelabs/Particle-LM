import { AudioMetrics } from '../types/simulation';

const SPECTRUM_BANDS = 32;

export class AudioChantEngine {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;

  private ttsAnalyser: AnalyserNode | null = null;
  private currentTtsSource: AudioBufferSourceNode | null = null;
  private isPlayingTts = false;
  private mutedTts = false;

  private freqBuffer = new Uint8Array(128);
  private prevEnergy = 0;
  private smoothedCadence = 0;

  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public isMicActive(): boolean {
    return this.micStream !== null;
  }

  public isTtsPlaying(): boolean {
    return this.isPlayingTts;
  }

  public setMuted(muted: boolean): void {
    this.mutedTts = muted;
    if (muted && this.currentTtsSource) {
      try {
        this.currentTtsSource.stop();
      } catch {
        // Ignore if already stopped
      }
      this.isPlayingTts = false;
    }
  }

  public async startMic(): Promise<void> {
    if (this.micStream) return;
    const ctx = this.ensureContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 256;
    this.micAnalyser.smoothingTimeConstant = 0.72;
    this.micSource.connect(this.micAnalyser);
  }

  public stopMic(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micAnalyser) {
      this.micAnalyser.disconnect();
      this.micAnalyser = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }

  public async startChantCapture(): Promise<void> {
    await this.startMic();
    if (!this.micStream) {
      throw new Error('Microphone stream unavailable.');
    }
    this.recordedChunks = [];
    const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = mimeType
      ? new MediaRecorder(this.micStream, { mimeType })
      : new MediaRecorder(this.micStream);

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };
    this.mediaRecorder = recorder;
    recorder.start(100);
  }

  public async stopChantCapture(): Promise<{ base64: string; mimeType: string } | null> {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === 'inactive') {
      return null;
    }

    return new Promise((resolve) => {
      recorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, {
          type: recorder.mimeType || 'audio/webm',
        });
        this.recordedChunks = [];
        if (blob.size < 256) {
          resolve(null);
          return;
        }
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        resolve({
          base64: btoa(binary),
          mimeType: (recorder.mimeType || 'audio/webm').split(';')[0],
        });
      };
      recorder.stop();
    });
  }

  public async playSynthesizedAudio(base64Wav: string): Promise<void> {
    if (this.mutedTts || !base64Wav) return;
    const ctx = this.ensureContext();

    if (this.currentTtsSource) {
      try {
        this.currentTtsSource.stop();
      } catch {
        // Ignore already stopped source
      }
      this.currentTtsSource = null;
    }

    const binary = atob(base64Wav);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    if (!this.ttsAnalyser) {
      this.ttsAnalyser = ctx.createAnalyser();
      this.ttsAnalyser.fftSize = 256;
      this.ttsAnalyser.smoothingTimeConstant = 0.68;
      this.ttsAnalyser.connect(ctx.destination);
    }

    source.connect(this.ttsAnalyser);
    this.currentTtsSource = source;
    this.isPlayingTts = true;

    source.onended = () => {
      if (this.currentTtsSource === source) {
        this.isPlayingTts = false;
        this.currentTtsSource = null;
      }
    };

    source.start(0);
  }

  public sampleMetrics(): AudioMetrics {
    const activeAnalyser = this.isPlayingTts && this.ttsAnalyser
      ? this.ttsAnalyser
      : this.micAnalyser;

    const source: AudioMetrics['source'] = this.isPlayingTts
      ? 'tts'
      : this.micAnalyser
        ? 'mic'
        : 'idle';

    if (!activeAnalyser) {
      this.smoothedCadence *= 0.9;
      return {
        bass: 0,
        mid: 0,
        treble: 0,
        cadence: this.smoothedCadence,
        pitchHz: 0,
        level: 0,
        spectrum: new Array(SPECTRUM_BANDS).fill(0),
        source: 'idle',
      };
    }

    if (this.freqBuffer.length !== activeAnalyser.frequencyBinCount) {
      this.freqBuffer = new Uint8Array(activeAnalyser.frequencyBinCount);
    }

    activeAnalyser.getByteFrequencyData(this.freqBuffer);
    const bins = this.freqBuffer.length;

    let bassSum = 0;
    let midSum = 0;
    let trebleSum = 0;
    let peakVal = 0;
    let peakBin = 0;

    const bassEnd = Math.max(4, Math.floor(bins * 0.14));
    const midEnd = Math.max(bassEnd + 4, Math.floor(bins * 0.48));

    for (let i = 0; i < bins; i++) {
      const val = this.freqBuffer[i] / 255;
      if (val > peakVal) {
        peakVal = val;
        peakBin = i;
      }
      if (i < bassEnd) {
        bassSum += val;
      } else if (i < midEnd) {
        midSum += val;
      } else {
        trebleSum += val;
      }
    }

    const bass = Math.min(1, (bassSum / bassEnd) * 1.25);
    const mid = Math.min(1, (midSum / (midEnd - bassEnd)) * 1.35);
    const treble = Math.min(1, (trebleSum / Math.max(1, bins - midEnd)) * 1.55);
    const level = bass * 0.45 + mid * 0.35 + treble * 0.2;

    const delta = Math.max(0, level - this.prevEnergy);
    this.prevEnergy = level * 0.8 + this.prevEnergy * 0.2;
    this.smoothedCadence = Math.min(1, Math.max(this.smoothedCadence * 0.86, delta * 3.8 + level * 0.35));

    const sampleRate = this.ctx?.sampleRate ?? 48000;
    const pitchHz = peakVal > 0.08 ? Math.round((peakBin * sampleRate) / (bins * 2)) : 0;

    const spectrum: number[] = [];
    const stride = Math.max(1, Math.floor((bins * 0.72) / SPECTRUM_BANDS));
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      let bandTotal = 0;
      for (let s = 0; s < stride; s++) {
        const idx = Math.min(bins - 1, b * stride + s);
        bandTotal += this.freqBuffer[idx] / 255;
      }
      spectrum.push(Math.min(1, (bandTotal / stride) * 1.15));
    }

    return {
      bass,
      mid,
      treble,
      cadence: this.smoothedCadence,
      pitchHz,
      level,
      spectrum,
      source,
    };
  }

  public dispose(): void {
    this.stopMic();
    if (this.currentTtsSource) {
      try {
        this.currentTtsSource.stop();
      } catch {
        // Ignore
      }
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
