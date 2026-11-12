import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { alertDrop, lossChart } from './bridge'
import type { PaceJob } from './bridge'
import { chartSvg } from './chart'
import { adoptedSuccessor, dropFrom, fmtDur, isAway, latestUserAt, nextPurge, opFrom, presenceWith, relayArmed, routeFor, successorAlive } from './drop'
import type { Drop } from './drop'
import { attachments, card, COLOR, curlConfig, parseCurl, payload, postArgv, progressBar, SILENT } from './embed'
import { cardDrop, commonPrefix, refresh } from './jobcards'
import type { JobCard } from './jobcards'

const NOW = Date.parse('2026-10-15T15:00:00Z')
const MIN = 60_000
const SECRET = 'https://discord.com/api/webhooks/123/very-secret-token'

const drop = (raw: Record<string, unknown>): Drop => {
  const d = dropFrom(raw)
  if (typeof d === 'string') throw new Error(d)
  return d
}

describe('the op', () => {
  test('reads the JSON from the heredoc', () => {
    expect(opFrom(`: drop <<'EOF'\n{"title":"t"}\nEOF`)).toEqual({ title: 't' })
    expect(typeof opFrom(': drop <<EOF\nnot json\nEOF')).toBe('string')
  })

  test('a drop needs a title or a text, safe absolute paths and at most 10 files', () => {
    expect(dropFrom({})).toContain('needs a title or a text')
    expect(dropFrom({ title: 't', image: 'rel/x.png' })).toContain('absolute path')
    expect(dropFrom({ title: 't', files: ['/a/b";x'] })).toContain('absolute path')
    expect(dropFrom({ title: 't', files: Array.from({ length: 11 }, (_, i) => `/f${i}`) })).toContain('at most 10')
    expect(dropFrom({ title: 't', url: 'javascript:x' })).toContain('http(s) link')
    expect(dropFrom({ kind: 'progress', title: 't' })).toContain('needs a key')
  })

  test('fills the defaults and normalises progress and eta', () => {
    const d = drop({ title: 'Download', key: 'COCO train!', progress: 52, eta: 1760000000123 })
    expect(d.kind).toBe('progress')
    expect(d.key).toBe('coco-train')
    expect(d.progress).toBe(0.52)
    expect(d.eta).toBe(1760000000)
    expect(drop({ text: 'x' }).kind).toBe('done')
    expect(drop({ title: 't', fields: [{ name: 'mAP', value: 43 }] }).fields).toEqual([{ name: 'mAP', value: '43', inline: true }])
  })
})

describe('the rule', () => {
  test('present: nothing goes unless asked; away: everything pings, progress quietly', () => {
    expect(routeFor('result', false, false)).toBe('hold')
    expect(routeFor('urgent', false, false)).toBe('hold')
    expect(routeFor('result', true, false)).toBe('ping')
    expect(routeFor('result', false, true)).toBe('ping')
    expect(routeFor('needs-you', false, true)).toBe('ping')
    expect(routeFor('progress', false, true)).toBe('silent')
    expect(routeFor('progress', true, false)).toBe('silent')
  })

  test('away after the threshold, or before any message', () => {
    expect(isAway(null, NOW, 30)).toBe(true)
    expect(isAway(NOW - 29 * MIN, NOW, 30)).toBe(false)
    expect(isAway(NOW - 30 * MIN, NOW, 30)).toBe(true)
  })

  test('presence keeps a week of sessions and reads the newest', () => {
    const p = presenceWith({ sessions: { old: { lastUserAt: NOW - 8 * 24 * 60 * MIN, host: 'a' }, b: { lastUserAt: NOW - MIN, host: 'b' } } }, 'c', NOW, 'c0629')
    expect(Object.keys(p.sessions).sort()).toEqual(['b', 'c'])
    expect(latestUserAt(p)).toBe(NOW)
    expect(latestUserAt(null)).toBe(null)
  })

  test('durations read short', () => {
    expect(fmtDur(45)).toBe('45 s')
    expect(fmtDur(12 * 60)).toBe('12 min')
    expect(fmtDur(2 * 3600 + 5 * 60)).toBe('2 h 05 min')
    expect(fmtDur(3 * 86400 + 4 * 3600)).toBe('3 d 4 h')
  })

  test('the purge is the first Tuesday of the month', () => {
    // Thursday 15 October 2026: the October purge (the 6th) is past, November's is the 3rd
    expect(nextPurge(NOW, -240)).toEqual({ year: 2026, month: 11, day: 3, daysLeft: 19 })
    expect(nextPurge(Date.parse('2026-11-03T14:00:00Z'), -300)).toEqual({ year: 2026, month: 11, day: 3, daysLeft: 0 })
    // a December purge rolls into January
    expect(nextPurge(Date.parse('2026-12-20T12:00:00Z'), -300)).toEqual({ year: 2027, month: 1, day: 5, daysLeft: 16 })
  })
})

