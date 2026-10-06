FROM node:22-alpine
WORKDIR /app
COPY package.json server.js game.js secret.js scenarios.js scenario.js scenario-witch.js index.html style.css app.js config.js ./
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "server.js"]
