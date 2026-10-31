#!/usr/bin/env node
// Test double for the Antigravity CLI (`agy`): same flags and JSON envelope, no network, no model.
// MOCK_AGY_MODE: ok (default) | error | denied | garbage | slow ; MOCK_AGY_LOG: file that receives the argv as JSON.
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.MOCK_AGY_LOG) fs.appendFileSync(process.env.MOCK_AGY_LOG, `${JSON.stringify(argv)}\n`);
const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const mode = process.env.MOCK_AGY_MODE || 'ok';

if (argv.includes('--version')) { process.stdout.write('agy 1.4.12-mock\n'); process.exit(0); }
if (argv[0] === 'models') {
  process.stdout.write(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'].join('\n') + '\n');
  process.exit(0);
}
const prompt = val('-p');
if (prompt === null) { process.stderr.write('mock-agy: no -p prompt\n'); process.exit(2); }
if (prompt === '/usage') {
  // real shape of `agy -p /usage --output-format json` (num_turns 0, answered by the CLI itself)
  const bucket = (id, window, remaining_fraction, reset_time) => ({ id, name: `${window} limit`, window, remaining_fraction, reset_time });
  const groups = [
    { name: 'Gemini Models', buckets: [bucket('gemini-weekly', 'weekly', 0.75, '2099-01-07T00:00:00Z'), bucket('gemini-5h', '5h', 0.6, '2099-01-01T05:00:00Z')] },
    { name: 'Claude and GPT models', buckets: [bucket('3p-weekly', 'weekly', 1, '2099-01-07T00:00:00Z'), bucket('3p-5h', '5h', 1, '2099-01-01T05:00:00Z')] },
  ];
  if (mode === 'garbage') { process.stdout.write('not json at all\n'); process.exit(0); }
  if (mode === 'no-usage-command') { process.stdout.write(`${JSON.stringify({ conversation_id: 'x', status: 'SUCCESS', response: 'I cannot run that.', num_turns: 1 })}\n`); process.exit(0); }
  process.stdout.write(`${JSON.stringify({ conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0, usage: { total_tokens: 0 }, command: { name: 'usage', data: { groups } } })}\n`);
  process.exit(0);
}
const conversation = val('--conversation') || 'mock-conversation-1';
const envelope = (o) => process.stdout.write(`${JSON.stringify({ conversation_id: conversation, duration_seconds: 1, num_turns: 1, ...o })}\n`);
const usage = { input_tokens: 1200, output_tokens: 80, thinking_tokens: 40, cache_read_tokens: 0, total_tokens: 1320 };

if (mode === 'garbage') { process.stdout.write('not json at all\n'); process.exit(0); }
if (mode === 'error') { envelope({ status: 'ERROR', error: 'quota exceeded: 429 resource exhausted', usage: null }); process.exit(1); }
if (mode === 'denied') {
  process.stderr.write('permission denied: command(npm test) is not allowed\n');
  envelope({ status: 'SUCCESS', response: 'I could not run the command.', usage });
  process.exit(0);
}
if (mode === 'slow') await new Promise((r) => setTimeout(r, 30000));
envelope({
  status: 'SUCCESS',
  response: `MOCK OK model=${val('--model')} mode=${val('--mode')} resumed=${argv.includes('--conversation')}`,
  usage,
});
