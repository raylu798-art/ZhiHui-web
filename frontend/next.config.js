const path = require('node:path');
const editorBase = path.dirname(require.resolve('@blocknote/core'));
/** Independent browser build: no desktop plugins or desktop source aliases. */
/** @type {import('next').NextConfig} */
module.exports = {
  output: 'export', reactStrictMode: true, poweredByHeader: false,
  images: { unoptimized: true }, experimental: { cpus: 2 },
  ...(process.env.NODE_ENV === 'development' ? {
    async rewrites() {
      return [{ source: '/api/:path*', destination: `${process.env.ZHIHUI_API_ORIGIN || 'http://127.0.0.1:8810'}/api/:path*` }];
    },
  } : {}),
  webpack(config) {
    config.resolve.fallback = { ...config.resolve.fallback, canvas: false, fs: false };
    // BlockNote and Tiptap must share ProseMirror constructors.
    for (const name of ['model', 'state', 'view', 'transform', 'tables', 'schema-list', 'keymap', 'commands', 'history', 'inputrules', 'gapcursor', 'dropcursor']) {
      const pkg = `prosemirror-${name}`;
      config.resolve.alias[pkg] = require.resolve(pkg, { paths: [editorBase] });
    }
    return config;
  },
};
