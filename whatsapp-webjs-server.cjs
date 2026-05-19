const cors = require("cors");
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { execSync, execFile } = require("child_process");
const qrcode = require("qrcode");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// Auto-detect Chrome/Chromium
function findChromePath() {
  // Use env var if set (Docker / Railway)
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    try { if (require("fs").existsSync(envPath)) return envPath; } catch {}
  }
  // Linux paths (Docker)
  const linuxPaths = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of linuxPaths) {
    try { if (require("fs").existsSync(p)) return p; } catch {}
  }
  // Windows paths
  const winPaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  for (const p of winPaths) {
    try { if (require("fs").existsSync(p)) return p; } catch {}
  }
  return undefined; // Let puppeteer find it
}

const app = express();
const port = Number(process.env.WHATSAPP_QR_PORT || 3030);
const clientId = "veylocrm";
const authPath = path.resolve(process.cwd(), ".wwebjs_auth");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

let client = null;
let status = "initializing";
let lastError = null;
let lastQr = null;
let connectedNumber = null;
let sendReady = false;
let restartTimer = null;
let isInitializing = false;

const conversations = new Map();
const events = [];

// ── Flow engine state ──
const flows = new Map();              // flowId → Flow
const flowExecutions = new Map();     // chatId → { flowId, currentNodeId, startedAt, waitStartedAt, vars }
const flowTimers = new Map();         // chatId → timeoutId

