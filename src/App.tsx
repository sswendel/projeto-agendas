import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import './quality.css'

type Owner = {
  user: { id: string; email: string; name: string }
  business: { id: string; name: string; slug: string; whatsappPhone: string; timezone: string }
}
type Service = { id: string; name: string; description: string; duration_minutes: number; price_cents: number; active: number }
type Customer = { id: string; name: string; phone: string; email: string; notes: string; created_at?: string }
type Product = { id: string; name: string; description: string; price_cents: number; active: number }
type Appointment = {
  id: string
  customer_id: string
  service_id: string
  team_member_id: string
  team_member_name: string
  service_name: string
  duration_minutes_snapshot: number
  price_cents_snapshot: number
  starts_at: string
  ends_at: string
  status: string
  source: string
  notes: string
  expires_at: string | null
  customer_name: string
  customer_phone: string
  customer_email: string
}
type FinanceEntry = {
  id: string
  direction: 'receivable' | 'payable'
  description: string
  amount_cents: number
  due_date: string
  settled_at: string | null
  payment_method: string
  cancelled_at: string | null
  category_name: string
  customer_name: string | null
  product_name: string | null
  service_name: string | null
  status: 'pending' | 'overdue' | 'settled' | 'cancelled'
}
type Category = { id: string; name: string; direction: 'receivable' | 'payable' }
type Slot = { startsAt: string; endsAt: string; time: string; teamMemberId: string; teamMemberName?: string }
type TeamMember = { id: string; name: string; is_owner: number; active: number }
type AvailabilityWindow = { weekday: number; startTime: string; endTime: string }
type BusinessPage = {
  id: string
  slug: string
  name: string
  description: string
  whatsapp_phone: string
  timezone: string
  services: Service[]
  teamMembers: Array<{ id: string; name: string }>
}
type CreatedRequest = {
  id: string
  status: string
  expiresAt: string
  trackingToken: string
  businessName: string
  whatsappPhone: string
  serviceName: string
  teamMemberName: string
  startsAt: string
  endsAt: string
  approvalPath: string
  trackingPath: string
}
type PublicRequestStatus = {
  business_name: string
  business_slug: string
  timezone: string
  service_name_snapshot: string
  starts_at: string
  status: string
}

type ApiOptions = { method?: string; body?: unknown }
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const result = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const data = (await result.json().catch(() => ({}))) as T & { error?: string }
  if (!result.ok) throw new Error(data.error ?? 'Não foi possível concluir essa operação.')
  return data
}

function money(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100)
}

function dateLong(value: string, timezone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', timeZone: timezone }).format(new Date(value))
}

function dateShort(value: string, timezone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: timezone }).format(new Date(value))
}

function timeOf(value: string, timezone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(value))
}

function localToday(timezone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

function shiftDateKey(value: string, amount: number, unit: 'day' | 'week' | 'month' = 'day'): string {
  const date = new Date(value + 'T12:00:00Z')
  if (unit === 'month') {
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + amount)
  } else {
    date.setUTCDate(date.getUTCDate() + amount * (unit === 'week' ? 7 : 1))
  }
  return date.toISOString().slice(0, 10)
}

function mondayOf(value: string): string {
  const weekday = new Date(value + 'T12:00:00Z').getUTCDay()
  return shiftDateKey(value, -((weekday + 6) % 7))
}

function formatDateKey(value: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('pt-BR', { ...options, timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z'))
}

function appointmentDateKey(appointment: Appointment, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(appointment.starts_at))
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function timeLabelFromMinutes(value: number): string {
  const hour = Math.floor(value / 60).toString().padStart(2, '0')
  const minute = (value % 60).toString().padStart(2, '0')
  return hour + ':' + minute
}

function initials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}

function brazilNationalDigits(value: string): string {
  let digits = value.replace(/\D/g, '')
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2)
  return digits.slice(0, 11)
}

function formatBrazilNationalPhone(value: string): string {
  const digits = brazilNationalDigits(value)
  if (digits.length <= 2) return digits
  const area = digits.slice(0, 2)
  const subscriber = digits.slice(2)
  if (subscriber.length <= 4) return '(' + area + ') ' + subscriber
  return '(' + area + ') ' + subscriber.slice(0, -4) + '-' + subscriber.slice(-4)
}

function brazilPhoneE164(value: string): string {
  const digits = brazilNationalDigits(value)
  return digits ? '+55' + digits : ''
}

function whatsappNumber(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits
  return digits.length === 10 || digits.length === 11 ? '55' + digits : ''
}

function BrazilPhoneInput({ label, name, value, onChange, required = false, placeholder = '(11) 99999-9999' }: {
  label: string
  name?: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  placeholder?: string
}) {
  return <label>{label}<span className="country-phone-field"><span aria-hidden="true">+55</span><input name={name} type="tel" inputMode="tel" autoComplete="tel-national" required={required} value={formatBrazilNationalPhone(value)} onChange={(event) => onChange(brazilNationalDigits(event.target.value))} placeholder={placeholder} /></span></label>
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Aguardando aprovação',
    confirmed: 'Confirmado',
    declined: 'Recusado',
    cancelled: 'Cancelado',
    completed: 'Concluído',
    expired: 'Expirado',
    overdue: 'Vencido',
    settled: 'Pago',
  }
  return labels[status] ?? status
}

function Icon({ name, size = 19 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
    calendar: 'M7 2v4 M17 2v4 M3 9h18 M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    people: 'M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
    service: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.9 6.9a2.12 2.12 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.94-7.94z',
    box: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7 12 12l8.7-5 M12 22V12',
    wallet: 'M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v10a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V6 M16 14h.01 M20 12h-4a2 2 0 0 0 0 4h4',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-1.5 2.6-.09-.02a1.65 1.65 0 0 0-1.75.83l-.04.08h-3l-.04-.08a1.65 1.65 0 0 0-1.75-.83l-.09.02-1.5-2.6.06-.06A1.65 1.65 0 0 0 10.4 15l-.08-.04v-3l.08-.04a1.65 1.65 0 0 0 .33-1.82l-.06-.06 1.5-2.6.09.02a1.65 1.65 0 0 0 1.75-.83l.04-.08h3l.04.08a1.65 1.65 0 0 0 1.75.83l.09-.02 1.5 2.6-.06.06A1.65 1.65 0 0 0 20.4 12l.08.04v3z',
    plus: 'M12 5v14 M5 12h14',
    edit: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z',
    trash: 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6 M10 11v5 M14 11v5',
    arrow: 'M5 12h14 M12 5l7 7-7 7',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35',
    check: 'M20 6 9 17l-5-5',
    close: 'M18 6 6 18 M6 6l12 12',
    clock: 'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
    link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
    menu: 'M4 6h16 M4 12h16 M4 18h16',
    trend: 'M3 3v18h18 M19 9l-5 5-4-4-5 5',
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.grid} />
    </svg>
  )
}

function Alert({ children, tone = 'error' }: { children: React.ReactNode; tone?: 'error' | 'success' | 'info' }) {
  return <div className={'alert alert-' + tone} role="status">{children}</div>
}

