type Owner = {
  user_id: string
  business_id: string
  email: string
  display_name: string
  business_name: string
  slug: string
  whatsapp_phone: string
  timezone: string
}

type Slot = { startsAt: string; endsAt: string; time: string; teamMemberId: string; teamMemberName?: string }
type Interval = { start: string; end: string }
type PushEnv = Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }

const COOKIE_NAME = 'agenda_session'
const SESSION_DAYS = 14
const PENDING_MINUTES = 30
// Cloudflare Workers' Web Crypto implementation rejects PBKDF2 counts above 100,000.
const PASSWORD_ITERATIONS = 100_000

function response(data: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers)
  result.set('Content-Type', 'application/json; charset=utf-8')
  result.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { status, headers: result })
}

function error(message: string, status = 400): Response {
  return response({ error: message }, status)
}

function isoNow(): string {
  return new Date().toISOString()
}

function newId(): string {
  return crypto.randomUUID()
}

function randomHex(bytes = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

async function hkdfExpand(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

async function vapidToken(endpoint: string, env: PushEnv): Promise<string> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) throw new Error('Push keys are not configured')
  const audience = new URL(endpoint).origin
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || 'https://projeto-agendas.wendel-dak.workers.dev',
  })))
  const signingInput = header + '.' + payload
  const privateKey = await crypto.subtle.importKey('pkcs8', fromBase64Url(env.VAPID_PRIVATE_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(signingInput)))
  return signingInput + '.' + base64Url(signature)
}

async function encryptPushPayload(payload: unknown, p256dh: string, auth: string): Promise<Uint8Array> {
  const userPublicKey = fromBase64Url(p256dh)
  const authSecret = fromBase64Url(auth)
  const subscriptionKey = await crypto.subtle.importKey('raw', userPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const serverPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', serverPair.publicKey) as ArrayBuffer)
  const ecdhParams = { name: 'ECDH', public: subscriptionKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0]
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, serverPair.privateKey, 256))
  const keyInfo = joinBytes(new TextEncoder().encode('WebPush: info\0'), userPublicKey, serverPublicKey)
  const inputKeyMaterial = await hkdfExpand(sharedSecret, authSecret, keyInfo, 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const contentKey = await hkdfExpand(inputKeyMaterial, salt, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdfExpand(inputKeyMaterial, salt, new TextEncoder().encode('Content-Encoding: nonce\0'), 12)
  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt'])
  const plaintext = joinBytes(new TextEncoder().encode(JSON.stringify(payload)), new Uint8Array([2]))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext))
  const recordSize = new Uint8Array([0, 0, 16, 0])
  const keyLength = new Uint8Array([serverPublicKey.length])
  return joinBytes(salt, recordSize, keyLength, serverPublicKey, ciphertext)
}

async function sendWebPush(env: PushEnv, subscription: { endpoint: string; p256dh: string; auth: string }, payload: unknown): Promise<boolean> {
  const body = await encryptPushPayload(payload, subscription.p256dh, subscription.auth)
  const token = await vapidToken(subscription.endpoint, env)
  const result = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '60',
    },
    body,
  })
  return result.ok || result.status === 201
}

async function notifyBusinessOfAppointment(env: PushEnv, business: { id: string; timezone: string }, serviceName: string, startsAt: string): Promise<void> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return
  const subscriptions = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE business_id = ?')
    .bind(business.id).all<{ endpoint: string; p256dh: string; auth: string }>()
  const localDate = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: business.timezone }).format(new Date(startsAt))
  const localTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: business.timezone }).format(new Date(startsAt))
  const payload = { title: 'Novo pedido de horário', body: `${serviceName} · ${localDate} às ${localTime}`, url: '/' }
  await Promise.all((subscriptions.results ?? []).map(async (subscription) => {
    try {
      const delivered = await sendWebPush(env, subscription, payload)
      if (!delivered) console.warn('Web push delivery failed with status other than success')
    } catch (cause) { console.warn('Web push delivery failed', cause instanceof Error ? cause.message : 'unknown error') }
  }))
}

function bytesFromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function makePasswordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' }, key, 256)
  const saltHex = Array.from(salt, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const hashHex = Array.from(new Uint8Array(derived), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return ['pbkdf2', String(PASSWORD_ITERATIONS), saltHex, hashHex].join('$')
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, roundsText, saltHex, expectedHex] = stored.split('$')
  const rounds = Number(roundsText)
  if (scheme !== 'pbkdf2' || !Number.isInteger(rounds) || rounds < 1 || rounds > PASSWORD_ITERATIONS || !saltHex || !expectedHex) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bytesFromHex(saltHex), iterations: rounds, hash: 'SHA-256' },
    key,
    expectedHex.length * 4,
  )
  const actual = Array.from(new Uint8Array(derived), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual.length !== expectedHex.length) return false
  let difference = 0
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expectedHex.charCodeAt(index)
  }
  return difference === 0
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') ?? ''
  const part = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(name + '='))
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null
}

function sessionCookie(token: string, maxAge: number, request: Request): string {
  const hostname = new URL(request.url).hostname
  const secure = hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]'
  return COOKIE_NAME + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly;' + (secure ? ' Secure;' : '') + ' SameSite=Strict; Max-Age=' + maxAge
}

async function body<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

function clean(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '')
}

function normalizeBrazilPhone(value: string): string {
  const digits = normalizePhone(value)
  return digits.startsWith('55') && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : digits
}

function formatBrazilPhone(value: string): string {
  const national = normalizeBrazilPhone(value)
  return national ? '+55' + national : ''
}

function brazilWhatsAppNumber(value: string): string {
  const digits = normalizePhone(value)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits
  return digits.length === 10 || digits.length === 11 ? '55' + digits : ''
}

async function findCustomersByBrazilPhone(env: Env, businessId: string, nationalPhone: string, excludeId = ''): Promise<Array<{ id: string; name: string; email: string }>> {
  if (!nationalPhone) return []
  const query = excludeId
    ? 'SELECT id, name, email FROM customers WHERE business_id = ? AND deleted_at IS NULL AND (phone_match_key IN (?, ?) OR phone_normalized IN (?, ?)) AND id <> ? LIMIT 2'
    : 'SELECT id, name, email FROM customers WHERE business_id = ? AND deleted_at IS NULL AND (phone_match_key IN (?, ?) OR phone_normalized IN (?, ?)) LIMIT 2'
  const statement = env.DB.prepare(query)
  const result = excludeId
    ? await statement.bind(businessId, nationalPhone, '55' + nationalPhone, nationalPhone, '55' + nationalPhone, excludeId).all<{ id: string; name: string; email: string }>()
    : await statement.bind(businessId, nationalPhone, '55' + nationalPhone, nationalPhone, '55' + nationalPhone).all<{ id: string; name: string; email: string }>()
  return result.results ?? []
}

function uniquePhoneValue(phone: string, customerId: string): string {
  return phone ? phone + ':' + customerId : 'no-phone-' + customerId
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

async function getOwner(request: Request, env: Env): Promise<Owner | null> {
  const token = readCookie(request, COOKIE_NAME)
  if (!token) return null
  const tokenHash = await sha256(token)
  return env.DB.prepare(
    'SELECT u.id AS user_id, u.business_id, u.email, u.display_name, b.name AS business_name, b.slug, b.whatsapp_phone, b.timezone ' +
      'FROM sessions s JOIN users u ON u.id = s.user_id JOIN businesses b ON b.id = u.business_id ' +
      'WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1 AND b.active = 1 LIMIT 1',
  )
    .bind(tokenHash, isoNow())
    .first<Owner>()
}

async function startSession(env: Env, userId: string): Promise<{ token: string; maxAge: number }> {
  const token = randomHex()
  const maxAge = SESSION_DAYS * 24 * 60 * 60
  const expires = new Date(Date.now() + maxAge * 1000).toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(isoNow()),
    env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      newId(),
      userId,
      await sha256(token),
      expires,
      isoNow(),
    ),
  ])
  return { token, maxAge }
}