describe('the card', () => {
  const ctx = { host: 'c0629', project: 'detr', now: NOW, lang: 'es' as const }

  test('a colour and an icon per kind, the image inside the card', () => {
    const d = drop({ kind: 'result', title: 'Eval COCO', text: 'mAP 43.0', image: '/r/pr curve.png', files: ['/r/pr curve.png', '/r/t.md'] })
    const a = attachments(d)
    expect(a.image?.name).toBe('pr_curve.png')
    expect(a.files.map(f => f.name)).toEqual(['2_pr_curve.png', 't.md'])
    const { embed, isCut } = card(d, { ...ctx, image: a.image })
    expect(embed.color).toBe(COLOR.result)
    expect(embed.title).toBe('✅ Eval COCO')
    expect(embed.image?.url).toBe('attachment://pr_curve.png')
    expect(embed.author?.name).toBe('Claude · detr')
    expect(embed.footer.text).toBe('discord-drop · c0629')
    expect(isCut).toBe(false)
  })

  test('a progress card shows its bar and a relative ETA', () => {
    expect(progressBar(0.5, 10)).toBe('▰▰▰▰▰▱▱▱▱▱ 50%')
    const { embed } = card(drop({ kind: 'progress', key: 'dl', title: 'COCO', progress: 0.25, eta: 1760003600 }), { ...ctx, image: null })
    expect(embed.description).toContain('25%')
    expect(embed.description).toContain('<t:1760003600:R>')
  })

  test('a long text is cut under the limits and flagged for attaching', () => {
    const { embed, isCut } = card(drop({ title: 't', text: 'x'.repeat(9000), fields: [{ name: 'a', value: 'y'.repeat(2000) }] }), { ...ctx, image: null })
    expect(isCut).toBe(true)
    expect(embed.fields?.[0]?.value.length).toBe(1024)
    const total = embed.title.length + (embed.description?.length ?? 0) + embed.footer.text.length + (embed.author?.name.length ?? 0) + 1025
    expect(total).toBeLessThan(6000)
  })

  test('the URL only ever goes to curl on stdin', () => {
    const json = payload(card(drop({ title: 't' }), { ...ctx, image: null }).embed, [{ path: '/r/a.png', name: 'a.png' }], true)
    expect(JSON.parse(json).flags).toBe(SILENT)
    const argv = postArgv(json, [{ path: '/r/a.png', name: 'a.png' }])
    expect(argv.join(' ')).not.toContain('very-secret-token')
    expect(argv).toContain('-K')
    expect(argv).toContain('files[0]=@"/r/a.png";filename="a.png"')
    expect(curlConfig(SECRET)).toBe(`url = "${SECRET}"\n`)
    expect(parseCurl('{"id":"9"}\n200')).toEqual({ status: 200, body: { id: '9' } })
    expect(parseCurl('\n429').status).toBe(429)
  })
})

const JOB: PaceJob = {
  id: '2001', jobId: '2001', name: 't4-train', state: 'COMPLETED', elapsedS: 7 * 3600, nodes: 1, gpus: 4, gpuType: 'H200',
  submittedAt: NOW - 9 * 3600_000, startedAt: NOW - 7 * 3600_000, workDir: '/w', stdout: '/w/runs/slurm-2001.out', exitCode: '0:0',
  lastLines: ['epoch 3 done', 'Traceback (most recent call last):', 'RuntimeError: CUDA out of memory'],
  metrics: {
    keys: { loss: { step: [0, 100, 200, 300], value: [2, 1.2, 0.8, 0.6] }, val_loss: { step: [100, 300], value: [1.1, 0.7] }, val_map: { step: [100, 300], value: [0.31, 0.43] } },
    lastStep: 300, totalSteps: 300, epoch: 3, totalEpochs: 3,
  },
  ckpt: { name: 'epoch=3-step=300.pt', path: '/w/runs/2001/checkpoints/epoch=3-step=300.pt' },
}