function Login({ onLogin, onRegister }: { onLogin: (email: string, password: string) => Promise<void>; onRegister: (values: { businessName: string; ownerName: string; email: string; password: string }) => Promise<void> }) {
  const [registerMode, setRegisterMode] = useState(false)
  const [email, setEmail] = useState(import.meta.env.DEV ? 'demo@agendas.local' : '')
  const [password, setPassword] = useState(import.meta.env.DEV ? 'AgendaLocal2026!' : '')
  const [businessName, setBusinessName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setErrorMessage('')
    setBusy(true)
    try {
      if (registerMode) await onRegister({ businessName, ownerName, email, password })
      else await onLogin(email, password)
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Não foi possível entrar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-brand"><div className="brand-mark"><Icon name="calendar" size={21} /></div><span>agendas<span className="brand-dot">.</span></span></div>
      <div className="auth-layout">
        <section className="auth-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> Organização que acompanha você</div>
          <h1>Seu trabalho tem hora marcada.<br /><em>Sua rotina também.</em></h1>
          <p>Agendamentos, clientes e financeiro em um só lugar, com a simplicidade que o seu dia precisa.</p>
          <div className="auth-proof">
            <div className="avatar-stack"><span>MC</span><span>RS</span><span>BL</span><b>+</b></div>
            <div><strong>Feito para quem atende</strong><small>Uma rotina mais leve começa aqui</small></div>
          </div>
          <div className="auth-decoration"><div className="decor-card"><span className="decor-check"><Icon name="check" size={14} /></span><div><strong>Agenda confirmada</strong><small>Seu próximo horário está organizado</small></div><span className="decor-time">10:30</span></div><div className="decor-orbit orbit-one" /><div className="decor-orbit orbit-two" /></div>
        </section>
        <section className="auth-card">
          <div className="auth-card-top"><div className="auth-card-icon"><Icon name={registerMode ? 'plus' : 'grid'} size={20} /></div><span className="secure-label"><span /> Acesso seguro</span></div>
          <h2>{registerMode ? 'Crie sua conta' : 'Boas-vindas de volta'}</h2>
          <p className="auth-subtitle">{registerMode ? 'Configure seu espaço para começar a organizar sua rotina.' : 'Entre para acompanhar sua agenda e cuidar do seu negócio.'}</p>
          {errorMessage && <Alert>{errorMessage}</Alert>}
          <form onSubmit={submit} className="form-stack">
            {registerMode && <>
              <label>Nome do negócio<input required value={businessName} onChange={(event) => setBusinessName(event.target.value)} placeholder="Ex.: Ateliê Horizonte" /></label>
              <label>Seu nome<input required value={ownerName} onChange={(event) => setOwnerName(event.target.value)} placeholder="Como podemos chamar você?" /></label>
            </>}
            <label>E-mail<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@exemplo.com" /></label>
            <label>Senha<input type="password" autoComplete={registerMode ? 'new-password' : 'current-password'} required minLength={registerMode ? 12 : 1} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" /></label>
            {registerMode && <small className="field-hint">Use pelo menos 12 caracteres. O acesso terá um profissional por conta.</small>}
            <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Aguarde...' : registerMode ? 'Criar minha conta' : 'Entrar na plataforma'}<Icon name="arrow" size={17} /></button>
          </form>
          {!registerMode && import.meta.env.DEV && <div className="demo-hint"><span className="demo-dot" /> Demonstração local <span className="demo-divider" /> demo@agendas.local <span className="demo-divider" /> AgendaLocal2026!</div>}
          <div className="auth-switch">{registerMode ? 'Já tem uma conta?' : 'Primeira vez por aqui?'} <button onClick={() => { setRegisterMode(!registerMode); setErrorMessage('') }}>{registerMode ? 'Entrar' : 'Criar conta'}</button></div>
          <div className="auth-foot"><span>© 2026 Agendas</span><span>Privacidade · Ajuda</span></div>
        </section>
      </div>
    </main>
  )
}

function PublicBooking({ slug }: { slug: string }) {
  const [business, setBusiness] = useState<BusinessPage | null>(null)
  const [serviceId, setServiceId] = useState('')
  const [teamMemberId, setTeamMemberId] = useState('any')
  const [date, setDate] = useState('')
  const [slots, setSlots] = useState<Slot[]>([])
  const [selectedSlot, setSelectedSlot] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [created, setCreated] = useState<CreatedRequest | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [redirectCancelled, setRedirectCancelled] = useState(false)
  const [secondsUntilWhatsApp, setSecondsUntilWhatsApp] = useState(3)
  const whatsAppLinkRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    api<BusinessPage>('/api/public/business/' + encodeURIComponent(slug))
      .then((result) => {
        setBusiness(result)
        setServiceId(result.services[0]?.id ?? '')
        setDate(localToday(result.timezone))
      })
      .catch((cause) => setErrorMessage(cause instanceof Error ? cause.message : 'Página não encontrada.'))
  }, [slug])

  useEffect(() => {
    if (!business || !serviceId || !date || created) return
    setSlots([])
    setSelectedSlot('')
    api<{ slots: Slot[] }>('/api/public/availability?slug=' + encodeURIComponent(slug) + '&serviceId=' + encodeURIComponent(serviceId) + '&date=' + encodeURIComponent(date) + '&teamMemberId=' + encodeURIComponent(teamMemberId))
      .then((result) => setSlots(result.slots))
      .catch((cause) => setErrorMessage(cause instanceof Error ? cause.message : 'Não foi possível consultar os horários.'))
  }, [business, serviceId, date, teamMemberId, slug, created])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!selectedSlot) {
      setErrorMessage('Escolha um horário para continuar.')
      return
    }
    setBusy(true)
    setErrorMessage('')
    try {
      const result = await api<CreatedRequest>('/api/public/appointments', {
        method: 'POST',
        body: { slug, serviceId, teamMemberId: slots.find((slot) => slot.startsAt === selectedSlot)?.teamMemberId, startsAt: selectedSlot, customerName, phone: brazilPhoneE164(phone), email },
      })
      setCreated(result)
      setRedirectCancelled(false)
      setSecondsUntilWhatsApp(3)
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Não foi possível enviar a solicitação.')
    } finally {
      setBusy(false)
    }
  }

  const requestText = created && business
    ? 'Olá! Gostaria de solicitar um horário.\n\n' +
      'Nome: ' + customerName + '\n' +
      'Telefone: ' + brazilPhoneE164(phone) + '\n' +
      'Serviço: ' + created.serviceName + '\n' +
      'Profissional: ' + created.teamMemberName + '\n' +
      'Data: ' + dateLong(created.startsAt, business.timezone) + ' às ' + timeOf(created.startsAt, business.timezone) + '\n\n' +
      'Aprovar ou recusar no app: ' + window.location.origin + created.approvalPath
    : ''
  const businessWhatsApp = created ? whatsappNumber(created.whatsappPhone) : ''
  const whatsappHref = businessWhatsApp
    ? 'https://wa.me/' + businessWhatsApp + '?text=' + encodeURIComponent(requestText)
    : ''

  useEffect(() => {
    if (!created || !whatsappHref || redirectCancelled) return
    const timeout = window.setTimeout(() => whatsAppLinkRef.current?.click(), 3000)
    const interval = window.setInterval(() => setSecondsUntilWhatsApp((seconds) => Math.max(0, seconds - 1)), 1000)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(interval)
    }
  }, [created, redirectCancelled, whatsappHref])

  return (
    <main className="public-page">
      <header className="public-header"><a className="public-brand" href="/"><span className="brand-mark"><Icon name="calendar" size={19} /></span> agendas<span className="brand-dot">.</span></a><span className="public-secure"><span /> Agendamento seguro</span></header>
      <section className="public-layout">
        <div className="public-intro">
          <div className="eyebrow"><span className="eyebrow-dot" /> RESERVE SEU HORÁRIO</div>
          <h1>Um tempo para<br /><em>você.</em></h1>
          <p>Escolha o serviço e o melhor horário. Sua solicitação será confirmada pelo profissional em até 30 minutos.</p>
          <div className="public-trust"><span className="trust-icon"><Icon name="check" size={16} /></span><span>Sem pagamento antecipado<br /><small>Você só confirma a solicitação pelo WhatsApp</small></span></div>
          <div className="public-doodle"><div className="doodle-ring" /><div className="doodle-square" /><div className="doodle-star">✳</div></div>
        </div>
        <div className="booking-card">
          {!business && !errorMessage && <div className="loading-state">Preparando a página...</div>}
          {errorMessage && !business && <Alert>{errorMessage}</Alert>}
          {business && !created && <>
            <div className="booking-business"><div className="business-avatar">{initials(business.name)}</div><div><span className="business-label">Atendimento com</span><h2>{business.name}</h2></div><span className="business-live"><span /> Disponível</span></div>
            <p className="business-description">{business.description || 'Escolha um serviço e encontre um horário que funcione para você.'}</p>
            <div className="booking-divider" />
            <form className="booking-form" onSubmit={submit}>
              <div className="form-heading"><span className="step-number">01</span><div><strong>Escolha o serviço</strong><small>Selecione o tipo de atendimento</small></div></div>
              <div className="service-options">
                {business.services.map((item) => (
                  <button type="button" key={item.id} className={'service-option ' + (serviceId === item.id ? 'selected' : '')} onClick={() => setServiceId(item.id)}>
                    <span className="service-radio">{serviceId === item.id && <i />}</span>
                    <span className="service-copy"><strong>{item.name}</strong><small>{item.duration_minutes} min · {item.description}</small></span>
                    <span className="service-price">{item.price_cents === 0 ? 'A combinar' : money(item.price_cents)}</span>
                  </button>
                ))}
              </div>
              {business.teamMembers.length > 1 && <label className="date-field">Profissional<select value={teamMemberId} onChange={(event) => { setTeamMemberId(event.target.value); setSelectedSlot('') }}><option value="any">Qualquer profissional disponível</option>{business.teamMembers.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
              <div className="form-heading booking-second"><span className="step-number">02</span><div><strong>Escolha dia e horário</strong><small>Horários no fuso do profissional</small></div></div>
              <label className="date-field">Data<input type="date" required value={date} min={business ? localToday(business.timezone) : undefined} onChange={(event) => setDate(event.target.value)} /></label>
              <div className="slot-grid">
                {slots.length ? slots.map((slot) => <button key={slot.startsAt} type="button" className={'slot-button ' + (selectedSlot === slot.startsAt ? 'selected' : '')} onClick={() => setSelectedSlot(slot.startsAt)}>{slot.time}</button>) : <div className="empty-slots">{date ? 'Não há horários disponíveis nesta data. Tente outro dia.' : 'Escolha uma data para ver os horários.'}</div>}
              </div>
              <div className="form-heading booking-second"><span className="step-number">03</span><div><strong>Seus dados</strong><small>Para o profissional reconhecer sua solicitação</small></div></div>
              <div className="booking-fields">
                <label>Nome completo<input required value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Seu nome" autoComplete="name" /></label>
                <div className="two-fields"><BrazilPhoneInput label="WhatsApp" value={phone} onChange={setPhone} required /><label>E-mail <span className="optional-label">opcional</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@email.com" autoComplete="email" /></label></div>
              </div>
              {errorMessage && <Alert>{errorMessage}</Alert>}
              <button className="button button-primary button-wide" disabled={busy || !serviceId}>{busy ? 'Enviando solicitação...' : 'Solicitar este horário'}<Icon name="arrow" size={17} /></button>
              <p className="privacy-note">Ao continuar, seus dados serão compartilhados com o profissional para este atendimento.</p>
            </form>
          </>}
          {business && created && <div className="request-success">
            <div className="success-mark"><Icon name="check" size={26} /></div>
            <div className="eyebrow"><span className="eyebrow-dot" /> PEDIDO REGISTRADO</div>
            <h2>Seu horário está<br /><em>aguardando aprovação.</em></h2>
            <p>Seu pedido foi registrado e o horário fica reservado por 30 minutos enquanto o profissional avalia.</p>
            <div className="booking-confirmation-summary"><div><span>Serviço</span><strong>{created.serviceName}</strong></div><div><span>Profissional</span><strong>{created.teamMemberName}</strong></div><div><span>Data e horário</span><strong>{dateLong(created.startsAt, business.timezone)} · {timeOf(created.startsAt, business.timezone)}</strong></div><div><span>Situação</span><strong className="status-pending">{statusLabel(created.status)}</strong></div></div>
            {whatsappHref ? <div className="whatsapp-next-step"><p>{redirectCancelled ? 'Se o WhatsApp não abrir, toque no botão abaixo.' : `Abrindo o WhatsApp em ${secondsUntilWhatsApp} ${secondsUntilWhatsApp === 1 ? 'segundo' : 'segundos'}…`}</p><a ref={whatsAppLinkRef} className="button button-whatsapp button-wide" href={whatsappHref} onClick={() => setRedirectCancelled(true)}><span className="whatsapp-mark">◉</span> Abrir WhatsApp agora<Icon name="arrow" size={17} /></a>{!redirectCancelled && <button className="text-button cancel-whatsapp-redirect" onClick={() => setRedirectCancelled(true)}>Continuar nesta página</button>}</div> : <Alert tone="info">O WhatsApp deste profissional ainda não está configurado corretamente. Seu pedido está registrado; use o acompanhamento abaixo ou entre em contato com o profissional.</Alert>}
            <a className="tracking-link" href={created.trackingPath}>Acompanhar meu pedido <Icon name="arrow" size={15} /></a>
            <p className="privacy-note">A mensagem será aberta já preenchida. Toque em Enviar no WhatsApp para avisar o profissional; o pedido não é enviado automaticamente.</p>
          </div>}
        </div>
      </section>
      <footer className="public-footer"><span>Agendas <span className="brand-dot">.</span></span><span>Uma forma simples de organizar o que importa.</span><span>© 2026</span></footer>
    </main>
  )
}

function PublicStatus({ token }: { token: string }) {
  const [status, setStatus] = useState<PublicRequestStatus | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  useEffect(() => {
    api<PublicRequestStatus>('/api/public/requests/' + encodeURIComponent(token))
      .then(setStatus)
      .catch((cause) => setErrorMessage(cause instanceof Error ? cause.message : 'Link inválido.'))
  }, [token])
  const copy = status?.status === 'confirmed'
    ? { title: 'Seu horário está confirmado.', description: 'O profissional confirmou este atendimento. Guarde a data e o horário abaixo.' }
    : status?.status === 'declined'
      ? { title: 'Este horário não pôde ser confirmado.', description: 'Fale com o profissional ou escolha outro horário pela página do negócio.' }
      : status?.status === 'expired'
        ? { title: 'O prazo da solicitação terminou.', description: 'O horário não ficou confirmado. Você pode enviar um novo pedido pela página do negócio.' }
        : status?.status === 'cancelled'
          ? { title: 'Este horário foi cancelado.', description: 'Entre em contato com o profissional se precisar combinar outro horário.' }
          : status?.status === 'completed'
            ? { title: 'Atendimento concluído.', description: 'Este atendimento já foi realizado.' }
            : { title: 'Sua solicitação está em análise.', description: 'O horário fica reservado por até 30 minutos enquanto o profissional responde. Volte a esta página para conferir a situação.' }
  return (
    <main className="status-page">
      <a className="public-brand" href={status ? '/p/' + encodeURIComponent(status.business_slug) : '/'}><span className="brand-mark"><Icon name="calendar" size={19} /></span> agendas<span className="brand-dot">.</span></a>
      <section className="status-card">
        {errorMessage ? <Alert>{errorMessage}</Alert> : !status ? <div className="loading-state">Consultando seu pedido...</div> : <>
          <div className={'success-mark ' + (status.status === 'confirmed' ? '' : 'muted-mark')}><Icon name={status.status === 'confirmed' ? 'check' : 'clock'} size={25} /></div>
          <div className="eyebrow"><span className="eyebrow-dot" /> ACOMPANHAMENTO DO HORÁRIO</div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
          <div className="tracking-business"><span>Atendimento com</span><strong>{status.business_name}</strong></div>
          <div className="tracking-summary">
            <div><span>Serviço</span><strong>{status.service_name_snapshot}</strong></div>
            <div><span>Data</span><strong>{dateLong(status.starts_at, status.timezone)}</strong></div>
            <div><span>Horário</span><strong>{timeOf(status.starts_at, status.timezone)}</strong></div>
            <div><span>Situação</span><strong className={'status-' + status.status}>{statusLabel(status.status)}</strong></div>
          </div>
          <a className="button button-secondary button-wide" href={'/p/' + encodeURIComponent(status.business_slug)}>Voltar para a página do negócio</a>
        </>}
      </section>
      <p className="status-foot">Guarde este link para acompanhar sua solicitação.</p>
    </main>
  )
}

function Sidebar({ owner, view, setView, logout, openPublic }: { owner: Owner; view: string; setView: (view: string) => void; logout: () => void; openPublic: () => void }) {
  const nav = [
    { id: 'overview', label: 'Visão geral', icon: 'grid', group: 'INÍCIO' },
    { id: 'appointments', label: 'Agenda', icon: 'calendar', group: 'ROTINA' },
    { id: 'customers', label: 'Clientes', icon: 'people', group: 'ROTINA' },
    { id: 'services', label: 'Serviços', icon: 'service', group: 'CADASTROS' },
    { id: 'products', label: 'Produtos', icon: 'box', group: 'CADASTROS' },
    { id: 'finance', label: 'Financeiro', icon: 'wallet', group: 'GESTÃO' },
    { id: 'settings', label: 'Configurações', icon: 'settings', group: 'GESTÃO' },
  ]
  return (
    <aside className="sidebar">
      <a className="sidebar-brand" href="/"><span className="brand-mark"><Icon name="calendar" size={20} /></span><span>agendas<span className="brand-dot">.</span></span></a>
      <div className="workspace-card"><div className="workspace-avatar">{initials(owner.business.name)}</div><div className="workspace-details"><strong>{owner.business.name}</strong><small>Conta profissional</small></div><span className="workspace-chevron">⌄</span></div>
      <nav className="side-nav">
        {nav.map((item, index) => (
          <div key={item.id}>
            {(index === 0 || nav[index - 1].group !== item.group) && <div className="nav-group">{item.group}</div>}
            <button className={'nav-item ' + (view === item.id ? 'active' : '')} onClick={() => setView(item.id)}><Icon name={item.icon} size={18} /><span>{item.label}</span>{item.id === 'appointments' && <span className="nav-notification" />}</button>
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className="public-link-button" onClick={openPublic}><span className="public-link-icon"><Icon name="link" size={17} /></span><span><strong>Sua página pública</strong><small>Compartilhe seu link</small></span><Icon name="arrow" size={14} /></button>
        <div className="sidebar-user"><div className="user-avatar">{initials(owner.user.name)}</div><div className="sidebar-user-copy"><strong>{owner.user.name}</strong><small>{owner.user.email}</small></div><button className="icon-button" aria-label="Sair" onClick={logout}><Icon name="logout" size={17} /></button></div>
      </div>
    </aside>
  )
}

function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="page-title"><div><div className="eyebrow"><span className="eyebrow-dot" /> {eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>
}

function StatCard({ label, value, change, icon, tone }: { label: string; value: string; change?: string; icon: string; tone: string }) {
  return <div className="stat-card"><div className={'stat-icon ' + tone}><Icon name={icon} size={19} /></div><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{change && <span className="stat-change">{change}</span>}</div>
}

function AppointmentLine({ appointment, timezone, onAction, onOpen }: { appointment: Appointment; timezone: string; onAction: (id: string, action: string) => Promise<void>; onOpen: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  async function act(action: string) {
    setBusy(true)
    try { await onAction(appointment.id, action) } finally { setBusy(false) }
  }
  return (
    <div className="appointment-line">
      <div className="appointment-time"><strong>{timeOf(appointment.starts_at, timezone)}</strong><span>{dateShort(appointment.starts_at, timezone)}</span></div>
      <div className="appointment-avatar">{initials(appointment.customer_name)}</div>
      <div className="appointment-main"><button className="text-button appointment-customer" onClick={() => onOpen(appointment.id)}>{appointment.customer_name}</button><span>{appointment.service_name}</span></div>
      <span className={'status-pill status-' + appointment.status}><i />{statusLabel(appointment.status)}</span>
      <div className="appointment-actions">
        {appointment.status === 'pending' && <><button className="small-action approve" disabled={busy} onClick={() => act('confirm')} aria-label="Aprovar e abrir WhatsApp"><Icon name="check" size={15} /></button><button className="small-action decline" disabled={busy} onClick={() => act('decline')} aria-label="Recusar e abrir WhatsApp"><Icon name="close" size={15} /></button></>}
        {appointment.status === 'confirmed' && <button className="small-action complete" disabled={busy} onClick={() => act('complete')}>Concluir</button>}
      </div>
    </div>
  )
}

function App() {
  const [owner, setOwner] = useState<Owner | null>(null)
  const [view, setView] = useState('overview')
  const [route, setRoute] = useState(window.location.pathname)
  const [dataVersion, setDataVersion] = useState(0)
  const [overview, setOverview] = useState<{ counts: { pending: number; today: number; customers: number }; money: { receivableCents: number; payableCents: number; receivedThisMonthCents: number; paidThisMonthCents: number }; upcoming: Appointment[] } | null>(null)
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [finance, setFinance] = useState<{ entries: FinanceEntry[]; categories: Category[] }>({ entries: [], categories: [] })
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)

  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', captureInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', captureInstallPrompt)
  }, [])

  const routeMatch = route.match(/^\/p\/([^/]+)$/)
  const statusMatch = route.match(/^\/pedido\/([^/]+)$/)
  const approvalMatch = route.match(/^\/solicitacoes\/([^/]+)$/)
  const publicSlug = routeMatch ? decodeURIComponent(routeMatch[1]) : null
  const trackingToken = statusMatch ? decodeURIComponent(statusMatch[1]) : null
  const approvalId = approvalMatch ? decodeURIComponent(approvalMatch[1]) : null

  useEffect(() => {
    if (!owner) return
    const key = 'agendas:guide:v1:' + owner.user.id
    try {
      if (window.localStorage.getItem(key) !== 'seen') {
        setView('overview')
        setShowGuide(true)
      }
    } catch {
      setView('overview')
      setShowGuide(true)
    }
  }, [owner?.user.id])

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path)
    setRoute(path)
    setMobileNav(false)
    setMessage('')
    setErrorMessage('')
  }, [])

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (publicSlug || trackingToken) {
      setLoading(false)
      return
    }
    api<Owner>('/api/auth/me')
      .then((result) => setOwner(result))
      .catch(() => setOwner(null))
      .finally(() => setLoading(false))
  }, [publicSlug, trackingToken])

  const refresh = useCallback(() => setDataVersion((version) => version + 1), [])
  useEffect(() => {
    if (!owner) return
    let active = true
    Promise.all([
      api<typeof overview>('/api/admin/overview'),
      api<Appointment[]>('/api/admin/appointments'),
      api<Customer[]>('/api/admin/customers'),
      api<Service[]>('/api/admin/services'),
      api<Product[]>('/api/admin/products'),
      api<typeof finance>('/api/admin/finance'),
    ])
      .then(([summary, agenda, clientList, serviceList, productList, financeData]) => {
        if (!active) return
        setOverview(summary)
        setAppointments(agenda)
        setCustomers(clientList)
        setServices(serviceList)
        setProducts(productList)
        setFinance(financeData)
      })
      .catch((cause) => {
        if (active) setErrorMessage(cause instanceof Error ? cause.message : 'Não foi possível carregar os dados.')
      })
    return () => { active = false }
  }, [owner, dataVersion])

  async function login(email: string, password: string) {
    const result = await api<Owner>('/api/auth/login', { method: 'POST', body: { email, password } })
    setOwner(result)
    setView(approvalId ? 'appointments' : 'overview')
  }

  async function register(values: { businessName: string; ownerName: string; email: string; password: string }) {
    const result = await api<Owner>('/api/auth/register', { method: 'POST', body: values })
    setOwner(result)
    setView('overview')
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' })
    setOwner(null)
    setView('overview')
  }

  async function action(path: string, method: string, body?: unknown, successMessage = 'Alteração salva com sucesso.') {
    setErrorMessage('')
    setMessage('')
    try {
      await api(path, { method, body })
      setMessage(successMessage)
      refresh()
    } catch (cause) {
      setErrorMessage(cause instanceof Error ? cause.message : 'Não foi possível salvar.')
      throw cause
    }
  }

  async function handleAppointmentAction(id: string, actionName: string) {
    if (!owner) throw new Error('Entre na sua conta para atualizar o agendamento.')
    const appointment = appointments.find((item) => item.id === id)
    const successMessage = actionName === 'confirm' ? 'Horário confirmado.' : actionName === 'decline' ? 'Solicitação recusada.' : 'Alteração salva com sucesso.'
    await action('/api/admin/appointments/' + id, 'PATCH', { action: actionName }, successMessage)
    if (actionName !== 'confirm' && actionName !== 'decline') return

    const customerNumber = appointment ? whatsappNumber(appointment.customer_phone) : ''
    if (!appointment || !customerNumber) {
      setMessage('Status atualizado, mas este cliente não tem um WhatsApp válido cadastrado.')
      return
    }

    const date = dateLong(appointment.starts_at, owner.business.timezone)
    const time = timeOf(appointment.starts_at, owner.business.timezone)
    const customerName = appointment.customer_name.trim().split(/\s+/)[0] || 'tudo bem'
    const messageText = actionName === 'confirm'
      ? `Olá, *${customerName}*!\n\nSeu horário está *confirmado* ✅\n\n*Serviço:* ${appointment.service_name}\n*Profissional:* ${appointment.team_member_name}\n*Data e horário:* ${date} às ${time}\n\nTe esperamos!\n— ${owner.business.name}`
      : `Olá, *${customerName}*.\n\nInfelizmente, não conseguimos confirmar este horário.\n\n*Serviço:* ${appointment.service_name}\n*Data e horário:* ${date} às ${time}\n\nPedimos desculpas pelo transtorno. Se quiser combinar outro horário, é só responder a esta mensagem.\n\n— ${owner.business.name}`
    window.location.assign('https://wa.me/' + customerNumber + '?text=' + encodeURIComponent(messageText))
  }

  const pendingAppointments = useMemo(() => appointments.filter((item) => item.status === 'pending'), [appointments])
  if (publicSlug) return <PublicBooking slug={publicSlug} />
  if (trackingToken) return <PublicStatus token={trackingToken} />
  if (loading) return <div className="full-loading"><div className="loading-spinner" /><span>Preparando sua agenda...</span></div>
  if (!owner) return <Login onLogin={login} onRegister={register} />

  const timezone = owner.business.timezone
  const isPublicLink = () => navigate('/p/' + encodeURIComponent(owner.business.slug))
  const goTo = (next: string) => { setView(next); navigate('/') }
  const closeGuide = () => {
    try { window.localStorage.setItem('agendas:guide:v1:' + owner.user.id, 'seen') } catch { /* local storage may be unavailable */ }
    setShowGuide(false)
  }

  return (
    <div className="app-shell">
      {mobileNav && <button className="mobile-shade" aria-label="Fechar menu" onClick={() => setMobileNav(false)} />}
      <Sidebar owner={owner} view={view} setView={goTo} logout={logout} openPublic={isPublicLink} />
      {mobileNav && <div className="mobile-sidebar"><Sidebar owner={owner} view={view} setView={goTo} logout={logout} openPublic={isPublicLink} /></div>}
      <main className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" aria-label="Abrir menu" onClick={() => setMobileNav(true)}><Icon name="menu" /></button>
          <div className="breadcrumb"><span>Seu espaço</span><i>/</i><strong>{view === 'overview' ? 'Visão geral' : view === 'appointments' ? 'Agenda' : view === 'customers' ? 'Clientes' : view === 'services' ? 'Serviços' : view === 'products' ? 'Produtos' : view === 'finance' ? 'Financeiro' : 'Configurações'}</strong></div>
          <div className="topbar-actions"><button className="topbar-guide" onClick={() => { setView('overview'); setShowGuide(true) }} aria-label="Abrir guia de uso"><span className="guide-mark">?</span><span>Como usar</span></button><button className="topbar-public-link" onClick={isPublicLink}><Icon name="link" size={16} /> Página pública</button><span className="topbar-date">{new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' }).format(new Date())}</span><div className="user-avatar topbar-avatar">{initials(owner.user.name)}</div></div>
        </header>
        {message && <div className="toast toast-success" role="status" aria-live="polite"><Icon name="check" size={16} />{message}<button onClick={() => setMessage('')} aria-label="Fechar"><Icon name="close" size={14} /></button></div>}
        {errorMessage && <div className="toast toast-error" role="alert"><span>{errorMessage}</span><button onClick={() => setErrorMessage('')} aria-label="Fechar"><Icon name="close" size={14} /></button></div>}
        <div className="page-content">
          {view === 'overview' && <OverviewPage owner={owner} summary={overview} appointments={appointments} customers={customers} services={services} timezone={timezone} onAction={handleAppointmentAction} onOpen={(id) => navigate('/solicitacoes/' + id)} onCreate={(form) => action('/api/admin/appointments', 'POST', form, 'Agendamento criado e confirmado.')} onSetupAvailability={() => goTo('settings')} setView={setView} />}
          {view === 'appointments' && <AgendaPage appointments={appointments} pending={pendingAppointments} customers={customers} services={services} timezone={timezone} focusId={approvalId ?? undefined} onAction={handleAppointmentAction} onReschedule={(id, startsAt) => action('/api/admin/appointments/' + id, 'PATCH', { action: 'reschedule', startsAt })} onCreate={(form) => action('/api/admin/appointments', 'POST', form, 'Agendamento criado e confirmado.')} onSetupAvailability={() => goTo('settings')} />}
          {view === 'customers' && <CustomersPage customers={customers} onCreate={(form) => action('/api/admin/customers', 'POST', form, 'Cliente cadastrado com sucesso.')} onUpdate={(id, form) => action('/api/admin/customers/' + encodeURIComponent(id), 'PATCH', form, 'Dados do cliente atualizados.')} onDelete={(id) => action('/api/admin/customers/' + encodeURIComponent(id), 'DELETE', undefined, 'Contato excluído. O histórico de agendamentos foi preservado.')} />}
          {view === 'services' && <ServicesPage services={services} onCreate={(form) => action('/api/admin/services', 'POST', form, 'Serviço cadastrado com sucesso.')} />}
          {view === 'products' && <ProductsPage products={products} onCreate={(form) => action('/api/admin/products', 'POST', form, 'Produto cadastrado com sucesso.')} />}
          {view === 'finance' && <FinancePage finance={finance} customers={customers} products={products} onCreate={(form) => action('/api/admin/finance', 'POST', form, 'Lançamento financeiro registrado.')} onSettle={(id) => action('/api/admin/finance/' + id, 'PATCH', { action: 'settle', paymentMethod: 'Manual' }, 'Lançamento atualizado.')} onCancel={(id) => action('/api/admin/finance/' + id, 'PATCH', { action: 'cancel' }, 'Lançamento cancelado.')} />}
          {view === 'settings' && <SettingsPage owner={owner} installPrompt={installPrompt} onInstallPromptConsumed={() => setInstallPrompt(null)} onSave={async (form) => {
            await action('/api/admin/settings', 'PATCH', form, 'Configurações salvas com sucesso.')
            setOwner({ ...owner, business: { ...owner.business, name: form.name, whatsappPhone: form.whatsappPhone, timezone: form.timezone } })
          }} onSaveAvailability={(teamMemberId, windows) => action('/api/admin/availability', 'PUT', { teamMemberId, windows }, 'Horários de atendimento atualizados.')} onCopyLink={() => navigator.clipboard.writeText(window.location.origin + '/p/' + owner.business.slug)} />}
        </div>
        <footer className="app-footer"><span>Agendas <span className="brand-dot">.</span></span><span>Organização simples para o seu negócio.</span><span>Versão inicial</span></footer>
      </main>
      {showGuide && <GettingStartedGuide onClose={closeGuide} onNavigate={setView} />}
    </div>
  )
}

