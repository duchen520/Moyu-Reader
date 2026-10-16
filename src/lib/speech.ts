export interface SpeechUnit { text: string; paragraph: number }
export interface SpeechState { status: 'stopped' | 'playing' | 'paused'; unit: number; paragraph: number }
export function speechUnits(paragraphs: string[]): SpeechUnit[] {
  return paragraphs.flatMap((text, paragraph) => {
    const sentences = text.match(/[^。！？.!?\n]+[。！？.!?]?|[。！？.!?]/gu) ?? [];
    return sentences.flatMap(s => {
      const chars = Array.from(s.trim());
      const out: SpeechUnit[] = [];
      for (let i = 0; i < chars.length; i += 180) out.push({ text: chars.slice(i, i + 180).join(''), paragraph });
      return out;
    });
  });
}

/** Cancel/resume at the current short unit avoids WebView pause/resume inconsistencies. */
export class SpeechReader {
  private generation = 0;
  private current: SpeechSynthesisUtterance | null = null;
  private units: SpeechUnit[] = [];
  private unit = 0;
  private status: SpeechState['status'] = 'stopped';
  rate = 1;
  voiceURI = '';
  constructor(private synth: SpeechSynthesis, private update: (s: SpeechState) => void,
    private finished: () => void, private error: (message: string) => void) {}
  private emit() { this.update({ status: this.status, unit: this.unit, paragraph: this.units[this.unit]?.paragraph ?? -1 }); }
  setText(paragraphs: string[]) { this.stop(); this.units = speechUnits(paragraphs); this.unit = 0; }
  start(paragraph?: number) {
    if (!this.units.length) { this.error('没有可以朗读的正文'); return; }
    if (paragraph !== undefined) this.unit = Math.max(0, this.units.findIndex(u => u.paragraph >= paragraph));
    this.status = 'playing';
    this.next();
  }
  private next() {
    const generation = ++this.generation;
    this.synth.cancel();
    const unit = this.units[this.unit];
    if (!unit) { this.status = 'stopped'; this.emit(); this.finished(); return; }
    const utterance = new SpeechSynthesisUtterance(unit.text);
    this.current = utterance; // retain until end; some engines need a strong reference
    utterance.lang = 'zh-CN'; utterance.rate = this.rate;
    utterance.voice = this.synth.getVoices().find(v => v.voiceURI === this.voiceURI)
      ?? this.synth.getVoices().find(v => /^zh/i.test(v.lang)) ?? null;
    utterance.onend = () => {
      if (generation !== this.generation || this.status !== 'playing') return;
      this.unit++; this.next();
    };
    utterance.onerror = () => {
      if (generation !== this.generation) return;
      this.stop(); this.error('电脑朗读失败，请检查系统语音和所选声音');
    };
    this.emit(); this.synth.speak(utterance);
  }
  pause() { if (this.status !== 'playing') return; this.generation++; this.synth.cancel(); this.status = 'paused'; this.emit(); }
  resume() { if (this.status === 'paused') { this.status = 'playing'; this.next(); } }
  stop() { this.generation++; this.synth.cancel(); this.current = null; this.status = 'stopped'; this.emit(); }
  configure(rate: number, voiceURI: string) {
    this.rate = Math.min(2, Math.max(0.5, rate)); this.voiceURI = voiceURI;
    if (this.status === 'playing') this.next();
  }
}