describe('pace-line alerts', () => {
  test('a completed job is a result with its numbers and its chart', () => {
    const d = alertDrop({ job: '2001', kind: 'ended', level: 'info', text: '✓ t4-train (2001) completed after 7 h', at: NOW }, JOB, 'es', '/c.png')
    expect(d.kind).toBe('result')
    expect(d.title).toBe('t4-train terminó')
    expect(d.image).toBe('/c.png')
    const names = d.fields.map(f => f.name)
    expect(names).toEqual(expect.arrayContaining(['Duración', 'GPUs', 'Pasos', 'val_map', 'Checkpoint']))
    expect(d.fields.find(f => f.name === 'val_map')?.value).toBe('0.43')
    expect(d.fields.find(f => f.name === 'val_loss')?.value).toBe('0.7')
  })

  test('a failure is urgent with the end of its log', () => {
    const d = alertDrop({ job: '2001', kind: 'oom', level: 'error', text: '✗ t4-train (2001) ran out of memory', at: NOW }, { ...JOB, state: 'RUNNING' }, 'en', null)
    expect(d.kind).toBe('urgent')
    expect(d.title).toBe('t4-train out of memory')
    expect(d.text).toContain('RuntimeError: CUDA out of memory')
  })

  test('a start after a long queue says how long it waited', () => {
    const d = alertDrop({ job: '2001', kind: 'started', level: 'info', text: '▶ t4-train started', at: NOW }, { ...JOB, state: 'RUNNING' }, 'es', null)
    expect(d.kind).toBe('started')
    expect(d.fields.find(f => f.name === 'En cola')?.value).toBe('2 h 00 min')
  })

  test('the loss chart is flat SVG librsvg can draw', () => {
    const svg = lossChart(JOB)
    expect(svg).toContain('<svg')
    expect(svg).not.toContain('var(')
    expect(svg).toContain('best 0.7')
    expect(chartSvg({ series: [] })).toBe(null)
  })
})

// ── Engine: the mod against a mocked Discord ──────────────────────────

type World = { curl: { argv: string[]; stdin: string }[]; files: Record<string, string>; contexts: (readonly string[] | undefined)[]; asked: string[]; squeue: Record<string, string> }

function world(on: On, env: Record<string, string> = {}): World {
  const w: World = { curl: [], files: {}, contexts: [], asked: [], squeue: {} }
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  mock.store(on)
  mock.env(on, { HOME: '/home/demo', USER: 'demo', SLURMD_NODENAME: 'c0629', DISCORD_WEBHOOK_URL: SECRET, ...env })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    const a = e.argv
    if (a[0] === 'curl') {
      w.curl.push({ argv: [...a], stdin: e.init?.stdin ?? '' })
      return ok(`{"id":"m${w.curl.length}"}\n200`)
    }
    if (a[0] === 'date') return ok('-0400\n')
    if (a[0] === 'squeue') return ok(w.squeue[a[a.indexOf('-j') + 1]!] ?? '')
    if (a[0] === 'rsvg-convert') w.files[a[a.indexOf('-o') + 1]!] = 'png'
    if (a[0] === 'rm') delete w.files[a[a.length - 1]!]
    return ok('')
  })
  on('fs.read', (_$, e) => (e.path in w.files ? { value: w.files[e.path]! } : { deny: 'missing' }))
  on('fs.write', (_$, e) => {
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: e.path in w.files }))
  on('fs.list', (_$, e) => {
    const names = Object.keys(w.files).filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
    return names.length ? { value: names.map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })) } : { deny: 'missing' }
  })
  on('fs.stat', (_$, e) => (e.path in w.files ? { value: { kind: 'file' as const, size: w.files[e.path]!.length, mtimeMs: NOW, isLink: false } } : { deny: 'missing' }))
  on('prompt.submit', (_$, e) => {
    w.contexts.push(e.context)
    if (e.origin.kind === 'plugin') w.asked.push(e.text)
    return { text: e.text }
  })
  on('classic.Stop', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  return w
}

const begin = async ($: Engine) => $.session.start({ cwd: '/w/detr', surface: 'terminal', isInteractive: true })
const say = ($: Engine, kind: 'composer' | 'task-notification' = 'composer') => $.prompt.submit({ text: 'hola', origin: { kind }, wait: false })
const dropCall = ($: Engine, op: Record<string, unknown>) => $.tool.call({ tool: 'Bash', command: `: drop <<'EOF'\n${JSON.stringify(op)}\nEOF` })
const out = (r: unknown) => JSON.stringify(r)
const posted = (w: World) => w.curl.filter(c => !c.argv.includes('DELETE')).map(c => {
  const form = c.argv.find(x => x.startsWith('payload_json='))
  const data = c.argv[c.argv.indexOf('--data-raw') + 1]
  return { method: c.argv.includes('PATCH') ? 'PATCH' : 'POST', body: JSON.parse(form ? form.slice('payload_json='.length) : data!) as Record<string, unknown>, stdin: c.stdin }
})