function log(level, msg, detail) {
  const entry = { level, message: msg, details: detail ? String(detail) : null, at: new Date().toISOString() };
  events.unshift(entry);
  events.splice(80);
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](detail ? `${msg}: ${detail}` : msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Simulate human typing indicator before sending
async function simulateTyping(chatId, typingMs) {
  if (!client || !typingMs || typingMs < 500) return;
  try {
    await client.sendPresenceUpdate("composing", chatId);
    await sleep(Math.min(typingMs, 25000));
    await client.sendPresenceUpdate("paused", chatId).catch(() => {});
    await sleep(300 + Math.random() * 700); // Brief pause after "typing"
  } catch {
    try { await client.sendPresenceUpdate("paused", chatId); } catch {}
  }
}

// ═══════════════════════════════════════════
// Flow Execution Engine
// ═══════════════════════════════════════════

function getNextNode(flow, nodeId, sourceHandle) {
  const edge = flow.edges.find(e => {
    if (e.source !== nodeId) return false;
    if (sourceHandle) return e.sourceHandle === sourceHandle;
    return !e.sourceHandle || e.sourceHandle === "true" || e.sourceHandle === "bottom";
  });
  return edge ? edge.target : null;
}

function stopFlowExecution(chatId) {
  const timer = flowTimers.get(chatId);
  if (timer) { clearTimeout(timer); flowTimers.delete(chatId); }
  if (flowExecutions.has(chatId)) {
    log("info", `Fluxo parado para ${chatId.slice(0, 12)}...`);
    flowExecutions.delete(chatId);
  }
}

async function executeFlowNode(chatId) {
  const exec = flowExecutions.get(chatId);
  if (!exec) return;

  const flow = flows.get(exec.flowId);
  if (!flow) { stopFlowExecution(chatId); return; }

  const node = flow.nodes.find(n => n.id === exec.currentNodeId);
  if (!node) { stopFlowExecution(chatId); return; }

  log("info", `Fluxo [${flow.name}] executando no: ${node.type} (${node.id})`);

  try {
    switch (node.type) {
      case "start": {
        const nextId = getNextNode(flow, node.id);
        if (!nextId) { stopFlowExecution(chatId); return; }
        exec.currentNodeId = nextId;
        await executeFlowNode(chatId);
        break;
      }

      case "send": {
        if (!client || !sendReady) { log("warn", "Fluxo: WhatsApp nao conectado"); stopFlowExecution(chatId); return; }
        let text = node.data?.message || "";
        // Personalize
        const conv = conversations.get(chatId) || {};
        const firstName = (conv.name || "").split(" ")[0] || "";
        text = text.replace(/\{\{nome\}\}/gi, firstName).replace(/\{\{nome_completo\}\}/gi, conv.name || "");
        text = text.replace(/\{\{phone\}\}/gi, conv.handle || "");
        // Last received message
        text = text.replace(/\{\{mensagem\}\}/gi, exec.vars?.lastMessage || "");

        await simulateTyping(chatId, Math.min(text.length * 150, 5000));
        const sent = await client.sendMessage(chatId, text);
        // Register in conversation
        await ingestMessage(sent, "agent", false).catch(() => {});

        const nextId = getNextNode(flow, node.id);
        if (!nextId) { stopFlowExecution(chatId); return; }
        exec.currentNodeId = nextId;
        await executeFlowNode(chatId);
        break;
      }

      case "wait": {
        const waitMinutes = node.data?.waitMinutes || 30;
        exec.waitStartedAt = Date.now();
        log("info", `Fluxo aguardando ${waitMinutes}min para ${chatId.slice(0, 12)}...`);
        // Set timeout
        const timer = setTimeout(async () => {
          flowTimers.delete(chatId);
          if (!flowExecutions.has(chatId)) return;
          log("info", `Fluxo timeout para ${chatId.slice(0, 12)}...`);
          const nextId = getNextNode(flow, node.id);
          if (!nextId) { stopFlowExecution(chatId); return; }
          exec.currentNodeId = nextId;
          await executeFlowNode(chatId);
        }, waitMinutes * 60 * 1000);
        flowTimers.set(chatId, timer);
        // Execution pauses here — waits for message or timeout
        break;
      }

      case "condition": {
        const keyword = (node.data?.condition || "").toLowerCase().trim();
        const lastMsg = (exec.vars?.lastMessage || "").toLowerCase();
        const matches = keyword && lastMsg.includes(keyword);
        log("info", `Fluxo condicao: "${keyword}" em "${lastMsg.slice(0, 30)}..." = ${matches}`);
        const nextId = getNextNode(flow, node.id, matches ? "true" : "false");
        if (!nextId) {
          // Fallback: try without handle
          const fallbackId = getNextNode(flow, node.id);
          if (!fallbackId) { stopFlowExecution(chatId); return; }
          exec.currentNodeId = fallbackId;
        } else {
          exec.currentNodeId = nextId;
        }
        await executeFlowNode(chatId);
        break;
      }

      case "ai": {
        if (!client || !sendReady) { stopFlowExecution(chatId); return; }
        // Placeholder: send a static response (AI integration pending)
        const prompt = node.data?.aiPrompt || "";
        const fallbackText = prompt
          ? `Recebemos sua mensagem. Um atendente respondera em breve.`
          : `Obrigado pela mensagem! Um atendente entrara em contato.`;
        await simulateTyping(chatId, 2000);
        const sentAi = await client.sendMessage(chatId, fallbackText);
        await ingestMessage(sentAi, "agent", false).catch(() => {});

        const nextAiId = getNextNode(flow, node.id);
        if (!nextAiId) { stopFlowExecution(chatId); return; }
        exec.currentNodeId = nextAiId;
        await executeFlowNode(chatId);
        break;
      }

      case "end": {
        log("info", `Fluxo finalizado para ${chatId.slice(0, 12)}...`);
        stopFlowExecution(chatId);
        break;
      }

      default: {
        // Unknown node type, skip to next
        const nextDefaultId = getNextNode(flow, node.id);
        if (!nextDefaultId) { stopFlowExecution(chatId); return; }
        exec.currentNodeId = nextDefaultId;
        await executeFlowNode(chatId);
      }
    }
  } catch (err) {
    log("error", `Erro no fluxo para ${chatId.slice(0, 12)}`, err?.message);
    stopFlowExecution(chatId);
  }
}

async function startFlowExecution(flow, chatId) {
  if (!flow || !chatId) return;
  stopFlowExecution(chatId); // Cancel any existing

  const startNode = flow.nodes.find(n => n.type === "start");
  if (!startNode) { log("warn", "Fluxo sem no de inicio"); return; }

  const nextId = getNextNode(flow, startNode.id);
  if (!nextId) { log("warn", "Fluxo sem conexao apos inicio"); return; }

  flowExecutions.set(chatId, {
    flowId: flow.id,
    currentNodeId: nextId,
    startedAt: new Date().toISOString(),
    vars: {},
  });

  log("info", `Fluxo [${flow.name}] iniciado para ${chatId.slice(0, 12)}...`);
  await executeFlowNode(chatId);
}

async function advanceFlowOnMessage(chatId, messageText) {
  const exec = flowExecutions.get(chatId);
  if (!exec) return;

  const flow = flows.get(exec.flowId);
  if (!flow) { stopFlowExecution(chatId); return; }

  const node = flow.nodes.find(n => n.id === exec.currentNodeId);
  if (!node) { stopFlowExecution(chatId); return; }

  // Save the received message
  exec.vars = exec.vars || {};
  exec.vars.lastMessage = messageText || "";

  if (node.type === "wait") {
    // Cancel timeout timer
    const timer = flowTimers.get(chatId);
    if (timer) { clearTimeout(timer); flowTimers.delete(chatId); }
    log("info", `Fluxo: resposta recebida para ${chatId.slice(0, 12)}...`);
    const nextId = getNextNode(flow, node.id);
    if (!nextId) { stopFlowExecution(chatId); return; }
    exec.currentNodeId = nextId;
    await executeFlowNode(chatId);
  }
}

// Trigger flow for new conversations
async function triggerFlowForNewConversation(chatId) {
  // Find active flow with "new_conversation" trigger
  for (const [, flow] of flows) {
    if (flow.active && (flow.trigger === "new_conversation" || !flow.trigger)) {
      await startFlowExecution(flow, chatId);
      return;
    }
  }
}

// Get descriptive text for a message (handles media types, stickers, etc.)
function getMessageText(msg) {
  if (msg.body && msg.body.length > 0) return msg.body;
  switch (msg.type) {
    case "ptt": case "audio": return "\u{1F3A4} Audio";
    case "image": return "\u{1F4F7} Foto";
    case "video": return "\u{1F3AC} Video";
    case "document": return "\u{1F4CE} Documento";
    case "sticker": return "\u{1F4DD} Sticker";
    case "location": return "\u{1F4CD} Localizacao";
    case "vcard": case "multi_vcard": return "\u{1F464} Contato";
    case "call_log": return "\u{1F4DE} Chamada";
    default: return "\u{1F4DD} Mensagem";
  }
}

// Normalize Brazilian phone numbers to consistent format with country code
const BR_DDDS = new Set([
  "11","12","13","14","15","16","17","18","19","21","22","24","27","28",
  "31","32","33","34","35","37","38","41","42","43","44","45","46","47","48","49",
  "51","53","54","55","61","62","63","64","65","66","67","68","69",
  "71","73","74","75","77","79","81","82","83","84","85","86","87","88","89",
  "91","92","93","94","95","96","97","98","99",
]);
function normalizeConvPhone(raw) {
  const d = String(raw).replace(/\D/g, "");
  if (!d) return raw;
  if (d.startsWith("55") && d.length >= 12) return d;
  if (d.length === 11 && BR_DDDS.has(d.substring(0, 2))) return "55" + d;
  if (d.length === 10 && BR_DDDS.has(d.substring(0, 2))) return "55" + d;
  return d;
}

function scheduleRestart(delay = 5000) {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (isInitializing) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startClient();
  }, delay);
}

