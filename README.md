# PAZAP Disparador - Versão Servidor

Sistema de disparos em massa para WhatsApp que roda no servidor Coolify, com autenticação por senha e processamento em background.

## 🚀 Recursos

- ✅ **Autenticação por senha** - Proteção de acesso
- ✅ **Armazenamento no servidor** - Dados salvos no servidor, não no navegador
- ✅ **Processamento em background** - Funciona mesmo fechando a aba
- ✅ **Agendamento de campanhas** - Dispara automaticamente no horário programado
- ✅ **Interface moderna** - Design responsivo e intuitivo

## 📦 Instalação

1. Instale as dependências:
```bash
npm install
```

2. Configure a senha (opcional - padrão é `admin123`):
```bash
export ADMIN_PASSWORD=sua_senha_segura
```

3. Inicie o servidor:
```bash
npm start
```

O servidor iniciará na porta 3000 (ou na porta definida pela variável de ambiente `PORT`).

## 🔒 Segurança

- A senha padrão é `admin123`. **MUDE ISSO EM PRODUÇÃO!**
- Configure a senha via variável de ambiente `ADMIN_PASSWORD`
- Configure a chave de sessão via variável de ambiente `SESSION_SECRET`

## 📁 Estrutura de Dados

Os dados são armazenados na pasta `data/`:
- `config.json` - Configurações da API
- `logs.json` - Histórico de execuções
- `jobs.json` - Campanhas agendadas e em execução

## 🌐 Coolify

Para usar no Coolify:

1. Crie um novo serviço
2. Conecte ao repositório ou faça upload dos arquivos
3. Configure as variáveis de ambiente:
   - `ADMIN_PASSWORD` - Senha de acesso
   - `SESSION_SECRET` - Chave secreta para sessões
   - `PORT` - Porta do servidor (opcional)

4. O Coolify irá instalar as dependências e iniciar o servidor automaticamente

## ⚙️ Variáveis de Ambiente

- `ADMIN_PASSWORD` - Senha de acesso ao sistema (padrão: `admin123`)
- `SESSION_SECRET` - Chave secreta para sessões (padrão: `pazap-secret-key-change-in-production`)
- `PORT` - Porta do servidor (padrão: `3000`)
- `NODE_ENV` - Ambiente de execução (`production` ou `development`)

## 📝 Uso

1. Acesse a aplicação no navegador
2. Faça login com a senha configurada
3. Configure a conexão com a API do WhatsApp
4. Crie e agende suas campanhas
5. As campanhas serão processadas no servidor, mesmo fechando a aba!

## 🛠️ Tecnologias

- Node.js + Express
- React (via CDN)
- Tailwind CSS
- Express Sessions para autenticação

## 📄 Licença

Feito por Rodrigo Pasa