test('while the user is here a drop is held; past 30 min it goes, and the URL stays on stdin', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await begin($)
  await say($)
  const r1 = await dropCall($, { kind: 'result', title: 'Eval', text: 'mAP 43.0' })
  expect(out(r1)).toContain('held')
  expect(w.curl).toHaveLength(0)

  await clock.advance(31 * MIN)
  const r2 = await dropCall($, { kind: 'result', title: 'Eval', text: 'mAP 43.0' })
  expect(out(r2)).toContain('drop: sent')
  expect(out(r2)).not.toContain('very-secret-token')
  const [p] = posted(w)
  expect(p?.stdin).toBe(`url = "${SECRET}?wait=true"\n`)
  expect(w.curl[0]!.argv.join(' ')).not.toContain('very-secret-token')
  expect((p?.body.embeds as { title: string }[])[0]?.title).toBe('✅ Eval')
  // the webhook is saved for jobs on other nodes, through the shell, never in an argv
  expect(w.files['/home/demo/.claude/discord-drop/config.json']).toContain('"awayMinutes":30')
  expect(w.files['/home/demo/.claude/discord-drop/presence.json']).toContain('"sess-1"')
})

test('force sends while the user is here; a notification turn does not count as the user', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await begin($)
  await say($)
  expect(out(await dropCall($, { title: 'Te aviso', force: true }))).toContain('drop: sent')
  await clock.advance(31 * MIN)
  await say($, 'task-notification')
  expect(out(await dropCall($, { title: 'Descarga lista' }))).toContain('drop: sent')
  expect(w.curl).toHaveLength(2)
})

test('the rules ride the first prompt only', async ($, on) => {
  mock.clock(on, { now: NOW })
  const w = world(on)
  const seen = w.contexts
  await begin($)
  await say($)
  await say($)
  expect(seen[0]?.some(c => c.includes('# Discord cards (discord-drop)'))).toBe(true)
  expect(seen[1]?.some(c => c.includes('discord-drop')) ?? false).toBe(false)
})

test('a progress card is created silently, edited in place, and its end announced', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await begin($)
  await say($)
  // here: not even created
  expect(out(await dropCall($, { kind: 'progress', key: 'coco', title: 'COCO', progress: 0.1 }))).toContain('held')
  await clock.advance(31 * MIN)
  expect(out(await dropCall($, { kind: 'progress', key: 'coco', title: 'COCO', progress: 0.4 }))).toContain('created (silent)')
  expect(out(await dropCall($, { kind: 'progress', key: 'coco', title: 'COCO', progress: 0.8 }))).toContain('progress updated')
  expect(out(await dropCall($, { kind: 'progress', key: 'coco', title: 'COCO lista', final: true }))).toContain('announced')
  const p = posted(w)
  expect(p.map(x => x.method)).toEqual(['POST', 'PATCH', 'PATCH', 'POST'])
  expect(p[0]?.body.flags).toBe(SILENT)
  expect(p[1]?.stdin).toBe(`url = "${SECRET.replace('?wait=true', '')}/messages/m1"\n`)
  expect(p[3]?.body.flags).toBe(undefined)
})

test('the safety net sends one card when a long stretch ends unannounced', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await begin($)
  await say($)
  // a short turn: they're still here
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Listo.', background_tasks: [] })
  expect(w.curl).toHaveLength(0)
  await clock.advance(40 * MIN)
  // background work still running: not done yet
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Descargando…', background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'wget' } as never] })
  expect(w.curl).toHaveLength(0)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'He terminado el refactor y abierto la PR.', background_tasks: [] })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Otra cosa.', background_tasks: [] })
  expect(w.curl).toHaveLength(1)
  const [p] = posted(w)
  const embed = (p?.body.embeds as { title: string; description: string; color: number }[])[0]!
  expect(embed.title).toBe('✔️ He terminado')
  expect(embed.description).toContain('abierto la PR')
})

test('no safety net for a turn another plugin started', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await begin($)
  await say($)
  await clock.advance(40 * MIN)
  await $.prompt.submit({ text: '[pace-line: batch-job alerts]', origin: { kind: 'unclassified' }, wait: false })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'The OOM is in the eval loop.', background_tasks: [] })
  expect(w.curl).toHaveLength(0)
})

test('no safety net when Claude already sent the card', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await begin($)
  await say($)
  await clock.advance(40 * MIN)
  await dropCall($, { kind: 'result', title: 'Eval' })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Done.', background_tasks: [] })
  expect(w.curl).toHaveLength(1)
})

