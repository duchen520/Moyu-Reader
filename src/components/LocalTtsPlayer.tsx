import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Pause, Play, Square, FolderOpen, Trash2, ExternalLink } from 'lucide-react';
import { kokoro, LocalSpeechReader } from '../lib/localSpeech';
import type { KokoroStatus, LocalSpeechState } from '../lib/localSpeech';

interface Props {
  bookId: string; chapterId: string; nextChapterId?: string; paragraphs: string[]; disabled: boolean;
  stopSignal: number; onStart: () => void; onNext: () => void; fromParagraph: () => number;
  onState: (state: LocalSpeechState) => void; controls: RefObject<{ toggle: () => void; play: () => void; pause: () => void } | null>;
}
const stopped: LocalSpeechState = { status: 'stopped', paragraph: -1, unit: 0 };
function preferences(): { speaker: number; rate: number; continuous: boolean } {
  try {
    const p = JSON.parse(localStorage.getItem('tomato-reader:kokoro-preferences') ?? '{}');
    return { speaker: Number.isInteger(p.speaker) && p.speaker >= 3 && p.speaker <= 102 ? p.speaker : 3,
      rate: [.75, 1, 1.25, 1.5, 2].includes(p.rate) ? p.rate : 1, continuous: p.continuous !== false };
  } catch { return { speaker: 3, rate: 1, continuous: true }; }
}
export function LocalTtsPlayer(props: Props) {
  const [status, setStatus] = useState<KokoroStatus | null>(null);
  const [busy, setBusy] = useState(false), [directory, setDirectory] = useState(''), [error, setError] = useState('');
  const [options, setOptions] = useState(preferences);
  const [state, setState] = useState(stopped);
  const latest = useRef({ props, options }); latest.current = { props, options };
  const engine = useRef<LocalSpeechReader | null>(null);
  const carry = useRef<string | null>(null), mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void kokoro.status().then(value => { if (mounted.current) setStatus(value); }).catch(error => { if (mounted.current) setError(String(error)); });
    engine.current = new LocalSpeechReader(state => {
      if (!mounted.current) return;
      setState(state); latest.current.props.onState(state);
    }, () => {
      const { props, options } = latest.current;
      if (options.continuous && props.nextChapterId) { carry.current = `${props.bookId}:${props.nextChapterId}`; props.onNext(); }
    }, error => { if (mounted.current) setError(error); });
    return () => { mounted.current = false; carry.current = null; engine.current?.stop(); engine.current = null; };
  }, []);
  useEffect(() => {
    const expected = `${props.bookId}:${props.chapterId}`;
    if (carry.current && carry.current !== expected) carry.current = null;
    engine.current?.setText(props.paragraphs);
    if (carry.current === expected && !props.disabled && props.paragraphs.length) {
      carry.current = null; latest.current.props.onStart(); engine.current?.start(0);
    }
  }, [props.bookId, props.chapterId, props.paragraphs, props.disabled]);
  useEffect(() => { engine.current?.configure(options.speaker, options.rate); }, [options.speaker, options.rate]);
  useEffect(() => { carry.current = null; engine.current?.stop(); }, [props.stopSignal]);
  const choose = (value: typeof options) => {
    setOptions(value);
    try { localStorage.setItem('tomato-reader:kokoro-preferences', JSON.stringify(value)); }
    catch { setError('音色偏好保存失败，本次仍可使用'); }
  };
  const toggle = () => {
    if (latest.current.props.disabled || !status?.installed || busy) return;
    const current = engine.current;
    if (state.status === 'loading') { carry.current = null; current?.stop(); }
    else if (state.status === 'playing') current?.pause();
    else { setError(''); latest.current.props.onStart(); if (state.status === 'paused') current?.resume(); else current?.start(latest.current.props.fromParagraph()); }
  };
  useImperativeHandle(props.controls, () => ({
    toggle,
    play: () => {
      if (latest.current.props.disabled || !status?.installed || busy) return;
      latest.current.props.onStart();
      engine.current?.play(latest.current.props.fromParagraph());
    },
    pause: () => { carry.current = null; engine.current?.pause(); },
  }));
  const install = async () => {
    setBusy(true); setError(''); carry.current = null; engine.current?.stop();
    try { const value = await kokoro.install(directory.trim()); if (mounted.current) setStatus(value); }
    catch (error) { if (mounted.current) setError(String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const pickFolder = async () => {
    try {
      const selected = await kokoro.pickDirectory();
      if (selected) {
        setDirectory(selected);
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const uninstall = async () => {
    if (!window.confirm('确定要卸载 Kokoro 离线语音包吗？卸载后将清理已复制的模型文件以释放磁盘空间。')) return;
    setBusy(true); setError(''); carry.current = null; engine.current?.stop();
    try {
      const value = await kokoro.uninstall();
      if (mounted.current) setStatus(value);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return <div className="audio-card kokoro-card">
    <div className="audio-card-main-row">
      <div className="audio-progress-info">
        <span className="audio-progress-title">Kokoro 离线语音</span>
        <span className="audio-progress-stats" role="status">{busy ? '正在处理语音包…' : state.status === 'loading' ? '正在准备本段语音…' : state.status === 'playing' ? `正在朗读第 ${state.paragraph + 1} 段` : state.status === 'paused' ? '朗读已暂停' : status?.installed ? '语音包已就绪 · 离线朗读' : status ? '请先导入语音包' : '正在检查语音包…'}</span>
      </div>
      <div className="audio-main-controls">
        <button type="button" className="audio-btn-primary" disabled={!status?.installed || !status.engineAvailable || busy || props.disabled} onClick={toggle}>
          {state.status === 'playing' ? <><Pause size={15}/> 暂停离线朗读</> : state.status === 'loading' ? '取消加载' : state.status === 'paused' ? <><Play size={15}/> 继续离线朗读</> : <><Play size={15}/> 开始离线朗读</>}
        </button>
        <button type="button" className="audio-btn-secondary" disabled={state.status === 'stopped'} onClick={() => { carry.current = null; engine.current?.stop(); }}><Square size={13}/> 停止离线朗读</button>
      </div>
    </div>
    <div className="audio-card-secondary-row">
      <div className="control-field"><label htmlFor="kokoro-voice">中文音色</label><select id="kokoro-voice" aria-label="Kokoro 中文音色" value={options.speaker} onChange={event => choose({ ...options, speaker: Number(event.target.value) })}>
        <optgroup label="中文女声">{Array.from({ length: 55 }, (_, i) => <option key={i + 3} value={i + 3}>中文女声 {String(i + 1).padStart(2, '0')}</option>)}</optgroup>
        <optgroup label="中文男声">{Array.from({ length: 45 }, (_, i) => <option key={i + 58} value={i + 58}>中文男声 {String(i + 1).padStart(2, '0')}</option>)}</optgroup>
      </select></div>
      <div className="control-field"><label htmlFor="kokoro-rate">朗读倍速</label><select id="kokoro-rate" aria-label="Kokoro 朗读倍速" value={options.rate} onChange={event => choose({ ...options, rate: Number(event.target.value) })}>{[.75, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></div>
      <label className="control-field kokoro-continuous"><input type="checkbox" checked={options.continuous} onChange={event => choose({ ...options, continuous: event.target.checked })}/> 连续朗读下一章</label>
    </div>
    {!status?.installed && <div className="kokoro-import">
      <label htmlFor="kokoro-directory">语音包文件夹</label>
      <div>
        <input id="kokoro-directory" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="粘贴包含 model.int8.onnx 的文件夹路径"/>
        <button type="button" className="audio-btn-secondary" disabled={busy} onClick={() => void pickFolder()} title="打开系统窗口选择文件夹"><FolderOpen size={14} /> 浏览文件夹…</button>
        <button type="button" className="audio-btn-secondary" disabled={busy || !directory.trim() || !status?.engineAvailable} onClick={() => void install()}>导入语音包</button>
      </div>
      <small style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span>导入后保存在应用资料目录，原下载文件夹可以移走。</span>
        <span>获取模型:</span>
        <a href="https://huggingface.co/csukuangfj/kokoro-int8-multi-lang-v1_1/tree/155831f1b4ba23b1f5c058be6a61df90cefb2a37" target="_blank" rel="noreferrer" style={{ color: 'var(--brand-orange)', textDecoration: 'underline', display: 'inline-flex', alignItems: 'center', gap: '2px' }}>Kokoro 1.1 中文 INT8 所需版本 <ExternalLink size={11} /></a>
        <span>请下载该版本的完整目录；hexgrad 原版权重不能直接导入。</span>
      </small>
    </div>}
    {status?.installed && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px', padding: '6px 12px', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border-light)' }}>
      <small style={{ color: 'var(--text-muted)' }}>已安装离线模型（已存储在应用资料库）</small>
      <button type="button" className="audio-btn-secondary" style={{ padding: '4px 10px', fontSize: '12px', color: 'var(--tone-rose-text)' }} disabled={busy || state.status !== 'stopped'} onClick={() => void uninstall()} title="卸载并清理语音包以释放空间"><Trash2 size={13} /> 卸载语音包</button>
    </div>}
    {status && !status.engineAvailable && <p role="alert">离线语音引擎缺失，请安装完整的阅读器新版。</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <p className="audio-hint-note">免费离线 · 使用 CPU · 无需单独启动服务。暂停或停止后释放模型；音色变化会停止当前朗读。</p>
  </div>;
}
