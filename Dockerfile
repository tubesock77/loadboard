FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