function ownerPayload(owner: Owner) {
  return {
    user: { id: owner.user_id, email: owner.email, name: owner.display_name },
    business: {
      id: owner.business_id,
      name: owner.business_name,
      slug: owner.slug,
      whatsappPhone: owner.whatsapp_phone,
      timezone: owner.timezone,
    },
  }
}

function localDateTimeToUtc(date: string, time: string, timezone: string): Date {
  const target = Date.parse(date + 'T' + time + ':00Z')
  let candidate = target
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(candidate))
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
    const actual = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
    const difference = target - actual
    if (difference === 0) break
    candidate += difference
  }
  return new Date(candidate)
}

function addDays(date: string, days: number): string {
  const parsed = new Date(date + 'T12:00:00Z')
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function minuteLabel(minutes: number): string {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0')
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && aEnd > bStart
}

async function getSlots(
  env: Env,
  businessId: string,
  timezone: string,
  serviceId: string,
  date: string,
  teamMemberId: string,
): Promise<Slot[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  const service = await env.DB.prepare(
    'SELECT duration_minutes FROM services WHERE business_id = ? AND id = ? AND active = 1 LIMIT 1',
  )
    .bind(businessId, serviceId)
    .first<{ duration_minutes: number }>()
  if (!service) return []

  const dayStart = localDateTimeToUtc(date, '00:00', timezone).toISOString()
  const dayEnd = localDateTimeToUtc(addDays(date, 1), '00:00', timezone).toISOString()
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay()
  const rules = await env.DB.prepare(
    'SELECT start_time, end_time FROM availability_rules WHERE business_id = ? AND team_member_id = ? AND weekday = ? AND active = 1 ORDER BY start_time',
  )
    .bind(businessId, teamMemberId, weekday)
    .all<{ start_time: string; end_time: string }>()
  const exceptions = await env.DB.prepare(
    'SELECT kind, start_time, end_time FROM availability_exceptions WHERE business_id = ? AND team_member_id = ? AND exception_date = ?',
  )
    .bind(businessId, teamMemberId, date)
    .all<{ kind: string; start_time: string | null; end_time: string | null }>()
  if (exceptions.results.some((item) => item.kind === 'closed' && !item.start_time)) return []

  const windows: Interval[] = rules.results.map((item) => ({ start: item.start_time, end: item.end_time }))
  for (const item of exceptions.results) {
    if (item.kind === 'extra_hours' && item.start_time && item.end_time) {
      windows.push({ start: item.start_time, end: item.end_time })
    }
  }
  const blocked = exceptions.results
    .filter((item) => item.kind === 'blocked' && item.start_time && item.end_time)
    .map((item) => ({ start: item.start_time as string, end: item.end_time as string }))

  const appointments = await env.DB.prepare(
    'SELECT starts_at, ends_at FROM appointments WHERE business_id = ? AND team_member_id = ? AND starts_at < ? AND ends_at > ? ' +
      'AND (status IN (\'confirmed\', \'completed\') OR (status = \'pending\' AND expires_at > ?))',
  )
    .bind(businessId, teamMemberId, dayEnd, dayStart, isoNow())
    .all<{ starts_at: string; ends_at: string }>()

  const slots: Slot[] = []
  const duration = service.duration_minutes
  const now = Date.now()
  for (const window of windows) {
    const [startHour, startMinute] = window.start.split(':').map(Number)
    const [endHour, endMinute] = window.end.split(':').map(Number)
    const startValue = startHour * 60 + startMinute
    const endValue = endHour * 60 + endMinute
    for (let minute = startValue; minute + duration <= endValue; minute += duration) {
      const localStart = minuteLabel(minute)
      const localEnd = minuteLabel(minute + duration)
      if (blocked.some((range) => rangesOverlap(localStart, localEnd, range.start, range.end))) continue
      const startsAt = localDateTimeToUtc(date, localStart, timezone)
      const endsAt = new Date(startsAt.getTime() + duration * 60000)
      if (startsAt.getTime() <= now) continue
      if (appointments.results.some((item) => rangesOverlap(startsAt.toISOString(), endsAt.toISOString(), item.starts_at, item.ends_at))) {
        continue
      }
      slots.push({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), time: localStart, teamMemberId })
    }
  }
  return slots
}

async function getActiveTeam(env: Env, businessId: string) {
  const result = await env.DB.prepare(
    'SELECT id, name, is_owner FROM team_members WHERE business_id = ? AND active = 1 ORDER BY is_owner DESC, name',
  ).bind(businessId).all<{ id: string; name: string; is_owner: number }>()
  return result.results ?? []
}

async function primaryTeamMemberId(env: Env, businessId: string): Promise<string> {
  const member = await env.DB.prepare(
    'SELECT id FROM team_members WHERE business_id = ? AND active = 1 ORDER BY is_owner DESC, created_at LIMIT 1',
  ).bind(businessId).first<{ id: string }>()
  return member?.id ?? ''
}

async function publicBusiness(env: Env, slug: string) {
  const business = await env.DB.prepare(
    'SELECT id, slug, name, description, whatsapp_phone, timezone FROM businesses WHERE slug = ? AND active = 1 LIMIT 1',
  )
    .bind(slug)
    .first<{ id: string; slug: string; name: string; description: string; whatsapp_phone: string; timezone: string }>()
  if (!business) return null
  const services = await env.DB.prepare(
    'SELECT id, name, description, duration_minutes, price_cents FROM services WHERE business_id = ? AND active = 1 ORDER BY name',
  )
    .bind(business.id)
    .all()
  const team = await getActiveTeam(env, business.id)
  return { ...business, services: services.results, teamMembers: team.map(({ id, name }) => ({ id, name })) }
}

async function publicRequestStatus(env: Env, token: string) {
  const tokenHash = await sha256(token)
  const appointment = await env.DB.prepare(
    "SELECT a.id, a.starts_at, a.ends_at, a.status, a.expires_at, a.service_name_snapshot, b.name AS business_name, b.slug AS business_slug, b.timezone, CASE WHEN c.deleted_at IS NULL THEN c.name ELSE 'Contato excluído' END AS customer_name " +
      'FROM appointments a JOIN businesses b ON b.id = a.business_id JOIN customers c ON c.id = a.customer_id ' +
      'WHERE a.tracking_token_hash = ? LIMIT 1',
  )
    .bind(tokenHash)
    .first<Record<string, unknown>>()
  if (!appointment) return null
  if (appointment.status === 'pending' && typeof appointment.expires_at === 'string' && appointment.expires_at <= isoNow()) {
    await env.DB.prepare('UPDATE appointments SET status = \'expired\', updated_at = ? WHERE id = ? AND status = \'pending\' AND expires_at <= ?')
      .bind(isoNow(), appointment.id, isoNow())
      .run()
    appointment.status = 'expired'
  }
  return appointment
}

