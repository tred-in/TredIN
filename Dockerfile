FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p public/admin && cp USER/index.html public/index.html && cp ADMIN/index.html public/admin/index.html
EXPOSE 8080
CMD ["npm","start"]