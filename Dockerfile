FROM node:22-bookworm-slim

# TeX Live（必要最小限 + よく使うパッケージ群）、日本語 (upLaTeX + 原ノ味フォント)、dvisvgm。
# ghostscript は dvisvgm が PostScript special（pstricks 等）を処理するのに使う。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-latex-base \
      texlive-latex-recommended \
      texlive-latex-extra \
      texlive-fonts-recommended \
      texlive-pictures \
      texlive-lang-japanese \
      dvisvgm \
      ghostscript \
 && rm -rf /var/lib/apt/lists/*

# 和文フォントの対応表 (kanjix.map) を、既定の非埋め込み (Ryumin-Light 等) から
# 実在するフォント（原ノ味）に切り替える。これをしないと和文が描画されない。
RUN kanji-config-updmap-sys --jis2004 haranoaji

# ビルド時の自己診断: 和文が実際にグリフとして出力されることを確認する。
# 失敗した場合は、和文が空白になるイメージをデプロイしないようビルドを止める。
RUN set -e; d=$(mktemp -d); cd "$d"; \
    printf '%s\n' '\documentclass{article}' '\begin{document}' '日本語' '\end{document}' > t.tex; \
    uplatex -interaction=nonstopmode -halt-on-error t.tex > /dev/null; \
    dvisvgm --no-fonts --fontmap=+kanjix.map --stdout t.dvi 2> err.txt > t.svg; \
    if grep -qi "can't embed\|no font file" err.txt; then cat err.txt; exit 1; fi; \
    cd /; rm -rf "$d"

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
