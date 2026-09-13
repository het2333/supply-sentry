FROM node:24.20.0-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS build

# Next.js writes rewrites into the production route manifest during build.
ARG READYWORK_PUBLIC_DEMO=0
ENV READYWORK_API_BASE_URL=http://business-api:4173
ENV READYWORK_CONTROL_PLANE_BASE_URL=http://control-api:4174
ENV READYWORK_PUBLIC_DEMO=$READYWORK_PUBLIC_DEMO
RUN pnpm --filter @readywork/app-console build

FROM node:24.20.0-bookworm-slim AS readywork-app

ARG OCI_SOURCE=https://github.com/het2333/supply-sentry
ARG OCI_REVISION=unknown
LABEL org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.licenses=AGPL-3.0-only

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

FROM readywork-app AS readywork-demo

ENV READYWORK_PUBLIC_DEMO=1
ENV READYWORK_PUBLIC_DEMO_TENANT=t:public-demo
ENV READYWORK_PUBLIC_DEMO_SIMULATION_POLICY=simulated_demo
