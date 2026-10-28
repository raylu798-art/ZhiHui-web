'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, CheckCircle2, ChevronRight, CircleHelp, Cloud, FileAudio, FileText, FolderOpen, Home, ListChecks, LogOut, Menu, Mic, Plus, Search, Settings as SettingsIcon, ShieldCheck, Sparkles, Square, Trash2, Upload, X } from 'lucide-react';
import { api, ApiError, asrUnavailableReason, BUILD, isActiveJob, Job, Meeting, MeetingDetail, messageOf, Settings, Template, timeLabel, User, VersionInfo, VERSION } from './api';
import { AuthPanel } from './AuthPanel';
import { HomeView } from './HomeView';
import { ImportModal } from './ImportModal';
import { MeetingView } from './MeetingView';
import { BrowserRecorder } from './recording';
import { SettingsModal } from './SettingsModal';
import { TemplatesModal } from './TemplatesModal';
import { dateText, InlineError, Modal, Spinner } from './ui';

const STATES: Record<Job['state'], string> = { queued: '排队中', running: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };

function JobList({ jobs, meetings, onSelect, onRefresh, onError }: { jobs: Job[]; meetings: Meeting[]; onSelect: (id: string) => void; onRefresh: () => Promise<void>; onError: (message: string) => void }) {
  const [busyId, setBusyId] = useState('');
  return <div className="job-list">{jobs.length ? jobs.map(job => <div className={`job-card state-${job.state}`} key={job.id}><div className="job-kind">{job.kind === 'summary' ? <Sparkles size={18} /> : <FileAudio size={18} />}</div><div className="job-information"><button className="job-title" onClick={() => onSelect(job.meeting_id)}>{meetings.find(meeting => meeting.id === job.meeting_id)?.title || '查看会议'}</button><p>{job.kind === 'summary' ? '生成纪要' : '音频转写'} · {STATES[job.state]} · {dateText(job.updated_at)}</p>{isActiveJob(job) ? <progress aria-label="任务进度" max={100} value={Math.max(0, Math.min(100, job.progress <= 1 ? job.progress * 100 : job.progress))} /> : null}{job.error ? <p className="job-error">{job.error}</p> : null}</div>{isActiveJob(job) ? <button className="button small" disabled={busyId === job.id} onClick={async () => { setBusyId(job.id); try { await api(`/jobs/${job.id}/cancel`, 'POST', {}); await onRefresh(); } catch (error) { onError(messageOf(error)); } finally { setBusyId(''); } }}>取消任务</button> : job.state === 'failed' || job.state === 'interrupted' ? <button className="button small" onClick={() => onSelect(job.meeting_id)}>查看并重试</button> : <CheckCircle2 size={17} className={job.state === 'completed' ? 'success' : 'muted'} />}</div>) : <div className="empty-panel"><ListChecks size={32} /><h3>暂无任务</h3><p>音频转写与纪要生成的进度会显示在这里。</p></div>}</div>;
}

