'use client';
import { ReactNode, useEffect, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={dialog} className={`web-modal ${wide ? 'wide' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <header><h2>{title}</h2><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={20} /></button></header>
    <div className="modal-content">{children}</div>
  </dialog>;
}
export function Spinner({ label = '加载中' }: { label?: string }) { return <span className="spinner" role="status"><Loader2 size={18} className="spin" />{label}</span>; }
export function InlineError({ children }: { children: ReactNode }) { return <p className="inline-error" role="alert">{children}</p>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>; }
export function dateText(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
