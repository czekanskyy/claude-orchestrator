// Autonomous mode: things the detached supervisor needs from the OS. Notifications (generic text only), keeping the
// machine awake, and zero-token probes (network, Claude login) used while a run waits for an external failure to clear.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { which, runProcess } from './common.mjs';
import { claudeBin } from './auto-worker.mjs';

// ---------------------------------------------------------------- notifications
// Fixed templates: a notification never carries code, paths, task names or findings (it may leave the machine).
export const NOTIFY_TEXT = Object.freeze({
  done: 'Orchestrator: autonomiczny przebieg zakończony. Raport: /orchestrator:auto report',
  blocked: 'Orchestrator: autonomiczny przebieg wymaga Twojej uwagi (część zadań zaparkowana). Szczegóły: /orchestrator:auto report',
  long_wait: 'Orchestrator: autonomiczny przebieg czeka na reset limitów i wznowi się sam.',
  waiting_external: 'Orchestrator: autonomiczny przebieg czeka na sieć lub logowanie (ponawia próby sam).',
  stopped: 'Orchestrator: autonomiczny przebieg zatrzymany w punkcie kontrolnym.',
  handed_over: 'Orchestrator: autonomiczny przebieg przekazany do trybu zwykłego.',
  aborted: 'Orchestrator: autonomiczny przebieg przerwany.',
});

export const NOTIFY_CHANNELS = ['os', 'file', 'command', 'none'];

function osNotify(text) {
  const title = 'Orchestrator';
  if (process.platform === 'win32') {
    const ps = which('powershell') || which('pwsh');
    if (!ps) return { ok: false, error: 'powershell not found' };
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle = '${title}'; $n.BalloonTipText = '${text.replace(/'/g, "''")}'; $n.Visible = $true; $n.ShowBalloonTip(15000); Start-Sleep -Seconds 16; $n.Dispose()`;
    const c = spawn(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
    return { ok: true };
  }
  if (process.platform === 'darwin') {
    const r = spawnSync('osascript', ['-e', `display notification "${text.replace(/"/g, '')}" with title "${title}"`], { timeout: 15000 });
    return { ok: r.status === 0, error: r.status === 0 ? null : 'osascript failed' };
  }
  if (!which('notify-send')) return { ok: false, error: 'notify-send not found' };
  const r = spawnSync('notify-send', [title, text], { timeout: 15000 });
  return { ok: r.status === 0, error: r.status === 0 ? null : 'notify-send failed' };
}

// notify: contract.notify { channel, command }. The file log is always written (the fallback every channel has).
export function sendNotification(notify, event, paths, { send = true } = {}) {
  const text = NOTIFY_TEXT[event];
  if (!text) return { ok: false, error: `unknown event ${event}` };
  const line = `${new Date().toISOString()} ${event} ${text}\n`;
  try { fs.appendFileSync(path.join(paths.dir, 'notifications.log'), line); fs.appendFileSync(path.join(path.dirname(paths.dir), 'notifications.log'), line); } catch { /* best effort */ }
  const channel = notify?.channel || 'file';
  if (!send || channel === 'file' || channel === 'none') return { ok: true, channel, delivered: channel === 'file' ? 'log' : 'none' };
  try {
    if (channel === 'os') return { ...osNotify(text), channel };
    if (channel === 'command' && notify.command) {
      const c = spawn(notify.command, [], { shell: true, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ORCH_NOTIFY_TEXT: text, ORCH_NOTIFY_EVENT: event } });
      c.unref();
      return { ok: true, channel };
    }
  } catch (e) { return { ok: false, channel, error: e.message }; }
  return { ok: false, channel, error: 'channel not usable' };
}

// ---------------------------------------------------------------- keep awake
export function keepAwakeCapability() {
  if (process.platform === 'win32') {
    const ps = which('powershell') || which('pwsh');
    return ps ? { ok: true, method: 'SetThreadExecutionState via a PowerShell helper', note: 'closing the lid or a power-plan sleep timer on battery can still suspend the machine: set "when I close the lid" to "do nothing"' } : { ok: false, method: null, note: 'powershell not found' };
  }
  if (process.platform === 'darwin') return which('caffeinate') ? { ok: true, method: 'caffeinate -i -s', note: 'a closed lid on battery still sleeps' } : { ok: false, method: null, note: 'caffeinate not found' };
  return which('systemd-inhibit') ? { ok: true, method: 'systemd-inhibit', note: 'lid-close handling is configured separately (logind.conf)' } : { ok: false, method: null, note: 'systemd-inhibit not found' };
}

// Starts a helper that holds a "do not sleep" request for as long as `parentPid` lives. -> { stop() , method }
export function startKeepAwake(parentPid = process.pid) {
  const cap = keepAwakeCapability();
  if (!cap.ok) return { method: null, stop() {}, note: cap.note };
  let child;
  try {
    if (process.platform === 'win32') {
      const ps = which('powershell') || which('pwsh');
      const script = `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void][W.P]::SetThreadExecutionState(0x80000001); while ($true) { Start-Sleep -Seconds 20; if (-not (Get-Process -Id ${Number(parentPid)} -ErrorAction SilentlyContinue)) { break } }`;
      child = spawn(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') child = spawn('caffeinate', ['-i', '-s', '-w', String(parentPid)], { stdio: 'ignore' });
    else child = spawn('systemd-inhibit', ['--what=sleep:idle', '--who=orchestrator', '--why=autonomous run', '--mode=block', 'tail', `--pid=${parentPid}`, '-f', '/dev/null'], { stdio: 'ignore' });
    child.on('error', () => {});
  } catch (e) { return { method: null, stop() {}, note: e.message }; }
  return { method: cap.method, note: cap.note, stop() { try { child.kill(); } catch { /* gone */ } } };
}

// ---------------------------------------------------------------- zero-token probes
export async function networkReachable(url = 'https://api.anthropic.com', timeoutMs = 8000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    await fetch(url, { method: 'HEAD', signal: ctl.signal });
    clearTimeout(t);
    return true; // any HTTP answer means the network works
  } catch { return false; }
}

export async function claudeLoggedIn() {
  const bin = claudeBin();
  if (!bin) return { ok: false, reason: 'cli_missing' };
  const r = await runProcess(bin, ['auth', 'status'], { timeoutMs: 30000 });
  try { const j = JSON.parse(r.stdout); return { ok: j.loggedIn === true, reason: j.loggedIn ? null : 'not_logged_in' }; } catch { return { ok: r.code === 0, reason: r.code === 0 ? null : 'auth_status_failed' }; }
}
