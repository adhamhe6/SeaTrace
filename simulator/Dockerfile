# SeaTrace vessel simulator + OPC UA server.
# Build context: the REPOSITORY ROOT (the image needs simulator/ and scripts/gen-dev-certs.sh):
#   docker build -f simulator/Dockerfile -t seatrace-simulator .

# ---- build stage ------------------------------------------------------------------------------
FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake ninja-build git python3 \
        libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY simulator/ /src/simulator/
# Dependencies (open62541, nlohmann_json) are fetched by CMake with pinned git tags.
RUN cmake -S simulator -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release -DSEATRACE_BUILD_TESTS=OFF \
 && cmake --build /build --target seatrace_simulator \
 && strip /build/seatrace_simulator

# ---- runtime stage ----------------------------------------------------------------------------
FROM ubuntu:24.04 AS runtime
ENV DEBIAN_FRONTEND=noninteractive
# bash: healthcheck; openssl + gen-dev-certs.sh: the compose "pki-init" job reuses this image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 openssl bash \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10002 sim \
 && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin sim

COPY --from=build /build/seatrace_simulator /usr/local/bin/seatrace_simulator
COPY simulator/config/fleet.json /etc/seatrace/fleet.json
COPY --chmod=755 scripts/gen-dev-certs.sh /opt/seatrace/gen-dev-certs.sh

ENV SIM_CONFIG=/etc/seatrace/fleet.json \
    SIM_OPCUA_PORT=4840

USER sim
EXPOSE 4840

# Pure-bash TCP connect to the OPC UA port (no extra tools needed).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${SIM_OPCUA_PORT:-4840}"]

# SIM_CONTROL_USER / SIM_CONTROL_PASSWORD (and, in secure mode, SIM_SERVER_CERT, SIM_SERVER_KEY,
# SIM_TRUSTED_CLIENT_CERTS) must be provided at run time.
CMD ["/usr/local/bin/seatrace_simulator"]
