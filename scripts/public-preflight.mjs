#!/usr/bin/env node
// Read-only observation of the existing desktop channel; never publishes updates.
import { createHash } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';

const base = 'http://101.200.125.86:8801';
async function get(route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.text();
}
const [health, manifest, dns] = await Promise.allSettled([
  get('/api/v1/health'), get('/update/latest.json'), resolve4('zhihui.helms.wiki'),
]);
const report = { observedAt: new Date().toISOString() };
if (health.status === 'fulfilled') report.license = JSON.parse(health.value);
else report.licenseError = health.reason.message;
if (manifest.status === 'fulfilled') {
  const parsed = JSON.parse(manifest.value);
  report.desktop = { version: parsed.version, manifestSha256: createHash('sha256').update(manifest.value).digest('hex'),
    installerUrl: parsed.platforms?.['windows-x86_64']?.url };
} else report.desktopError = manifest.reason.message;
report.domain = dns.status === 'fulfilled' ? { addresses: dns.value } : { error: dns.reason.code };
console.log(JSON.stringify(report, null, 2));
if (!report.license?.ok || !report.desktop?.version) process.exitCode = 1;
