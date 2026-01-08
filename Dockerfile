# Imagem base Node.js LTS
FROM node:20-alpine

# Metadados
LABEL maintainer="Rodrigo Pasa"
LABEL description="PAZAP Disparador - Sistema de Disparos em Massa para WhatsApp"

# Criar diretório da aplicação
WORKDIR /app

# Instalar dependências primeiro (melhor cache do Docker)
COPY package*.json ./

# Instalar dependências de produção
RUN npm ci --only=production

# Copiar código da aplicação
COPY . .

# Criar diretório de dados com permissões corretas
RUN mkdir -p /app/data && chmod 755 /app/data

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=3000

# Expor porta
EXPOSE 3000

# Health check para Coolify/Docker
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/auth/check || exit 1

# Usuário não-root para segurança
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Iniciar aplicação
CMD ["node", "server.js"]

