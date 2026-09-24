# Caddy plus the DuckDNS DNS provider, so Let's Encrypt can issue a real
# certificate through a DNS-01 challenge, which works even when ports 80/443
# belong to another web server (the HTTP and TLS-ALPN challenges need them).
FROM caddy:2-builder AS build
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
