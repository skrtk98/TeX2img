FROM node:22-bookworm-slim

# TeX Live（必要最小限 + よく使うパッケージ群）と dvisvgm。
# ghostscript は dvisvgm が PostScript special（pstricks 等）を処理するのに使う。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-latex-base \
      texlive-latex-recommended \
      texlive-latex-extra \
      texlive-fonts-recommended \
      texlive-pictures \
      dvisvgm \
      ghostscript \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

# 任意の TeX を実行するので root では動かさない
USER node
ENV PORT=10000
EXPOSE 10000
CMD ["node", "src/server.js"]