function OverviewPage({ owner, summary, appointments, customers, services, timezone, onAction, onOpen, onCreate, onSetupAvailability, setView }: {
  owner: Owner
  summary: { counts: { pending: number; today: number; customers: number }; money: { receivableCents: number; payableCents: number; receivedThisMonthCents: number; paidThisMonthCents: number }; upcoming: Appointment[] } | null
  appointments: Appointment[]
  customers: Customer[]
  services: Service[]
  timezone: string
  onAction: (id: string, action: string) => Promise<void>
  onOpen: (id: string) => void
  onCreate: (form: unknown) => Promise<void>
  onSetupAvailability: () => void
  setView: (view: string) => void
}) {
  const pending = appointments.filter((item) => item.status === 'pending')
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day')
  const [showCreate, setShowCreate] = useState(false)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  useEffect(() => { api<TeamMember[]>('/api/admin/team-members').then(setTeamMembers).catch(() => {}) }, [])
  const todayLabel = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone }).format(new Date())
  const today = localToday(timezone)
  const weekStart = mondayOf(today)
  const monthStart = shiftDateKey(today, 0, 'month')
  const rangeStart = period === 'day' ? today : period === 'week' ? weekStart : monthStart
  const rangeEnd = period === 'day' ? shiftDateKey(today, 1) : period === 'week' ? shiftDateKey(weekStart, 1, 'week') : shiftDateKey(monthStart, 1, 'month')
  const periodLabel = period === 'day' ? 'hoje' : period === 'week' ? 'esta semana' : 'este mês'
  const periodAppointments = appointments
    .filter((item) => ['pending', 'confirmed', 'completed'].includes(item.status))
    .filter((item) => { const date = appointmentDateKey(item, timezone); return date >= rangeStart && date < rangeEnd })
    .sort((left, right) => left.starts_at.localeCompare(right.starts_at))
  const uniqueCustomers = new Set(periodAppointments.map((item) => item.customer_id)).size
  const nextAppointments = periodAppointments.slice(0, 6)
  return (
    <>
      <PageTitle eyebrow="SEU ESPAÇO" title={'Olá, ' + owner.user.name.split(' ')[0] + '.'} description={todayLabel + ' · Aqui está um resumo da sua rotina.'} action={<button className="button button-secondary" onClick={() => setView('appointments')}><Icon name="calendar" size={16} /> Ver agenda</button>} />
      {pending.length > 0 && <div className="pending-banner"><div className="pending-banner-icon"><Icon name="clock" size={19} /></div><div><strong>{pending.length} {pending.length === 1 ? 'solicitação aguarda' : 'solicitações aguardam'} sua aprovação</strong><span>Os horários ficam reservados por 30 minutos.</span></div><button className="button button-primary button-small" onClick={() => setView('appointments')}>Revisar agora <Icon name="arrow" size={15} /></button></div>}
      <div className="overview-focus-grid"><section className="panel overview-agenda-panel">
        <div className="panel-heading overview-agenda-heading"><div><span className="panel-kicker">ACOMPANHAMENTO</span><h2>Atendimentos {periodLabel}</h2></div><button className="button button-primary button-small" onClick={() => setShowCreate(true)}><Icon name="plus" size={15} /> Novo atendimento</button></div>
        <div className="overview-period-toolbar"><div className="segmented-filter">{([['day', 'Dia'], ['week', 'Semana'], ['month', 'Mês']] as const).map(([value, label]) => <button key={value} className={period === value ? 'selected' : ''} onClick={() => setPeriod(value)}>{label}</button>)}</div><span className="result-count">{periodAppointments.length} {periodAppointments.length === 1 ? 'atendimento' : 'atendimentos'}</span></div>
        <div className="appointment-list">{nextAppointments.length ? nextAppointments.map((appointment) => <AppointmentLine key={appointment.id} appointment={appointment} timezone={timezone} onAction={onAction} onOpen={onOpen} />) : <EmptyState title="Nenhum atendimento neste período" description="Os próximos horários aparecerão aqui." />}</div>
        {periodAppointments.length > nextAppointments.length && <button className="text-link overview-see-all" onClick={() => setView('appointments')}>Ver todos os atendimentos <Icon name="arrow" size={15} /></button>}
      </section><section className="stat-grid overview-stat-grid">
        <StatCard label={'Atendimentos ' + periodLabel} value={String(periodAppointments.length)} change="Cada horário é contado separadamente" icon="calendar" tone="stat-blue" />
        <StatCard label="Clientes atendidos" value={String(uniqueCustomers)} change="Clientes únicos neste período" icon="people" tone="stat-violet" />
      </section></div>
      <section className="panel overview-monthly-finance"><div className="panel-heading"><div><span className="panel-kicker">FINANCEIRO</span><h2>Resumo do mês</h2><p>Entradas e despesas realizadas, com os valores que ainda estão em aberto.</p></div><button className="text-link" onClick={() => setView('finance')}>Acessar financeiro <Icon name="arrow" size={15} /></button></div><div className="overview-finance-values"><div><span>Faturamento</span><strong>{money(summary?.money.receivedThisMonthCents ?? 0)}</strong><small>Recebido no mês · {money(summary?.money.receivableCents ?? 0)} a receber</small></div><div><span>Despesas</span><strong>{money(summary?.money.paidThisMonthCents ?? 0)}</strong><small>Pago no mês · {money(summary?.money.payableCents ?? 0)} em aberto</small></div><div className="overview-finance-balance"><span>Saldo do mês</span><strong>{money((summary?.money.receivedThisMonthCents ?? 0) - (summary?.money.paidThisMonthCents ?? 0))}</strong><small>Faturamento menos despesas pagas</small></div></div></section>
      <section className="quick-actions"><div><span className="panel-kicker">ACESSO RÁPIDO</span><h2>O que você precisa fazer?</h2></div><div className="quick-action-list"><button onClick={() => setView('customers')}><span className="quick-icon quick-violet"><Icon name="people" /></span><span><strong>Cadastrar cliente</strong><small>Adicione alguém à sua base</small></span><Icon name="arrow" size={15} /></button><button onClick={() => setView('services')}><span className="quick-icon quick-blue"><Icon name="service" /></span><span><strong>Organizar serviços</strong><small>Revise opções e duração</small></span><Icon name="arrow" size={15} /></button><button onClick={() => setView('settings')}><span className="quick-icon quick-green"><Icon name="link" /></span><span><strong>Compartilhar página</strong><small>Receba pedidos online</small></span><Icon name="arrow" size={15} /></button></div></section>
      {showCreate && <ManualAppointmentForm customers={customers} services={services} teamMembers={teamMembers.filter((member) => member.active)} timezone={timezone} onClose={() => setShowCreate(false)} onCreate={async (form) => { await onCreate(form); setShowCreate(false) }} onSetupAvailability={onSetupAvailability} />}
    </>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><div className="empty-state-icon"><Icon name="calendar" size={21} /></div><strong>{title}</strong><p>{description}</p></div>
}

