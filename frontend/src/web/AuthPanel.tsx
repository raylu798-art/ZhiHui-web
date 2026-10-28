'use client';
import { FormEvent, useState } from 'react';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { api, messageOf, User, VERSION } from './api';
import { Field, InlineError, Spinner } from './ui';

export function AuthPanel({ invite, onAuthenticated }: { invite: string | null; onAuthenticated: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const user = await api<User>(invite ? '/auth/accept-invite' : '/auth/login', 'POST', { username: username.trim(), password, ...(invite ? { token: invite } : {}) });
      setPassword(''); window.history.replaceState(null, '', '/'); onAuthenticated(user);
    } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-story"><div className="auth-brand"><img src="/icon_128x128.png" alt="" width={48} height={48} /><strong>知会</strong><span>ZH I HUI</span></div><div><span className="eyebrow">专注交流，知会记录</span><h1>让每一次交流<br />都有迹可循。</h1><p>从实时转写到清晰纪要，<br />把讨论变成值得留存的知识。</p><div className="story-tags"><span>实时语音转写</span><span>智能会议纪要</span><span>多种文档导出</span></div></div><small>知会 {VERSION} · Web</small></section><section className="auth-form-area"><form onSubmit={submit} className="auth-form"><div className="auth-symbol"><LockKeyhole size={24} /></div><h2>{invite ? '接受邀请，加入知会' : '欢迎使用知会'}</h2><p>{invite ? '设置你的用户名和密码，开始记录会议。' : '登录你的账号，继续工作。'}</p><Field label="用户名"><input name="username" autoComplete="username" required minLength={3} maxLength={64} value={username} onChange={event => setUsername(event.target.value)} placeholder="请输入用户名" /></Field><Field label="密码" hint={invite ? '至少 12 个字符，请使用独立的强密码。' : undefined}><input name="password" type="password" autoComplete={invite ? 'new-password' : 'current-password'} required minLength={invite ? 12 : 1} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder={invite ? '设置密码' : '请输入密码'} /></Field>{error ? <InlineError>{error}</InlineError> : null}<button className="button primary full" disabled={busy}>{busy ? <Spinner label="正在验证" /> : <>{invite ? '创建账号' : '登录'}<ArrowRight size={17} /></>}</button><div className="auth-note">{invite ? '邀请链接仅限使用一次，并有有效期。' : 'Web 版仅对受邀用户开放，请向管理员获取邀请链接。'}<br />会议保存在云端，与你的桌面会议独立。{invite ? <><br /><a href="/">已有账号？返回登录</a></> : null}</div></form></section></main>;
}
