import { invoke } from '@tauri-apps/api/core';
import type { SpeechUnit } from './speech';
import { base64ToBlobUrl } from './media';

export interface LocalSpeechState { status: 'stopped' | 'loading' | 'playing' | 'paused'; paragraph: number; unit: number }
export interface KokoroStatus { installed: boolean; engineAvailable: boolean; importing: boolean }
interface AudioResult { audioBase64: string; mime: 'audio/wav'; session: number }
export const kokoro = {
  status: () => invoke<KokoroStatus>('kokoro_status'),
  install: (directory: string) => invoke<KokoroStatus>('kokoro_import', { directory }),
  uninstall: () => invoke<KokoroStatus>('kokoro_uninstall'),
  pickDirectory: () => invoke<string | null>('kokoro_pick_directory'),
};
export function localSpeechUnits(paragraphs: string[]): SpeechUnit[] {
  return paragraphs.flatMap((text, paragraph) => {
    const sentences = text.match(/[^。！？\n]+[。！？]?/gu) ?? [];
    return sentences.flatMap(sentence => {
      const chars = Array.from(sentence.trim()), units: SpeechUnit[] = [];
      while (chars.length) {
        let end = Math.min(48, chars.length);
        if (chars.length > end) {
          for (let i = end - 1; i >= 16; i--) if (/[，,；;：:]/u.test(chars[i])) { end = i + 1; break; }
        }
        const text = chars.splice(0, end).join('').trim();
        if (text) units.push({ text, paragraph });
      }
      return units;
    });
  });
}

/** One short unit ahead, bounded to two WAVs; no chapter text is cached on disk. */
export class LocalSpeechReader {
  private generation = 0;
  private session: number | null = null;
  private beginning: Promise<number> | null = null;
  private units: SpeechUnit[] = [];
  private unit = 0;
  private status: LocalSpeechState['status'] = 'stopped';
  private audio: HTMLAudioElement | null = null;
  private objectUrl = '';
  private prefetched: { index: number; generation: number; promise: Promise<AudioResult> } | null = null;
  rate = 1;
  speaker = 3;
  constructor(private update: (state: LocalSpeechState) => void, private finished: () => void, private error: (message: string) => void) {}
  private emit() { this.update({ status: this.status, unit: this.unit, paragraph: this.units[this.unit]?.paragraph ?? -1 }); }
  private discardAudio() {
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); }
    this.audio = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
  }
  private cancelSession() {
    const session = this.session; this.session = null; this.beginning = null; this.prefetched = null;
    if (session !== null) void invoke('kokoro_stop', { session }).catch(() => {});
  }
  setText(paragraphs: string[]) { this.stop(); this.units = localSpeechUnits(paragraphs); this.unit = 0; }
  configure(speaker: number, rate: number) {
    const changed = this.speaker !== speaker;
    this.speaker = speaker; this.rate = Math.max(.5, Math.min(2, rate));
    if (this.audio) this.audio.playbackRate = this.rate;
    if (changed && this.status !== 'stopped') this.stop();
  }
  start(paragraph = 0) {
    this.stop();
    const found = this.units.findIndex(unit => unit.paragraph >= paragraph);
    if (found < 0) { this.error('没有可以朗读的正文'); return; }
    this.unit = found; this.status = 'loading'; this.emit();
    void this.next(this.generation);
  }
  private async ensureSession(generation: number): Promise<number> {
    if (this.session !== null) return this.session;
    if (!this.beginning) this.beginning = invoke<number>('kokoro_begin');
    const pending = this.beginning, session = await pending;
    if (generation !== this.generation) {
      void invoke('kokoro_stop', { session }).catch(() => {});
      throw Error('朗读已取消');
    }
    if (this.beginning === pending) { this.session = session; this.beginning = null; }
    return session;
  }
  private async generate(index: number, generation: number): Promise<AudioResult> {
    const session = await this.ensureSession(generation);
    const result = await invoke<AudioResult>('kokoro_synthesize', { session, text: this.units[index].text, speaker: this.speaker });
    if (result.session !== session || result.mime !== 'audio/wav' || !result.audioBase64 || result.audioBase64.length > 8 * 1024 * 1024) throw Error('离线语音响应无效');
    return result;
  }
  private prefetch(generation: number) {
    const index = this.unit + 1;
    if (index >= this.units.length || this.status !== 'playing' || this.prefetched) return;
    const promise = this.generate(index, generation);
    // Keep a rejection handler from the moment prefetch starts. Playback later
    // awaits the original promise and can show the error if it is still current.
    void promise.catch(() => {});
    this.prefetched = { index, generation, promise };
  }
  private async playAudio(audio: HTMLAudioElement, generation: number) {
    await audio.play();
    if (generation !== this.generation || this.audio !== audio) { audio.pause(); return; }
    this.status = 'playing'; this.emit(); this.prefetch(generation);
  }
  private async next(generation: number) {
    if (generation !== this.generation) return;
    if (this.unit >= this.units.length) { this.stop(); this.finished(); return; }
    this.status = 'loading'; this.emit();
    const prepared = this.prefetched;
    const pending = prepared?.index === this.unit && prepared.generation === generation ? prepared.promise : this.generate(this.unit, generation);
    this.prefetched = null;
    try {
      const result = await pending;
      if (generation !== this.generation || this.status !== 'loading') return;
      this.discardAudio();
      const url = await base64ToBlobUrl(result.audioBase64, 'audio/wav');
      if (generation !== this.generation || this.status !== 'loading') {
        URL.revokeObjectURL(url); return;
      }
      this.objectUrl = url;
      const audio = new Audio(this.objectUrl); this.audio = audio; audio.playbackRate = this.rate;
      audio.onended = () => { if (this.audio === audio && this.status === 'playing') { this.unit++; void this.next(this.generation); } };
      audio.onerror = () => { if (this.audio === audio) { this.stop(); this.error('离线语音播放失败，请重新开始朗读'); } };
      await this.playAudio(audio, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop(); this.error(String(error instanceof Error ? error.message : error));
    }
  }
  play(paragraph = 0) {
    if (this.status === 'paused') this.resume();
    else if (this.status === 'stopped') this.start(paragraph);
  }
  pause() {
    if (this.status !== 'playing' && this.status !== 'loading') return;
    this.generation++; this.cancelSession(); this.audio?.pause(); this.status = 'paused'; this.emit();
  }
  resume() {
    if (this.status !== 'paused') return;
    const generation = ++this.generation;
    if (this.audio) {
      this.status = 'loading'; this.emit();
      void this.playAudio(this.audio, generation).catch(error => { if (generation === this.generation) { this.stop(); this.error(String(error)); } });
    } else void this.next(generation);
  }
  stop() { this.generation++; this.cancelSession(); this.discardAudio(); this.status = 'stopped'; this.emit(); }
}