test('a question left unanswered for 5 min reaches Discord; one answered in time does not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  let answerAfter = 6 * MIN
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    await clock.sleep(answerAfter)
    return { result: { questions: e.questions, answers: {} } }
  })
  await begin($)
  await say($)
  const questions = [{ question: '¿Lanzo la ablación?', header: 'Ablación', multiSelect: false, options: [{ label: 'Sí', description: 'ahora' }, { label: 'No', description: 'espera' }] }]
  const first = $.tool.call({ tool: 'AskUserQuestion', questions } as never)
  await clock.advance(6 * MIN)
  await first
  expect(w.curl).toHaveLength(1)
  const embed = (posted(w)[0]?.body.embeds as { title: string; description: string; color: number }[])[0]!
  expect(embed.title).toBe('⏸️ Necesito una respuesta')
  expect(embed.description).toContain('1. **Sí**')

  answerAfter = 2 * MIN
  const second = $.tool.call({ tool: 'AskUserQuestion', questions } as never)
  await clock.advance(10 * MIN)
  await second
  expect(w.curl).toHaveLength(1)
})

test('a permission prompt left 5 min goes out with the command', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  await begin($)
  await say($)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push origin discord-drop' } })
  await clock.advance(5 * MIN + 1000)
  const embed = (posted(w)[0]?.body.embeds as { title: string; description: string }[])[0]!
  expect(embed.title).toBe('⏸️ Necesito tu permiso')
  expect(embed.description).toContain('git push origin discord-drop')
})

test('pace-line alerts become cards only when nobody is here, with the chart, once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  let alerts = [] as { job: string; kind: string; level: string; text: string; at: number }[]
  on('state.get', (_$, e) => (e.plugin === 'pace-line' && e.key === 'jobs' ? { value: { value: { jobs: [JOB], alerts }, version: 1 } } : { value: { value: undefined, version: 0 } }))
  await begin($)
  await say($)
  alerts = [{ job: '2001', kind: 'oom', level: 'error', text: 'oom', at: NOW + 1000 }]
  await clock.advance(16_000)
  expect(w.curl).toHaveLength(0)

  await clock.advance(31 * MIN)
  alerts = [...alerts, { job: '2001', kind: 'ended', level: 'info', text: '✓ t4-train completed', at: NOW + 31 * MIN }]
  await clock.advance(16_000)
  await clock.advance(16_000)
  expect(w.curl).toHaveLength(1)
  const p = w.curl[0]!
  expect(p.argv.some(a => a.startsWith('files[0]=@"/home/demo/.claude/discord-drop/out/2001-loss.png"'))).toBe(true)
  expect(w.files['/home/demo/.claude/discord-drop/out/2001-loss.svg']).toContain('<svg')
})

test('a job that reported itself is not repeated', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  w.files['/w/runs/2001/notified.json'] = '{}'
  on('state.get', () => ({ value: { value: { jobs: [JOB], alerts: [{ job: '2001', kind: 'ended', level: 'info', text: 'done', at: NOW + 1 }] }, version: 1 } }))
  await begin($)
  await clock.advance(16_000)
  expect(w.curl).toHaveLength(0)
})

describe('dev-relay', () => {
  test('armed while a successor is lined up and the supervisor writes', () => {
    const at = NOW / 1000
    expect(relayArmed({ phase: 'ready', updatedAt: at - 60 }, NOW)).toBe(true)
    expect(relayArmed({ phase: 'queued', updatedAt: at }, NOW)).toBe(true)
    expect(relayArmed({ phase: 'running', updatedAt: at }, NOW)).toBe(false)
    expect(relayArmed({ phase: 'off', updatedAt: at }, NOW)).toBe(false)
    expect(relayArmed({ phase: 'ready', updatedAt: at - 11 * 60 }, NOW)).toBe(false)
    expect(relayArmed({ phase: 'queued', updatedAt: at - 20 * 3600, adopted: true }, NOW)).toBe(true)
    expect(relayArmed(null, NOW)).toBe(false)
  })

  test('an adopted job names its successor for squeue', () => {
    expect(adoptedSuccessor({ adopted: true, successor: { job: '11445297' } })).toBe('11445297')
    expect(adoptedSuccessor({ successor: { job: '11445297' } })).toBeNull()
    expect(adoptedSuccessor({ adopted: true, successor: null })).toBeNull()
    expect(successorAlive('PENDING\n')).toBe(true)
    expect(successorAlive('RUNNING')).toBe(true)
    expect(successorAlive('CANCELLED')).toBe(false)
    expect(successorAlive('')).toBe(false)
  })
})

const ENDING = { SLURM_JOB_ID: '100', SLURM_JOB_END_TIME: String(NOW / 1000 + 20 * 60) }

test('a relayed allocation is not handed off; an ordinary one is', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, ENDING)
  w.files['/home/demo/.local/state/dev-relay/jobs/100.json'] = JSON.stringify({ phase: 'ready', updatedAt: NOW / 1000 + 3600 })
  await begin($)
  await clock.advance(2 * MIN)
  expect(w.asked.filter(t => t.includes('this allocation'))).toHaveLength(0)

  w.files['/home/demo/.local/state/dev-relay/jobs/100.json'] = JSON.stringify({ phase: 'off', updatedAt: NOW / 1000 + 3600 })
  await clock.advance(2 * MIN)
  expect(w.asked.filter(t => t.includes('this allocation (Slurm job 100)'))).toHaveLength(1)
})

