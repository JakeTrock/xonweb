# Xonotic dedicated server (native, sv-release).
#
# Build from the repo root:
#   docker build -f deploy/dedicated.Dockerfile -t xonweb-dedicated .
#
# The game data (xonotic/data/*.dat etc.) is NOT baked in; mount it at
# /game at run time (see docker-compose.yml "dedicated" service).

FROM debian:bookworm AS build
RUN apt-get update \
	&& apt-get install -y --no-install-recommends build-essential libjpeg-dev zlib1g-dev \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src/darkplaces
COPY xonotic/darkplaces/ ./
RUN make sv-release

FROM debian:bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libjpeg62-turbo zlib1g ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /home/xon && chown 1000:100 /home/xon
COPY --from=build /src/darkplaces/darkplaces-dedicated /usr/local/bin/darkplaces-dedicated
# Non-root, but needs no privileges: plain UDP. HOME must be writable for the
# engine session lock.
USER 1000:100
WORKDIR /game
ENV HOME=/home/xon
EXPOSE 26000/udp
ENTRYPOINT ["/usr/local/bin/darkplaces-dedicated", "-xonotic", "-basedir", "/game", "-sessionid", "xonweb-compose", "+sv_public", "0", "+port", "26000"]
