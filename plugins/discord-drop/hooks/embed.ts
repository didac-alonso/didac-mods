// The card: a Discord embed with one colour and icon per kind, and the curl
// calls that post or edit it. Pure: a Drop in, the payload and argv out.
// The webhook URL never enters an argv: curl reads it from stdin (`-K -`).

import { cut, fmtDur } from './drop'
import type { Drop, Field, Kind } from './drop'

export const COLOR: Record<Kind, number> = {
  result: 0x2ecc71,
  urgent: 0xe74c3c,
  'needs-you': 0xf1c40f,
  progress: 0x3498db,
  started: 0x9b59b6,
  done: 0x5865f2,
}

export const ICON: Record<Kind, string> = {
  result: '✅',
  urgent: '🛑',
  'needs-you': '⏸️',
  progress: '⏳',
  started: '▶️',
  done: '✔️',
}

/** Discord's limits for one embed. */
const LIMIT = { title: 256, description: 4096, fields: 25, name: 256, value: 1024, footer: 2048, author: 256, total: 6000 }
/** SUPPRESS_NOTIFICATIONS: the message lands without a push or a sound. */
export const SILENT = 1 << 12

export type Lang = 'es' | 'en'
export const STRINGS = {
  es: {
    finished: 'He terminado',
    question: 'Tengo una pregunta',
    took: 'Duración',
    since: 'Desde tu último mensaje',
    needsPermission: 'Necesito tu permiso',
    needsAnswer: 'Necesito una respuesta',
    planReady: 'Plan listo para revisar',
    answerInTerminal: 'Responde en la terminal.',
    waiting: 'Esperando',
    sessionEnds: (m: string) => `Mi sesión se cierra en ${m}`,
    sessionEndsText: 'El dev-shell llega a su límite de tiempo. Lo último que hice:',
    purgeTitle: (d: string) => `Purga de /scratch el martes ${d}`,
    purgeText: 'La política de Research Computing borra /scratch el primer martes de cada mes. Mueve a /projects lo que no puedas volver a descargar.',
    test: 'Prueba de discord-drop',
    testText: 'Si ves esta tarjeta, el webhook funciona.',
    eta: 'ETA',
    full: 'Texto completo adjunto.',
  },
  en: {
    finished: 'Finished',
    question: 'I have a question',
    took: 'Took',
    since: 'Since your last message',
    needsPermission: 'I need your permission',
    needsAnswer: 'I need an answer',
    planReady: 'Plan ready for review',
    answerInTerminal: 'Answer in the terminal.',
    waiting: 'Waiting',
    sessionEnds: (m: string) => `My session ends in ${m}`,
    sessionEndsText: 'The dev-shell reaches its time limit. The last thing I did:',
    purgeTitle: (d: string) => `/scratch purge on Tuesday ${d}`,
    purgeText: "Research Computing's policy purges /scratch on the first Tuesday of each month. Move to /projects what you can't download again.",
    test: 'discord-drop test',
    testText: 'If you see this card, the webhook works.',
    eta: 'ETA',
    full: 'Full text attached.',
  },
} as const
export type Strings = (typeof STRINGS)[Lang]

export type Attachment = { path: string; name: string }

