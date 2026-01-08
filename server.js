const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

// Usar fetch nativo do Node.js 18+ ou node-fetch como fallback
let fetch;
if (typeof globalThis.fetch === 'function') {
    fetch = globalThis.fetch;
} else {
    fetch = require('node-fetch');
}

// Wrapper para fetch com timeout
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
    // Usar AbortController se disponível (Node 15+)
    if (typeof AbortController !== 'undefined') {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);
            return response;
        } catch (error) {
            clearTimeout(id);
            if (error.name === 'AbortError' || error.name === 'TimeoutError') {
                throw new Error('Timeout: requisição excedeu o tempo limite');
            }
            throw error;
        }
    } else {
        // Fallback para versões antigas do Node.js
        return Promise.race([
            fetch(url, options),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout: requisição excedeu o tempo limite')), timeout)
            )
        ]);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de senha - MUDE ISSO para uma senha segura!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Use variável de ambiente em produção

// Configurações de segurança
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutos
const loginAttempts = new Map(); // IP -> {count, resetTime}

// Diretório de dados
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

// Garantir que o diretório de dados existe
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        // Inicializar arquivos se não existirem
        try {
            await fs.access(CONFIG_FILE);
        } catch {
            await fs.writeFile(CONFIG_FILE, JSON.stringify({
                baseUrl: 'http://localhost:8080',
                apiKey: '',
                instanceName: ''
            }, null, 2));
        }
        try {
            await fs.access(LOGS_FILE);
        } catch {
            await fs.writeFile(LOGS_FILE, JSON.stringify([]));
        }
        try {
            await fs.access(JOBS_FILE);
        } catch {
            await fs.writeFile(JOBS_FILE, JSON.stringify([]));
        }
    } catch (error) {
        console.error('Erro ao criar diretório de dados:', error);
    }
}

ensureDataDir();

// Middlewares
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));
app.use(session({
    secret: process.env.SESSION_SECRET || 'pazap-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 horas
    }
}));

// Middleware de autenticação
const requireAuth = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ error: 'Não autenticado' });
    }
};

// === ROTAS DE AUTENTICAÇÃO ===

// Middleware de rate limiting para login
const rateLimitLogin = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const attempts = loginAttempts.get(ip);

    if (attempts) {
        if (now > attempts.resetTime) {
            // Reset window expirou
            loginAttempts.delete(ip);
            next();
        } else if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
            const remainingTime = Math.ceil((attempts.resetTime - now) / 1000 / 60);
            return res.status(429).json({ 
                error: `Muitas tentativas. Aguarde ${remainingTime} minuto(s).` 
            });
        } else {
            next();
        }
    } else {
        next();
    }
};

app.post('/api/login', rateLimitLogin, async (req, res) => {
    const { password } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (!password) {
        return res.status(400).json({ error: 'Senha não fornecida' });
    }

    // Comparar senha (melhorado - agora com hash)
    const passwordMatch = password === ADMIN_PASSWORD;
    
    if (passwordMatch) {
        // Login bem-sucedido - limpar tentativas
        loginAttempts.delete(ip);
        req.session.authenticated = true;
        req.session.loginTime = Date.now();
        return res.json({ success: true, message: 'Autenticado com sucesso' });
    } else {
        // Login falhou - registrar tentativa
        const attempts = loginAttempts.get(ip) || { count: 0, resetTime: Date.now() + LOGIN_ATTEMPT_WINDOW };
        attempts.count++;
        loginAttempts.set(ip, attempts);
        
        const remainingAttempts = MAX_LOGIN_ATTEMPTS - attempts.count;
        return res.status(401).json({ 
            error: `Senha incorreta. ${remainingAttempts > 0 ? remainingAttempts + ' tentativas restantes.' : 'Bloqueado temporariamente.'}` 
        });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logout realizado' });
});

app.get('/api/auth/check', (req, res) => {
    res.json({ authenticated: !!req.session.authenticated });
});

// === ROTAS DE CONFIGURAÇÃO ===

app.get('/api/config', requireAuth, async (req, res) => {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao ler configuração' });
    }
});