async function handleAuth(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/auth/register' && request.method === 'POST') {
    const input = await body<{ businessName: string; ownerName: string; email: string; password: string }>(request)
    const businessName = clean(input?.businessName, 90)
    const ownerName = clean(input?.ownerName, 90)
    const email = clean(input?.email, 160).toLowerCase()
    const password = typeof input?.password === 'string' ? input.password : ''
    const baseSlug = slugify(businessName)
    if (!businessName || !ownerName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error('Preencha o nome do negócio, seu nome e um e-mail válido.')
    if (password.length < 12) return error('Use uma senha com pelo menos 12 caracteres.')
    if (!baseSlug) return error('Informe um nome de negócio válido.')

    const businessId = newId()
    const userId = newId()
    const ownerMemberId = 'owner-' + userId
    const suffix = randomHex(3)
    const slug = baseSlug + '-' + suffix
    const createdAt = isoNow()
    try {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO businesses (id, slug, name, description, whatsapp_phone, timezone, active, created_at) VALUES (?, ?, ?, \'\', \'\', \'America/Sao_Paulo\', 1, ?)',
        ).bind(businessId, slug, businessName, createdAt),
        env.DB.prepare(
          'INSERT INTO users (id, business_id, email, password_hash, display_name, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        ).bind(userId, businessId, email, await makePasswordHash(password), ownerName, createdAt),
        env.DB.prepare(
          'INSERT INTO team_members (id, business_id, name, is_owner, active, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)',
        ).bind(ownerMemberId, businessId, ownerName, createdAt, createdAt),
      ])
    } catch (cause) {
      if (cause instanceof Error && /UNIQUE constraint failed: users\.email/i.test(cause.message)) {
        return error('Este e-mail já está cadastrado. Tente entrar com ele.', 409)
      }
      console.error('Account registration failed', cause)
      return error('Não foi possível criar a conta agora. Tente novamente em instantes.', 500)
    }
    const session = await startSession(env, userId)
    const owner = await getOwner(
      new Request(request.url, { headers: { Cookie: sessionCookie(session.token, session.maxAge, request).split(';')[0] } }),
      env,
    )
    return response(owner ? ownerPayload(owner) : {}, 201, { 'Set-Cookie': sessionCookie(session.token, session.maxAge, request) })
  }

  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const input = await body<{ email: string; password: string }>(request)
    const email = clean(input?.email, 160).toLowerCase()
    const password = typeof input?.password === 'string' ? input.password : ''
    const user = await env.DB.prepare(
      'SELECT id, password_hash FROM users WHERE email = ? AND active = 1 LIMIT 1',
    )
      .bind(email)
      .first<{ id: string; password_hash: string }>()
    if (!user || !(await verifyPassword(password, user.password_hash))) return error('E-mail ou senha não conferem.', 401)
    const session = await startSession(env, user.id)
    const owner = await getOwner(
      new Request(request.url, { headers: { Cookie: sessionCookie(session.token, session.maxAge, request).split(';')[0] } }),
      env,
    )
    return response(owner ? ownerPayload(owner) : {}, 200, { 'Set-Cookie': sessionCookie(session.token, session.maxAge, request) })
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = readCookie(request, COOKIE_NAME)
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
    return response({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0, request) })
  }

  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    const owner = await getOwner(request, env)
    return owner ? response(ownerPayload(owner)) : error('Entre na sua conta para continuar.', 401)
  }

  return null
}