/** Upload names: the basename, safe for `attachment://`, unique within the card. */
export function attachments(drop: Drop, extra: readonly string[] = []): { image: Attachment | null; files: Attachment[] } {
  const used = new Set<string>()
  const name = (path: string) => {
    const base = (path.split('/').pop() || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file'
    let n = base
    for (let i = 2; used.has(n); i++) n = `${i}_${base}`
    used.add(n)
    return n
  }
  const image = drop.image ? { path: drop.image, name: name(drop.image) } : null
  return { image, files: [...drop.files, ...extra].map(p => ({ path: p, name: name(p) })) }
}

/** "▰▰▰▰▰▱▱▱▱▱ 52%" */
export function progressBar(p: number, width = 12): string {
  const n = Math.round(Math.max(0, Math.min(1, p)) * width)
  return `${'▰'.repeat(n)}${'▱'.repeat(width - n)} ${Math.round(p * 100)}%`
}

export type CardContext = {
  host: string
  project: string | null
  now: number
  lang: Lang
  image: Attachment | null
}

export type Embed = {
  color: number
  title: string
  url?: string
  description?: string
  fields?: { name: string; value: string; inline: boolean }[]
  author?: { name: string }
  footer: { text: string }
  timestamp: string
  image?: { url: string }
}

/**
 * The embed for a drop, and whether its text had to be cut (the caller then
 * attaches it in full). The total stays under Discord's 6000 characters.
 */
export function card(drop: Drop, ctx: CardContext): { embed: Embed; isCut: boolean } {
  const s = STRINGS[ctx.lang]
  const head: string[] = []
  if (drop.kind === 'progress' && drop.progress !== null) head.push(progressBar(drop.final ? 1 : drop.progress))
  if (drop.eta !== null && !drop.final) head.push(`${s.eta} <t:${Math.round(drop.eta)}:R>`)
  const title = cut(`${ICON[drop.kind]} ${drop.title || cut(drop.text.split('\n')[0] ?? '', 80)}`, LIMIT.title)
  const author = cut(drop.author ?? (ctx.project ? `Claude · ${ctx.project}` : 'Claude'), LIMIT.author)
  const footer = cut(drop.footer ? `${drop.footer} · ${ctx.host}` : `discord-drop · ${ctx.host}`, LIMIT.footer)
  const fields: Field[] = drop.fields.slice(0, LIMIT.fields).map(f => ({ name: cut(f.name, LIMIT.name), value: cut(f.value, LIMIT.value), inline: f.inline }))
  const fixed = title.length + author.length + footer.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0)
  const room = Math.max(200, Math.min(LIMIT.description, LIMIT.total - fixed - 50))
  const body = [head.join('  ·  '), drop.title ? drop.text : drop.text.split('\n').slice(1).join('\n')].filter(Boolean).join('\n\n')
  const isCut = body.length > room
  const description = isCut ? `${cut(body, room - s.full.length - 6)}\n-# ${s.full}` : body
  const embed: Embed = {
    color: COLOR[drop.kind],
    title,
    ...(drop.url ? { url: drop.url } : {}),
    ...(description ? { description } : {}),
    ...(fields.length ? { fields } : {}),
    author: { name: author },
    footer: { text: footer },
    timestamp: new Date(ctx.now).toISOString(),
    ...(ctx.image ? { image: { url: `attachment://${ctx.image.name}` } } : {}),
  }
  return { embed, isCut }
}

/** The JSON a post carries: the card, its uploads, no pings for @-mentions in the text. */
export function payload(embed: Embed, uploads: readonly Attachment[], isSilent: boolean): string {
  return JSON.stringify({
    embeds: [embed],
    allowed_mentions: { parse: [] },
    ...(isSilent ? { flags: SILENT } : {}),
    ...(uploads.length ? { attachments: uploads.map((u, i) => ({ id: i, filename: u.name })) } : {}),
  })
}

/** Webhook base: the URL without a query or trailing slash. */
export const baseOf = (url: string) => url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')

/** What `curl -K -` reads on stdin: just the URL. */
export const curlConfig = (url: string) => `url = "${url.replace(/["\\]/g, '')}"\n`

/** curl for a new message: multipart, the card in payload_json, each upload as files[i]. */
export function postArgv(json: string, uploads: readonly Attachment[]): string[] {
  return [
    'curl', '-sS', '--max-time', '60', '-K', '-', '-w', '\n%{http_code}',
    '--form-string', `payload_json=${json}`,
    ...uploads.flatMap((u, i) => ['-F', `files[${i}]=@"${u.path}";filename="${u.name}"`]),
  ]
}

/** curl for an edit of a message the webhook sent: the card as JSON, no uploads. */
export function patchArgv(json: string): string[] {
  return ['curl', '-sS', '--max-time', '30', '-K', '-', '-w', '\n%{http_code}', '-X', 'PATCH', '-H', 'Content-Type: application/json', '--data-raw', json]
}

export const postUrl = (base: string) => `${base}?wait=true`
export const messageUrl = (base: string, id: string) => `${base}/messages/${id}`

/** curl's stdout (body, then the status on its own line) as status and parsed body. */
export function parseCurl(stdout: string): { status: number; body: Record<string, unknown> | null } {
  const i = stdout.lastIndexOf('\n')
  const status = Number(stdout.slice(i + 1).trim()) || 0
  const text = stdout.slice(0, Math.max(0, i)).trim()
  try {
    const body = JSON.parse(text) as unknown
    return { status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : null }
  } catch {
    return { status, body: null }
  }
}

/** A short, URL-free reason for a failed call. */
export function failure(status: number, body: Record<string, unknown> | null, stderr: string): string {
  const msg = typeof body?.message === 'string' ? body.message : ''
  const why = status ? `HTTP ${status}${msg ? `: ${msg}` : ''}` : stderr.replace(/https?:\/\/\S+/g, '<url>').trim().slice(0, 200) || 'no answer'
  return `discord-drop: Discord refused the card (${why}).`
}

/** The duration field Claude's own cards carry. */
export const tookField = (s: Strings, seconds: number): Field => ({ name: s.took, value: fmtDur(seconds), inline: true })
