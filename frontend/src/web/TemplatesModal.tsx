'use client';
import { FormEvent, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, messageOf, Template } from './api';
import { Field, InlineError, Modal, Spinner } from './ui';

export function TemplatesModal({ templates, onChanged, onClose }: { templates: Template[]; onChanged: () => Promise<void>; onClose: () => void }) {
  const [selected, setSelected] = useState<Template | null>(templates[0] || null);
  const [name, setName] = useState(selected?.name || ''); const [description, setDescription] = useState(selected?.description || ''); const [prompt, setPrompt] = useState(selected?.prompt || '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  function select(template: Template | null) { setSelected(template); setName(template?.name || ''); setDescription(template?.description || ''); setPrompt(template?.prompt || ''); setError(''); }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const id = selected && !selected.builtin ? selected.id : crypto.randomUUID(); const template = await api<Template>(`/templates/${id}`, 'PUT', { name: name.trim(), description: description.trim(), prompt: prompt.trim() }); await onChanged(); select(template); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); }
  }
  return <Modal title="纪要模板" onClose={onClose} wide><div className="templates-layout"><aside className="template-list"><button className="button" onClick={() => select(null)}><Plus size={16} />新建模板</button>{templates.map(template => <button key={template.id} className={`template-item ${selected?.id === template.id ? 'selected' : ''}`} onClick={() => select(template)}><strong>{template.name}</strong><small>{template.builtin ? '内置模板' : '我的模板'}</small></button>)}</aside><form className="stack template-form" onSubmit={save}><Field label="模板名称"><input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="模板说明"><input maxLength={500} value={description} onChange={event => setDescription(event.target.value)} /></Field><Field label="纪要生成提示词" hint="描述希望生成的结构、重点和语言。转写内容由服务端自动附加。"><textarea required minLength={10} maxLength={16000} rows={12} value={prompt} onChange={event => setPrompt(event.target.value)} /></Field>{error ? <InlineError>{error}</InlineError> : null}<footer className="form-footer">{selected && !selected.builtin ? <button type="button" className="text-button danger" disabled={busy} onClick={async () => { setBusy(true); try { await api(`/templates/${selected.id}`, 'DELETE'); await onChanged(); select(null); } catch (error) { setError(messageOf(error)); } finally { setBusy(false); } }}><Trash2 size={16} />删除模板</button> : <span className="muted">{selected?.builtin ? '内置模板编辑后另存为个人模板。' : '模板仅对当前账号可见。'}</span>}<button className="button primary" disabled={busy}>{busy ? <Spinner label="保存中" /> : selected?.builtin ? '另存为我的模板' : '保存模板'}</button></footer></form></div></Modal>;
}