async function stopClient() {
  const current = client;
  client = null;
  sendReady = false;
  if (!current) return;
  try {
    // Try to get the browser process PID before destroying
    let browserPid = null;
    try {
      const browser = current.pupBrowser;
      if (browser && browser.process()) {
        browserPid = browser.process().pid;
      }
    } catch {}

    current.removeAllListeners?.();
    await current.destroy();

    // Force kill the specific Chrome process tree if it's still alive
    if (browserPid) {
      try {
        execSync(`taskkill /F /T /PID ${browserPid} 2>nul`, { timeout: 5000 });
      } catch {}
    }
  } catch (err) {
    log("warn", "Falha ao encerrar cliente", err.message);
  }
  await sleep(3000);
}

async function startClient() {
  if (isInitializing) { log("warn", "Ja inicializando, ignorando"); return; }
  isInitializing = true;

  try {
    await stopClient();

    status = "initializing";
    lastError = null;
    lastQr = null;
    connectedNumber = null;
    sendReady = false;

    const chromePath = findChromePath();
    const puppeteerConfig = {
      headless: true,
      dumpio: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-trottling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-crashpad",
      ],
    };
    if (chromePath) puppeteerConfig.executablePath = chromePath;

    client = new Client({
      authStrategy: new LocalAuth({ clientId, dataPath: authPath }),
      puppeteer: puppeteerConfig,
    });

    client.on("qr", async (qr) => {
      status = "qr";
      lastQr = await qrcode.toDataURL(qr);
      connectedNumber = null;
      lastError = null;
      log("info", "QR Code gerado");
    });

    client.on("authenticated", () => {
      status = "authenticated";
      lastQr = null;
      lastError = null;
      log("info", "Autenticado");
    });

    client.on("ready", async () => {
      status = "ready";
      lastQr = null;
      lastError = null;
      connectedNumber = client?.info?.wid?.user || null;
      log("info", `WhatsApp conectado: ${connectedNumber}`);
      // Give a moment for encryption to sync
      setTimeout(() => {
        if (status === "ready") {
          sendReady = true;
          log("info", "Envio liberado");
        }
      }, 3000);
      await hydrateRecentChats();
      // Try to resolve LID contacts to real phone numbers
      resolveAllLids().catch(() => {});
    });

    client.on("auth_failure", (message) => {
      status = "auth_failure";
      lastError = message || "Falha de autenticacao";
      sendReady = false;
      log("error", "Falha de autenticacao", lastError);
      scheduleRestart(5000);
    });

    client.on("disconnected", (reason) => {
      status = "disconnected";
      connectedNumber = null;
      lastQr = null;
      sendReady = false;
      lastError = reason || "Desconectado";
      log("warn", "Desconectado", lastError);
      scheduleRestart(5000);
    });

    client.on("message", async (message) => {
      const chatId = message.from;
      const isNew = !conversations.has(chatId) && !conversations.has(normalizeConvPhone(chatId) + "@c.us");
      await ingestMessage(message, "lead");
      // Advance active flow or trigger new one
      if (!message.fromMe) {
        const msgText = getMessageText(message);
        const hadExec = flowExecutions.has(chatId);
        await advanceFlowOnMessage(chatId, msgText);
        // If no active flow and conversation is new, trigger
        if (!hadExec && !flowExecutions.has(chatId) && isNew) {
          await triggerFlowForNewConversation(chatId);
        }
      }
    });

    client.on("message_create", async (message) => {
      if (message.fromMe) await ingestMessage(message, "agent");
    });

    log("info", "Inicializando WhatsApp Web...");
    await client.initialize();
    log("info", "Cliente inicializado");
  } catch (err) {
    status = "error";
    const errMsg = err?.message || String(err);
    // Provide helpful error messages for common issues
    if (errMsg.includes("Could not find Chrome") || errMsg.includes("chromium") || errMsg.includes("ENOENT")) {
      lastError = "Chrome/Chromium nao encontrado. Instale o Google Chrome ou rode: npx puppeteer browsers install chrome";
    } else if (errMsg.includes("launch") || errMsg.includes("Failed to launch")) {
      lastError = "Falha ao abrir navegador. Verifique se nao ha outro Chrome rodando e tente novamente.";
    } else if (errMsg.includes("timeout")) {
      lastError = "Timeout ao inicializar WhatsApp. Verifique sua conexao com a internet.";
    } else {
      lastError = errMsg;
    }
    log("error", "Erro ao inicializar", errMsg);
    scheduleRestart(8000);
  } finally {
    isInitializing = false;
  }
}

// Contact cache for LID resolution
let contactCache = null;
let contactCacheTime = 0;
let waStoreAvailable = false;

async function getContactCache() {
  if (!client) return [];
  const now = Date.now();
  if (contactCache && now - contactCacheTime < 60000) return contactCache;
  try {
    contactCache = await client.getContacts();
    contactCacheTime = now;
  } catch { contactCache = []; }
  return contactCache;
}

// Try to resolve LID → phone using multiple approaches
async function resolveLidToPhone(lid) {
  if (!client) return null;

  // Approach 1: Try Puppeteer Store access
  try {
    const result = await client.pupPage.evaluate((lidStr) => {
      try {
        let Store = window.Store;
        if (!Store) {
          try { Store = Object.values(window.__webpack_modules__ || {}).find(m => m?.exports?.Contact)?.exports; } catch {}
        }
        if (!Store) return null;

        const jid = lidStr + "@lid";
        const contactFn = Store.Contact?.get || Store.ContactCollection?.get;
        if (typeof contactFn === "function") {
          const c = contactFn.call(Store.Contact || Store.ContactCollection, jid);
          if (c) {
            if (c.phoneNumber) return String(c.phoneNumber);
            if (c.number) return String(c.number);
            const id = c.__x_id || c.id;
            if (id?.user && !String(id.user).endsWith("@lid")) return String(id.user);
          }
        }
        if (Store.LidUtils) {
          try { const p = Store.LidUtils.getPhone(jid); if (p) return String(p); } catch {}
        }
      } catch {}
      return null;
    }, lid);
    if (result && !String(result).endsWith("@lid")) {
      waStoreAvailable = true;
      return String(result);
    }
  } catch {}

  return null;
}

