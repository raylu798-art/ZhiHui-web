'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Block } from '@blocknote/core';
import { Check, ChevronDown, Copy, Download, FileText, Pencil, Play, RefreshCw, Save, Sparkles, UserRound, X } from 'lucide-react';
import { api, asrUnavailableReason, isActiveJob, Job, MeetingDetail, messageOf, Settings, Template, timeLabel, Transcript } from './api';
import { JobIntent, PendingJobIntentError } from './job-intent.mjs';
import { dateText, Field, InlineError, Modal, Spinner } from './ui';
import { normalizeBlocks, sanitizeFileName } from '@/lib/export/blockUtils';

const RichEditor = dynamic(() => import('./RichEditor'), { ssr: false, loading: () => <Spinner label="正在加载编辑器" /> });

function TranscriptRow({ transcript, onSaved, onSeek, onRename }: { transcript: Transcript; onSaved: () => Promise<void>; onSeek: (seconds: number) => void; onRename: (speaker: string) => void }) {
  const [editing, setEditing] = useState(false); const [value, setValue] = useState(transcript.transcript); const [speaker, setSpeaker] = useState(transcript.speaker || '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); try { await api(`/meetings/${transcript.meeting_id}/transcripts/${transcript.id}`, 'PATCH', { transcript: value, speaker }); await onSaved(); setEditing(false); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); } }
  return <article className="transcript-row"><div className="transcript-avatar"><UserRound size={17} /></div><div className="transcript-content"><div className="transcript-meta"><button className="speaker-button" title="批量重命名此说话人" onClick={() => onRename(transcript.speaker || '')}>{transcript.speaker || '未标记说话人'}</button>{typeof transcript.audio_start_time === 'number' ? <button className="timestamp" onClick={() => onSeek(transcript.audio_start_time!)}><Play size={10} />{timeLabel(transcript.audio_start_time)}</button> : null}<button className="icon-button edit-transcript" aria-label="编辑转写" onClick={() => { setEditing(!editing); setValue(transcript.transcript); setSpeaker(transcript.speaker || ''); }}><Pencil size={13} /></button></div>{editing ? <form className="stack" onSubmit={save}><input aria-label="说话人名称" value={speaker} onChange={event => setSpeaker(event.target.value)} placeholder="说话人名称" maxLength={100} /><textarea aria-label="转写文字" value={value} required rows={4} maxLength={100000} onChange={event => setValue(event.target.value)} />{error ? <InlineError>{error}</InlineError> : null}<div className="row-actions"><button type="button" className="button small" onClick={() => setEditing(false)}>取消</button><button className="button small primary" disabled={busy}>{busy ? '保存中' : '保存'}</button></div></form> : <p>{transcript.transcript}</p>}</div></article>;
}

export function MeetingView({ detail, settings, templates, reload, onError, onDirty, isRecording }: { detail: MeetingDetail; settings?: Settings; templates: Template[]; reload: () => Promise<void>; onError: (message: string) => void; onDirty: (dirty: boolean) => void; isRecording: boolean }) {
  const [tab, setTab] = useState<'transcript' | 'summary'>('transcript'); const [template, setTemplate] = useState('');
  const [markdown, setMarkdown] = useState(detail.summary || ''); const [editorValue, setEditorValue] = useState(detail.summary || '');
  const [dirty, setDirty] = useState(false); const dirtyRef = useRef(false);
  const [busy, setBusy] = useState(false); const [exporting, setExporting] = useState(false); const [copied, setCopied] = useState(false);
  const [rename, setRename] = useState<{ from: string; to: string } | null>(null); const [titleEdit, setTitleEdit] = useState(false); const [title, setTitle] = useState(detail.meeting.title);
  const [exportMenu, setExportMenu] = useState(false); const audio = useRef<HTMLAudioElement>(null);
  const summaryIntent = useRef(new JobIntent()); const transcribeIntent = useRef(new JobIntent());
  const meetingId = detail.meeting.id;
  const activeSummary = detail.jobs.some(job => job.kind === 'summary' && isActiveJob(job));
  const activeTranscribe = detail.jobs.some(job => job.kind === 'transcribe' && isActiveJob(job));
  const fileUnavailable = asrUnavailableReason(settings, 'file_transcription');
  useEffect(() => { if (!template && templates.length) setTemplate(templates[0].id); }, [template, templates]);
  useEffect(() => { if (!dirtyRef.current) { setMarkdown(detail.summary || ''); setEditorValue(detail.summary || ''); } }, [detail.summary]);
  useEffect(() => { onDirty(dirty); dirtyRef.current = dirty; }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const editorChange = useCallback((value: string, _blocks: Block[], changed: boolean) => { setMarkdown(value); if (changed) { dirtyRef.current = true; setDirty(true); } }, []);
  async function saveSummary() {
    setBusy(true); try { await api(`/meetings/${meetingId}/summary`, 'PUT', { markdown }); dirtyRef.current = false; setDirty(false); await reload(); } catch (error) { onError(messageOf(error)); } finally { setBusy(false); }
  }
  async function generateSummary() {
    if (busy || activeSummary) return;
    if (dirty) { onError('请先保存纪要修改，再生成新的纪要'); return; }
    setBusy(true); try { await submitIntent(summaryIntent.current, { kind: 'summary', meeting_id: meetingId, template_id: template }); setTab('summary'); await reload(); } catch (error) { onError(messageOf(error)); } finally { setBusy(false); }
  }
  async function submitIntent(manager: JobIntent, payload: Parameters<JobIntent['prepare']>[0]) {
    let intent;
    try { intent = manager.prepare(payload); }
    catch (error) {
      if (!(error instanceof PendingJobIntentError) || !window.confirm('此前任务的提交结果尚未确认，且本次参数已改变。建议先查看任务队列。确定创建一个可能再次收费的新任务？')) throw error;
      manager.resetForNewIntent(); intent = manager.prepare(payload);
    }
    const job = await api<Job>('/jobs', 'POST', { ...intent.payload, request_id: intent.request_id });
    manager.confirmResponse(job);
  }
  async function retranscribe() {
    if (busy || activeTranscribe || !detail.meeting.asset_id) return;
    if (fileUnavailable) { onError(fileUnavailable); return; }
    setBusy(true);
    try { await submitIntent(transcribeIntent.current, { kind: 'transcribe', meeting_id: meetingId, asset_id: detail.meeting.asset_id, language: settings?.asr.provider === 'token_plan' ? 'auto' : settings?.asr.language || 'auto' }); await reload(); }
    catch (error) { onError(messageOf(error)); } finally { setBusy(false); }
  }
  async function exportDocument(format: 'pdf' | 'docx' | 'md' | 'txt') {
    setExporting(true); setExportMenu(false);
    try {
      let bytes: Uint8Array | string; let type: string;
      if (format === 'txt') { bytes = detail.transcripts.map(item => `${item.speaker ? `${item.speaker}: ` : ''}${item.transcript}`).join('\n\n'); type = 'text/plain;charset=utf-8'; }
      else if (format === 'md') { bytes = `# ${detail.meeting.title}\n\n${markdown}\n\n## 会议转写\n\n${detail.transcripts.map(item => `${item.speaker ? `**${item.speaker}：** ` : ''}${item.transcript}`).join('\n\n')}`; type = 'text/markdown;charset=utf-8'; }
      else {
        // Export works before the Summary tab/editor has ever been opened.
        let exportBlocks: Block[] = [];
        if (markdown.trim()) {
          const { BlockNoteEditor } = await import('@blocknote/core');
          const parser = BlockNoteEditor.create();
          exportBlocks = await parser.tryParseMarkdownToBlocks(markdown);
          parser._tiptapEditor.destroy();
        }
        const data = { title: detail.meeting.title, dateText: new Date(detail.meeting.created_at).toLocaleString('zh-CN'), blocks: normalizeBlocks(exportBlocks), transcripts: detail.transcripts.map(item => ({ speaker: item.speaker || undefined, text: item.transcript })), labels: { transcriptHeading: '会议转写' } };
        if (format === 'pdf') { bytes = await (await import('@/lib/export/exportPdf')).generatePdf(data); type = 'application/pdf'; }
        else { bytes = await (await import('@/lib/export/exportDocx')).generateDocx(data); type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; }
      }
      const payload = typeof bytes === 'string' ? bytes : Uint8Array.from(bytes).buffer;
      const url = URL.createObjectURL(new Blob([payload], { type })); const link = document.createElement('a'); link.href = url; link.download = `${sanitizeFileName(detail.meeting.title)}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { onError(messageOf(error)); } finally { setExporting(false); }
  }
  async function renameSpeaker(event: FormEvent) { event.preventDefault(); if (!rename) return; setBusy(true); try { await api(`/meetings/${meetingId}/speakers/rename`, 'POST', rename); setRename(null); await reload(); } catch (error) { onError(messageOf(error)); } finally { setBusy(false); } }
  return <section className="meeting-view"><header className="meeting-header"><div>{titleEdit ? <form className="title-form" onSubmit={async event => { event.preventDefault(); setBusy(true); try { await api(`/meetings/${meetingId}`, 'PATCH', { title: title.trim() }); setTitleEdit(false); await reload(); } catch (error) { onError(messageOf(error)); } finally { setBusy(false); } }}><input aria-label="会议名称" value={title} onChange={event => setTitle(event.target.value)} required maxLength={200} autoFocus /><button className="icon-button" aria-label="保存会议名称" disabled={busy}><Check size={18} /></button><button type="button" className="icon-button" aria-label="取消重命名" onClick={() => setTitleEdit(false)}><X size={18} /></button></form> : <h1>{detail.meeting.title}<button className="icon-button" aria-label="重命名会议" onClick={() => { setTitle(detail.meeting.title); setTitleEdit(true); }}><Pencil size={15} /></button></h1>}<div className="meeting-subtitle">{dateText(detail.meeting.created_at)}<span>·</span>{detail.transcripts.length} 段转写<span>·</span>{dirty ? '纪要修改未保存' : '云端已保存'}</div></div><div className="export-control"><button className="button" disabled={exporting} onClick={() => setExportMenu(!exportMenu)}>{exporting ? <Spinner label="导出中" /> : <><Download size={16} />导出<ChevronDown size={14} /></>}</button>{exportMenu ? <div className="dropdown" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setExportMenu(false); }}>{(['pdf', 'docx', 'md', 'txt'] as const).map(format => <button key={format} onClick={() => void exportDocument(format)}>{format.toUpperCase()}{format === 'txt' ? ' 转写' : ' 文档'}</button>)}</div> : null}</div></header><div className="meeting-toolbar"><div className="content-tabs"><button className={tab === 'transcript' ? 'active' : ''} onClick={() => { if (tab === 'summary') setEditorValue(markdown); setTab('transcript'); }}><FileText size={17} />会议转写<span>{detail.transcripts.length}</span></button><button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}><Sparkles size={17} />智能纪要{dirty ? <span className="dirty-dot" title="未保存" /> : null}</button></div><button className="icon-button" aria-label="刷新会议" onClick={() => void reload()}><RefreshCw size={16} /></button></div>{detail.meeting.asset_id ? <div className="audio-bar"><audio ref={audio} controls preload="metadata" src={`/api/v1/assets/${detail.meeting.asset_id}`} onError={() => onError('音频暂时无法播放，请刷新或检查文件是否仍存在')} /><a className="text-button" href={`/api/v1/assets/${detail.meeting.asset_id}`} download>下载原音频</a>{!activeTranscribe ? <button className="text-button" title={fileUnavailable || '使用当前语音模型重新转写'} disabled={!!fileUnavailable || busy} onClick={() => void retranscribe()}><RefreshCw size={13} />重新转写</button> : <Spinner label="转写中" />}</div> : null}<div className="meeting-body">{detail.meeting.asset_id && !fileUnavailable && settings?.asr.provider === 'token_plan' ? <p className="muted">文件识别语言：自动</p> : null}{detail.meeting.asset_id && fileUnavailable ? <div className="notice" role="status">{fileUnavailable}</div> : null}{detail.recording_state === 'interrupted' && !isRecording ? <div className="notice recording-recovery" role="status">录音已中断。服务器已保留接收的音频和转写；请检查内容，需要时使用“重新转写”。不会自动重新连接或重复提交收费任务。</div> : null}{tab === 'transcript' ? <div className="transcript-panel">{detail.transcripts.length ? detail.transcripts.map(transcript => <TranscriptRow key={transcript.id} transcript={transcript} onSaved={reload} onRename={from => setRename({ from, to: from })} onSeek={seconds => { if (audio.current) { audio.current.currentTime = seconds; void audio.current.play().catch(() => undefined); } }} />) : <div className="empty-panel"><FileText size={32} /><h3>{isRecording ? '正在聆听……' : activeTranscribe ? '音频正在转写' : '暂无转写内容'}</h3><p>{isRecording ? '开始说话后，这里将显示实时转写内容。' : activeTranscribe ? '任务在服务端持续处理，刷新或关闭页面不会重复提交。' : '导入文字或音频，或从主页开始录音。'}</p></div>}</div> : <div className="summary-panel"><div className="summary-actions"><label className="template-select"><span>纪要模板</span><select aria-label="纪要模板" value={template} onChange={event => setTemplate(event.target.value)}>{templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="button primary" disabled={busy || activeSummary || !settings?.summary.configured || !detail.transcripts.length || !template || dirty} onClick={() => void generateSummary()}>{activeSummary ? <Spinner label="生成中" /> : <><Sparkles size={16} />{detail.summary ? '重新生成' : '生成纪要'}</>}</button></div>{!settings?.summary.configured ? <div className="notice">请在设置中配置摘要 API Key，然后生成会议纪要。</div> : null}{activeSummary ? <div className="notice"><Spinner label="纪要在后台生成，完成后将自动显示" /></div> : null}<div className="editor-toolbar"><span>{dirty ? '有未保存的修改' : '内容支持直接编辑与格式调整'}</span><div><button className="icon-button" aria-label="复制纪要" onClick={() => { void navigator.clipboard.writeText(markdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(error => onError(messageOf(error))); }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button><button className="button small" disabled={!dirty || busy} onClick={() => void saveSummary()}><Save size={14} />{busy ? '保存中' : '保存修改'}</button></div></div><RichEditor value={editorValue} onChange={editorChange} onError={onError} /></div>}</div>{rename ? <Modal title="重命名说话人" onClose={() => setRename(null)}><form className="stack" onSubmit={renameSpeaker}><p className="muted">将此会议中“{rename.from || '未标记说话人'}”的所有转写统一改名。</p><Field label="新名称"><input autoFocus required maxLength={100} value={rename.to} onChange={event => setRename({ ...rename, to: event.target.value })} /></Field><button className="button primary" disabled={busy}>保存名称</button></form></Modal> : null}</section>;
}