test('an adopted relay holds the hand-off while squeue still has the successor', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, ENDING)
  // adopted: nobody rewrites the file, so its age says nothing
  w.files['/home/demo/.local/state/dev-relay/jobs/100.json'] = JSON.stringify({ phase: 'queued', adopted: true, updatedAt: NOW / 1000 - 20 * 3600, successor: { job: '501' } })
  w.squeue['501'] = 'PENDING\n'
  await begin($)
  await clock.advance(2 * MIN)
  expect(w.asked.filter(t => t.includes('this allocation'))).toHaveLength(0)

  delete w.squeue['501'] // cancelled before it ever ran
  await clock.advance(2 * MIN)
  expect(w.asked.filter(t => t.includes('this allocation (Slurm job 100)'))).toHaveLength(1)
})

// ── progress cards for this session's jobs ──

const run = (id: string, name: string, over: Partial<PaceJob> = {}): PaceJob => ({
  ...JOB, id, jobId: id, name, state: 'RUNNING', elapsedS: 600, submittedAt: NOW, startedAt: NOW, exitCode: null, lastLines: [], ckpt: null, endedAt: null, owner: 'mine', ownerAgent: null,
  metrics: { keys: { loss: { step: [0, 100], value: [2, 1] } }, lastStep: 100, totalSteps: 400, epoch: null, totalEpochs: null, firstStep: 0, firstTime: NOW / 1000 - 600, lastTime: NOW / 1000 },
  ...over,
})

describe('job cards', () => {
  let n = 0
  const key = () => `k${n++}`

  test('jobs one Claude launches together share a card; a later launch opens another, a subagent keeps its own', () => {
    let cards: JobCard[] = refresh([], [run('3001', 'sweep-lr1e-4'), run('3002', 'sweep-lr3e-4', { submittedAt: NOW + 2 * MIN })], 'es', NOW + 3 * MIN, key)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.rows.map(r => r.id)).toEqual(['3001', '3002'])
    cards = refresh(cards, [run('3003', 'eval', { submittedAt: NOW + 40 * MIN }), run('3004', 'chain-a', { ownerAgent: 'r1', submittedAt: NOW + 41 * MIN })], 'es', NOW + 42 * MIN, key)
    expect(cards.map(c => c.rows.map(r => r.id))).toEqual([['3001', '3002'], ['3003'], ['3004']])
    // the subagent's next job, an hour on, joins its card
    cards = refresh(cards, [run('3005', 'chain-b', { ownerAgent: 'r1', submittedAt: NOW + 100 * MIN })], 'es', NOW + 101 * MIN, key)
    expect(cards[2]!.rows.map(r => r.id)).toEqual(['3004', '3005'])
  })

  test('a card shows a line per job, the shared progress and ETA, and waits for the results', () => {
    const cards = refresh([], [run('3001', 'sweep-lr1e-4'), run('3002', 'sweep-lr3e-4', { state: 'PENDING', metrics: null })], 'es', NOW, () => 'k')
    const d = cardDrop(cards[0]!, 'es', NOW)
    expect(d.title).toBe('sweep · 2 jobs')
    expect(d.text).toContain('**1 corriendo · 1 en cola')
    expect(d.text).toContain('▶ `lr1e-4` paso 100/400 · loss')
    expect(d.text).toContain('⏸ `lr3e-4` en cola')
    expect(d.progress).toBe(0.125)
    // 30 min left on the running one, then the queued one at its pace (40 min a job)
    expect(d.eta).toBe(Math.round(NOW / 1000 + 1800 + 2400))
    const done = refresh(cards, [run('3001', 'sweep-lr1e-4', { state: 'COMPLETED', endedAt: NOW }), run('3002', 'sweep-lr3e-4', { state: 'FAILED', endedAt: NOW })], 'es', NOW, () => 'k')
    const e = cardDrop(done[0]!, 'es', NOW)
    expect(e.text).toContain('✓ `lr1e-4` terminó')
    expect(e.text).toContain('✗ `lr3e-4` falló')
    expect(e.text).toContain('resultados que pediste llegarán aquí')
    expect(e.progress).toBe(1)
    expect(commonPrefix(['a', 'b'])).toBe('')
  })

  test('a log-only job shows its it k/N, loss and speed; the total ETA comes from the jobs that ended', () => {
    const logJob = (id: string, name: string, over: Partial<PaceJob>) => run(id, name, { metrics: null, progress: { k: 300, n: 2000 }, logLoss: { key: 'train_loss', value: 3.97 }, secPerIt: 3.6, elapsedS: 1200, ...over })
    const jobs = [
      logJob('5001', 'p3t-tempo-pinwheels-a2', { state: 'COMPLETED', endedAt: NOW, elapsedS: 3120 }),
      logJob('5002', 'p3t-tempo-pinwheels-a5', { elapsedS: 2820 }),
      logJob('5003', 'p3t-tempo-pinwheels-ak', {}),
      logJob('5004', 'p3t-tempo-tea-a2', { state: 'PENDING', progress: null, logLoss: null, secPerIt: null, elapsedS: 0 }),
      logJob('5005', 'p3t-tempo-tea-a3', { state: 'PENDING', progress: null, logLoss: null, secPerIt: null, elapsedS: 0 }),
      logJob('5006', 'p3t-tempo-tea-ak', { state: 'PENDING', progress: null, logLoss: null, secPerIt: null, elapsedS: 0 }),
    ]
    const c = refresh([], jobs, 'es', NOW, () => 'k')[0]!
    const d = cardDrop(c, 'es', NOW)
    expect(d.text).toContain('**2 corriendo · 3 en cola · 1 terminado · ~52 min/job**')
    expect(d.text).toContain('▶ `pinwheels-ak` it 300/2000 · train_loss 3.97 · 3.6 s/it · 20 min')
    // ak has 32 min left by the ones that ended (52 − 20), its own count says 1.7 h: the longer; then 3 queued, 2 at a time
    expect(d.eta).toBe(Math.round(NOW / 1000 + 1700 * 3.6 + 2 * 3120))
    expect(d.text).toContain('ETA total estimada con 52 min por job y 2 a la vez')
  })

  test('Claude\'s title and description head the card, even when sent before it existed', () => {
    const notes = { '6001': { title: 'Grid 3T (usuarios de tempo)', about: '210 runs: 3 variantes × 14 sujetos × 5 semillas', at: NOW } }
    const c = refresh([], [run('6001', 'p3t-a'), run('6002', 'p3t-b')], 'es', NOW, () => 'k', notes)[0]!
    const d = cardDrop(c, 'es', NOW)
    expect(d.title).toBe('Grid 3T (usuarios de tempo)')
    expect(d.text.startsWith('210 runs: 3 variantes × 14 sujetos × 5 semillas\n**2 corriendo')).toBe(true)
  })

  test('a job that ended long before any card is left alone', () => {
    expect(refresh([], [run('2999', 'old', { state: 'COMPLETED', endedAt: NOW - 3600_000 })], 'es', NOW, () => 'k')).toEqual([])
  })
})