// Resolve LID contacts to phone numbers by name matching against @c.us contacts
async function resolveLidByName(contactName) {
  if (!client || !contactName) return null;
  try {
    const contacts = await getContactCache();
    const searchName = contactName.toLowerCase().trim();

    // Helper: check if a number looks like a real phone number (not a LID)
    const isRealPhone = (num) => {
      const d = String(num).replace(/\D/g, "");
      return d.length >= 10 && d.length <= 13;
    };

    // First pass: exact match with REAL phone number
    for (const c of contacts) {
      if (c.id?._serialized?.endsWith("@c.us") && c.number && isRealPhone(c.number)) {
        const cName = (c.pushname || c.name || "").toLowerCase().trim();
        if (cName && cName === searchName) return c.number;
      }
    }
    // Second pass: partial match with REAL phone number
    for (const c of contacts) {
      if (c.id?._serialized?.endsWith("@c.us") && c.number && isRealPhone(c.number)) {
        const cName = (c.pushname || c.name || "").toLowerCase().trim();
        if (cName && searchName && (cName.includes(searchName) || searchName.includes(cName))) return c.number;
      }
    }
    // Third pass: any match (including LID numbers, better than nothing)
    for (const c of contacts) {
      if (c.id?._serialized?.endsWith("@c.us") && c.number) {
        const cName = (c.pushname || c.name || "").toLowerCase().trim();
        if (cName && cName === searchName) return c.number;
      }
    }
  } catch {}
  return null;
}

// Resolve contact info from JID and contact object
async function resolveContact(rawJid, contact, pushName, chatName) {
  const isLid = rawJid.endsWith("@lid");
  const rawUser = rawJid.replace(/@(c\.us|lid)$/, "");

  let phone = "";
  let displayName = "";
  let avatarUrl = null;

  if (contact) {
    phone = contact.number || contact.id?.user || "";
    phone = phone.replace(/@(c\.us|lid)$/, "");
    displayName = contact.pushname || contact.name || contact.shortName || "";
  }

  // If phone is empty, use raw JID
  if (!phone) phone = rawUser;

  // For LID contacts, try to resolve real phone number via WhatsApp Web Store
  if (isLid && client) {
    const resolvedPhone = await resolveLidToPhone(rawUser);
    if (resolvedPhone) {
      phone = resolvedPhone.replace(/\D/g, "");
      log("info", `LID resolvido: ${rawUser} -> ${phone}`);
    }
  }

  // For LID contacts, try to find real contact by name matching
  if (isLid && client) {
    try {
      const contacts = await getContactCache();
      const searchName = displayName || pushName || "";
      if (searchName) {
        for (const c of contacts) {
          if (c.id?._serialized?.endsWith("@c.us") && c.number) {
            const cName = c.pushname || c.name || "";
            if (cName && (cName === searchName || searchName.includes(cName) || cName.includes(searchName))) {
              phone = c.number;
              if (!displayName) displayName = cName;
              break;
            }
          }
        }
      }
    } catch {}
  }

  // Fallback name: pushName from message > chat name
  if (!displayName) displayName = pushName || chatName || "";

  // Sanitize: never use generic WhatsApp labels as display name
  const blockedNames = ["whatsapp", "unknown", "desconhecido", "contato"];
  if (blockedNames.includes((displayName || "").toLowerCase().trim())) displayName = "";

  // Get avatar - try contact first, then chat
  try {
    if (contact?.getProfilePicUrl) {
      avatarUrl = await contact.getProfilePicUrl();
    }
  } catch {}
  if (!avatarUrl && isLid && client) {
    try {
      const contacts = await getContactCache();
      for (const c of contacts) {
        if (c.id?._serialized === rawJid && c.getProfilePicUrl) {
          avatarUrl = await c.getProfilePicUrl();
          if (avatarUrl) break;
        }
      }
    } catch {}
  }

  return { phone, displayName, avatarUrl, chatId: rawJid, isLid };
}

async function hydrateRecentChats() {
  try {
    if (!client) return;
    const chats = await client.getChats();
    const nonGroup = chats.filter(c => !c.isGroup && c.id?._serialized && !c.id._serialized.endsWith("@g.us") && c.id._serialized !== "status@broadcast");
    log("info", `Total de conversas disponiveis: ${nonGroup.length}`);

    for (const chat of nonGroup.slice(0, 100)) {
      const rawId = chat.id?._serialized || "";

      const contact = await chat.getContact().catch(() => null);
      const { phone, displayName, avatarUrl, chatId } = await resolveContact(rawId, contact, null, chat.name);
      const convId = normalizeConvPhone(phone) + "@c.us";

      const conv = conversations.get(convId) || {
        id: convId, chatId, name: displayName || chat.name || phone, handle: phone, avatarUrl,
        channel: "WhatsApp", status: "novo", stage: "Novo", owner: "Ninguem",
        unread: chat.unreadCount || 0, lastSeen: "", value: "", tags: [], messages: [],
      };

      conv.name = displayName || chat.name || phone;
      conv.handle = phone;
      conv.chatId = chatId;
      if (avatarUrl) conv.avatarUrl = avatarUrl;

      const messages = await chat.fetchMessages({ limit: 30 }).catch(() => []);
      for (const msg of messages) {
        const msgId = msg.id?._serialized || `${convId}-${Date.now()}`;
        if (conv.messages.some(m => m.id === msgId)) continue;
        const ts = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;
        let text = getMessageText(msg);
        let mediaUrl = null;
        let mediaMime = null;

        // Download media for history messages
        if (msg.hasMedia) {
          try {
            const isVoice = msg.type === "ptt";
            const isAudio = msg.type === "audio";

            if (isVoice && msg.body && msg.body.length > 200) {
              const mime = msg.mimetype || "audio/ogg; codecs=opus";
              mediaUrl = `data:${mime};base64,${msg.body}`;
              mediaMime = mime;
              text = "\u{1F3A4} Audio";
            } else {
              const media = await msg.downloadMedia();
              if (media && media.data) {
                mediaUrl = `data:${media.mimetype};base64,${media.data}`;
                mediaMime = media.mimetype;
                if (isVoice || isAudio) {
                  text = "\u{1F3A4} Audio";
                } else if (media.mimetype?.startsWith("image/")) {
                  text = msg.body || "\u{1F4F7} Foto";
                } else if (media.mimetype?.startsWith("video/")) {
                  text = msg.body || "\u{1F3AC} Video";
                } else {
                  text = msg.body || "\u{1F4CE} Documento";
                }
              }
            }
          } catch {
            if (msg.type === "ptt" || msg.type === "audio") text = "\u{1F3A4} Audio";
            else if (msg.type === "image") text = "\u{1F4F7} Foto";
            else if (msg.type === "video") text = "\u{1F3AC} Video";
            else if (msg.type === "document") text = "\u{1F4CE} Documento";
          }
        }

        conv.messages.push({
          id: msgId,
          from: msg.fromMe ? "agent" : "lead",
          text,
          time: new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
          ts,
          mediaUrl,
          mediaMime,
        });
      }
      conv.messages = conv.messages.slice(-80);
      const lastMsg = conv.messages.at(-1);
      conv.lastTs = lastMsg ? (lastMsg.ts || 0) : 0;
      conversations.set(convId, conv);
    }
    log("info", `Conversas carregadas: ${conversations.size}`);
  } catch (err) {
    log("warn", "Erro ao carregar conversas", err.message);
  }
}

