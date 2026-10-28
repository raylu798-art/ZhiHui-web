import type { Metadata } from 'next';
import product from '../../package.json';
import { SiteFooter } from '../web/SiteFooter';
import './globals.css';
export const metadata: Metadata = { title: '知会 · 会议纪要', description: `知会 ${product.version} Web 版，会议转写与智能纪要`, icons: { icon: '/icon_128x128.png' } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}<SiteFooter /></body></html>;
}