function AgendaPage({ appointments, pending, customers, services, timezone, focusId, onAction, onReschedule, onCreate, onSetupAvailability }: {
  appointments: Appointment[]
  pending: Appointment[]
  customers: Customer[]
  services: Service[]
  timezone: string
  focusId?: string
  onAction: (id: string, action: string) => Promise<void>
  onReschedule: (id: string, startsAt: string) => Promise<void>
  onCreate: (form: unknown) => Promise<void>
  onSetupAvailability: () => void
}) {
  const [filter, setFilter] = useState('all')
  const [calendarView, setCalendarView] = useState<'day' | 'week' | 'month'>('week')
  const [selectedDate, setSelectedDate] = useState(() => localToday(timezone))
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [availabilityByTeam, setAvailabilityByTeam] = useState<Record<string, AvailabilityWindow[]>>({})
  const [availabilityLoaded, setAvailabilityLoaded] = useState(false)
  const [teamFilter, setTeamFilter] = useState('all')
  const [rescheduleId, setRescheduleId] = useState('')
  const [newDate, setNewDate] = useState('')
  const [newTime, setNewTime] = useState('10:00')
  const [showCreate, setShowCreate] = useState(false)
  useEffect(() => {
    let active = true
    api<TeamMember[]>('/api/admin/team-members').then(async (members) => {
      if (!active) return
      setTeamMembers(members)
      const calendars = await Promise.all(members.filter((member) => member.active).map(async (member) => {
        const windows = await api<AvailabilityWindow[]>('/api/admin/availability?teamMemberId=' + encodeURIComponent(member.id)).catch(() => [])
        return [member.id, windows] as const
      }))
      if (active) {
        setAvailabilityByTeam(Object.fromEntries(calendars))
        setAvailabilityLoaded(true)
      }
    }).catch(() => { if (active) setAvailabilityLoaded(true) })
    return () => { active = false }
  }, [])
  const focus = appointments.find((item) => item.id === focusId)
  const visible = appointments.filter((item) => {
    if (teamFilter !== 'all' && item.team_member_id !== teamFilter) return false
    if (filter === 'all') return true
    if (filter === 'pending') return item.status === 'pending'
    if (filter === 'confirmed') return item.status === 'confirmed' || item.status === 'completed'
    return ['cancelled', 'declined', 'expired'].includes(item.status)
  })
  const selectedAppointments = visible
    .filter((appointment) => appointmentDateKey(appointment, timezone) === selectedDate)
    .sort((left, right) => left.starts_at.localeCompare(right.starts_at))
  const monthStart = shiftDateKey(selectedDate, 0, 'month')
  const monthFirstWeekday = (new Date(monthStart + 'T12:00:00Z').getUTCDay() + 6) % 7
  const monthLength = new Date(Date.UTC(Number(selectedDate.slice(0, 4)), Number(selectedDate.slice(5, 7)), 0)).getUTCDate()
  const monthGridStart = shiftDateKey(monthStart, -monthFirstWeekday)
  const monthCellCount = Math.ceil((monthFirstWeekday + monthLength) / 7) * 7
  const monthDates = Array.from({ length: monthCellCount }, (_, index) => shiftDateKey(monthGridStart, index))
  const weekStart = mondayOf(selectedDate)
  const weekDates = Array.from({ length: 7 }, (_, index) => shiftDateKey(weekStart, index))
  const periodHeading = calendarView === 'day'
    ? formatDateKey(selectedDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : calendarView === 'week'
      ? `${formatDateKey(weekStart, { day: 'numeric', month: 'short' })} – ${formatDateKey(shiftDateKey(weekStart, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`
      : formatDateKey(monthStart, { month: 'long', year: 'numeric' })
  const appointmentCountOn = (date: string) => visible.filter((appointment) => appointmentDateKey(appointment, timezone) === date).length
  const scheduleMembers = teamMembers.filter((member) => member.active && (teamFilter === 'all' || member.id === teamFilter))
  function windowsForMember(memberId: string, date: string) {
    const weekday = new Date(date + 'T12:00:00Z').getUTCDay()
    return (availabilityByTeam[memberId] ?? []).filter((window) => window.weekday === weekday).sort((left, right) => left.startTime.localeCompare(right.startTime))
  }
  function weekAvailabilityLabel(date: string) {
    if (!availabilityLoaded) return 'Carregando'
    const windows = scheduleMembers.flatMap((member) => windowsForMember(member.id, date))
    if (!windows.length) return 'Fechado'
    if (teamFilter === 'all' && scheduleMembers.length > 1) {
      const dailyPatterns = scheduleMembers.map((member) => windowsForMember(member.id, date).map((window) => `${window.startTime}-${window.endTime}`).join(','))
      if (new Set(dailyPatterns).size > 1) return 'Varia por pessoa'
    }
    const unique = [...new Map(windows.map((window) => [`${window.startTime}-${window.endTime}`, window])).values()]
    if (unique.length === 1) return `${unique[0].startTime}–${unique[0].endTime}`
    return `${unique.length} períodos`
  }
  const selectedDaySchedules = scheduleMembers.map((member) => {
    const appointmentsForMember = appointments
      .filter((appointment) => appointment.team_member_id === member.id && appointmentDateKey(appointment, timezone) === selectedDate)
      .filter((appointment) => ['confirmed', 'completed'].includes(appointment.status) || (appointment.status === 'pending' && (!appointment.expires_at || new Date(appointment.expires_at).getTime() > Date.now())))
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at))
    const periods = windowsForMember(member.id, selectedDate).map((window) => {
      const start = minuteOfDay(window.startTime)
      const end = minuteOfDay(window.endTime)
      let cursor = start
      const blocks: Array<{ kind: 'available' | 'booked'; start: number; end: number; appointment?: Appointment }> = []
      for (const appointment of appointmentsForMember) {
        const bookingStart = Math.max(start, minuteOfDay(timeOf(appointment.starts_at, timezone)))
        const bookingEnd = Math.min(end, minuteOfDay(timeOf(appointment.ends_at, timezone)))
        if (bookingEnd <= start || bookingStart >= end || bookingEnd <= cursor) continue
        if (bookingStart > cursor) blocks.push({ kind: 'available', start: cursor, end: bookingStart })
        blocks.push({ kind: 'booked', start: Math.max(cursor, bookingStart), end: bookingEnd, appointment })
        cursor = bookingEnd
      }
      if (cursor < end) blocks.push({ kind: 'available', start: cursor, end })
      return { window, blocks }
    })
    return { member, periods }
  })
  function moveCalendar(direction: number) {
    setSelectedDate((current) => shiftDateKey(current, direction, calendarView))
  }

  async function saveReschedule(appointment: Appointment) {
    if (!newDate || !newTime) return
    const local = new Date(newDate + 'T' + newTime + ':00')
    await onReschedule(appointment.id, local.toISOString())
    setRescheduleId('')
  }

  return (
    <>
      <PageTitle eyebrow="ROTINA" title="Sua agenda" description="Acompanhe pedidos e organize os atendimentos." action={<div className="agenda-title-actions"><span className="agenda-date-chip"><Icon name="calendar" size={16} /> {new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' }).format(new Date())}</span><button className="button button-primary" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} /> Novo agendamento</button></div>} />
      {focus && <div className="focused-request"><span className="focus-pulse" /><div><strong>Solicitação aberta pelo link do WhatsApp</strong><span>{focus.customer_name} · {focus.service_name} · {dateLong(focus.starts_at, timezone)} às {timeOf(focus.starts_at, timezone)}</span></div><button className="button button-primary button-small" onClick={() => onAction(focus.id, 'confirm')}>Aprovar horário</button><button className="small-action decline" onClick={() => onAction(focus.id, 'decline')} aria-label="Recusar"><Icon name="close" size={15} /></button></div>}
      {pending.length > 0 && <div className="pending-inline"><span className="pending-inline-icon"><Icon name="clock" size={16} /></span><span><strong>{pending.length} solicitação{pending.length === 1 ? '' : 'ões'} pendente{pending.length === 1 ? '' : 's'}</strong> · revise antes que o prazo de reserva termine.</span></div>}
      <section className="panel calendar-panel">
        <div className="calendar-topline"><div className="calendar-navigation"><button className="icon-button muted" aria-label="Período anterior" onClick={() => moveCalendar(-1)}>‹</button><button className="icon-button muted" aria-label="Próximo período" onClick={() => moveCalendar(1)}>›</button><h2>{periodHeading}</h2></div><div className="calendar-controls"><button className="text-link" onClick={() => setSelectedDate(localToday(timezone))}>Hoje</button><div className="segmented-filter">{([['day', 'Dia'], ['week', 'Semana'], ['month', 'Mês']] as const).map(([value, label]) => <button key={value} className={calendarView === value ? 'selected' : ''} onClick={() => setCalendarView(value)}>{label}</button>)}</div></div></div>
        {calendarView === 'month' ? <>
          <div className="calendar-month-weekdays">{'seg ter qua qui sex sáb dom'.split(' ').map((day) => <span key={day}>{day}</span>)}</div>
          <div className="calendar-month-grid">{monthDates.map((date) => { const count = appointmentCountOn(date); return <button key={date} className={'calendar-day-button ' + (date === selectedDate ? 'selected' : '') + (date.slice(0, 7) !== monthStart.slice(0, 7) ? ' outside-month' : '') + (date === localToday(timezone) ? ' today' : '')} onClick={() => setSelectedDate(date)} aria-label={`${formatDateKey(date, { weekday: 'long', day: 'numeric', month: 'long' })}, ${count} atendimentos`}><span>{Number(date.slice(8, 10))}</span>{count > 0 && <i>{count}</i>}</button> })}</div>
        </> : calendarView === 'week' ? <div className="calendar-week-strip">{weekDates.map((date) => { const count = appointmentCountOn(date); const hours = weekAvailabilityLabel(date); return <button key={date} className={'calendar-week-day ' + (date === selectedDate ? 'selected' : '') + (date === localToday(timezone) ? ' today' : '') + (hours === 'Fechado' ? ' is-closed' : '')} onClick={() => setSelectedDate(date)}><span>{formatDateKey(date, { weekday: 'short' }).replace('.', '')}</span><strong>{Number(date.slice(8, 10))}</strong><i>{hours}</i><small>{count} {count === 1 ? 'atendimento' : 'atend.'}</small></button> })}</div> : <div className="calendar-day-summary"><span className="calendar-day-number">{Number(selectedDate.slice(8, 10))}</span><div><strong>{formatDateKey(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}</strong><small>{appointmentCountOn(selectedDate)} {appointmentCountOn(selectedDate) === 1 ? 'atendimento' : 'atendimentos'}</small></div><label className="calendar-date-picker">Escolher data<input type="date" value={selectedDate} onChange={(event) => { if (event.target.value) setSelectedDate(event.target.value) }} /></label></div>}
      </section>
      {calendarView !== 'month' && <section className="panel day-availability-panel">
        <div className="panel-heading"><div><span className="panel-kicker">DISPONIBILIDADE</span><h2>Horários de {formatDateKey(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}</h2></div><span className="availability-legend"><i className="legend-open" /> Disponível <i className="legend-booked" /> Ocupado</span></div>
        {!availabilityLoaded ? <div className="loading-state">Carregando horários de atendimento…</div> : !scheduleMembers.length ? <EmptyState title="Nenhum profissional ativo" description="Ative um profissional nas configurações para ver os horários." /> : <div className="day-schedule-list">{selectedDaySchedules.map(({ member, periods }) => <section className="day-schedule-member" key={member.id}><h3>{scheduleMembers.length > 1 ? member.name : 'Expediente'}</h3>{periods.length ? periods.map(({ window, blocks }, index) => <div className="day-schedule-period" key={`${member.id}-${window.startTime}-${index}`}><div className="day-schedule-period-heading"><strong>{window.startTime}–{window.endTime}</strong><span>Expediente</span></div><div className="day-schedule-blocks">{blocks.map((block, blockIndex) => <div key={`${member.id}-${index}-${blockIndex}`} className={'day-schedule-block ' + (block.kind === 'available' ? 'is-available' : 'is-booked')}><strong>{block.kind === 'available' ? 'Disponível' : 'Ocupado'} · {timeLabelFromMinutes(block.start)}–{timeLabelFromMinutes(block.end)}</strong>{block.appointment && <small>{block.appointment.customer_name} · {block.appointment.service_name}</small>}</div>)}</div></div>) : <p className="day-schedule-closed">Fechado neste dia · sem horários configurados</p>}</section>)}</div>}
      </section>}
      <div className="panel agenda-table-panel">
        <div className="agenda-toolbar"><div className="segmented-filter">{[['all', 'Todos'], ['pending', 'Pendentes'], ['confirmed', 'Confirmados'], ['closed', 'Encerrados']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}{value === 'pending' && pending.length > 0 && <i>{pending.length}</i>}</button>)}</div>{teamMembers.filter((item) => item.active).length > 1 && <label className="agenda-team-filter"><span>Agenda</span><select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}><option value="all">Todas</option>{teamMembers.filter((item) => item.active).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}<span className="result-count">{selectedAppointments.length} {selectedAppointments.length === 1 ? 'horário' : 'horários'}</span></div>
        <div className="date-group"><div className="date-group-heading"><span>{formatDateKey(selectedDate, { weekday: 'long', day: '2-digit', month: 'long' })}</span><i>{selectedAppointments.length} {selectedAppointments.length === 1 ? 'horário' : 'horários'}</i></div>
        {selectedAppointments.length ? selectedAppointments.map((appointment) => <div key={appointment.id} className={'agenda-row ' + (appointment.id === focusId ? 'row-focused' : '')}>
              <div className="agenda-row-time"><strong>{timeOf(appointment.starts_at, timezone)}</strong><small>{appointment.duration_minutes_snapshot} min</small></div><div className="appointment-avatar">{initials(appointment.customer_name)}</div>
              <div className="agenda-row-person"><strong>{appointment.customer_name}</strong><span>{appointment.customer_phone || 'Telefone não informado'} · {appointment.service_name} · {appointment.team_member_name}</span></div>
              <span className={'status-pill status-' + appointment.status}><i />{statusLabel(appointment.status)}</span>
              <div className="agenda-row-actions">
                {appointment.status === 'pending' && <><button className="button button-primary button-small" onClick={() => onAction(appointment.id, 'confirm')}>Aprovar</button><button className="icon-button muted" onClick={() => onAction(appointment.id, 'decline')} aria-label="Recusar"><Icon name="close" size={16} /></button></>}
                {appointment.status === 'confirmed' && <><button className="text-link" onClick={() => { setRescheduleId(rescheduleId === appointment.id ? '' : appointment.id); setNewDate(appointment.starts_at.slice(0, 10)); setNewTime(timeOf(appointment.starts_at, timezone)) }}>Reagendar</button><button className="icon-button muted" onClick={() => onAction(appointment.id, 'complete')} aria-label="Concluir"><Icon name="check" size={16} /></button></>}
              </div>
              {rescheduleId === appointment.id && <div className="reschedule-row"><span>Escolha o novo horário</span><input type="date" value={newDate} onChange={(event) => setNewDate(event.target.value)} /><input type="time" value={newTime} onChange={(event) => setNewTime(event.target.value)} /><button className="button button-primary button-small" onClick={() => saveReschedule(appointment)}>Salvar</button><button className="text-button" onClick={() => setRescheduleId('')}>Cancelar</button></div>}
            </div>) : <EmptyState title="Nenhum horário neste dia" description="Escolha outra data no calendário ou cadastre um novo atendimento." />}
        </div>
      </div>
      <p className="helper-note"><Icon name="clock" size={15} /> Solicitações pendentes reservam o horário por 30 minutos. A aprovação acontece nesta página do app.</p>
      {showCreate && <ManualAppointmentForm customers={customers} services={services} teamMembers={teamMembers.filter((item) => item.active)} timezone={timezone} onClose={() => setShowCreate(false)} onCreate={async (form) => { await onCreate(form); setShowCreate(false) }} onSetupAvailability={onSetupAvailability} />}
    </>
  )
}

function ManualAppointmentForm({ customers, services, teamMembers, timezone, onClose, onCreate, onSetupAvailability }: {
  customers: Customer[]
  services: Service[]
  teamMembers: TeamMember[]
  timezone: string
  onClose: () => void
  onCreate: (form: unknown) => Promise<void>
  onSetupAvailability: () => void
}) {
  const activeServices = services.filter((item) => item.active)
  const [serviceId, setServiceId] = useState(activeServices[0]?.id ?? '')
  const [teamMemberId, setTeamMemberId] = useState(teamMembers[0]?.id ?? '')
  const [date, setDate] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()))
  const [customerId, setCustomerId] = useState(customers.length ? '' : '__new')
  const [newCustomerPhone, setNewCustomerPhone] = useState('')
  const [slots, setSlots] = useState<Slot[]>([])
  const [selectedSlot, setSelectedSlot] = useState('')
  const [loadingSlots, setLoadingSlots] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!serviceId || !date) {
      setSlots([])
      setSelectedSlot('')
      return
    }
    let active = true
    setLoadingSlots(true)
    api<Slot[]>('/api/admin/availability-slots?serviceId=' + encodeURIComponent(serviceId) + '&date=' + encodeURIComponent(date) + '&teamMemberId=' + encodeURIComponent(teamMemberId))
      .then((result) => { if (active) setSlots(result) })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Não foi possível consultar os horários.') })
      .finally(() => { if (active) setLoadingSlots(false) })
    return () => { active = false }
  }, [serviceId, date, teamMemberId])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedSlot) {
      setError('Escolha um horário livre para continuar.')
      return
    }
    setSaving(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
      await onCreate({
        serviceId,
        teamMemberId,
        startsAt: selectedSlot,
        customerId: customerId === '__new' ? '' : customerId,
        newCustomer: customerId === '__new' ? {
          name: data.get('customerName'),
          phone: brazilPhoneE164(newCustomerPhone),
          email: data.get('customerEmail'),
        } : undefined,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar o agendamento.')
    } finally {
      setSaving(false)
    }
  }

  return <FormPanel title="Novo agendamento" onClose={onClose}>
    <form className="form-stack modal-form" onSubmit={submit}>
      {!activeServices.length ? <div className="availability-empty"><strong>Cadastre um serviço primeiro</strong><span>O agendamento precisa estar ligado a um serviço ativo.</span></div> : <>
        {teamMembers.length > 1 && <label>Profissional<select required value={teamMemberId} onChange={(event) => { setTeamMemberId(event.target.value); setSelectedSlot('') }}>{teamMembers.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
        <label>Serviço<select required value={serviceId} onChange={(event) => { setServiceId(event.target.value); setSelectedSlot('') }}>{activeServices.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.duration_minutes} min</option>)}</select></label>
        <label>Cliente<select required value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">Selecione um cliente</option><option value="__new">Cadastrar cliente agora</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.phone || 'sem telefone'}</option>)}</select></label>
        {customerId === '__new' && <div className="new-customer-fields"><label>Nome completo<input required name="customerName" placeholder="Nome do cliente" /></label><BrazilPhoneInput label="WhatsApp" name="customerPhone" value={newCustomerPhone} onChange={setNewCustomerPhone} required /><label>E-mail <span className="optional-label">opcional</span><input name="customerEmail" type="email" placeholder="cliente@email.com" /></label></div>}
        <label>Data<input required type="date" value={date} min={new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())} onChange={(event) => { setDate(event.target.value); setSelectedSlot('') }} /></label>
        <div className="slot-picker-label"><strong>Horários livres</strong><span>Fuso: {timezone.replace('America/', '').replaceAll('_', ' ')}</span></div>
        {loadingSlots ? <div className="loading-state">Buscando horários disponíveis…</div> : slots.length ? <div className="slot-grid admin-slot-grid">{slots.map((slot) => <button key={slot.startsAt} type="button" className={'slot-button ' + (selectedSlot === slot.startsAt ? 'selected' : '')} onClick={() => setSelectedSlot(slot.startsAt)}>{slot.time}</button>)}</div> : <div className="availability-empty"><strong>Nenhum horário disponível nesta data</strong><span>Confira sua jornada em Configurações → Horários de atendimento.</span><button type="button" className="text-link" onClick={onSetupAvailability}>Configurar horários</button></div>}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancelar</button><button className="button button-primary" disabled={saving || !selectedSlot}>{saving ? 'Salvando…' : 'Criar agendamento'}<Icon name="arrow" size={15} /></button></div>
      </>}
    </form>
  </FormPanel>
}