function paceState(on: On, get: () => PaceJob[]) {
  on('state.get', (_$, e) => (e.plugin === 'pace-line' && e.key === 'jobs' ? { value: { value: { jobs: get(), alerts: [] }, version: 1 } } : { value: { value: undefined, version: 0 } }))
}

test('a launch gets one silent progress card, edited as it runs, even while the user is here', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  let jobs = [run('3001', 'sweep-lr1e-4'), run('3002', 'sweep-lr3e-4')]
  paceState(on, () => jobs)
  await begin($)
  await say($)
  await clock.advance(16_000)
  let p = posted(w)
  expect(p.map(x => x.method)).toEqual(['POST'])
  expect(p[0]!.body.flags).toBe(SILENT)
  // a new step: edited, but at most once a minute
  jobs = [run('3001', 'sweep-lr1e-4', { metrics: { ...jobs[0]!.metrics!, lastStep: 200 } }), jobs[1]!]
  await clock.advance(16_000)
  expect(posted(w)).toHaveLength(1)
  await clock.advance(60_000)
  p = posted(w)
  expect(p.map(x => x.method)).toEqual(['POST', 'PATCH'])
  expect(p[1]!.stdin).toContain('/messages/m1')
  // an end shows at once
  jobs = [run('3001', 'sweep-lr1e-4', { state: 'COMPLETED', endedAt: NOW + 2 * MIN }), jobs[1]!]
  await clock.advance(16_000)
  expect(posted(w).map(x => x.method)).toEqual(['POST', 'PATCH', 'PATCH'])
  // another session's job, or nobody's: no card
  jobs = [...jobs, run('4001', 'other', { owner: 'other' })]
  await clock.advance(76_000)
  expect(posted(w).filter(x => x.method === 'POST')).toHaveLength(1)
})