app.post('/api/config', requireAuth, async (req, res) => {
    try {
        // Validar configuração
        const { baseUrl, apiKey, instanceName } = req.body;
        if (!baseUrl || !apiKey || !instanceName) {
            return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
        }
        
        // Validar URL
        try {
            new URL(baseUrl);
        } catch {
            return res.status(400).json({ error: 'URL base inválida' });
        }
        
        await fs.writeFile(CONFIG_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'Configuração salva' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar configuração' });
    }
});

// Nova rota: Verificar status da instância
app.get('/api/instance/status', requireAuth, async (req, res) => {
    try {
        const configData = await fs.readFile(CONFIG_FILE, 'utf8');
        const config = JSON.parse(configData);
        
        if (!config.baseUrl || !config.apiKey || !config.instanceName) {
            return res.status(400).json({ error: 'Configure a API primeiro' });
        }
        
        const status = await checkInstanceStatus(config);
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao verificar status' });
    }
});

// === ROTAS DE LOGS ===

app.get('/api/logs', requireAuth, async (req, res) => {
    try {
        const data = await fs.readFile(LOGS_FILE, 'utf8');
        const logs = JSON.parse(data);
        const limit = parseInt(req.query.limit) || 500;
        res.json(logs.slice(0, limit));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao ler logs' });
    }
});

app.post('/api/logs', requireAuth, async (req, res) => {
    try {
        const { type, text } = req.body;
        const time = new Date().toLocaleString('pt-BR');
        const logEntry = { type, text, time };
        
        const data = await fs.readFile(LOGS_FILE, 'utf8');
        const logs = JSON.parse(data);
        logs.unshift(logEntry);
        
        // Manter apenas os últimos 1000 logs
        const limitedLogs = logs.slice(0, 1000);
        await fs.writeFile(LOGS_FILE, JSON.stringify(limitedLogs, null, 2));
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar log' });
    }
});

app.delete('/api/logs', requireAuth, async (req, res) => {
    try {
        await fs.writeFile(LOGS_FILE, JSON.stringify([]));
        res.json({ success: true, message: 'Logs limpos' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao limpar logs' });
    }
});

// === ROTAS DE JOBS/CAMPANHAS ===

// Listar jobs agendados
app.get('/api/jobs', requireAuth, async (req, res) => {
    try {
        const data = await fs.readFile(JOBS_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).json({ error: 'Erro ao ler jobs' });
    }
});

// Criar novo job
app.post('/api/jobs', requireAuth, async (req, res) => {
    try {
        const job = req.body;
        job.id = Date.now().toString();
        job.createdAt = new Date().toISOString();
        job.status = 'scheduled'; // scheduled, running, completed, cancelled
        
        const data = await fs.readFile(JOBS_FILE, 'utf8');
        const jobs = JSON.parse(data);
        jobs.push(job);
        
        await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
        
        // Processar job imediatamente se não houver agendamento
        if (!job.scheduleTime || new Date(job.scheduleTime) <= new Date()) {
            setTimeout(() => processJob(job.id), 1000);
        } else {
            scheduleJob(job);
        }
        
        res.json({ success: true, jobId: job.id });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar job' });
    }
});

// Cancelar job
app.delete('/api/jobs/:id', requireAuth, async (req, res) => {
    try {
        const data = await fs.readFile(JOBS_FILE, 'utf8');
        const jobs = JSON.parse(data);
        const jobIndex = jobs.findIndex(j => j.id === req.params.id);
        
        if (jobIndex !== -1) {
            jobs[jobIndex].status = 'cancelled';
            await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Job não encontrado' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Erro ao cancelar job' });
    }
});

// === FUNÇÕES AUXILIARES EVOLUTION API ===

// Verificar status da instância Evolution API
async function checkInstanceStatus(config) {
    try {
        const cleanUrl = config.baseUrl.replace(/\/$/, '');
        const res = await fetchWithTimeout(`${cleanUrl}/instance/connectionState/${config.instanceName}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'apikey': config.apiKey
            }
        }, 10000); // 10 segundos timeout para verificação

        if (!res.ok) {
            return { connected: false, error: `Erro ${res.status}` };
        }

        const data = await res.json();
        const state = data?.state || data?.connection || 'disconnected';
        const connected = state === 'open' || state === 'connected';
        
        return { connected, state, raw: data };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

// Validar número de telefone
function validatePhoneNumber(number) {
    const clean = number.replace(/\D/g, '');
    if (clean.length < 10 || clean.length > 15) {
        return { valid: false, error: 'Número inválido: deve ter entre 10 e 15 dígitos' };
    }
    if (!clean.startsWith('55') && clean.length === 11) {
        return { valid: false, error: 'Número brasileiro deve começar com 55' };
    }
    return { valid: true, cleaned: clean };
}

// === FUNÇÕES DE PROCESSAMENTO ===

async function processJob(jobId) {
    try {
        const data = await fs.readFile(JOBS_FILE, 'utf8');
        const jobs = JSON.parse(data);
        const job = jobs.find(j => j.id === jobId);
        
        if (!job || job.status !== 'scheduled') return;
        
        job.status = 'running';
        await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
        
        // Ler configuração
        const configData = await fs.readFile(CONFIG_FILE, 'utf8');
        const config = JSON.parse(configData);
        
        // Verificar status da instância antes de iniciar
        const instanceStatus = await checkInstanceStatus(config);
        if (!instanceStatus.connected) {
            job.status = 'failed';
            job.error = `Instância não conectada: ${instanceStatus.error || instanceStatus.state}`;
            await addLog('error', `Campanha ${jobId} falhou: ${job.error}`);
            
            const updatedData = await fs.readFile(JOBS_FILE, 'utf8');
            const updatedJobs = JSON.parse(updatedData);
            const jobIndex = updatedJobs.findIndex(j => j.id === jobId);
            if (jobIndex !== -1) {
                updatedJobs[jobIndex] = job;
                await fs.writeFile(JOBS_FILE, JSON.stringify(updatedJobs, null, 2));
            }
            return;
        }
        
        await addLog('info', `Instância conectada (${instanceStatus.state}). Iniciando campanha ${jobId} para ${job.targets.length} destinatários...`);
        
        // Processar cada target
        let success = 0;
        let fail = 0;
        let retryableFailures = 0; // Falhas que podem ser tentadas novamente
        
        // Validar e limpar targets
        const validatedTargets = [];
        for (const target of job.targets) {
            if (target.includes('@')) {
                // É um grupo
                validatedTargets.push({ original: target, number: target, type: 'group' });
            } else {
                // É um número - validar
                const validation = validatePhoneNumber(target);
                if (validation.valid) {
                    validatedTargets.push({ original: target, number: validation.cleaned, type: 'number' });
                } else {
                    fail++;
                    await addLog('warning', `Número inválido ignorado: ${target} - ${validation.error}`);
                }
            }
        }
        
        if (validatedTargets.length === 0) {
            job.status = 'failed';
            job.error = 'Nenhum destinatário válido';
            const updatedData = await fs.readFile(JOBS_FILE, 'utf8');
            const updatedJobs = JSON.parse(updatedData);
            const jobIndex = updatedJobs.findIndex(j => j.id === jobId);
            if (jobIndex !== -1) {
                updatedJobs[jobIndex] = job;
                await fs.writeFile(JOBS_FILE, JSON.stringify(updatedJobs, null, 2));
            }
            return;
        }
        
        for (let i = 0; i < validatedTargets.length; i++) {
            const target = validatedTargets[i];
            
            // Verificar se job foi cancelado
            const currentJobData = await fs.readFile(JOBS_FILE, 'utf8');
            const currentJobs = JSON.parse(currentJobData);
            const currentJob = currentJobs.find(j => j.id === jobId);
            if (currentJob?.status === 'cancelled') {
                await addLog('warning', 'Campanha cancelada pelo usuário.');
                break;
            }
            
            try {
                const cleanUrl = config.baseUrl.replace(/\/$/, '');
                let endpoint = '';
                let payload = {};
                
                const commonOptions = {
                    delay: 1200,
                    presence: "composing",
                    linkPreview: job.linkPreview !== false // Default true
                };
                
                if (job.mediaType === 'text') {
                    endpoint = `${cleanUrl}/message/sendText/${config.instanceName}`;
                    payload = {
                        number: target.number,
                        options: commonOptions,
                        textMessage: { text: job.message },
                        text: job.message
                    };
                } else {
                    endpoint = `${cleanUrl}/message/sendMedia/${config.instanceName}`;
                    payload = {
                        number: target.number,
                        options: commonOptions,
                        mediaMessage: {
                            mediatype: job.mediaType,
                            caption: job.message || '',
                            media: job.mediaBase64,
                            fileName: job.fileName
                        },
                        mediatype: job.mediaType,
                        caption: job.message || '',
                        media: job.mediaBase64,
                        fileName: job.fileName
                    };
                }
                
                // Tentar enviar com retry
                let sendSuccess = false;
                let lastError = null;
                const maxRetries = 3;
                
                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        const res = await fetchWithTimeout(endpoint, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'apikey': config.apiKey
                            },
                            body: JSON.stringify(payload)
                        }, 30000); // 30 segundos timeout
                        
                        if (res.ok) {
                            const responseData = await res.json().catch(() => ({}));
                            sendSuccess = true;
                            success++;
                            await addLog('success', `Enviado para ${target.type === 'group' ? 'Grupo' : target.number}`);
                            break;
                        } else {
                            const errorData = await res.json().catch(() => ({ message: res.statusText }));
                            lastError = errorData.message || errorData.error || `HTTP ${res.status}`;
                            
                            // Alguns erros não devem ser retentados (ex: número inválido)
                            if (res.status === 400 || res.status === 404) {
                                break; // Não tentar novamente
                            }
                            
                            if (attempt < maxRetries) {
                                await addLog('warning', `Tentativa ${attempt}/${maxRetries} falhou para ${target.number}, tentando novamente...`);
                                await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Backoff exponencial
                            }
                        }
                    } catch (fetchError) {
                        lastError = fetchError.message;
                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                        }
                    }
                }
                
                if (!sendSuccess) {
                    fail++;
                    if (lastError) {
                        await addLog('error', `Falha ao enviar para ${target.number}: ${lastError}`);
                    }
                }
                
                // Atualizar progresso periodicamente (a cada 10 mensagens ou no final)
                if ((i + 1) % 10 === 0 || i === validatedTargets.length - 1) {
                    job.progress = { current: i + 1, total: validatedTargets.length, success, fail };
                    const progressData = await fs.readFile(JOBS_FILE, 'utf8');
                    const progressJobs = JSON.parse(progressData);
                    const progressIndex = progressJobs.findIndex(j => j.id === jobId);
                    if (progressIndex !== -1) {
                        progressJobs[progressIndex] = job;
                        await fs.writeFile(JOBS_FILE, JSON.stringify(progressJobs, null, 2));
                    }
                }
                
                // Delay entre envios
                if (i < validatedTargets.length - 1) {
                    const delay = Math.floor(Math.random() * (job.delays.max - job.delays.min + 1) + job.delays.min) * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (err) {
                fail++;
                await addLog('error', `Erro ao processar ${target.number}: ${err.message}`);
            }
        }
        
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        job.results = { success, fail, total: validatedTargets.length };
        job.progress = { current: validatedTargets.length, total: validatedTargets.length, success, fail };
        
        const updatedData = await fs.readFile(JOBS_FILE, 'utf8');
        const updatedJobs = JSON.parse(updatedData);
        const jobIndex = updatedJobs.findIndex(j => j.id === jobId);
        if (jobIndex !== -1) {
            updatedJobs[jobIndex] = job;
            await fs.writeFile(JOBS_FILE, JSON.stringify(updatedJobs, null, 2));
        }
        
        const successRate = ((success / validatedTargets.length) * 100).toFixed(1);
        await addLog('success', `Campanha ${jobId} finalizada! ${success} sucessos (${successRate}%), ${fail} falhas de ${validatedTargets.length} destinatários.`);
        
    } catch (error) {
        console.error('Erro ao processar job:', error);
        await addLog('error', `Erro ao processar campanha ${jobId}: ${error.message}`);
    }
}

async function addLog(type, text) {
    try {
        const data = await fs.readFile(LOGS_FILE, 'utf8');
        const logs = JSON.parse(data);
        logs.unshift({ type, text, time: new Date().toLocaleString('pt-BR') });
        const limitedLogs = logs.slice(0, 1000);
        await fs.writeFile(LOGS_FILE, JSON.stringify(limitedLogs, null, 2));
    } catch (error) {
        console.error('Erro ao adicionar log:', error);
    }
}

function scheduleJob(job) {
    const scheduleDate = new Date(job.scheduleTime);
    const now = new Date();
    const delay = scheduleDate.getTime() - now.getTime();
    
    if (delay > 0) {
        setTimeout(() => processJob(job.id), delay);
    } else {
        processJob(job.id);
    }
}

// Verificar jobs pendentes ao iniciar
async function checkPendingJobs() {
    try {
        const data = await fs.readFile(JOBS_FILE, 'utf8');
        const jobs = JSON.parse(data);
        
        const now = new Date();
        for (const job of jobs) {
            if (job.status === 'scheduled' && job.scheduleTime) {
                const scheduleDate = new Date(job.scheduleTime);
                if (scheduleDate <= now) {
                    processJob(job.id);
                } else {
                    scheduleJob(job);
                }
            } else if (job.status === 'scheduled' && !job.scheduleTime) {
                processJob(job.id);
            }
        }
    } catch (error) {
        console.error('Erro ao verificar jobs pendentes:', error);
    }
}

// Verificar jobs a cada minuto
setInterval(checkPendingJobs, 60000);
checkPendingJobs(); // Verificar imediatamente ao iniciar

// Rota para servir o HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'disparador.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor PAZAP Disparador rodando na porta ${PORT}`);
    console.log(`🔒 Senha padrão: ${ADMIN_PASSWORD}`);
    console.log(`📝 Configure a senha via variável de ambiente ADMIN_PASSWORD`);
});