async function ingestMessage(message, fallbackFrom, announce = true, extraAudioUrl = null) {
  try {
    const rawChatId = message.fromMe ? message.to : message.from;
    if (!rawChatId || rawChatId.endsWith("@g.us") || rawChatId === "status@broadcast") return;

    const contact = await message.getContact().catch(() => null);
    const { phone, displayName, avatarUrl, chatId } = await resolveContact(rawChatId, contact, message.pushName, null);
    const convId = normalizeConvPhone(phone) + "@c.us";

    const finalName = displayName || message.pushName || phone;

    const conv = conversations.get(convId) || {
      id: convId, chatId, name: finalName, handle: phone,
      avatarUrl: avatarUrl || null, channel: "WhatsApp",
      status: "novo", stage: "Novo", owner: "Ninguem",
      unread: 0, lastSeen: "", value: "", tags: [], messages: [],
    };

    conv.name = finalName;
    conv.handle = phone;
    conv.chatId = chatId;
    if (avatarUrl) conv.avatarUrl = avatarUrl;
    conv.lastSeen = new Date((message.timestamp || Date.now() / 1000) * 1000).toLocaleString("pt-BR");

    const msgId = message.id?._serialized || `${convId}-${Date.now()}`;
    const msgTs = (message.timestamp || Math.floor(Date.now() / 1000)) * 1000;

    if (!conv.messages.some(m => m.id === msgId)) {
      let msgText = getMessageText(message);
      let mediaUrl = extraAudioUrl || null;
      let mediaMime = null;

      // Download media for all types
      if (message.hasMedia) {
        try {
          const isVoice = message.type === "ptt";
          const isAudio = message.type === "audio";

          // Voice notes may have base64 in body already
          if (isVoice && message.body && message.body.length > 200) {
            const mime = message.mimetype || "audio/ogg; codecs=opus";
            mediaUrl = `data:${mime};base64,${message.body}`;
            mediaMime = mime;
            msgText = "\u{1F3A4} Audio";
          } else {
            const media = await message.downloadMedia();
            if (media && media.data) {
              mediaUrl = `data:${media.mimetype};base64,${media.data}`;
              mediaMime = media.mimetype;
              if (isVoice || isAudio) {
                msgText = "\u{1F3A4} Audio";
              } else if (media.mimetype?.startsWith("image/")) {
                msgText = message.body || "\u{1F4F7} Foto";
              } else if (media.mimetype?.startsWith("video/")) {
                msgText = message.body || "\u{1F3AC} Video";
              } else {
                msgText = message.body || "\u{1F4CE} Documento";
              }
            }
          }
          log("info", `Midia baixada: ${message.type} ${mediaMime || ""} ${mediaUrl?.length || 0} chars`);
        } catch (dlErr) {
          log("warn", "Falha ao baixar midia", dlErr?.message);
          // Fallback: set descriptive text
          if (message.type === "ptt" || message.type === "audio") msgText = "\u{1F3A4} Audio";
          else if (message.type === "image") msgText = "\u{1F4F7} Foto";
          else if (message.type === "video") msgText = "\u{1F3AC} Video";
          else if (message.type === "document") msgText = "\u{1F4CE} Documento";
        }
      }

      conv.messages.push({
        id: msgId,
        from: message.fromMe ? "agent" : fallbackFrom,
        text: msgText,
        time: new Date(msgTs).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
        ts: msgTs,
        mediaUrl,
        mediaMime,
      });
    }

    conv.lastTs = msgTs;
    if (!message.fromMe && announce) conv.unread = (conv.unread || 0) + 1;
    conv.messages = conv.messages.slice(-80);
    conversations.set(convId, conv);
  } catch (err) {
    // swallow - don't crash on message ingestion
  }
}

// ── API ──