test('the results sent with "card" replace the progress card: silent while here, notifying when away', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  const jobs = [run('3001', 'sweep-lr1e-4', { state: 'COMPLETED', endedAt: NOW })]
  paceState(on, () => jobs)
  await begin($)
  await say($)
  await clock.advance(16_000)
  expect(out(await dropCall($, { card: '3001', kind: 'result', title: 'Sweep lr', text: 'best lr 3e-4: Acc 87.3', fields: [{ name: 'lr 3e-4', value: '87.3' }] }))).toContain('replaced')
  const p = posted(w)
  expect(p.map(x => x.method)).toEqual(['POST', 'POST'])
  expect(p[1]!.body.flags).toBe(SILENT)
  expect((p[1]!.body.embeds as { title: string }[])[0]!.title).toContain('Sweep lr')
  expect(w.curl[2]!.argv).toContain('DELETE')
  expect(w.curl[2]!.stdin).toContain('/messages/m1')
  // no longer edited
  await clock.advance(120_000)
  expect(w.curl).toHaveLength(3)
})

test('away, the results notify; a job with no card sends its drop as usual', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  paceState(on, () => [run('3001', 'train', { state: 'COMPLETED', endedAt: NOW })])
  await begin($)
  await say($)
  await clock.advance(31 * MIN)
  expect(out(await dropCall($, { card: '3001', kind: 'result', title: 'Train', text: 'Acc 90' }))).toContain('with a notification')
  expect(posted(w).at(-1)!.body.flags).toBe(undefined)
  expect(out(await dropCall($, { card: '9999', kind: 'result', title: 'Other', text: 'x' }))).not.toContain('replaced')
})

test('a resumed subagent\'s card file in the outbox is sent and removed; another session\'s is left', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  paceState(on, () => [run('3001', 'chain-a', { ownerAgent: 'r1', state: 'COMPLETED', endedAt: NOW })])
  await begin($)
  await say($)
  w.files['/home/demo/.claude/discord-drop/outbox/r1-1.json'] = JSON.stringify({ card: '3001', kind: 'result', title: 'Chain', text: '11 + 77 = 88' })
  w.files['/home/demo/.claude/discord-drop/outbox/zz-1.json'] = JSON.stringify({ kind: 'done', title: 'not mine' })
  await clock.advance(16_000)
  await clock.advance(16_000)
  expect('/home/demo/.claude/discord-drop/outbox/r1-1.json' in w.files).toBe(false)
  expect('/home/demo/.claude/discord-drop/outbox/zz-1.json' in w.files).toBe(true)
  expect(posted(w).some(x => JSON.stringify(x.body).includes('11 + 77 = 88'))).toBe(true)
})

test('a pace-line alert about carded jobs tells Claude where their results go', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  paceState(on, () => [run('3001', 'train', { state: 'COMPLETED', endedAt: NOW })])
  await begin($)
  await say($)
  await clock.advance(16_000)
  await $.prompt.submit({ text: '[pace-line: batch-job alerts, from the job watcher, not typed by the user]\n✓ train (3001) completed after 2h', origin: { kind: 'plugin' }, wait: false } as never)
  expect(w.contexts.at(-1)?.some(c => c.includes('"card": "3001"'))).toBe(true)
})

test('an alert that comes before the card\'s next refresh still sees its jobs ended', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  let jobs = [run('3001', 'train')]
  paceState(on, () => jobs)
  await begin($)
  await say($)
  await clock.advance(16_000)
  jobs = [run('3001', 'train', { state: 'COMPLETED', endedAt: NOW + 16_000 })]
  await $.prompt.submit({ text: '[pace-line: batch-job alerts, from the job watcher, not typed by the user]\n✓ train (3001) completed after 2h', origin: { kind: 'plugin' }, wait: false } as never)
  expect(w.contexts.at(-1)?.some(c => c.includes('every job') && c.includes('"card": "3001"'))).toBe(true)
})

test('a progress drop with "card" names and describes the card, before or after it appears', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  let jobs: PaceJob[] = []
  paceState(on, () => jobs)
  await begin($)
  await say($)
  // sent right after sbatch, before pace-line lists the job
  expect(out(await dropCall($, { card: '7001', kind: 'progress', title: 'Grid 3T', text: '210 runs' }))).toContain('noted')
  jobs = [run('7001', 'p3t-a')]
  await clock.advance(16_000)
  const first = posted(w)[0]!.body.embeds as { title: string; description: string }[]
  expect(first[0]!.title).toContain('Grid 3T')
  expect(first[0]!.description).toContain('210 runs')
  // a new description: edited at the next pass, without waiting the minute
  expect(out(await dropCall($, { card: '7001', kind: 'progress', text: '210 runs; tea y quesadilla esperan cola' }))).toContain('keep updating')
  await clock.advance(16_000)
  const p = posted(w)
  expect(p.map(x => x.method)).toEqual(['POST', 'PATCH'])
  expect(JSON.stringify(p[1]!.body)).toContain('esperan cola')
})