const guideSteps = [
  {
    view: 'overview',
    eyebrow: '1 · VISÃO GERAL',
    title: 'Aqui você acompanha um resumo do negócio',
    description: 'Nesta página ficam os números principais, os próximos horários e os atalhos para as tarefas mais usadas.',
    details: [['Quando começar o dia', 'Confira se há solicitações aguardando sua aprovação e veja os próximos atendimentos.']],
  },
  {
    view: 'appointments',
    eyebrow: '2 · AGENDA',
    title: 'Aqui você organiza seus atendimentos',
    description: 'Veja os pedidos que chegam pela sua página e os horários já confirmados.',
    details: [['Solicitações', 'Abra um pedido para confirmar ou recusar. Você também pode criar um agendamento manual, que já fica confirmado.']],
  },
  {
    view: 'customers',
    eyebrow: '3 · CLIENTES',
    title: 'Aqui fica sua base de clientes',
    description: 'Consulte e pesquise os dados das pessoas que atendem com você.',
    details: [['Como adicionar', 'Use “Novo cliente” para cadastrar alguém. Quando uma pessoa fizer a primeira solicitação pela página pública, o cadastro também será criado automaticamente.']],
  },
  {
    view: 'services',
    eyebrow: '4 · SERVIÇOS',
    title: 'Aqui você cadastra o que oferece',
    description: 'Adicione cada tipo de atendimento para que seus clientes possam escolher na página pública.',
    details: [['O que informar', 'Inclua nome, descrição, duração e preço. Apenas serviços ativos ficam disponíveis para solicitação.']],
  },
  {
    view: 'products',
    eyebrow: '5 · PRODUTOS',
    title: 'Aqui você registra os produtos que oferece',
    description: 'Mantenha nome, descrição e preço dos produtos no app.',
    details: [['Importante', 'Esta área é apenas um catálogo: não controla estoque nem quantidade de itens.']],
  },
  {
    view: 'finance',
    eyebrow: '6 · FINANCEIRO',
    title: 'Aqui você acompanha valores a receber e a pagar',
    description: 'Registre manualmente entradas e despesas para manter o controle financeiro do negócio.',
    details: [['Atualize a situação', 'Quando receber ou pagar um lançamento, marque-o como quitado para atualizar o resumo.']],
  },
  {
    view: 'settings',
    eyebrow: '7 · CONFIGURAÇÕES',
    title: 'Aqui você define como e quando atende',
    description: 'Configure o nome do negócio, WhatsApp, fuso horário e os dias e períodos disponíveis para agendamento.',
    details: [['Antes de receber pedidos', 'Cadastre seus serviços e abra os dias e horários de atendimento. Sem disponibilidade configurada, o cliente não verá horários livres.']],
  },
  {
    view: 'settings',
    eyebrow: '8 · LINK PARA SEUS CLIENTES',
    title: 'Aqui você compartilha sua página',
    description: 'Toque em “Sua página pública” no menu lateral para abrir o link do seu negócio. Em Configurações, você também pode copiar o link para enviar aos clientes.',
    details: [['Como o cliente usa', 'Ele escolhe um serviço e horário livre, informa nome e WhatsApp e envia o pedido. Depois, abre a mensagem pronta no WhatsApp e toca em Enviar. Você confirma ou recusa pela Agenda.']],
  },
]