async function resolveAllLids() {
  if (!client || status !== "ready") return;

  // Debug: count contact types
  const contacts = await getContactCache();
  const cusCount = contacts.filter(c => c.id?._serialized?.endsWith("@c.us")).length;
  const lidCount = contacts.filter(c => c.id?._serialized?.endsWith("@lid")).length;
  log("info", `Contatos: ${cusCount} @c.us, ${lidCount} @lid, ${contacts.length} total`);

  let resolved = 0;
  let attempted = 0;
  for (const [convId, conv] of conversations) {
    if (conv.chatId?.endsWith("@lid")) {
      attempted++;
      const lid = conv.chatId.replace("@lid", "");

      // Try Puppeteer Store first
      let phone = await resolveLidToPhone(lid);

      // Fallback: name matching against @c.us contacts
      if (!phone) {
        phone = await resolveLidByName(conv.name);
      }

      if (phone && phone.replace(/\D/g, "").length >= 10 && !phone.endsWith("@lid")) {
        const cleanPhone = normalizeConvPhone(phone);
        const normalizedConvId = cleanPhone + "@c.us";

        // If another conversation already exists for this phone, merge into it
        if (normalizedConvId !== convId && conversations.has(normalizedConvId)) {
          const existing = conversations.get(normalizedConvId);
          // Merge messages (keep unique by ID)
          const msgMap = new Map();
          for (const m of existing.messages) msgMap.set(m.id, m);
          for (const m of conv.messages) if (!msgMap.has(m.id)) msgMap.set(m.id, m);
          existing.messages = [...msgMap.values()].slice(-80);
          existing.lastTs = Math.max(existing.lastTs || 0, conv.lastTs || 0);
          if (!existing.name || existing.name.length < 3) existing.name = conv.name;
          existing.unread = Math.max(existing.unread || 0, conv.unread || 0);
          conversations.delete(convId);
          log("info", `Conversa duplicada mesclada: ${convId} -> ${normalizedConvId}`);
        } else {
          // Update the conversation key if phone changed
          if (normalizedConvId !== convId) {
            conversations.delete(convId);
            conv.id = normalizedConvId;
            conversations.set(normalizedConvId, conv);
          }
          conv.handle = cleanPhone;
        }
        resolved++;
        log("info", `LID resolvido: ${conv.name} ${lid} -> ${cleanPhone}`);
      }
    }
  }
  log("info", `LID resolution: ${resolved}/${attempted} resolvidos, Store: ${waStoreAvailable}`);
}

app.get("/api/status", (_req, res) => {
  res.json({
    status,
    connected: status === "ready",
    sendReady,
    connectedNumber,
    hasQr: Boolean(lastQr),
    lastError,
    events: events.slice(0, 15),
  });
});

app.get("/api/qr", (_req, res) => {
  res.json({
    status,
    qr: lastQr,
    connected: status === "ready",
    sendReady,
    connectedNumber,
    lastError,
    events: events.slice(0, 15),
  });
});

app.get("/api/conversations", (_req, res) => {
  const list = Array.from(conversations.values()).sort((a, b) => {
    const at = a.lastTs || 0;
    const bt = b.lastTs || 0;
    return bt - at;
  });
  res.json({ conversations: list });
});

app.post("/api/conversations/:id/read", (req, res) => {
  const conv = conversations.get(decodeURIComponent(req.params.id));
  if (conv) conv.unread = 0;
  res.json({ ok: true });
});

app.delete("/api/conversations/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  conversations.delete(id);
  log("info", `Conversa excluida: ${id}`);
  res.json({ ok: true });
});