async function handlePublic(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response | null> {
  const businessMatch = url.pathname.match(/^\/api\/public\/business\/([^/]+)$/)
  if (businessMatch && request.method === 'GET') {
    const business = await publicBusiness(env, decodeURIComponent(businessMatch[1]))
    return business ? response(business) : error('Não encontramos essa página.', 404)
  }

  if (url.pathname === '/api/public/availability' && request.method === 'GET') {
    const slug = clean(url.searchParams.get('slug'), 80)
    const serviceId = clean(url.searchParams.get('serviceId'), 80)
    const date = clean(url.searchParams.get('date'), 10)
    const requestedMemberId = clean(url.searchParams.get('teamMemberId'), 80)
    const business = await env.DB.prepare('SELECT id, timezone FROM businesses WHERE slug = ? AND active = 1 LIMIT 1')
      .bind(slug)
      .first<{ id: string; timezone: string }>()
    if (!business) return error('Não encontramos essa página.', 404)
    const team = await getActiveTeam(env, business.id)
    const selectedTeam = requestedMemberId && requestedMemberId !== 'any'
      ? team.filter((member) => member.id === requestedMemberId)
      : team
    const slots = (await Promise.all(selectedTeam.map(async (member) => {
      const available = await getSlots(env, business.id, business.timezone, serviceId, date, member.id)
      return available.map((slot) => ({ ...slot, teamMemberName: member.name }))
    }))).flat()
    const uniqueSlots = new Map<string, Slot>()
    for (const slot of slots.sort((a, b) => a.time.localeCompare(b.time) || a.teamMemberName!.localeCompare(b.teamMemberName!))) {
      if (!uniqueSlots.has(slot.startsAt)) uniqueSlots.set(slot.startsAt, slot)
    }
    return response({ slots: [...uniqueSlots.values()] })
  }

  if (url.pathname === '/api/public/appointments' && request.method === 'POST') {
    const input = await body<{ slug: string; serviceId: string; startsAt: string; teamMemberId?: string; customerName: string; phone: string; email?: string }>(request)
    const slug = clean(input?.slug, 80)
    const serviceId = clean(input?.serviceId, 80)
    const startsAt = clean(input?.startsAt, 40)
    const requestedMemberId = clean(input?.teamMemberId, 80)
    const customerName = clean(input?.customerName, 90)
    const phone = clean(input?.phone, 30)
    const phoneNormalized = normalizeBrazilPhone(phone)
    const email = clean(input?.email, 160).toLowerCase()
    if (!slug || !serviceId || !startsAt || !customerName || (phoneNormalized.length !== 10 && phoneNormalized.length !== 11)) {
      return error('Informe seu nome, telefone e escolha um serviço e horário.')
    }
    const business = await env.DB.prepare('SELECT id, name, timezone, whatsapp_phone FROM businesses WHERE slug = ? AND active = 1 LIMIT 1')
      .bind(slug)
      .first<{ id: string; name: string; timezone: string; whatsapp_phone: string }>()
    if (!business) return error('Não encontramos essa página.', 404)
    const service = await env.DB.prepare(
      'SELECT id, name, duration_minutes, price_cents FROM services WHERE business_id = ? AND id = ? AND active = 1 LIMIT 1',
    )
      .bind(business.id, serviceId)
      .first<{ id: string; name: string; duration_minutes: number; price_cents: number }>()
    if (!service) return error('Esse serviço não está disponível.', 404)

    const start = new Date(startsAt)
    if (Number.isNaN(start.getTime())) return error('Horário inválido.')
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(start)
    const team = await getActiveTeam(env, business.id)
    const eligible = requestedMemberId && requestedMemberId !== 'any'
      ? team.filter((member) => member.id === requestedMemberId)
      : team
    const availableMembers = (await Promise.all(eligible.map(async (member) => ({
      member,
      slot: (await getSlots(env, business.id, business.timezone, service.id, date, member.id)).find((item) => item.startsAt === start.toISOString()),
    })))).filter((item) => item.slot)
    const chosen = availableMembers[0]
    if (!chosen?.slot) return error('Esse horário acabou de ficar indisponível. Escolha outro.', 409)
    const slot = chosen.slot
    const teamMemberId = chosen.member.id

    const createdAt = isoNow()
    const expiresAt = new Date(Date.now() + PENDING_MINUTES * 60000).toISOString()
    const appointmentId = newId()
    const trackingToken = randomHex()
    const trackingHash = await sha256(trackingToken)

    const phoneMatches = await findCustomersByBrazilPhone(env, business.id, phoneNormalized)
    const samePerson = phoneMatches.filter((item) => item.name.trim().toLowerCase() === customerName.trim().toLowerCase() && (!email || !item.email || item.email.toLowerCase() === email))
    let customer: { id: string } | null = samePerson.length === 1 ? samePerson[0] : null
    if (customer) {
      await env.DB.prepare('UPDATE customers SET name = ?, phone = ?, phone_normalized = ?, phone_match_key = ?, email = ?, updated_at = ? WHERE business_id = ? AND id = ?')
        .bind(customerName, formatBrazilPhone(phoneNormalized), uniquePhoneValue(phoneNormalized, customer.id), phoneNormalized, email, createdAt, business.id, customer.id)
        .run()
    } else {
      const customerId = newId()
      await env.DB.prepare(
        'INSERT INTO customers (id, business_id, name, phone, phone_normalized, phone_match_key, email, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'\', ?, ?)',
      )
        .bind(customerId, business.id, customerName, formatBrazilPhone(phoneNormalized), uniquePhoneValue(phoneNormalized, customerId), phoneNormalized, email, createdAt, createdAt)
        .run()
      customer = { id: customerId }
    }
    if (!customer) return error('Não foi possível registrar os dados do cliente.', 500)

    const insert = await env.DB.prepare(
      'INSERT INTO appointments (id, business_id, team_member_id, customer_id, service_id, service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot, starts_at, ends_at, status, source, notes, expires_at, tracking_token_hash, created_at, updated_at) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', \'public\', \'\', ?, ?, ?, ? ' +
        'WHERE NOT EXISTS (SELECT 1 FROM appointments WHERE business_id = ? AND team_member_id = ? AND starts_at < ? AND ends_at > ? AND (status IN (\'confirmed\', \'completed\') OR (status = \'pending\' AND expires_at > ?))) ' +
        'RETURNING id',
    )
      .bind(
        appointmentId,
        business.id,
        teamMemberId,
        customer.id,
        service.id,
        service.name,
        service.duration_minutes,
        service.price_cents,
        slot.startsAt,
        slot.endsAt,
        expiresAt,
        trackingHash,
        createdAt,
        createdAt,
        business.id,
        teamMemberId,
        slot.endsAt,
        slot.startsAt,
        createdAt,
      )
      .all<{ id: string }>()
    if (!insert.results?.length) return error('Esse horário acabou de ficar indisponível. Escolha outro.', 409)
    await env.DB.prepare(
      'INSERT INTO appointment_events (id, business_id, appointment_id, event_type, details, created_at) VALUES (?, ?, ?, \'requested\', \'Solicitação enviada pela página pública.\', ?)',
    )
      .bind(newId(), business.id, appointmentId, createdAt)
      .run()
    ctx.waitUntil(notifyBusinessOfAppointment(env as PushEnv, business, service.name, slot.startsAt).catch((cause) => {
      console.warn('Could not queue appointment notification', cause instanceof Error ? cause.message : 'unknown error')
    }))
    return response({
      id: appointmentId,
      status: 'pending',
      expiresAt,
      trackingToken,
      businessName: business.name,
      whatsappPhone: brazilWhatsAppNumber(business.whatsapp_phone),
      serviceName: service.name,
      teamMemberName: chosen.member.name,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      approvalPath: '/solicitacoes/' + appointmentId,
      trackingPath: '/pedido/' + trackingToken,
    }, 201)
  }

  const statusMatch = url.pathname.match(/^\/api\/public\/requests\/([^/]+)$/)
  if (statusMatch && request.method === 'GET') {
    const requestStatus = await publicRequestStatus(env, decodeURIComponent(statusMatch[1]))
    return requestStatus ? response(requestStatus) : error('Link de acompanhamento inválido.', 404)
  }
  return null
}

async function adminData(owner: Owner, env: Env, path: string, requestedTeamMemberId?: string): Promise<Response | null> {
  const businessId = owner.business_id
  if (path === '/api/admin/overview') {
    const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: owner.timezone }).format(new Date())
    const todayStart = localDateTimeToUtc(localToday, '00:00', owner.timezone).toISOString()
    const tomorrowStart = localDateTimeToUtc(addDays(localToday, 1), '00:00', owner.timezone).toISOString()
    const stats = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS count FROM appointments WHERE business_id = ? AND status = ? AND expires_at > ?')
        .bind(businessId, 'pending', isoNow()),
      env.DB.prepare('SELECT COUNT(*) AS count FROM appointments WHERE business_id = ? AND starts_at >= ? AND starts_at < ? AND status IN (?, ?)')
        .bind(businessId, todayStart, tomorrowStart, 'pending', 'confirmed'),
      env.DB.prepare(
        "SELECT a.id, a.starts_at, a.ends_at, a.status, a.service_name_snapshot AS service_name, CASE WHEN c.deleted_at IS NULL THEN c.name ELSE 'Contato excluído' END AS customer_name " +
          'FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.business_id = ? AND a.starts_at >= ? ' +
          'AND a.status IN (?, ?) ORDER BY a.starts_at LIMIT 6',
      ).bind(businessId, isoNow(), 'pending', 'confirmed'),
      env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM financial_entries WHERE business_id = ? AND direction = ? AND settled_at IS NULL AND cancelled_at IS NULL')
        .bind(businessId, 'receivable'),
      env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM financial_entries WHERE business_id = ? AND direction = ? AND settled_at IS NULL AND cancelled_at IS NULL')
        .bind(businessId, 'payable'),
      env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM financial_entries WHERE business_id = ? AND direction = ? AND settled_at IS NOT NULL AND cancelled_at IS NULL AND date(settled_at) >= date(\'now\', \'start of month\')')
        .bind(businessId, 'receivable'),
      env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM financial_entries WHERE business_id = ? AND direction = ? AND settled_at IS NOT NULL AND cancelled_at IS NULL AND date(settled_at) >= date(\'now\', \'start of month\')')
        .bind(businessId, 'payable'),
      env.DB.prepare('SELECT COUNT(*) AS count FROM customers WHERE business_id = ? AND deleted_at IS NULL')
        .bind(businessId),
    ])
    const countOf = (index: number) => Number((stats[index].results?.[0] as { count?: number } | undefined)?.count ?? 0)
    const totalOf = (index: number) => Number((stats[index].results?.[0] as { total?: number } | undefined)?.total ?? 0)
    const upcoming = stats[2].results ?? []
    return response({
      counts: { pending: countOf(0), today: countOf(1), customers: countOf(7) },
      money: {
        receivableCents: totalOf(3),
        payableCents: totalOf(4),
        receivedThisMonthCents: totalOf(5),
        paidThisMonthCents: totalOf(6),
      },
      upcoming,
    })
  }

  if (path === '/api/admin/appointments') {
    const rows = await env.DB.prepare(
      "SELECT a.id, a.customer_id, a.service_id, a.team_member_id, tm.name AS team_member_name, a.service_name_snapshot AS service_name, a.duration_minutes_snapshot, a.price_cents_snapshot, a.starts_at, a.ends_at, a.status, a.source, a.notes, a.expires_at, CASE WHEN c.deleted_at IS NULL THEN c.name ELSE 'Contato excluído' END AS customer_name, c.phone AS customer_phone, c.email AS customer_email " +
        'FROM appointments a JOIN customers c ON c.id = a.customer_id LEFT JOIN team_members tm ON tm.id = a.team_member_id WHERE a.business_id = ? ORDER BY a.starts_at DESC LIMIT 200',
    )
      .bind(businessId)
      .all()
    return response(rows.results)
  }

  if (path === '/api/admin/team-members') {
    const rows = await env.DB.prepare(
      'SELECT id, name, is_owner, active FROM team_members WHERE business_id = ? ORDER BY is_owner DESC, active DESC, name',
    ).bind(businessId).all()
    return response(rows.results)
  }

  if (path === '/api/admin/availability') {
    const rows = await env.DB.prepare(
      'SELECT weekday, start_time AS startTime, end_time AS endTime FROM availability_rules WHERE business_id = ? AND team_member_id = ? AND active = 1 ORDER BY weekday, start_time',
    )
      .bind(businessId, requestedTeamMemberId || await primaryTeamMemberId(env, businessId))
      .all()
    return response(rows.results)
  }

  if (path === '/api/admin/customers') {
    const rows = await env.DB.prepare(
      'SELECT id, name, phone, email, notes, created_at FROM customers WHERE business_id = ? AND deleted_at IS NULL ORDER BY name',
    )
      .bind(businessId)
      .all()
    return response(rows.results)
  }

  if (path === '/api/admin/services') {
    const rows = await env.DB.prepare(
      'SELECT id, name, description, duration_minutes, price_cents, active FROM services WHERE business_id = ? ORDER BY active DESC, name',
    )
      .bind(businessId)
      .all()
    return response(rows.results)
  }

  if (path === '/api/admin/products') {
    const rows = await env.DB.prepare(
      'SELECT id, name, description, price_cents, active FROM products WHERE business_id = ? ORDER BY active DESC, name',
    )
      .bind(businessId)
      .all()
    return response(rows.results)
  }

  if (path === '/api/admin/finance') {
    const rows = await env.DB.prepare(
      "SELECT f.id, f.direction, f.description, f.amount_cents, f.due_date, f.settled_at, f.payment_method, f.cancelled_at, c.name AS category_name, CASE WHEN u.deleted_at IS NULL THEN u.name ELSE 'Contato excluído' END AS customer_name, p.name AS product_name, a.service_name_snapshot AS service_name, CASE WHEN f.cancelled_at IS NOT NULL THEN 'cancelled' WHEN f.settled_at IS NOT NULL THEN 'settled' WHEN f.due_date < date('now') THEN 'overdue' ELSE 'pending' END AS status " +
        'FROM financial_entries f JOIN financial_categories c ON c.id = f.category_id ' +
        'LEFT JOIN customers u ON u.id = f.customer_id LEFT JOIN products p ON p.id = f.product_id LEFT JOIN appointments a ON a.id = f.appointment_id ' +
        'WHERE f.business_id = ? ORDER BY f.due_date DESC LIMIT 300',
    )
      .bind(businessId)
      .all()
    const categories = await env.DB.prepare(
      'SELECT id, name, direction FROM financial_categories WHERE business_id = ? AND active = 1 ORDER BY direction, name',
    )
      .bind(businessId)
      .all()
    return response({ entries: rows.results, categories: categories.results })
  }

  if (path === '/api/admin/settings') {
    const business = await env.DB.prepare(
      'SELECT name, description, slug, whatsapp_phone, timezone FROM businesses WHERE id = ? LIMIT 1',
    )
      .bind(businessId)
      .first()
    return response(business)
  }

  return null
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/admin/')) return null
  const owner = await getOwner(request, env)
  if (!owner) return error('Sua sessão expirou. Entre novamente.', 401)
  const path = url.pathname
  if (path === '/api/admin/push-key' && request.method === 'GET') {
    return response({ publicKey: (env as PushEnv).VAPID_PUBLIC_KEY || null })
  }
  if (path === '/api/admin/push-subscriptions' && request.method === 'POST') {
    const input = await body<{ endpoint: string; keys?: { p256dh?: string; auth?: string } }>(request)
    const endpoint = clean(input?.endpoint, 2048)
    const p256dh = clean(input?.keys?.p256dh, 256)
    const auth = clean(input?.keys?.auth, 256)
    let endpointUrl: URL
    try { endpointUrl = new URL(endpoint) } catch { return error('Assinatura de notificações inválida.') }
    const allowedHost = endpointUrl.hostname === 'fcm.googleapis.com'
      || endpointUrl.hostname === 'web.push.apple.com'
      || endpointUrl.hostname.endsWith('.push.services.mozilla.com')
      || endpointUrl.hostname.endsWith('.notify.windows.com')
      || endpointUrl.hostname.endsWith('.push.microsoft.com')
    if (endpointUrl.protocol !== 'https:' || !allowedHost || !p256dh || !auth) return error('Assinatura de notificações inválida.')
    const now = isoNow()
    await env.DB.prepare(
      'INSERT INTO push_subscriptions (id, business_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(endpoint) DO UPDATE SET business_id = excluded.business_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at',
    ).bind(newId(), owner.business_id, endpoint, p256dh, auth, now, now).run()
    return response({ ok: true }, 201)
  }
  if (path === '/api/admin/push-subscriptions' && request.method === 'DELETE') {
    const input = await body<{ endpoint: string }>(request)
    const endpoint = clean(input?.endpoint, 2048)
    if (!endpoint) return error('Assinatura de notificações inválida.')
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE business_id = ? AND endpoint = ?').bind(owner.business_id, endpoint).run()
    return response({ ok: true })
  }
  if (request.method === 'GET') {
    if (path === '/api/admin/availability-slots') {
      const serviceId = clean(url.searchParams.get('serviceId'), 80)
      const date = clean(url.searchParams.get('date'), 10)
      const teamMemberId = clean(url.searchParams.get('teamMemberId'), 80) || await primaryTeamMemberId(env, owner.business_id)
      if (!serviceId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return error('Escolha um serviço e uma data válida.')
      return response(await getSlots(env, owner.business_id, owner.timezone, serviceId, date, teamMemberId))
    }
    if (path === '/api/admin/availability') {
      const teamMemberId = clean(url.searchParams.get('teamMemberId'), 80) || await primaryTeamMemberId(env, owner.business_id)
      const member = await env.DB.prepare('SELECT id FROM team_members WHERE business_id = ? AND id = ? AND active = 1 LIMIT 1').bind(owner.business_id, teamMemberId).first()
      if (!member) return error('Selecione um profissional ativo.', 404)
      return adminData(owner, env, path, teamMemberId)
    }
    return adminData(owner, env, path)
  }

  if (path === '/api/admin/settings' && request.method === 'PATCH') {
    const input = await body<{ name: string; description: string; whatsappPhone: string; timezone: string }>(request)
    const name = clean(input?.name, 90)
    const description = clean(input?.description, 300)
    const rawWhatsapp = clean(input?.whatsappPhone, 30)
    const nationalWhatsapp = normalizeBrazilPhone(rawWhatsapp)
    const whatsappPhone = nationalWhatsapp ? '55' + nationalWhatsapp : ''
    const timezone = clean(input?.timezone, 60) || 'America/Sao_Paulo'
    if (!name) return error('Informe o nome do negócio.')
    if (rawWhatsapp && nationalWhatsapp.length !== 10 && nationalWhatsapp.length !== 11) return error('Informe um WhatsApp válido com DDD.')
    try {
      new Intl.DateTimeFormat('pt-BR', { timeZone: timezone })
    } catch {
      return error('Informe um fuso horário válido.')
    }
    await env.DB.prepare('UPDATE businesses SET name = ?, description = ?, whatsapp_phone = ?, timezone = ? WHERE id = ?')
      .bind(name, description, whatsappPhone, timezone, owner.business_id)
      .run()
    return response({ ok: true })
  }

  if (path === '/api/admin/team-members' && request.method === 'POST') {
    const input = await body<{ name: string }>(request)
    const name = clean(input?.name, 90)
    if (!name) return error('Informe o nome do profissional.')
    const id = newId()
    const now = isoNow()
    await env.DB.prepare(
      'INSERT INTO team_members (id, business_id, name, is_owner, active, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)',
    ).bind(id, owner.business_id, name, now, now).run()
    return response({ id, name, is_owner: 0, active: 1 }, 201)
  }

  const teamMemberMatch = path.match(/^\/api\/admin\/team-members\/([^/]+)$/)
  if (teamMemberMatch && request.method === 'PATCH') {
    const memberId = decodeURIComponent(teamMemberMatch[1])
    const input = await body<{ name?: string; active?: boolean }>(request)
    const member = await env.DB.prepare(
      'SELECT id, is_owner FROM team_members WHERE business_id = ? AND id = ? LIMIT 1',
    ).bind(owner.business_id, memberId).first<{ id: string; is_owner: number }>()
    if (!member) return error('Profissional não encontrado.', 404)
    const name = input?.name === undefined ? null : clean(input.name, 90)
    if (name !== null && !name) return error('Informe o nome do profissional.')
    if (input?.active === false && member.is_owner) return error('O titular da conta não pode ser desativado.')
    await env.DB.prepare(
      'UPDATE team_members SET name = COALESCE(?, name), active = COALESCE(?, active), updated_at = ? WHERE business_id = ? AND id = ?',
    ).bind(name, input?.active === undefined ? null : input.active ? 1 : 0, isoNow(), owner.business_id, memberId).run()
    return response({ ok: true })
  }

  if (path === '/api/admin/availability' && request.method === 'PUT') {
    const input = await body<{ teamMemberId?: string; windows: Array<{ weekday: number; startTime: string; endTime: string }> }>(request)
    const teamMemberId = clean(input?.teamMemberId, 80) || await primaryTeamMemberId(env, owner.business_id)
    const member = await env.DB.prepare('SELECT id FROM team_members WHERE business_id = ? AND id = ? AND active = 1 LIMIT 1').bind(owner.business_id, teamMemberId).first()
    if (!member) return error('Selecione um profissional ativo.', 404)
    if (!Array.isArray(input?.windows) || input.windows.length > 28) return error('Confira os períodos de atendimento informados.')
    const windows = input.windows.map((item) => ({
      weekday: Number(item.weekday),
      startTime: clean(item.startTime, 5),
      endTime: clean(item.endTime, 5),
    }))
    const validTime = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    if (windows.some((item) => !Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6 || !validTime(item.startTime) || !validTime(item.endTime) || item.startTime >= item.endTime)) {
      return error('Confira os dias e horários. O início precisa ser anterior ao fim.')
    }
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const dayWindows = windows.filter((item) => item.weekday === weekday).sort((left, right) => left.startTime.localeCompare(right.startTime))
      if (dayWindows.some((item, index) => index > 0 && item.startTime < dayWindows[index - 1].endTime)) {
        return error('Os períodos de um mesmo dia não podem se sobrepor.')
      }
    }
    const statements = [env.DB.prepare('DELETE FROM availability_rules WHERE business_id = ? AND team_member_id = ?').bind(owner.business_id, teamMemberId)]
    for (const item of windows) {
      statements.push(
        env.DB.prepare('INSERT INTO availability_rules (id, business_id, team_member_id, weekday, start_time, end_time, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
          .bind(newId(), owner.business_id, teamMemberId, item.weekday, item.startTime, item.endTime),
      )
    }
    await env.DB.batch(statements)
    return response({ ok: true })
  }

  if (path === '/api/admin/appointments' && request.method === 'POST') {
    const input = await body<{
      customerId?: string
      newCustomer?: { name: string; phone: string; email?: string }
      serviceId: string
      teamMemberId?: string
      startsAt: string
    }>(request)
    const serviceId = clean(input?.serviceId, 80)
    const teamMemberId = clean(input?.teamMemberId, 80) || await primaryTeamMemberId(env, owner.business_id)
    const startsAt = clean(input?.startsAt, 40)
    const start = new Date(startsAt)
    if (!serviceId || Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) return error('Escolha um serviço, uma data e um horário futuro.')
    const service = await env.DB.prepare(
      'SELECT id, name, duration_minutes, price_cents FROM services WHERE business_id = ? AND id = ? AND active = 1 LIMIT 1',
    )
      .bind(owner.business_id, serviceId)
      .first<{ id: string; name: string; duration_minutes: number; price_cents: number }>()
    if (!service) return error('Esse serviço não está disponível.', 404)
    const teamMember = await env.DB.prepare('SELECT id FROM team_members WHERE business_id = ? AND id = ? AND active = 1 LIMIT 1').bind(owner.business_id, teamMemberId).first()
    if (!teamMember) return error('Selecione um profissional ativo.', 404)
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: owner.timezone }).format(start)
    const slots = await getSlots(env, owner.business_id, owner.timezone, service.id, localDate, teamMemberId)
    const slot = slots.find((item) => item.startsAt === start.toISOString())
    if (!slot) return error('Esse horário não está disponível. Escolha um dos horários livres.', 409)

    const customerId = clean(input?.customerId, 80)
    let customer: { id: string } | null = null
    const createdAt = isoNow()
    if (customerId) {
      customer = await env.DB.prepare('SELECT id FROM customers WHERE business_id = ? AND id = ? LIMIT 1')
        .bind(owner.business_id, customerId)
        .first<{ id: string }>()
      if (!customer) return error('Selecione um cliente válido.', 404)
    } else {
      const name = clean(input?.newCustomer?.name, 90)
      const phone = clean(input?.newCustomer?.phone, 30)
      const phoneNormalized = normalizeBrazilPhone(phone)
      const email = clean(input?.newCustomer?.email, 160).toLowerCase()
      if (!name || (phoneNormalized.length !== 10 && phoneNormalized.length !== 11)) return error('Informe o nome e um WhatsApp válido com DDD para o novo cliente.')
      const matches = await findCustomersByBrazilPhone(env, owner.business_id, phoneNormalized)
      const samePerson = matches.filter((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase() && (!email || !item.email || item.email.toLowerCase() === email))
      customer = samePerson.length === 1 ? samePerson[0] : null
      if (customer) {
        await env.DB.prepare('UPDATE customers SET name = ?, phone = ?, phone_normalized = ?, phone_match_key = ?, email = ?, updated_at = ? WHERE business_id = ? AND id = ?')
          .bind(name, formatBrazilPhone(phoneNormalized), uniquePhoneValue(phoneNormalized, customer.id), phoneNormalized, email, createdAt, owner.business_id, customer.id)
          .run()
      } else {
        const customerId = newId()
        await env.DB.prepare(
          'INSERT INTO customers (id, business_id, name, phone, phone_normalized, phone_match_key, email, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'\', ?, ?)',
        )
          .bind(customerId, owner.business_id, name, formatBrazilPhone(phoneNormalized), uniquePhoneValue(phoneNormalized, customerId), phoneNormalized, email, createdAt, createdAt)
          .run()
        customer = { id: customerId }
      }
    }

    const appointmentId = newId()
    const trackingHash = await sha256(randomHex())
    const insert = await env.DB.prepare(
      'INSERT INTO appointments (id, business_id, team_member_id, customer_id, service_id, service_name_snapshot, duration_minutes_snapshot, price_cents_snapshot, starts_at, ends_at, status, source, notes, expires_at, tracking_token_hash, created_at, updated_at) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'confirmed\', \'manual\', \'\', NULL, ?, ?, ? ' +
        'WHERE NOT EXISTS (SELECT 1 FROM appointments WHERE business_id = ? AND team_member_id = ? AND starts_at < ? AND ends_at > ? AND (status IN (\'confirmed\', \'completed\') OR (status = \'pending\' AND expires_at > ?))) ' +
        'RETURNING id',
    )
      .bind(
        appointmentId,
        owner.business_id,
        teamMemberId,
        customer.id,
        service.id,
        service.name,
        service.duration_minutes,
        service.price_cents,
        slot.startsAt,
        slot.endsAt,
        trackingHash,
        createdAt,
        createdAt,
        owner.business_id,
        teamMemberId,
        slot.endsAt,
        slot.startsAt,
        createdAt,
      )
      .all<{ id: string }>()
    if (!insert.results?.length) return error('Esse horário acabou de ser ocupado. Escolha outro.', 409)
    await env.DB.prepare('INSERT INTO appointment_events (id, business_id, appointment_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId(), owner.business_id, appointmentId, 'approved', 'Agendamento criado manualmente pelo profissional.', createdAt)
      .run()
    return response({ ok: true, id: appointmentId }, 201)
  }

  const appointmentMatch = path.match(/^\/api\/admin\/appointments\/([^/]+)$/)
  if (appointmentMatch && request.method === 'PATCH') {
    const appointmentId = decodeURIComponent(appointmentMatch[1])
    const input = await body<{ action: string; startsAt?: string }>(request)
    const appointment = await env.DB.prepare(
      'SELECT id, status, starts_at, duration_minutes_snapshot, expires_at, team_member_id FROM appointments WHERE business_id = ? AND id = ? LIMIT 1',
    )
      .bind(owner.business_id, appointmentId)
      .first<{ id: string; status: string; starts_at: string; duration_minutes_snapshot: number; expires_at: string | null; team_member_id: string }>()
    if (!appointment) return error('Agendamento não encontrado.', 404)
    const now = isoNow()
    let update: D1PreparedStatement | null = null
    let eventType = ''
    let eventDetails = ''
    if (input?.action === 'confirm') {
      update = env.DB.prepare(
        'UPDATE appointments SET status = \'confirmed\', expires_at = NULL, updated_at = ? WHERE business_id = ? AND id = ? AND status = \'pending\' AND expires_at > ? ' +
        'AND NOT EXISTS (SELECT 1 FROM appointments other WHERE other.business_id = ? AND other.team_member_id = appointments.team_member_id AND other.id <> ? AND other.starts_at < appointments.ends_at AND other.ends_at > appointments.starts_at AND (other.status IN (\'confirmed\', \'completed\') OR (other.status = \'pending\' AND other.expires_at > ?))) RETURNING id',
      ).bind(now, owner.business_id, appointmentId, now, owner.business_id, appointmentId, now)
      eventType = 'approved'
      eventDetails = 'Solicitação aprovada pelo profissional.'
    } else if (input?.action === 'decline' && appointment.status === 'pending') {
      update = env.DB.prepare('UPDATE appointments SET status = \'declined\', updated_at = ? WHERE business_id = ? AND id = ? AND status = \'pending\' RETURNING id')
        .bind(now, owner.business_id, appointmentId)
      eventType = 'declined'
      eventDetails = 'Solicitação recusada pelo profissional.'
    } else if (input?.action === 'cancel' && ['pending', 'confirmed'].includes(appointment.status)) {
      update = env.DB.prepare('UPDATE appointments SET status = \'cancelled\', updated_at = ? WHERE business_id = ? AND id = ? AND status IN (\'pending\', \'confirmed\') RETURNING id')
        .bind(now, owner.business_id, appointmentId)
      eventType = 'cancelled'
      eventDetails = 'Agendamento cancelado pelo profissional.'
    } else if (input?.action === 'complete' && appointment.status === 'confirmed') {
      update = env.DB.prepare('UPDATE appointments SET status = \'completed\', updated_at = ? WHERE business_id = ? AND id = ? AND status = \'confirmed\' RETURNING id')
        .bind(now, owner.business_id, appointmentId)
      eventType = 'completed'
      eventDetails = 'Atendimento marcado como concluído.'
    } else if (input?.action === 'reschedule' && input.startsAt && appointment.status === 'confirmed') {
      const newStart = new Date(input.startsAt)
      if (Number.isNaN(newStart.getTime()) || newStart.getTime() <= Date.now()) return error('Escolha uma data futura.')
      const newEnd = new Date(newStart.getTime() + appointment.duration_minutes_snapshot * 60000).toISOString()
      const startIso = newStart.toISOString()
      const updateResult = await env.DB.prepare(
        'UPDATE appointments SET starts_at = ?, ends_at = ?, updated_at = ? WHERE business_id = ? AND id = ? AND status = \'confirmed\' ' +
          'AND NOT EXISTS (SELECT 1 FROM appointments other WHERE other.business_id = ? AND other.team_member_id = appointments.team_member_id AND other.id <> appointments.id AND other.starts_at < ? AND other.ends_at > ? AND (other.status IN (\'confirmed\', \'completed\') OR (other.status = \'pending\' AND other.expires_at > ?))) ' +
          'RETURNING id',
      )
        .bind(startIso, newEnd, now, owner.business_id, appointmentId, owner.business_id, newEnd, startIso, now)
        .all<{ id: string }>()
      if (!updateResult.results?.length) return error('Não foi possível reagendar: confira se o horário está livre.', 409)
      await env.DB.prepare('INSERT INTO appointment_events (id, business_id, appointment_id, event_type, details, created_at) VALUES (?, ?, ?, \'rescheduled\', ?, ?)')
        .bind(newId(), owner.business_id, appointmentId, 'Novo horário: ' + startIso, now)
        .run()
      return response({ ok: true })
    }
    if (!update) return error('Essa ação não está disponível para o agendamento.')
    const changed = await update.all<{ id: string }>()
    if (!changed.results?.length) return error('O horário expirou ou foi ocupado por outro agendamento.', 409)
    await env.DB.prepare('INSERT INTO appointment_events (id, business_id, appointment_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId(), owner.business_id, appointmentId, eventType, eventDetails, now)
      .run()
    return response({ ok: true })
  }

  if (path === '/api/admin/customers' && request.method === 'POST') {
    const input = await body<{ name: string; phone?: string; email?: string; notes?: string }>(request)
    const name = clean(input?.name, 90)
    const rawPhone = clean(input?.phone, 30)
    const nationalPhone = normalizeBrazilPhone(rawPhone)
    const email = clean(input?.email, 160).toLowerCase()
    const notes = clean(input?.notes, 500)
    if (!name) return error('Informe o nome do cliente.')
    if (rawPhone && nationalPhone.length !== 10 && nationalPhone.length !== 11) return error('Informe um WhatsApp válido com DDD.')
    const phone = nationalPhone ? formatBrazilPhone(nationalPhone) : ''
    const customerId = newId()
    const phoneNormalized = uniquePhoneValue(nationalPhone, customerId)
    const timestamp = isoNow()
    await env.DB.prepare(
      'INSERT INTO customers (id, business_id, name, phone, phone_normalized, phone_match_key, email, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(customerId, owner.business_id, name, phone, phoneNormalized, nationalPhone, email, notes, timestamp, timestamp)
      .run()
    return response({ ok: true }, 201)
  }

  const customerMatch = path.match(/^\/api\/admin\/customers\/([^/]+)$/)
  if (customerMatch && request.method === 'PATCH') {
    const customerId = decodeURIComponent(customerMatch[1])
    const input = await body<{ name: string; phone?: string; email?: string; notes?: string }>(request)
    const name = clean(input?.name, 90)
    const rawPhone = clean(input?.phone, 30)
    const nationalPhone = normalizeBrazilPhone(rawPhone)
    const email = clean(input?.email, 160).toLowerCase()
    const notes = clean(input?.notes, 500)
    if (!name) return error('Informe o nome do cliente.')
    if (rawPhone && nationalPhone.length !== 10 && nationalPhone.length !== 11) return error('Informe um WhatsApp válido com DDD.')
    const existing = await env.DB.prepare('SELECT id FROM customers WHERE business_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1')
      .bind(owner.business_id, customerId)
      .first<{ id: string }>()
    if (!existing) return error('Cliente não encontrado.', 404)
    const phone = nationalPhone ? formatBrazilPhone(nationalPhone) : ''
    const phoneNormalized = uniquePhoneValue(nationalPhone, customerId)
    await env.DB.prepare('UPDATE customers SET name = ?, phone = ?, phone_normalized = ?, phone_match_key = ?, email = ?, notes = ?, updated_at = ? WHERE business_id = ? AND id = ?')
      .bind(name, phone, phoneNormalized, nationalPhone, email, notes, isoNow(), owner.business_id, customerId)
      .run()
    return response({ ok: true })
  }

  if (customerMatch && request.method === 'DELETE') {
    const customerId = decodeURIComponent(customerMatch[1])
    const now = isoNow()
    const removed = await env.DB.prepare(
      "UPDATE customers SET name = 'Contato excluído', phone = '', phone_normalized = 'deleted-' || id, phone_match_key = '', email = '', notes = '', deleted_at = ?, updated_at = ? WHERE business_id = ? AND id = ? AND deleted_at IS NULL RETURNING id",
    )
      .bind(now, now, owner.business_id, customerId)
      .all<{ id: string }>()
    if (!removed.results?.length) return error('Cliente não encontrado.', 404)
    return response({ ok: true })
  }

  if (path === '/api/admin/services' && request.method === 'POST') {
    const input = await body<{ name: string; description?: string; durationMinutes: number; priceCents: number }>(request)
    const name = clean(input?.name, 100)
    const duration = Number(input?.durationMinutes)
    const price = Number(input?.priceCents)
    if (!name || !Number.isInteger(duration) || duration < 5 || duration > 720 || !Number.isInteger(price) || price < 0) {
      return error('Confira nome, duração e preço do serviço.')
    }
    const timestamp = isoNow()
    await env.DB.prepare(
      'INSERT INTO services (id, business_id, name, description, duration_minutes, price_cents, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    )
      .bind(newId(), owner.business_id, name, clean(input?.description, 300), duration, price, timestamp, timestamp)
      .run()
    return response({ ok: true }, 201)
  }

  if (path === '/api/admin/products' && request.method === 'POST') {
    const input = await body<{ name: string; description?: string; priceCents: number }>(request)
    const name = clean(input?.name, 100)
    const price = Number(input?.priceCents)
    if (!name || !Number.isInteger(price) || price < 0) return error('Confira nome e preço do produto.')
    const timestamp = isoNow()
    await env.DB.prepare(
      'INSERT INTO products (id, business_id, name, description, price_cents, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    )
      .bind(newId(), owner.business_id, name, clean(input?.description, 300), price, timestamp, timestamp)
      .run()
    return response({ ok: true }, 201)
  }

  if (path === '/api/admin/finance' && request.method === 'POST') {
    const input = await body<{
      direction: 'receivable' | 'payable'
      categoryId: string
      customerId?: string
      appointmentId?: string
      productId?: string
      description: string
      amountCents: number
      dueDate: string
      paymentMethod?: string
    }>(request)
    const direction = input?.direction
    const categoryId = clean(input?.categoryId, 80)
    const description = clean(input?.description, 160)
    const amount = Number(input?.amountCents)
    const dueDate = clean(input?.dueDate, 10)
    if (!['receivable', 'payable'].includes(direction ?? '') || !categoryId || !description || !Number.isInteger(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return error('Confira tipo, categoria, descrição, valor e vencimento.')
    }
    const timestamp = isoNow()
    await env.DB.prepare(
      'INSERT INTO financial_entries (id, business_id, category_id, direction, customer_id, appointment_id, product_id, description, amount_cents, due_date, settled_at, payment_method, cancelled_at, created_at, updated_at) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM financial_categories WHERE business_id = ? AND id = ? AND direction = ?)',
    )
      .bind(
        newId(), owner.business_id, categoryId, direction, clean(input?.customerId, 80) || null,
        clean(input?.appointmentId, 80) || null, clean(input?.productId, 80) || null,
        description, amount, dueDate, clean(input?.paymentMethod, 40), timestamp, timestamp,
        owner.business_id, categoryId, direction,
      )
      .run()
    return response({ ok: true }, 201)
  }

  const financeMatch = path.match(/^\/api\/admin\/finance\/([^/]+)$/)
  if (financeMatch && request.method === 'PATCH') {
    const input = await body<{ action: 'settle' | 'cancel'; paymentMethod?: string }>(request)
    const timestamp = isoNow()
    if (input?.action === 'settle') {
      await env.DB.prepare('UPDATE financial_entries SET settled_at = ?, payment_method = ?, updated_at = ? WHERE business_id = ? AND id = ? AND settled_at IS NULL AND cancelled_at IS NULL')
        .bind(timestamp, clean(input.paymentMethod, 40), timestamp, owner.business_id, decodeURIComponent(financeMatch[1]))
        .run()
    } else if (input?.action === 'cancel') {
      await env.DB.prepare('UPDATE financial_entries SET cancelled_at = ?, updated_at = ? WHERE business_id = ? AND id = ? AND settled_at IS NULL AND cancelled_at IS NULL')
        .bind(timestamp, timestamp, owner.business_id, decodeURIComponent(financeMatch[1]))
        .run()
    } else {
      return error('Ação financeira inválida.')
    }
    return response({ ok: true })
  }

  return error('Ação não encontrada.', 404)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return new Response(null, { status: 404 })
    try {
      const auth = await handleAuth(request, env, url)
      if (auth) return auth
      const publicResponse = await handlePublic(request, env, url, ctx)
      if (publicResponse) return publicResponse
      if (url.pathname.startsWith('/api/admin/')) {
        if (request.method === 'GET') {
          const owner = await getOwner(request, env)
          if (!owner) return error('Sua sessão expirou. Entre novamente.', 401)
          const result = await adminData(owner, env, url.pathname)
          return result ?? error('Página não encontrada.', 404)
        }
        return (await handleAdmin(request, env, url)) ?? error('Página não encontrada.', 404)
      }
      return error('Página não encontrada.', 404)
    } catch (cause) {
      console.error('API failure', cause)
      return error('Não foi possível concluir essa operação agora.', 500)
    }
  },
}
