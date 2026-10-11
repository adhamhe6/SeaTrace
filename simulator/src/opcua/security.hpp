#pragma once

#include <open62541/server.h>

#include <stdexcept>
#include <string>
#include <vector>

#include "core/logger.hpp"
#include "core/settings.hpp"

namespace seatrace::sim::opcua {

class ServerError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

using Bytes = std::vector<unsigned char>;

// DER encoded certificates and private key read from disk.
struct SecurityMaterial {
  Bytes certificate;
  Bytes private_key;
  std::vector<Bytes> trusted_clients;
};

// Reads the files named in the options. Throws ServerError naming the offending file.
SecurityMaterial load_security_material(const std::string& certificate_path,
                                        const std::string& key_path,
                                        const std::vector<std::string>& trusted_client_paths);

inline constexpr std::string_view kApplicationUri = "urn:seatrace:simulator";

// secure: a single SecurityPolicy#Basic256Sha256 / SignAndEncrypt endpoint; client certificates are
//         accepted only if they are in `material.trusted_clients`.
// none:   a single unsecured endpoint (username/password then travels in clear text).
UA_StatusCode apply_security(UA_ServerConfig* config, SecurityMode mode,
                             const SecurityMaterial& material, Logger& logger);

}  // namespace seatrace::sim::opcua
