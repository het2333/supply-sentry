FROM node:22.18.0-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS build

# Next.js writes rewrites into the production route manifest during build.
ENV READYWORK_API_BASE_URL=http://business-api:4173
ENV READYWORK_CONTROL_PLANE_BASE_URL=http://control-api:4174
RUN pnpm --filter @readywork/app-console build

FROM node:22.18.0-bookworm-slim AS readywork-app

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@11.7.0 --activate \
  && groupadd --system --gid 10001 readywork \
  && useradd --system --uid 10001 --gid readywork --home-dir /app --shell /usr/sbin/nologin readywork

COPY --from=build --chown=readywork:readywork /app /app
RUN mkdir -p /app/data /app/.readywork && chown -R readywork:readywork /app/data /app/.readywork

USER readywork