function GettingStartedGuide({ onClose, onNavigate }: { onClose: () => void; onNavigate: (view: string) => void }) {
  const [step, setStep] = useState(0)
  const current = guideSteps[step]
  function goToStep(nextStep: number) {
    const next = Math.max(0, Math.min(guideSteps.length - 1, nextStep))
    setStep(next)
    onNavigate(guideSteps[next].view)
  }
  return <div className="guide-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <div className="guide-top"><span className="guide-brand"><span className="brand-mark"><Icon name="calendar" size={17} /></span> Guia rápido</span><button className="icon-button" aria-label="Fechar apresentação" onClick={onClose}><Icon name="close" size={17} /></button></div>
      <div className="guide-progress" aria-label={'Tela ' + (step + 1) + ' de ' + guideSteps.length}>{guideSteps.map((item, index) => <span key={item.eyebrow} className={index <= step ? 'active' : ''} />)}</div>
      <span className="panel-kicker">{current.eyebrow}</span>
      <h2 id="guide-title">{current.title}</h2>
      <p className="guide-description">{current.description}</p>
      <div className="guide-details">{current.details.map(([title, description]) => <article key={title}><strong>{title}</strong><p>{description}</p></article>)}</div>
      <div className="guide-footer"><button className="text-button guide-skip" onClick={onClose}>Fechar guia</button><div>{step > 0 && <button className="button button-secondary" onClick={() => goToStep(step - 1)}>Voltar</button>}{step < guideSteps.length - 1 ? <button className="button button-primary" onClick={() => goToStep(step + 1)}>Próxima tela <Icon name="arrow" size={15} /></button> : <button className="button button-primary" onClick={onClose}>Começar a usar <Icon name="check" size={15} /></button>}</div></div>
    </section>
  </div>
}

function FormPanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal-card"><div className="modal-heading"><div><span className="panel-kicker">NOVO CADASTRO</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></div>{children}</section></div>
}

function CustomersPage({ customers, onCreate, onUpdate, onDelete }: { customers: Customer[]; onCreate: (form: unknown) => Promise<void>; onUpdate: (id: string, form: unknown) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [phone, setPhone] = useState('')
  const [formError, setFormError] = useState('')
  const filtered = customers.filter((item) => (item.name + ' ' + item.phone + ' ' + item.email).toLowerCase().includes(search.toLowerCase()))
  function addCustomer() {
    setEditingCustomer(null)
    setPhone('')
    setFormError('')
    setShowForm(true)
  }
  function editCustomer(customer: Customer) {
    setEditingCustomer(customer)
    setPhone(brazilNationalDigits(customer.phone))
    setFormError('')
    setShowForm(true)
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const values = { name: form.get('name'), phone: brazilPhoneE164(phone), email: form.get('email'), notes: form.get('notes') }
    setFormError('')
    try {
      if (editingCustomer) await onUpdate(editingCustomer.id, values)
      else await onCreate(values)
      setShowForm(false)
      setEditingCustomer(null)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Não foi possível salvar os dados do cliente.')
    }
  }
  async function removeCustomer(customer: Customer) {
    const confirmed = window.confirm(`Excluir o contato de ${customer.name}? Os dados pessoais serão removidos da lista, mas o histórico de agendamentos e financeiro será preservado como “Contato excluído”.`)
    if (!confirmed) return
    await onDelete(customer.id)
  }
  return <>
    <PageTitle eyebrow="RELACIONAMENTO" title="Clientes" description="Informações e histórico de quem escolhe seu trabalho." action={<button className="button button-primary" onClick={addCustomer}><Icon name="plus" size={17} /> Novo cliente</button>} />
    <div className="panel directory-panel"><div className="directory-toolbar"><div className="search-field"><Icon name="search" size={17} /><input placeholder="Buscar cliente por nome, telefone ou e-mail" value={search} onChange={(event) => setSearch(event.target.value)} /></div><span className="result-count">{filtered.length} clientes</span></div>
      <div className="table-scroll">{filtered.length > 0 ? <table className="data-table"><thead><tr><th>CLIENTE</th><th>TELEFONE</th><th>E-MAIL</th><th>OBSERVAÇÕES</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><div className="client-cell"><span className="table-avatar">{initials(item.name)}</span><strong>{item.name}</strong><div className="customer-row-actions"><button className="icon-button muted" onClick={() => editCustomer(item)} aria-label={'Editar ' + item.name} title="Editar contato"><Icon name="edit" size={16} /></button><button className="icon-button customer-delete-button" onClick={() => void removeCustomer(item)} aria-label={'Excluir ' + item.name} title="Excluir contato"><Icon name="trash" size={16} /></button></div></div></td><td>{item.phone || '—'}</td><td>{item.email || '—'}</td><td className="muted-cell">{item.notes || '—'}</td></tr>)}</tbody></table> : <EmptyState title={search ? 'Nenhum cliente encontrado' : 'Sua base começa aqui'} description={search ? 'Tente buscar por outro nome, telefone ou e-mail.' : 'Você pode cadastrar um cliente manualmente ou ele será adicionado automaticamente quando fizer a primeira solicitação pela sua página pública.'} />}</div>
    </div>
    {showForm && <FormPanel title={editingCustomer ? 'Editar cliente' : 'Adicionar cliente'} onClose={() => { setShowForm(false); setEditingCustomer(null) }}><form className="form-stack modal-form" onSubmit={submit}><label>Nome completo<input required name="name" defaultValue={editingCustomer?.name ?? ''} placeholder="Nome do cliente" /></label><BrazilPhoneInput label="WhatsApp" name="phone" value={phone} onChange={setPhone} /><label>E-mail<input type="email" name="email" defaultValue={editingCustomer?.email ?? ''} placeholder="cliente@email.com" /></label><label>Observações<textarea name="notes" rows={3} defaultValue={editingCustomer?.notes ?? ''} placeholder="Preferências ou informações úteis" /></label>{formError && <Alert>{formError}</Alert>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => { setShowForm(false); setEditingCustomer(null) }}>Cancelar</button><button className="button button-primary">{editingCustomer ? 'Salvar alterações' : 'Salvar cliente'} <Icon name="arrow" size={15} /></button></div></form></FormPanel>}
  </>
}

