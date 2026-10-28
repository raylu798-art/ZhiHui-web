'use client';
import { useRef, useState } from 'react';
import { ChevronRight, Globe, Mic, Settings, X } from 'lucide-react';
import type { Meeting } from './api';

interface HomeViewProps {
  title: string; setTitle: (value: string) => void;
  language: string; setLanguage: (value: string) => void;
  includeSystem: boolean; setIncludeSystem: (value: boolean) => void;
  capabilityDisplay: boolean; asrReady: boolean; recording: boolean;
  recordingUnavailableReason?: string; automaticLanguageOnly?: boolean;
  meetings: Meeting[]; onSelect: (id: string) => void;
  onStart: () => void; onSettings: () => void; onImport: () => void; onTemplates: () => void;
}

/** Keeps the 0.6.6 desktop welcome/recording layout at the browser boundary. */
export function HomeView(props: HomeViewProps) {
  const [controls, setControls] = useState(false);
  const language = useRef<HTMLSelectElement>(null);
  return <section className="desktop-home-view">
    <div className="desktop-quick-settings"><div className="desktop-button-group"><button onClick={props.onSettings} title="模型"><Settings size={16} /><span>模型</span></button><button className={controls ? 'selected' : ''} onClick={() => setControls(!controls)} title="设备"><Mic size={16} /><span>设备</span></button><button onClick={() => { setControls(true); setTimeout(() => language.current?.focus(), 0); }} title="语言"><Globe size={16} /><span>语言</span></button></div></div>
    {controls ? <section className="desktop-capture-settings"><header><h2>录音设置</h2><button className="icon-button" aria-label="关闭录音设置" onClick={() => setControls(false)}><X size={16} /></button></header><label className="field"><span>会议标题</span><input value={props.title} onChange={event => props.setTitle(event.target.value)} placeholder="请输入会议标题（可选）" maxLength={200} /></label><div className="capture-options"><label><span>识别语言</span><select ref={language} aria-label="录音识别语言" value={props.automaticLanguageOnly ? 'auto' : props.language} onChange={event => props.setLanguage(event.target.value)} disabled={props.recording || props.automaticLanguageOnly}><option value="auto">自动识别</option>{!props.automaticLanguageOnly ? <><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option><option value="fr">Français</option><option value="de">Deutsch</option></> : null}</select></label><label className="system-audio"><input type="checkbox" checked={props.includeSystem} disabled={!props.capabilityDisplay || props.recording} onChange={event => props.setIncludeSystem(event.target.checked)} />{props.capabilityDisplay ? '同时采集共享声音' : '当前浏览器不支持共享声音'}</label></div><p className="muted">麦克风使用浏览器当前默认设备。共享声音时需勾选“共享音频”，支持范围因浏览器而异。</p></section> : null}
    <div className="desktop-welcome"><div className="welcome-glows" aria-hidden="true"><div className="welcome-glow-inner" /><div className="welcome-glow-outer" /></div><div className="desktop-welcome-copy"><h1>欢迎使用 知会！</h1><p>开始录音后，这里将显示实时转写内容</p></div></div>
    {!props.asrReady || props.recordingUnavailableReason ? <button className="desktop-api-notice" onClick={props.onSettings}><Settings size={14} /><span>{props.recordingUnavailableReason || '首次使用 Web 版，请先配置语音 API Key'}</span><ChevronRight size={14} /></button> : null}
    <div className="desktop-record-controls"><div className="desktop-record-pill"><button className="desktop-record-circle" aria-label="开始录音" title={props.recordingUnavailableReason || '开始录音'} disabled={props.recording || !!props.recordingUnavailableReason} onClick={props.onStart}><Mic size={20} /></button><div className="desktop-idle-levels" aria-hidden="true"><i /><i /><i /></div></div><p>{props.recordingUnavailableReason ? '当前语音配置尚未启用实时转写。' : '开始前，请告知与会人员并获取录音许可。'}</p></div>
  </section>;
}