export function WebApp() {
  const [user, setUser] = useState<User | null | undefined>(undefined); const [invite, setInvite] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]); const [jobs, setJobs] = useState<Job[]>([]); const [settings, setSettings] = useState<Settings>(); const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<string | null>(null); const [detail, setDetail] = useState<MeetingDetail>(); const [search, setSearch] = useState(''); const [debouncedSearch, setDebouncedSearch] = useState('');
  const [modal, setModal] = useState<'settings' | 'templates' | 'import' | 'jobs' | 'about' | null>(null); const [remove, setRemove] = useState<Meeting | null>(null); const [removeBusy, setRemoveBusy] = useState(false);
  const [error, setError] = useState(''); const [offline, setOffline] = useState(false); const [loading, setLoading] = useState(false); const [sideOpen, setSideOpen] = useState(false);
  const [title, setTitle] = useState(''); const [includeSystem, setIncludeSystem] = useState(false); const [language, setLanguage] = useState('auto');
  const [recordingState, setRecordingState] = useState<'idle' | 'starting' | 'recording' | 'stopping'>('idle'); const [recordingId, setRecordingId] = useState<string>(); const [seconds, setSeconds] = useState(0); const [level, setLevel] = useState(0);
  const [newVersion, setNewVersion] = useState(false); const [capabilityDisplay, setCapabilityDisplay] = useState(false);
  const recorder = useRef<BrowserRecorder>(); const dirty = useRef(false); const currentSelected = useRef(selected); const requestId = useRef(0); const fetchController = useRef<AbortController>();
  const showError = useCallback((message: string) => setError(message), []);
  const trackDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  useEffect(() => { currentSelected.current = selected; }, [selected]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search); setInvite(params.get('invite')); setSelected(params.get('meeting'));
    setCapabilityDisplay(!!navigator.mediaDevices?.getDisplayMedia);
    const controller = new AbortController();
    if (params.get('invite')) { setUser(null); return () => controller.abort(); }
    api<User>('/auth/me', 'GET', undefined, controller.signal).then(setUser).catch(error => { if (!controller.signal.aborted) { setUser(null); if (!(error instanceof ApiError && error.status === 401)) setError(messageOf(error)); } });
    return () => controller.abort();
  }, []);
  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search), 250); return () => clearTimeout(timer); }, [search]);

  const refresh = useCallback(async () => {
    if (!user) return;
    fetchController.current?.abort(); const controller = new AbortController(); fetchController.current = controller; const id = ++requestId.current;
    try {
      const data = await Promise.all([
        api<Meeting[]>(`/meetings?search=${encodeURIComponent(debouncedSearch)}`, 'GET', undefined, controller.signal),
        api<Job[]>('/jobs', 'GET', undefined, controller.signal),
        api<Settings>('/settings', 'GET', undefined, controller.signal),
        api<Template[]>('/templates', 'GET', undefined, controller.signal),
        selected ? api<MeetingDetail>(`/meetings/${selected}`, 'GET', undefined, controller.signal) : Promise.resolve(undefined),
      ]);
      if (id !== requestId.current) return;
      setMeetings(data[0]); setJobs(data[1]); setSettings(data[2]); setTemplates(data[3]); if (data[4]) setDetail(data[4]); setOffline(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) { setUser(null); void recorder.current?.stop(); }
      else if (error instanceof ApiError && error.status === 404 && selected) { setSelected(null); setDetail(undefined); window.history.replaceState(null, '', '/'); }
      else setOffline(true);
    } finally { if (id === requestId.current) setLoading(false); }
  }, [user, debouncedSearch, selected]);
  useEffect(() => {
    if (!user) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() { await refresh(); if (!cancelled) timer = setTimeout(poll, 3000); }
    void poll(); return () => { cancelled = true; clearTimeout(timer); fetchController.current?.abort(); };
  }, [refresh, user]);
  useEffect(() => { if (settings?.asr.provider === 'token_plan') setLanguage('auto'); else if (settings?.asr.language) setLanguage(settings.asr.language); }, [settings?.asr.language, settings?.asr.provider]);
  useEffect(() => {
    if (!user) return; let cancelled = false;
    const check = () => { void api<VersionInfo>('/version').then(value => { if (!cancelled) setNewVersion(value.version !== VERSION || String(value.build) !== BUILD); }).catch(() => undefined); };
    check(); const timer = setInterval(check, 60000); return () => { cancelled = true; clearInterval(timer); };
  }, [user]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (recordingState !== 'idle' || dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [recordingState]);
  useEffect(() => { if (recordingState !== 'recording') return; const start = Date.now(); const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000); return () => clearInterval(timer); }, [recordingState]);

  function selectMeeting(id: string | null) {
    if (id !== selected && dirty.current && !window.confirm('纪要有未保存的修改，离开会丢失这些修改。确定离开？')) return;
    dirty.current = false; if (id !== selected) setDetail(undefined); setSelected(id); setLoading(!!id); setSideOpen(false);
    window.history.replaceState(null, '', id ? `/?meeting=${encodeURIComponent(id)}` : '/');
  }
  async function startRecording() {
    if (recordingState !== 'idle') return;
    const unavailable = asrUnavailableReason(settings, 'realtime');
    if (unavailable) { setModal('settings'); setError(unavailable); return; }
    if (dirty.current && !window.confirm('开始新会议前将离开当前纪要。确定放弃未保存修改？')) return;
    setRecordingState('starting'); setSeconds(0); setError('');
    try {
      recorder.current = await BrowserRecorder.start({ title: title.trim() || `会议 ${new Date().toLocaleString('zh-CN')}`, language: settings?.asr.provider === 'token_plan' ? 'auto' : language, includeSystem,
        onCreated: id => { setRecordingId(id); dirty.current = false; selectMeeting(id); },
        onTranscript: transcript => { if (currentSelected.current === transcript.meeting_id) setDetail(value => value ? { ...value, transcripts: [...value.transcripts.filter(item => item.id !== transcript.id), transcript] } : value); },
        onError: showError, onClosed: () => { setRecordingState('idle'); setLevel(0); recorder.current = undefined; }, onLevel: setLevel,
      });
      setRecordingState('recording');
    } catch (error) { setError(messageOf(error)); setRecordingState('idle'); }
  }
  async function stopRecording() { if (recordingState !== 'recording') return; setRecordingState('stopping'); await recorder.current?.stop(); setRecordingState('idle'); await refresh(); }
  const activeJobs = jobs.filter(isActiveJob);
  const realtimeUnavailable = asrUnavailableReason(settings, 'realtime');
  const fileUnavailable = asrUnavailableReason(settings, 'file_transcription');

  if (user === undefined) return <div className="boot-screen"><img src="/icon_128x128.png" width={56} height={56} alt="知会" /><Spinner label="正在连接知会" /></div>;
  if (!user) return <>{error ? <div className="auth-error"><InlineError>{error}</InlineError></div> : null}<AuthPanel invite={invite} onAuthenticated={value => { setUser(value); setInvite(null); setError(''); }} /></>;
  return <div className="web-shell">{sideOpen ? <button className="sidebar-scrim" aria-label="收起侧边栏" onClick={() => setSideOpen(false)} /> : null}<aside className={`sidebar ${sideOpen ? 'open' : ''}`}><button className="brand" onClick={() => setModal('about')}><img src="/icon_128x128.png" width={36} height={36} alt="" /><strong>知会</strong><span>Web</span></button><nav className="sidebar-top"><button className={!selected ? 'nav-button active' : 'nav-button'} onClick={() => selectMeeting(null)}><Home size={18} />主页</button><button className="nav-button" onClick={() => setModal('templates')}><FileText size={18} />纪要模板</button><button className="nav-button" onClick={() => setModal('jobs')}><ListChecks size={18} />任务队列{activeJobs.length ? <span className="count-badge">{activeJobs.length}</span> : null}</button></nav><div className="sidebar-divider" /><div className="sidebar-heading"><span><FileText size={16} />会议纪要</span><button className="icon-button" aria-label="新建会议" onClick={() => selectMeeting(null)}><Plus size={16} /></button></div><label className="meeting-search"><Search size={15} /><input aria-label="搜索会议" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索会议内容……" />{search ? <button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={13} /></button> : null}</label><div className="meeting-list custom-scrollbar">{meetings.length ? meetings.map(meeting => <div className={`meeting-list-item ${selected === meeting.id ? 'selected' : ''}`} key={meeting.id}><button className="meeting-link" onClick={() => selectMeeting(meeting.id)}><FileText size={16} /><span><strong>{meeting.title}</strong><small>{dateText(meeting.updated_at)}</small></span></button><button className="delete-meeting icon-button" aria-label={`删除会议 ${meeting.title}`} onClick={() => setRemove(meeting)}><Trash2 size={13} /></button></div>) : <p className="sidebar-empty">{search ? '没有找到匹配的会议' : '开始第一场会议，记录将显示在这里。'}</p>}</div><div className="sidebar-bottom"><button className="sidebar-record-button" title={realtimeUnavailable || '开始录音'} disabled={recordingState !== 'idle' || !!realtimeUnavailable} onClick={() => void startRecording()}><Mic size={16} />{recordingState === 'idle' ? '开始录音' : '正在录音……'}</button><button className="sidebar-import-button" onClick={() => setModal('import')}><Upload size={16} />导入音频</button><button className="nav-button" onClick={() => setModal('settings')}><SettingsIcon size={17} />设置<span className={`status-dot ${settings?.asr.configured && settings.summary.configured ? 'ready' : ''}`} /></button><div className="account-line"><div className="account-avatar">{user.username.slice(0, 1).toUpperCase()}</div><span><strong>{user.username}</strong><small>v{VERSION} · 构建 {BUILD}</small></span><button className="icon-button" aria-label="退出登录" disabled={recordingState !== 'idle'} onClick={async () => { if (dirty.current && !window.confirm('纪要有未保存的修改，确定退出登录？')) return; try { await api('/auth/logout', 'POST', {}); setUser(null); setMeetings([]); setJobs([]); setDetail(undefined); setSelected(null); setSettings(undefined); } catch (error) { setError(messageOf(error)); } }}><LogOut size={16} /></button></div></div></aside><main className="workspace"><div className="mobile-header"><button className="icon-button" aria-label="展开侧边栏" onClick={() => setSideOpen(true)}><Menu size={22} /></button><img src="/icon_128x128.png" width={28} height={28} alt="" /><strong>知会</strong><span>{VERSION}</span></div>{error ? <div className="banner error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={17} /></button></div> : null}{offline ? <div className="banner warning-banner" role="status">连接暂时不可用，正在重试。已提交任务仍由服务端处理。</div> : null}{newVersion && recordingState === 'idle' ? <div className="banner update-banner"><span>Web 版已更新，空闲时刷新即可使用最新构建。</span><button className="button small" onClick={() => { if (!dirty.current || window.confirm('刷新会丢失未保存的纪要修改，确定刷新？')) window.location.reload(); }}>刷新页面</button></div> : null}{recordingState !== 'idle' ? <div className="recording-banner"><span className="recording-light" /><button onClick={() => recordingId && selectMeeting(recordingId)}>{recordingState === 'starting' ? '正在连接麦克风与实时转写…' : recordingState === 'stopping' ? '正在完成转写并保存录音…' : `正在录音 ${timeLabel(seconds)} · 查看实时转写`}</button><div className="level-bars" aria-label="麦克风音量">{[.5, .9, .65, 1, .7].map((scale, index) => <i key={index} style={{ height: `${Math.max(3, level * scale * 25)}px` }} />)}</div><button className="button small" disabled={recordingState !== 'recording'} onClick={() => void stopRecording()}><Square size={13} fill="currentColor" />结束录音</button></div> : null}{selected ? detail?.meeting.id === selected ? <MeetingView key={selected} detail={detail} settings={settings} templates={templates} reload={refresh} onError={showError} onDirty={trackDirty} isRecording={recordingState !== 'idle' && recordingId === selected} /> : <div className="boot-screen"><Spinner label={loading ? '正在加载会议' : '正在恢复会议'} /></div> : <HomeView automaticLanguageOnly={settings?.asr.provider === 'token_plan'} title={title} setTitle={setTitle} language={language} setLanguage={setLanguage} includeSystem={includeSystem} setIncludeSystem={setIncludeSystem} capabilityDisplay={capabilityDisplay} asrReady={!!settings?.asr.configured} recordingUnavailableReason={realtimeUnavailable} recording={recordingState !== 'idle'} meetings={meetings} onSelect={selectMeeting} onStart={() => void startRecording()} onSettings={() => setModal('settings')} onImport={() => setModal('import')} onTemplates={() => setModal('templates')} />}</main>{modal === 'settings' ? <SettingsModal user={user} onClose={() => setModal(null)} onSaved={setSettings} /> : null}{modal === 'templates' ? <TemplatesModal templates={templates} onChanged={refresh} onClose={() => setModal(null)} /> : null}{modal === 'import' ? <ImportModal asrReady={!fileUnavailable} unavailableReason={fileUnavailable} maxDurationSeconds={settings?.asr.capabilities?.max_duration_seconds || 7200} diarization={!!settings?.asr.capabilities?.diarization} automaticLanguageOnly={settings?.asr.provider === 'token_plan'} language={settings?.asr.provider === 'token_plan' ? 'auto' : language} onClose={() => setModal(null)} onDone={id => { setModal(null); selectMeeting(id); }} /> : null}{modal === 'jobs' ? <Modal title="任务队列" onClose={() => setModal(null)} wide><p className="muted">任务状态保存在服务端，刷新后自动恢复。失败任务不会自动重复调用收费接口。</p><JobList jobs={jobs} meetings={meetings} onRefresh={refresh} onError={showError} onSelect={id => { setModal(null); selectMeeting(id); }} /></Modal> : null}{modal === 'about' ? <Modal title="关于知会 Web" onClose={() => setModal(null)}><div className="about-brand"><img src="/icon_128x128.png" width={64} height={64} alt="知会" /><h2>知会</h2><p>版本 {VERSION} · Web 构建 {BUILD}</p></div><p>与桌面版保持相同的产品版本、会议工作流和纪要模板。Web 通过云端模型完成识别和摘要，结果可能因模型不同而有所差异。</p><p className="muted">会议保存在当前服务器，不与桌面会议同步。共享声音依赖浏览器支持，选择共享源时需勾选音频。录音中断后会保留服务器已接收的内容，不自动重建收费连接。</p></Modal> : null}{remove ? <Modal title="删除会议" onClose={() => { if (!removeBusy) setRemove(null); }}><div className="stack"><p>确定删除“{remove.title}”？会议文字、纪要和关联文件将被删除，此操作无法撤销。</p><footer className="form-footer"><button className="button" disabled={removeBusy} onClick={() => setRemove(null)}>保留会议</button><button className="button destructive" disabled={removeBusy || (recordingState !== 'idle' && recordingId === remove.id)} onClick={async () => { setRemoveBusy(true); try { await api(`/meetings/${remove.id}`, 'DELETE'); if (selected === remove.id) { dirty.current = false; selectMeeting(null); } setRemove(null); await refresh(); } catch (error) { setError(messageOf(error)); } finally { setRemoveBusy(false); } }}>{removeBusy ? <Spinner label="删除中" /> : '删除会议'}</button></footer>{recordingState !== 'idle' && recordingId === remove.id ? <InlineError>请先结束这场会议的录音。</InlineError> : null}</div></Modal> : null}</div>;
}
