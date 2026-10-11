#include "opcua/security.hpp"

#include <open62541/plugin/pki_default.h>
#include <open62541/server_config_default.h>

#include <fstream>
#include <iterator>

#include "opcua/ua_util.hpp"

namespace seatrace::sim::opcua {

namespace {

Bytes read_file(const std::string& path, std::string_view what) {
  std::ifstream file(path, std::ios::binary);
  if (!file) throw ServerError("cannot read " + std::string(what) + " '" + path + "'");
  Bytes bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  if (bytes.empty()) throw ServerError(std::string(what) + " '" + path + "' is empty");
  return bytes;
}

UA_ByteString view(const Bytes& bytes) {
  UA_ByteString b;
  b.length = bytes.size();
  b.data = const_cast<UA_Byte*>(bytes.data());
  return b;
}

constexpr std::string_view kBasic256Sha256Uri =
    "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256";

}  // namespace

SecurityMaterial load_security_material(const std::string& certificate_path,
                                        const std::string& key_path,
                                        const std::vector<std::string>& trusted_client_paths) {
  SecurityMaterial material;
  material.certificate = read_file(certificate_path, "server certificate");
  material.private_key = read_file(key_path, "server private key");
  for (const std::string& path : trusted_client_paths) {
    material.trusted_clients.push_back(read_file(path, "trusted client certificate"));
  }
  return material;
}

UA_StatusCode apply_security(UA_ServerConfig* config, SecurityMode mode,
                             const SecurityMaterial& material, Logger& logger) {
  UA_String_clear(&config->applicationDescription.applicationUri);
  config->applicationDescription.applicationUri =
      UA_STRING_ALLOC(std::string(kApplicationUri).c_str());

  if (mode == SecurityMode::kNone) {
    logger.warn(
        "SIM_SECURITY_MODE=none: the OPC UA endpoint is NOT encrypted or signed and the control "
        "account's password is sent in clear text. Use this for local development only.");
    config->allowNonePolicyPassword = true;
    UA_StatusCode status = UA_ServerConfig_addSecurityPolicyNone(config, nullptr);
    if (status != UA_STATUSCODE_GOOD) return status;
    return UA_ServerConfig_addEndpoint(config, UA_SECURITY_POLICY_NONE_URI,
                                       UA_MESSAGESECURITYMODE_NONE);
  }

  std::vector<UA_ByteString> trust_list;
  for (const Bytes& cert : material.trusted_clients) trust_list.push_back(view(cert));
  UA_StatusCode status = UA_CertificateVerification_Trustlist(
      &config->secureChannelPKI, trust_list.data(), trust_list.size(), nullptr, 0, nullptr, 0);
  if (status != UA_STATUSCODE_GOOD) return status;
  // CreateSession checks that the client's ApplicationUri matches its certificate.
  status = UA_CertificateVerification_Trustlist(&config->sessionPKI, trust_list.data(),
                                                trust_list.size(), nullptr, 0, nullptr, 0);
  if (status != UA_STATUSCODE_GOOD) return status;

  const UA_ByteString certificate = view(material.certificate);
  const UA_ByteString key = view(material.private_key);
  status = UA_ServerConfig_addSecurityPolicyBasic256Sha256(config, &certificate, &key);
  if (status != UA_STATUSCODE_GOOD) return status;
  return UA_ServerConfig_addEndpoint(config, ua_view(kBasic256Sha256Uri),
                                     UA_MESSAGESECURITYMODE_SIGNANDENCRYPT);
}

}  // namespace seatrace::sim::opcua