function ServicesPage({ services, onCreate }: { services: Service[]; onCreate: (form: unknown) => Promise<void> }) {
  const [showForm, setShowForm] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await onCreate({ name: form.get('name'), description: form.get('description'), durationMinutes: Number(form.get('duration')), priceCents: Math.round(Number(form.get('price')) * 100) })
    setShowForm(false)
  }
  return <>
    <PageTitle eyebrow="OFERTA" title="Serviços" description="Defina o que você oferece, a duração e o valor de cada atendimento." action={<button className="button button-primary" onClick={() => setShowForm(true)}><Icon name="plus" size={17} /> Novo serviço</button>} />
    <div className="catalog-grid">{services.map((item, index) => <article className="catalog-card" key={item.id}><div className={'catalog-index shade-' + (index % 4)}>{String(index + 1).padStart(2, '0')}</div><span className={'active-tag ' + (item.active ? '' : 'inactive-tag')}>{item.active ? 'Ativo' : 'Inativo'}</span><h2>{item.name}</h2><p>{item.description || 'Sem descrição adicional.'}</p><div className="catalog-card-meta"><span><Icon name="clock" size={15} /> {item.duration_minutes} min</span><strong>{item.price_cents ? money(item.price_cents) : 'A combinar'}</strong></div></article>)}</div>
    {!services.length && <EmptyState title="Você ainda não cadastrou serviços" description="Adicione os serviços que seus clientes podem solicitar." />}
    {showForm && <FormPanel title="Adicionar serviço" onClose={() => setShowForm(false)}><form className="form-stack modal-form" onSubmit={submit}><label>Nome do serviço<input required name="name" placeholder="Ex.: Atendimento padrão" /></label><label>Descrição<textarea name="description" rows={3} placeholder="Explique brevemente o que está incluído" /></label><div className="two-fields"><label>Duração em minutos<input type="number" name="duration" min="5" max="720" step="5" defaultValue="60" required /></label><label>Preço em reais<input type="number" name="price" min="0" step="0.01" defaultValue="0" required /></label></div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setShowForm(false)}>Cancelar</button><button className="button button-primary">Salvar serviço <Icon name="arrow" size={15} /></button></div></form></FormPanel>}
  </>
}

function ProductsPage({ products, onCreate }: { products: Product[]; onCreate: (form: unknown) => Promise<void> }) {
  const [showForm, setShowForm] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await onCreate({ name: form.get('name'), description: form.get('description'), priceCents: Math.round(Number(form.get('price')) * 100) })
    setShowForm(false)
  }
  return <>
    <PageTitle eyebrow="CATÁLOGO" title="Produtos" description="Um catálogo simples de produtos, sem controle de estoque." action={<button className="button button-primary" onClick={() => setShowForm(true)}><Icon name="plus" size={17} /> Novo produto</button>} />
    <div className="product-note"><span className="note-mark">i</span><span>Este cadastro guarda nome, descrição e preço. Não acompanha quantidades nem movimentações de estoque.</span></div>
    <div className="catalog-grid product-grid">{products.map((item, index) => <article className="catalog-card product-card" key={item.id}><div className={'product-symbol shade-' + (index % 4)}><Icon name="box" size={20} /></div><span className={'active-tag ' + (item.active ? '' : 'inactive-tag')}>{item.active ? 'Ativo' : 'Inativo'}</span><h2>{item.name}</h2><p>{item.description || 'Sem descrição adicional.'}</p><div className="catalog-card-meta"><span>Preço cadastrado</span><strong>{money(item.price_cents)}</strong></div></article>)}</div>
    {!products.length && <EmptyState title="Seu catálogo está vazio" description="Cadastre produtos sem acompanhar estoque." />}
    {showForm && <FormPanel title="Adicionar produto" onClose={() => setShowForm(false)}><form className="form-stack modal-form" onSubmit={submit}><label>Nome do produto<input required name="name" placeholder="Nome do produto" /></label><label>Descrição<textarea name="description" rows={3} placeholder="Detalhes que ajudam seus clientes" /></label><label>Preço em reais<input type="number" name="price" min="0" step="0.01" required /></label><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setShowForm(false)}>Cancelar</button><button className="button button-primary">Salvar produto <Icon name="arrow" size={15} /></button></div></form></FormPanel>}
  </>
}

function FinancePage({ finance, customers, products, onCreate, onSettle, onCancel }: {
  finance: { entries: FinanceEntry[]; categories: Category[] }
  customers: Customer[]
  products: Product[]
  onCreate: (form: unknown) => Promise<void>
  onSettle: (id: string) => Promise<void>
  onCancel: (id: string) => Promise<void>
}) {
  const [direction, setDirection] = useState<'receivable' | 'payable'>('receivable')
  const [showForm, setShowForm] = useState(false)
  const entries = finance.entries.filter((item) => item.direction === direction)
  const open = entries.filter((item) => item.status === 'pending' || item.status === 'overdue')
  const totalOpen = open.reduce((sum, item) => sum + item.amount_cents, 0)
  const options = finance.categories.filter((item) => item.direction === direction)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const productId = String(form.get('productId') ?? '')
    const customerId = String(form.get('customerId') ?? '')
    await onCreate({
      direction,
      categoryId: form.get('categoryId'),
      customerId: customerId || undefined,
      productId: productId || undefined,
      description: form.get('description'),
      amountCents: Math.round(Number(form.get('amount')) * 100),
      dueDate: form.get('dueDate'),
      paymentMethod: form.get('paymentMethod'),
    })
    setShowForm(false)
  }
  return <>
    <PageTitle eyebrow="CONTROLE FINANCEIRO" title="Financeiro" description="Acompanhe entradas e saídas com lançamentos manuais." action={<button className="button button-primary" onClick={() => setShowForm(true)}><Icon name="plus" size={17} /> Novo lançamento</button>} />
    <div className="finance-top-cards"><div className="finance-top-card"><span>{direction === 'receivable' ? 'A receber' : 'A pagar'}</span><strong>{money(totalOpen)}</strong><small>{open.length} lançamento{open.length === 1 ? '' : 's'} em aberto</small></div><div className="finance-top-card finance-top-card-subtle"><span>Recebido no mês</span><strong>{money(finance.entries.filter((item) => item.direction === 'receivable' && item.status === 'settled').reduce((sum, item) => sum + item.amount_cents, 0))}</strong><small>Contas marcadas como recebidas</small></div><div className="finance-top-card finance-top-card-subtle"><span>Vencido</span><strong className="overdue-value">{money(open.filter((item) => item.status === 'overdue').reduce((sum, item) => sum + item.amount_cents, 0))}</strong><small>Contas em atraso</small></div></div>
    <div className="panel finance-table-panel"><div className="directory-toolbar"><div className="segmented-filter"><button className={direction === 'receivable' ? 'selected' : ''} onClick={() => setDirection('receivable')}>A receber</button><button className={direction === 'payable' ? 'selected' : ''} onClick={() => setDirection('payable')}>A pagar</button></div><span className="result-count">{entries.length} lançamentos</span></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>DESCRIÇÃO</th><th>CATEGORIA</th><th>VENCIMENTO</th><th>VALOR</th><th>SITUAÇÃO</th><th></th></tr></thead><tbody>{entries.map((item) => <tr key={item.id}><td><div className="entry-cell"><strong>{item.description}</strong><small>{item.customer_name || item.product_name || item.service_name || (direction === 'payable' ? 'Despesa do negócio' : 'Lançamento manual')}</small></div></td><td>{item.category_name}</td><td>{new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(item.due_date + 'T12:00:00Z'))}</td><td className="money-cell">{money(item.amount_cents)}</td><td><span className={'status-pill status-' + item.status}><i />{statusLabel(item.status)}</span></td><td>{item.status === 'pending' || item.status === 'overdue' ? <div className="finance-actions"><button className="text-link" onClick={() => onSettle(item.id)}>{direction === 'receivable' ? 'Receber' : 'Pagar'}</button><button className="icon-button muted" onClick={() => onCancel(item.id)} aria-label="Cancelar lançamento"><Icon name="close" size={15} /></button></div> : '—'}</td></tr>)}</tbody></table>{!entries.length && <EmptyState title="Nenhum lançamento por aqui" description="Registre uma conta a pagar ou receber para acompanhar seu financeiro." />}</div>
    </div>
    <p className="helper-note"><Icon name="wallet" size={15} /> O financeiro é manual. Não processa pagamentos nem importa transações bancárias.</p>
    {showForm && <FormPanel title="Novo lançamento" onClose={() => setShowForm(false)}><form className="form-stack modal-form" onSubmit={submit}><div className="segmented-filter form-switch"><button type="button" className={direction === 'receivable' ? 'selected' : ''} onClick={() => setDirection('receivable')}>A receber</button><button type="button" className={direction === 'payable' ? 'selected' : ''} onClick={() => setDirection('payable')}>A pagar</button></div><label>Descrição<input required name="description" placeholder="Ex.: Atendimento ou conta do mês" /></label><div className="two-fields"><label>Valor em reais<input required type="number" name="amount" min="0.01" step="0.01" /></label><label>Vencimento<input required type="date" name="dueDate" defaultValue={localToday()} /></label></div><label>Categoria<select required name="categoryId">{options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{direction === 'receivable' && <><label>Cliente <span className="optional-label">opcional</span><select name="customerId"><option value="">Sem vínculo</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Produto <span className="optional-label">opcional</span><select name="productId"><option value="">Sem vínculo</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}<label>Forma de pagamento<input name="paymentMethod" placeholder="Pix, dinheiro, cartão..." /></label><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setShowForm(false)}>Cancelar</button><button className="button button-primary">Salvar lançamento <Icon name="arrow" size={15} /></button></div></form></FormPanel>}
  </>
}

