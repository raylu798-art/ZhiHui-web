'use client';
import { FormEvent, useRef, useState } from 'react';
import { FileAudio, FileText, UploadCloud } from 'lucide-react';
import { api, Job, Meeting, messageOf, upload } from './api';
import { JobIntent } from './job-intent.mjs';
import { extractDocument } from './imports';
import { Field, InlineError, Modal, Spinner } from './ui';

export function ImportModal({ asrReady, language, onDone, onClose, unavailableReason, maxDurationSeconds = 7200, diarization = true, automaticLanguageOnly = false }: { asrReady: boolean; language: string; onDone: (id: string) => void; onClose: () => void; unavailableReason?: string; maxDurationSeconds?: number; diarization?: boolean; automaticLanguageOnly?: boolean }) {
  const [mode, setMode] = useState<'audio' | 'text'>('audio'); const [file, setFile] = useState<File>();
  const [title, setTitle] = useState(''); const [text, setText] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [progress, setProgress] = useState(0); const [stage, setStage] = useState('');
  const meetingId = useRef<string>(); const assetId = useRef<string>();
  const jobIntent = useRef(new JobIntent());
  function beginNewImport() {
    if (jobIntent.current.pending && !window.confirm('此前转写任务的提交结果尚未确认。请先查看任务队列；继续将创建一个可能再次收费的新导入任务。确定继续？')) return false;
    jobIntent.current.resetForNewIntent(); meetingId.current = undefined; assetId.current = undefined;
    return true;
  }
  function changeMode(next: 'audio' | 'text') {
    if (next === mode || !beginNewImport()) return;
    setMode(next); setFile(undefined); setError('');
  }
  async function choose(next?: File) {
    if (!next || !beginNewImport()) return; setFile(next); setError('');
    if (!title) setTitle(next.name.replace(/\.[^.]+$/, ''));
    if (mode === 'text') {
      setBusy(true); setStage('正在提取文档文字');
      try { setText(await extractDocument(next)); } catch (error) { setError(messageOf(error)); }
      finally { setBusy(false); }
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (mode === 'audio' && (!file || !asrReady)) { setError(!asrReady ? unavailableReason || '请先配置语音 API Key' : '请选择音频文件'); return; }
    if (mode === 'text' && !text.trim()) { setError('文档中没有可导入的文字'); return; }
    if (mode === 'audio' && file!.size > 200 * 1024 * 1024) { setError('音频文件不能超过 200 MB'); return; }
    setBusy(true);
    try {
      if (mode === 'audio' && !assetId.current) { setStage('正在上传音频'); assetId.current = (await upload(file!, setProgress)).id; }
      setStage('正在创建会议');
      if (!meetingId.current) meetingId.current = (await api<Meeting>('/meetings', 'POST', { title: title.trim() || '导入会议' })).id;
      if (mode === 'audio') {
        await api(`/meetings/${meetingId.current}/asset`, 'POST', { asset_id: assetId.current });
        setStage('正在提交转写任务');
        // A retry uses the exact original language and payload, even if settings changed elsewhere.
        const intent = jobIntent.current.prepare(jobIntent.current.pending?.payload || { kind: 'transcribe', meeting_id: meetingId.current, asset_id: assetId.current, language: automaticLanguageOnly ? 'auto' : language });
        const job = await api<Job>('/jobs', 'POST', { ...intent.payload, request_id: intent.request_id });
        jobIntent.current.confirmResponse(job);
      } else await api(`/meetings/${meetingId.current}/import-text`, 'POST', { text: text.trim() });
      onDone(meetingId.current);
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <Modal title="导入会议" onClose={() => { if (!busy && (!jobIntent.current.pending || window.confirm('此前转写任务的提交结果尚未确认。关闭后请先查看任务队列，避免重新导入并再次收费。确定关闭？'))) onClose(); }} wide><div className="settings-tabs"><button disabled={busy} className={mode === 'audio' ? 'active' : ''} onClick={() => changeMode('audio')}><FileAudio size={17} />音频转写</button><button disabled={busy} className={mode === 'text' ? 'active' : ''} onClick={() => changeMode('text')}><FileText size={17} />导入文字</button></div><form onSubmit={submit} className="stack"><Field label="会议名称"><input value={title} maxLength={200} onChange={event => setTitle(event.target.value)} placeholder="例如：产品需求讨论" disabled={busy} /></Field><label className="upload-zone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy && (mode !== 'audio' || asrReady)) void choose(event.dataTransfer.files[0]); }}><UploadCloud size={32} /><strong>{file?.name || (mode === 'audio' ? '选择或拖入音频文件' : '选择或拖入文字文档')}</strong><span>{mode === 'audio' ? (asrReady ? `MP3、WAV、M4A、FLAC、OGG、AAC · 最大 200 MB / ${Math.ceil(maxDurationSeconds / 60)} 分钟` : unavailableReason || '请先配置可用的语音服务。') : 'TXT、MD、SRT、VTT、DOCX、文字型 PDF · 最大 20 MB'}</span><input aria-label={mode === 'audio' ? '选择音频文件' : '选择文字文档'} type="file" accept={mode === 'audio' ? '.mp3,.wav,.m4a,.flac,.ogg,.aac,.mp4,.webm,.opus' : '.txt,.md,.srt,.vtt,.csv,.docx,.pdf'} disabled={busy || (mode === 'audio' && !asrReady)} onChange={event => void choose(event.target.files?.[0])} /></label>{mode === 'text' ? <Field label="转写文字" hint="也可以直接粘贴会议记录；导入后可编辑并生成纪要。"><textarea rows={9} maxLength={1000000} value={text} disabled={busy} onChange={event => setText(event.target.value)} placeholder="在这里粘贴会议文字…" /></Field> : <p className="muted">{asrReady ? '使用当前账号的语音模型。任务提交后在后台排队处理。' : unavailableReason || '请先在设置中配置语音 API Key。'}{asrReady ? `${automaticLanguageOnly ? ' 识别语言：自动。' : ''} 文件最长 ${Math.ceil(maxDurationSeconds / 60)} 分钟；${diarization ? '支持说话人分离，可在转写中调整名称。' : '当前模型不支持说话人分离。'}` : ''}</p>}{error ? <InlineError>{error}{jobIntent.current.pending ? ' 再次点击提交会核对原任务及原识别语言，不会创建新的收费任务。请勿通过重新导入来重试。' : ''}</InlineError> : null}{busy ? <div className="upload-progress"><Spinner label={stage} /><progress aria-label="上传进度" max={100} value={progress} /></div> : null}<footer className="form-footer"><span className="muted">{meetingId.current && error ? '已创建的会议会保留，可在列表中继续处理。' : '仅上传到当前账号的云端空间。'}</span><button className="button primary" disabled={busy || (mode === 'audio' && !asrReady)}>{mode === 'audio' ? '上传并转写' : '导入文字'}</button></footer></form></Modal>;
}
