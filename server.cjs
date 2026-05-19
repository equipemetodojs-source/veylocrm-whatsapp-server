const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const pino = require('pino')
const fs = require('fs')
const QRCode = require('qrcode')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 3001
const BUCKET = 'whatsapp-sessions'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// In-memory state
let sock = null
let status = 'desconectado'
let qrCode = null
let telefone = null
let initializing = false

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', wa: status, uptime: process.uptime() })
})

// Save creds to Supabase Storage
async function saveCreds(userId, creds) {
  try {
    const json = JSON.stringify(creds)
    await supabase.storage.from(BUCKET).remove([`${userId}/creds.json`])
    await supabase.storage.from(BUCKET).upload(`${userId}/creds.json`, Buffer.from(json), {
      contentType: 'application/json',
      upsert: true,
    })
  } catch (err) {
    console.error('[WA] Erro ao salvar creds:', err.message)
  }
}

// Load creds from Supabase Storage
async function loadCreds(userId) {
  try {
    const { data } = await supabase.storage.from(BUCKET).download(`${userId}/creds.json`)
    if (!data) return null
    return JSON.parse(await data.text())
  } catch {
    return null
  }
}

// Save status to Supabase DB
async function saveStatus(userId, st, qr, tel) {
  try {
    await supabase.from('WhatsAppSession').upsert({
      userId,
      status: st,
      qrCode: qr,
      telefone: tel,
      atualizadoEm: new Date().toISOString(),
    }, { onConflict: 'userId' })
  } catch (err) {
    console.error('[WA] Erro ao salvar status:', err.message)
  }
}

async function initWhatsApp(userId) {
  if (status === 'conectado' && sock) return { status: 'conectado' }
  if (initializing) return { status: 'conectando', qrCode }

  initializing = true
  status = 'conectando'
  qrCode = null

  // Ensure bucket
  try { await supabase.storage.createBucket(BUCKET, { public: false }) } catch {}

  const { state: authState } = await useMultiFileAuthState(`/tmp/wa-${userId}`)

  const remoteCreds = await loadCreds(userId)
  if (remoteCreds) {
    fs.mkdirSync(`/tmp/wa-${userId}`, { recursive: true })
    fs.writeFileSync(`/tmp/wa-${userId}/creds.json`, JSON.stringify(remoteCreds))
  }

  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['ProSpec AI', 'Chrome', '4.0.0'],
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      initializing = false
      status = 'desconectado'
      saveStatus(userId, 'desconectado', null, null)
      reject(new Error('Timeout ao conectar WhatsApp'))
    }, 120000)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('[WA] QR Code recebido')
        qrCode = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
        await saveStatus(userId, 'conectando', qrCode, null)
        resolve({ status: 'conectando', qrCode })
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = code !== DisconnectReason.loggedOut
        console.log('[WA] Conexão fechada, code:', code)

        if (shouldReconnect) {
          initializing = false
          status = 'desconectado'
          clearTimeout(timeout)
          await saveStatus(userId, 'desconectado', null, null)
          setTimeout(() => initWhatsApp(userId).catch(() => {}), 3000)
        } else {
          status = 'desconectado'
          initializing = false
          sock = null
          clearTimeout(timeout)
          await saveStatus(userId, 'desconectado', null, null)
        }
      }

      if (connection === 'open') {
        console.log('[WA] Conectado!')
        clearTimeout(timeout)
        status = 'conectado'
        initializing = false
        qrCode = null
        telefone = sock.user?.id?.split(':')[0] || null
        await saveCreds(userId, authState.creds)
        await saveStatus(userId, 'conectado', null, telefone)
        resolve({ status: 'conectado', telefone })
      }
    })

    sock.ev.on('creds.update', () => saveCreds(userId, authState.creds))

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          console.log('[WA] Msg de:', msg.key.remoteJid)
        }
      }
    })
  })
}

// --- API Routes ---

app.post('/connect', async (req, res) => {
  const { userId } = req.body
  if (!userId) return res.status(400).json({ erro: 'userId obrigatório' })
  try {
    const result = await initWhatsApp(userId)
    res.json(result)
  } catch (err) {
    console.error('[WA] Erro connect:', err.message)
    res.status(500).json({ erro: err.message })
  }
})

app.get('/status', async (req, res) => {
  const userId = req.query.userId
  if (sock && status === 'conectado') {
    return res.json({ status: 'conectado', telefone })
  }
  if (qrCode) {
    return res.json({ status: 'conectando', qrCode })
  }
  if (userId) {
    const { data } = await supabase.from('WhatsAppSession').select('status,telefone,qrCode').eq('userId', userId).single()
    if (data) return res.json({ status: data.status, telefone: data.telefone, qrCode: data.qrCode })
  }
  res.json({ status: 'desconectado' })
})

app.delete('/disconnect', async (req, res) => {
  const { userId } = req.body
  if (sock) {
    try { sock.end(undefined) } catch {}
  }
  sock = null
  status = 'desconectado'
  qrCode = null
  telefone = null
  initializing = false
  if (userId) await saveStatus(userId, 'desconectado', null, null)
  res.json({ ok: true })
})

app.post('/send', async (req, res) => {
  const { telefone: tel, mensagem } = req.body
  if (!sock || status !== 'conectado') {
    return res.status(400).json({ erro: 'WhatsApp não conectado' })
  }
  try {
    let numero = tel.replace(/\D/g, '')
    if (!numero.startsWith('55')) numero = '55' + numero
    await sock.sendMessage(numero + '@s.whatsapp.net', { text: mensagem })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

app.post('/send-audio', async (req, res) => {
  const { telefone: tel, audioBase64, mimeType } = req.body
  if (!sock || status !== 'conectado') {
    return res.status(400).json({ erro: 'WhatsApp não conectado' })
  }
  try {
    let numero = tel.replace(/\D/g, '')
    if (!numero.startsWith('55')) numero = '55' + numero
    const buffer = Buffer.from(audioBase64, 'base64')
    await sock.sendMessage(numero + '@s.whatsapp.net', {
      audio: buffer,
      mimetype: mimeType || 'audio/ogg; codecs=opus',
      ptt: true,
    })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`[WA Server] Rodando na porta ${PORT}`)
})