// Fetch more messages for a specific conversation (lazy load history)
app.get("/api/conversations/:id/messages", async (req, res) => {
  try {
    if (!client || status !== "ready") return res.status(503).json({ error: "nao_conectado" });
    const convId = decodeURIComponent(req.params.id);
    const conv = conversations.get(convId);
    if (!conv) return res.status(404).json({ error: "conversa_nao_encontrada" });

    const chatId = conv.chatId || convId;
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    let chat;
    try {
      chat = await client.getChatById(chatId);
    } catch {
      return res.status(404).json({ error: "chat_nao_encontrado" });
    }

    const messages = await chat.fetchMessages({ limit }).catch(() => []);
    const enriched = [];

    for (const msg of messages) {
      const msgId = msg.id?._serialized || `${convId}-${Date.now()}`;
      const ts = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;
      let text = getMessageText(msg);
      let mediaUrl = null;
      let mediaMime = null;

      if (msg.hasMedia) {
        try {
          const isVoice = msg.type === "ptt";
          const isAudio = msg.type === "audio";

          if (isVoice && msg.body && msg.body.length > 200) {
            const mime = msg.mimetype || "audio/ogg; codecs=opus";
            mediaUrl = `data:${mime};base64,${msg.body}`;
            mediaMime = mime;
            text = "\u{1F3A4} Audio";
          } else {
            const media = await msg.downloadMedia();
            if (media && media.data) {
              mediaUrl = `data:${media.mimetype};base64,${media.data}`;
              mediaMime = media.mimetype;
              if (isVoice || isAudio) text = "\u{1F3A4} Audio";
              else if (media.mimetype?.startsWith("image/")) text = msg.body || "\u{1F4F7} Foto";
              else if (media.mimetype?.startsWith("video/")) text = msg.body || "\u{1F3AC} Video";
              else text = msg.body || "\u{1F4CE} Documento";
            }
          }
        } catch {
          if (msg.type === "ptt" || msg.type === "audio") text = "\u{1F3A4} Audio";
          else if (msg.type === "image") text = "\u{1F4F7} Foto";
          else if (msg.type === "video") text = "\u{1F3AC} Video";
          else if (msg.type === "document") text = "\u{1F4CE} Documento";
        }
      }

      enriched.push({
        id: msgId,
        from: msg.fromMe ? "agent" : "lead",
        text,
        time: new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
        ts,
        mediaUrl,
        mediaMime,
      });
    }

    // Merge into conversation
    const msgMap = new Map();
    for (const m of conv.messages) msgMap.set(m.id, m);
    for (const m of enriched) msgMap.set(m.id, m);
    conv.messages = [...msgMap.values()].slice(-80);
    const lastMsg = conv.messages.at(-1);
    conv.lastTs = lastMsg ? (lastMsg.ts || 0) : 0;
    conversations.set(convId, conv);

    res.json({ messages: enriched });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Resolve LID phone numbers for all conversations
app.post("/api/resolve-lids", async (_req, res) => {
  if (!client || status !== "ready") return res.status(503).json({ error: "nao_conectado" });
  let resolved = 0;
  for (const [convId, conv] of conversations) {
    if (conv.chatId?.endsWith("@lid")) {
      const lid = conv.chatId.replace("@lid", "");
      const phone = await resolveLidToPhone(lid);
      if (phone && phone.replace(/\D/g, "").length >= 10 && !phone.endsWith("@lid")) {
        const cleanPhone = phone.replace(/\D/g, "");
        conv.handle = cleanPhone;
        resolved++;
        log("info", `LID resolvido para ${conv.name}: ${lid} -> ${cleanPhone}`);
      }
    }
  }
  res.json({ ok: true, resolved, total: conversations.size });
});

app.post("/api/send", async (req, res) => {
  try {
    if (!client) return res.status(503).json({ error: "cliente_nao_iniciado" });
    if (status !== "ready") return res.status(503).json({ error: "whatsapp_nao_conectado" });
    if (!sendReady) return res.status(503).json({ error: "aguarde_sessoes" });

    const to = String(req.body?.to || "").trim();
    const text = String(req.body?.text || "").trim();
    const chatIdParam = String(req.body?.chatId || "").trim();
    if (!to || !text) return res.status(400).json({ error: "to e text obrigatorios" });

    // Use chatId if provided (for @lid contacts), otherwise construct from 'to'
    const chatId = chatIdParam || (to.includes("@") ? to : `${to.replace(/\D/g, "")}@c.us`);

    // Simulate typing before sending
    const typingMs = Number(req.body?.typingMs) || 0;
    await simulateTyping(chatId, typingMs);

    const sent = await client.sendMessage(chatId, text);
    await ingestMessage(sent, "agent", false);

    log("info", `Enviado: ${text.substring(0, 50)} -> ${chatId}`);
    res.json({ ok: true, id: sent.id?._serialized });
  } catch (err) {
    lastError = err?.message || String(err);
    log("error", "Erro ao enviar", lastError);
    res.status(500).json({ error: lastError });
  }
});

function convertToOgg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      "-y",
      "-i", inputPath,
      "-c:a", "libopus",
      "-b:a", "32k",
      "-ar", "16000",
      "-ac", "1",
      outputPath,
    ], { timeout: 15000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

app.post("/api/send-audio", async (req, res) => {
  const tmpFiles = [];
  try {
    if (!client) return res.status(503).json({ error: "cliente_nao_iniciado" });
    if (status !== "ready") return res.status(503).json({ error: "whatsapp_nao_conectado" });
    if (!sendReady) return res.status(503).json({ error: "aguarde_sessoes" });

    const to = String(req.body?.to || "").trim();
    const chatIdParam = String(req.body?.chatId || "").trim();
    const audioBase64 = String(req.body?.audio || "").trim();
    const mimeType = String(req.body?.mimeType || "audio/webm").trim();
    if (!to || !audioBase64) return res.status(400).json({ error: "to e audio obrigatorios" });

    const chatId = chatIdParam || (to.includes("@") ? to : `${to.replace(/\D/g, "")}@c.us`);

    // Simulate typing before sending audio
    const typingMs = Number(req.body?.typingMs) || 0;
    await simulateTyping(chatId, typingMs);

    // Save input file
    const tmpDir = path.join(authPath, "..", ".wwebjs_audio");
    await fs.mkdir(tmpDir, { recursive: true });
    const ts = Date.now();
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
    const inputFile = path.join(tmpDir, `input_${ts}.${ext}`);
    const outputFile = path.join(tmpDir, `output_${ts}.ogg`);
    tmpFiles.push(inputFile, outputFile);
    const audioBuffer = Buffer.from(audioBase64, "base64");
    await fs.writeFile(inputFile, audioBuffer);

    // Convert to OGG/Opus (WhatsApp voice format)
    let voiceFile = inputFile;
    try {
      await convertToOgg(inputFile, outputFile);
      voiceFile = outputFile;
      log("info", `Convertido para OGG/Opus: ${audioBuffer.length} bytes`);
    } catch (convErr) {
      log("warn", "Conversao falhou, usando original", convErr?.message);
    }

    // Read converted file as base64 for playback in CRM
    let sentAudioUrl = null;
    try {
      const outBuf = await fs.readFile(voiceFile);
      sentAudioUrl = `data:audio/ogg;base64,${outBuf.toString("base64")}`;
    } catch {}

    // Send as voice message
    let sent;
    try {
      const media = MessageMedia.fromFilePath(voiceFile);
      sent = await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
      log("info", `Audio enviado como voz -> ${chatId}`);
    } catch (voiceErr) {
      log("warn", "Envio como voz falhou, tentando anexo", voiceErr?.message);
      const media = MessageMedia.fromFilePath(voiceFile);
      sent = await client.sendMessage(chatId, media);
      log("info", `Audio enviado como anexo -> ${chatId}`);
    }

    // Register message in conversations with audioUrl for playback
    await ingestMessage(sent, "agent", false, sentAudioUrl);

    res.json({ ok: true, id: sent.id?._serialized });
  } catch (err) {
    const errMsg = err?.message || err?.toString() || "erro desconhecido";
    lastError = errMsg;
    log("error", "Erro ao enviar audio", errMsg);
    if (!res.headersSent) res.status(500).json({ error: errMsg });
  } finally {
    for (const f of tmpFiles) { await fs.unlink(f).catch(() => {}); }
  }
});

app.post("/api/send-image", async (req, res) => {
  try {
    if (!client) return res.status(503).json({ error: "cliente_nao_iniciado" });
    if (status !== "ready") return res.status(503).json({ error: "whatsapp_nao_conectado" });
    if (!sendReady) return res.status(503).json({ error: "aguarde_sessoes" });

    const to = String(req.body?.to || "").trim();
    const chatIdParam = String(req.body?.chatId || "").trim();
    const imageBase64 = String(req.body?.imageBase64 || "").trim();
    const mimeType = String(req.body?.mimeType || "image/jpeg").trim();
    const caption = String(req.body?.caption || "").trim();
    if (!to || !imageBase64) return res.status(400).json({ error: "to e imageBase64 obrigatorios" });

    const chatId = chatIdParam || (to.includes("@") ? to : `${to.replace(/\D/g, "")}@c.us`);

    // Simulate typing before sending image
    const typingMs = Number(req.body?.typingMs) || 0;
    await simulateTyping(chatId, typingMs);

    const media = new MessageMedia(mimeType, imageBase64);
    const sent = await client.sendMessage(chatId, media, { caption: caption || undefined });
    await ingestMessage(sent, "agent", false);

    log("info", `Imagem enviada -> ${chatId}${caption ? ` (${caption})` : ""}`);
    res.json({ ok: true, id: sent.id?._serialized });
  } catch (err) {
    lastError = err?.message || String(err);
    log("error", "Erro ao enviar imagem", lastError);
    res.status(500).json({ error: lastError });
  }
});

app.post("/api/send-video", async (req, res) => {
  try {
    if (!client) return res.status(503).json({ error: "cliente_nao_iniciado" });
    if (status !== "ready") return res.status(503).json({ error: "whatsapp_nao_conectado" });
    if (!sendReady) return res.status(503).json({ error: "aguarde_sessoes" });

    const to = String(req.body?.to || "").trim();
    const chatIdParam = String(req.body?.chatId || "").trim();
    const videoBase64 = String(req.body?.videoBase64 || "").trim();
    const mimeType = String(req.body?.mimeType || "video/mp4").trim();
    const caption = String(req.body?.caption || "").trim();
    if (!to || !videoBase64) return res.status(400).json({ error: "to e videoBase64 obrigatorios" });

    const chatId = chatIdParam || (to.includes("@") ? to : `${to.replace(/\D/g, "")}@c.us`);

    // Simulate typing before sending video
    const typingMs = Number(req.body?.typingMs) || 0;
    await simulateTyping(chatId, typingMs);

    const media = new MessageMedia(mimeType, videoBase64);
    const sent = await client.sendMessage(chatId, media, { caption: caption || undefined });
    await ingestMessage(sent, "agent", false);

    log("info", `Video enviado -> ${chatId}${caption ? ` (${caption})` : ""}`);
    res.json({ ok: true, id: sent.id?._serialized });
  } catch (err) {
    lastError = err?.message || String(err);
    log("error", "Erro ao enviar video", lastError);
    res.status(500).json({ error: lastError });
  }
});

app.post("/api/logout", async (_req, res) => {
  try {
    if (client) await client.logout().catch(() => {});
  } catch {}
  status = "logged_out";
  lastQr = null;
  connectedNumber = null;
  sendReady = false;
  res.json({ ok: true });
  scheduleRestart(2000);
});

app.post("/api/restart", (_req, res) => {
  res.json({ ok: true });
  scheduleRestart(1000);
});

app.post("/api/reset-session", async (_req, res) => {
  try {
    await stopClient();
    const sessionDir = path.join(authPath, `session-${clientId}`);
    await fs.rm(sessionDir, { recursive: true, force: true });
    conversations.clear();
    status = "resetting";
    lastQr = null;
    connectedNumber = null;
    sendReady = false;
    log("info", "Sessao resetada");
    res.json({ ok: true });
    scheduleRestart(1000);
  } catch (err) {
    lastError = err?.message || String(err);
    log("error", "Erro ao resetar", lastError);
    res.status(500).json({ error: lastError });
  }
});

// ── Flow API ──

app.post("/api/flows", (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  flows.clear();
  for (const f of list) {
    if (f && f.id) flows.set(f.id, f);
  }
  log("info", `Fluxos atualizados: ${flows.size} fluxos`);
  res.json({ ok: true, count: flows.size });
});

app.get("/api/flows", (_req, res) => {
  res.json([...flows.values()]);
});

app.get("/api/flows/status", (_req, res) => {
  const active = [];
  for (const [chatId, exec] of flowExecutions) {
    const flow = flows.get(exec.flowId);
    const node = flow?.nodes?.find(n => n.id === exec.currentNodeId);
    active.push({
      chatId,
      flowName: flow?.name || "?",
      currentNodeType: node?.type || "?",
      startedAt: exec.startedAt,
    });
  }
  res.json(active);
});

app.post("/api/flows/trigger", async (req, res) => {
  try {
    const { flowId, chatId } = req.body || {};
    if (!flowId || !chatId) return res.status(400).json({ error: "flowId e chatId obrigatorios" });
    const flow = flows.get(flowId);
    if (!flow) return res.status(404).json({ error: "Fluxo nao encontrado" });
    await startFlowExecution(flow, chatId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/flows/stop", (req, res) => {
  const { chatId } = req.body || {};
  if (!chatId) return res.status(400).json({ error: "chatId obrigatorio" });
  stopFlowExecution(chatId);
  res.json({ ok: true });
});

// ── Error handlers ──
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes("Session closed") || msg.includes("Target closed")) return;
  lastError = msg;
  log("error", "Unhandled rejection", msg);
  scheduleRestart(5000);
});

process.on("uncaughtException", (err) => {
  lastError = err?.message || String(err);
  log("error", "Uncaught exception", lastError);
  scheduleRestart(5000);
});

// ── Health check endpoint ──
app.get("/api/health", (_req, res) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    uptime: Math.round(uptime),
    status,
    connected: status === "ready",
    sendReady,
    connectedNumber,
    hasQr: Boolean(lastQr),
    lastError,
    memoryMB: Math.round(mem.heapUsed / 1024 / 1024),
    conversations: conversations.size,
    flows: flows.size,
    events: events.length,
  });
});

// ── Start ──
app.listen(port, "0.0.0.0", () => {
  log("info", `Servidor WhatsApp (web.js) em http://0.0.0.0:${port}`);
  startClient();
});
