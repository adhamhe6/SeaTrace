#!/usr/bin/env bash
# Generates self-signed development certificates for the SeaTrace OPC UA link.
#
#   $PKI_DIR/simulator/{cert,key}.{der,pem}   server application instance certificate
#   $PKI_DIR/backend/{cert,key}.{der,pem}     backend (OPC UA client) application instance certificate
#
# PKI_DIR defaults to <repo root>/pki (git-ignored). The script is idempotent: existing key/cert
# pairs are kept, missing DER/PEM counterparts are re-derived. Use FORCE=1 to regenerate
# everything. These certificates are for DEVELOPMENT ONLY (self-signed, 10 year validity).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
umask 077  # key material is created owner-only; certificates are made world-readable below
pki_dir="${PKI_DIR:-$repo_root/pki}"
days="${CERT_DAYS:-3650}"
force="${FORCE:-0}"

command -v openssl >/dev/null || { echo "gen-dev-certs: openssl is required" >&2; exit 1; }

# generate <directory-name> <application-uri> <dns-name> <common-name>
generate() {
  local name="$1" uri="$2" dns="$3" common_name="$4"
  local dir="$pki_dir/$name"
  mkdir -p "$dir"
  chmod 755 "$dir"

  if [[ "$force" != "1" && -s "$dir/cert.pem" && -s "$dir/key.pem" ]]; then
    echo "[$name] keeping existing certificate ($dir/cert.pem)"
  else
    local config
    config="$(mktemp)"
    # shellcheck disable=SC2064
    trap "rm -f '$config'" RETURN
    cat >"$config" <<CONF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
O = SeaTrace (development)
CN = $common_name
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment, keyCertSign
extendedKeyUsage = serverAuth, clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
subjectAltName = URI:$uri, DNS:$dns, DNS:localhost, IP:127.0.0.1
CONF
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days "$days" \
      -keyout "$dir/key.pem" -out "$dir/cert.pem" -config "$config" 2>/dev/null
    echo "[$name] generated new certificate ($uri)"
  fi

  # DER copies (OPC UA stacks usually expect DER). Re-derived when missing or outdated.
  if [[ "$force" == "1" || ! -s "$dir/cert.der" || "$dir/cert.pem" -nt "$dir/cert.der" ]]; then
    openssl x509 -in "$dir/cert.pem" -outform DER -out "$dir/cert.der"
  fi
  if [[ "$force" == "1" || ! -s "$dir/key.der" || "$dir/key.pem" -nt "$dir/key.der" ]]; then
    openssl pkey -in "$dir/key.pem" -outform DER -out "$dir/key.der"
  fi

  chmod 600 "$dir/key.pem" "$dir/key.der"
  chmod 644 "$dir/cert.pem" "$dir/cert.der"
}

generate simulator "urn:seatrace:simulator" simulator "SeaTrace Simulator"
generate backend "urn:seatrace:backend" backend "SeaTrace Backend"

cat <<MSG

Done. Files are in $pki_dir
  simulator: SIM_SERVER_CERT=$pki_dir/simulator/cert.der  SIM_SERVER_KEY=$pki_dir/simulator/key.der
             SIM_TRUSTED_CLIENT_CERTS=$pki_dir/backend/cert.der
  backend:   client certificate $pki_dir/backend/cert.der / key $pki_dir/backend/key.der (PEM variants alongside)
MSG