function SettingsPage({ owner, installPrompt, onInstallPromptConsumed, onSave, onSaveAvailability, onCopyLink }: { owner: Owner; installPrompt: InstallPromptEvent | null; onInstallPromptConsumed: () => void; onSave: (form: { name: string; description: string; whatsappPhone: string; timezone: string }) => Promise<void>; onSaveAvailability: (teamMemberId: string, windows: AvailabilityWindow[]) => Promise<void>; onCopyLink: () => void }) {
  const [name, setName] = useState(owner.business.name)
  const [description, setDescription] = useState('')
  const [phone, setPhone] = useState(owner.business.whatsappPhone)
  const [timezone, setTimezone] = useState(owner.business.timezone)
  const [saved, setSaved] = useState(false)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [selectedMemberId, setSelectedMemberId] = useState('')
  const [newMemberName, setNewMemberName] = useState('')
  const [teamError, setTeamError] = useState('')
  const [teamBusy, setTeamBusy] = useState(false)
  const loadTeam = useCallback(async () => {
    const members = await api<TeamMember[]>('/api/admin/team-members')
    setTeamMembers(members)
    setSelectedMemberId((current) => current && members.some((member) => member.id === current && member.active)
      ? current
      : members.find((member) => member.active)?.id ?? '')
  }, [])
  useEffect(() => { loadTeam().catch(() => {}) }, [owner, loadTeam])
  useEffect(() => { api<{ name: string; description: string; whatsapp_phone: string; timezone: string }>('/api/admin/settings').then((result) => { setName(result.name); setDescription(result.description); setPhone(result.whatsapp_phone); setTimezone(result.timezone) }).catch(() => {}) }, [owner])
  async function submit(event: FormEvent) {
    event.preventDefault()
    await onSave({ name, description, whatsappPhone: brazilPhoneE164(phone), timezone })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2500)
  }
  async function createMember(event: FormEvent) {
    event.preventDefault()
    if (!newMemberName.trim()) return
    setTeamBusy(true); setTeamError('')
    try {
      await api('/api/admin/team-members', { method: 'POST', body: { name: newMemberName } })
      setNewMemberName(''); await loadTeam()
    } catch (cause) { setTeamError(cause instanceof Error ? cause.message : 'Não foi possível cadastrar o profissional.') }
    finally { setTeamBusy(false) }
  }
  async function updateMember(member: TeamMember, name: string, active = Boolean(member.active)) {
    setTeamBusy(true); setTeamError('')
    try {
      await api('/api/admin/team-members/' + encodeURIComponent(member.id), { method: 'PATCH', body: { name, active } })
      await loadTeam()
    } catch (cause) { setTeamError(cause instanceof Error ? cause.message : 'Não foi possível salvar o profissional.') }
    finally { setTeamBusy(false) }
  }
  const publicUrl = window.location.origin + '/p/' + owner.business.slug
  return <>
    <PageTitle eyebrow="SEU NEGÓCIO" title="Configurações" description="Personalize as informações que seus clientes veem." />
    <AppAccessPanel ownerName={owner.business.name} installPrompt={installPrompt} onInstallPromptConsumed={onInstallPromptConsumed} />
    <section className="panel team-manager"><div className="panel-heading"><div><span className="panel-kicker">EQUIPE</span><h2>Profissionais e agendas</h2><p>Cadastre quem atende no negócio. Cada pessoa terá horários e agendamentos próprios; somente o titular acessa o aplicativo.</p></div></div>
      <form className="team-create-form" onSubmit={createMember}><label>Nome do profissional<input value={newMemberName} onChange={(event) => setNewMemberName(event.target.value)} placeholder="Ex.: Ana Souza" maxLength={90} required /></label><button className="button button-primary" disabled={teamBusy}>Adicionar à equipe <Icon name="plus" size={15} /></button></form>
      {teamError && <Alert>{teamError}</Alert>}
      <div className="team-member-list">{teamMembers.map((member) => <form className={'team-member-row ' + (!member.active ? 'team-member-inactive' : '')} key={member.id} onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void updateMember(member, String(data.get('name') ?? member.name)) }}><div className="team-member-badge">{initials(member.name)}</div><label><span>{member.is_owner ? 'Titular da conta' : 'Profissional'}</span><input name="name" defaultValue={member.name} maxLength={90} disabled={!member.active} /></label><div className="team-member-controls"><span className={'team-member-state ' + (member.active ? 'is-active' : '')}>{member.active ? 'Ativo' : 'Inativo'}</span><button className="button button-secondary button-small" disabled={teamBusy || !member.active}>Salvar nome</button>{!member.is_owner && <button type="button" className="text-link" disabled={teamBusy} onClick={() => void updateMember(member, member.name, !member.active)}>{member.active ? 'Desativar' : 'Reativar'}</button>}</div></form>)}</div>
      {teamMembers.filter((member) => member.active).length > 1 && <label className="team-calendar-select">Editar agenda de<select value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)}>{teamMembers.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.name}{member.is_owner ? ' (titular)' : ''}</option>)}</select></label>}
    </section>
    {selectedMemberId && <AvailabilityEditor key={selectedMemberId} teamMemberId={selectedMemberId} onSave={onSaveAvailability} />}
    <div className="settings-layout">
      <section className="panel settings-panel"><div className="panel-heading"><div><span className="panel-kicker">PERFIL PÚBLICO</span><h2>Informações do negócio</h2></div><span className="settings-status"><i /> Página ativa</span></div>
        <form className="form-stack settings-form" onSubmit={submit}><label>Nome do negócio<input required value={name} onChange={(event) => setName(event.target.value)} /></label><label>Descrição<textarea rows={4} maxLength={300} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Conte brevemente como você atende e o que os clientes podem esperar." /></label><div className="two-fields"><div className="country-phone-setting"><BrazilPhoneInput label="WhatsApp do profissional" value={phone} onChange={setPhone} /><small className="field-hint">O código +55 é incluído automaticamente no link enviado ao WhatsApp.</small></div><label>Fuso horário<select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="America/Sao_Paulo">Brasília — São Paulo</option><option value="America/Manaus">Manaus</option><option value="America/Belem">Belém</option><option value="America/Noronha">Fernando de Noronha</option></select></label></div><div className="settings-save-row"><span>{saved ? <span className="inline-success"><Icon name="check" size={15} /> Salvo</span> : 'Suas alterações serão aplicadas à página pública.'}</span><button className="button button-primary">Salvar alterações <Icon name="arrow" size={15} /></button></div></form>
      </section>
      <aside className="panel share-panel"><span className="share-illustration"><Icon name="link" size={22} /></span><span className="panel-kicker">LINK COMPARTILHÁVEL</span><h2>Seu trabalho, à disposição dos clientes.</h2><p>Envie sua página para que as pessoas conheçam seus serviços e solicitem um horário.</p><div className="share-url"><span>{publicUrl}</span><button className="icon-button" onClick={onCopyLink} aria-label="Copiar link"><Icon name="link" size={16} /></button></div><button className="button button-secondary button-wide" onClick={() => window.open(publicUrl, '_blank')}>Abrir página pública <Icon name="arrow" size={15} /></button><div className="share-foot"><span className="demo-dot" /> Página sem autenticação para clientes</div></aside>
    </div>
    <div className="settings-note"><span className="note-mark">i</span><div><strong>Acesso pelo titular</strong><span>O titular gerencia a equipe e visualiza todas as agendas. Clientes não precisam criar uma conta para solicitar um horário.</span></div></div>
  </>
}

function AppAccessPanel({ ownerName, installPrompt, onInstallPromptConsumed }: { ownerName: string; installPrompt: InstallPromptEvent | null; onInstallPromptConsumed: () => void }) {
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => 'Notification' in window && 'serviceWorker' in navigator ? Notification.permission : 'unsupported')
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)

  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setPushEnabled(Boolean(subscription)))
      .catch(() => {})
  }, [])

  async function installApp() {
    setFeedback('')
    if (!installPrompt) {
      setFeedback(isInstalled ? 'O Agendas já está instalado neste aparelho.' : isIos
        ? 'No Safari, toque em Compartilhar e escolha “Adicionar à Tela de Início”.'
        : 'No menu do navegador, escolha “Instalar app” ou “Adicionar à tela inicial”.')
      return
    }
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    onInstallPromptConsumed()
    setFeedback(choice.outcome === 'accepted' ? 'Tudo certo — o app ficará disponível na tela inicial.' : 'Você pode instalar depois pelo menu do navegador.')
  }

  async function toggleNotifications() {
    setPushBusy(true)
    setFeedback('')
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('Este navegador não oferece notificações por push.')
      let granted = Notification.permission
      if (granted !== 'granted') granted = await Notification.requestPermission()
      setPermission(granted)
      if (granted !== 'granted') throw new Error('Permita notificações nas configurações do navegador para receber novos pedidos.')
      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      if (existing && pushEnabled) {
        await api('/api/admin/push-subscriptions', { method: 'DELETE', body: { endpoint: existing.endpoint } })
        await existing.unsubscribe()
        setPushEnabled(false)
        setFeedback('Notificações desativadas neste aparelho.')
        return
      }
      if (!registration.pushManager) throw new Error('Este navegador não oferece notificações por push.')
      const { publicKey } = await api<{ publicKey: string | null }>('/api/admin/push-key')
      if (!publicKey) throw new Error('As notificações ainda não foram ativadas no servidor. Tente novamente mais tarde.')
      const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(publicKey) })
      const serialized = subscription.toJSON()
      if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) throw new Error('Não foi possível registrar este aparelho para notificações.')
      await api('/api/admin/push-subscriptions', { method: 'POST', body: serialized })
      setPushEnabled(true)
      setFeedback('Pronto! Este aparelho receberá um aviso quando chegar um novo pedido.')
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : 'Não foi possível configurar as notificações.')
    } finally {
      setPushBusy(false)
    }
  }

  return <section className="panel app-access-panel">
    <div className="app-access-copy"><span className="panel-kicker">NO SEU CELULAR</span><h2>Instale o Agendas e receba novos pedidos</h2><p>Adicione à tela inicial para abrir como um aplicativo. Ative as notificações neste aparelho para saber quando um cliente solicitar horário.</p></div>
    <div className="app-access-actions"><button className="button button-secondary" onClick={() => void installApp()}>{isInstalled ? 'App instalado' : 'Instalar app'} <Icon name="arrow" size={15} /></button><button className="button button-primary" onClick={() => void toggleNotifications()} disabled={pushBusy || permission === 'unsupported'}>{pushBusy ? 'Configurando…' : pushEnabled ? 'Desativar notificações' : 'Ativar notificações'} <Icon name={pushEnabled ? 'check' : 'arrow'} size={15} /></button></div>
    {feedback && <p className={'app-access-feedback ' + (feedback.includes('não') || feedback.includes('Permita') ? 'is-error' : '')} role="status" aria-live="polite">{feedback}</p>}
    {permission === 'denied' && <p className="app-access-hint">As notificações estão bloqueadas no navegador. Altere a permissão do site nas configurações do aparelho.</p>}
    {isIos && !isInstalled && <p className="app-access-hint">No iPhone, instale pela opção “Adicionar à Tela de Início” do Safari antes de ativar notificações.</p>}
    <span className="sr-only">Conta de {ownerName}</span>
  </section>
}

function pushKeyBytes(key: string): ArrayBuffer {
  const normalized = key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)
  const decoded = atob(normalized)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return bytes.buffer as ArrayBuffer
}

const weekDays: Array<{ value: number; label: string }> = [
  { value: 1, label: 'Segunda-feira' },
  { value: 2, label: 'Terça-feira' },
  { value: 3, label: 'Quarta-feira' },
  { value: 4, label: 'Quinta-feira' },
  { value: 5, label: 'Sexta-feira' },
  { value: 6, label: 'Sábado' },
  { value: 0, label: 'Domingo' },
]

function AvailabilityEditor({ teamMemberId, onSave }: { teamMemberId: string; onSave: (teamMemberId: string, windows: AvailabilityWindow[]) => Promise<void> }) {
  const [windows, setWindows] = useState<AvailabilityWindow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    api<AvailabilityWindow[]>('/api/admin/availability?teamMemberId=' + encodeURIComponent(teamMemberId))
      .then((result) => { if (active) setWindows(result) })
      .catch(() => { if (active) setWindows([]) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [teamMemberId])

  function toggleDay(weekday: number, enabled: boolean) {
    setWindows((current) => enabled
      ? [...current, { weekday, startTime: '09:00', endTime: '17:00' }]
      : current.filter((window) => window.weekday !== weekday))
  }

  function updateWindow(weekday: number, index: number, field: 'startTime' | 'endTime', value: string) {
    setWindows((current) => {
      let dayIndex = -1
      return current.map((window) => {
        if (window.weekday !== weekday) return window
        dayIndex += 1
        return dayIndex === index ? { ...window, [field]: value } : window
      })
    })
  }

  function addWindow(weekday: number) {
    const dayWindows = windows.filter((window) => window.weekday === weekday)
    const lastEnd = dayWindows.at(-1)?.endTime ?? '12:00'
    const startTime = lastEnd < '12:00' ? '13:00' : lastEnd
    const endTime = startTime < '17:00' ? '17:00' : '20:00'
    setWindows((current) => [...current, { weekday, startTime, endTime }])
  }

  function removeWindow(weekday: number, index: number) {
    setWindows((current) => {
      let dayIndex = -1
      return current.filter((window) => {
        if (window.weekday !== weekday) return true
        dayIndex += 1
        return dayIndex !== index
      })
    })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    try { await onSave(teamMemberId, windows) } finally { setSaving(false) }
  }

  return <section className="panel availability-editor">
      <div className="panel-heading"><div><span className="panel-kicker">DISPONIBILIDADE</span><h2>Horários de atendimento</h2><p>Defina quando clientes podem solicitar e você pode criar agendamentos. Os horários sugeridos respeitam a duração de cada serviço.</p></div></div>
    {loading ? <div className="loading-state">Carregando horários…</div> : <form className="availability-form" onSubmit={submit}>
      <div className="availability-days">{weekDays.map((day) => {
        const dayWindows = windows.filter((window) => window.weekday === day.value)
        const enabled = dayWindows.length > 0
        return <div className={'availability-day ' + (enabled ? 'is-open' : '')} key={day.value}>
          <label className="availability-day-heading"><input type="checkbox" checked={enabled} onChange={(event) => toggleDay(day.value, event.target.checked)} /><span>{day.label}</span></label>
          <div className="availability-periods">{dayWindows.map((window, index) => <div className="availability-period" key={day.value + '-' + index}>
            <label><span>Das</span><input type="time" value={window.startTime} onChange={(event) => updateWindow(day.value, index, 'startTime', event.target.value)} required /></label>
            <label><span>às</span><input type="time" value={window.endTime} onChange={(event) => updateWindow(day.value, index, 'endTime', event.target.value)} required /></label>
            <button type="button" className="icon-button muted remove-period" onClick={() => removeWindow(day.value, index)} aria-label={'Remover período de ' + day.label}>×</button>
          </div>)}</div>
          {enabled ? <button type="button" className="add-period-button" onClick={() => addWindow(day.value)}>+ Adicionar período</button> : <span className="day-closed">Fechado</span>}
        </div>
      })}</div>
      <div className="availability-save"><span>Ex.: crie um período de manhã e outro à tarde para incluir o intervalo de almoço.</span><button className="button button-primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar horários'}<Icon name="arrow" size={15} /></button></div>
    </form>}
  </section>
}

export default App
