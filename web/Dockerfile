FROM node:20-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
COPY fixtures ./fixtures
WORKDIR /app/web
RUN npm ci
COPY web/ ./
ARG VITE_WS_URL=
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
