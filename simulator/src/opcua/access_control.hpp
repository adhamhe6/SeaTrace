#pragma once

#include <open62541/server.h>

#include <string>
#include <string_view>

#include "core/logger.hpp"

namespace seatrace::sim::opcua {

struct ControlCredentials {
  std::string user;
  std::string password;  // never logged
};

// True for sessions that authenticated as the control account. open62541 hands the session
// context pointer to every callback, so the check is a pointer comparison.
bool is_control_session(const void* session_context);

// Comparison whose run time does not depend on where the inputs differ.
bool constant_time_equal(std::string_view a, std::string_view b);

// Authenticates the control account and installs the access control into a server config:
// anonymous read-only access plus one username/password account. Everything that modifies the
// address space through the OPC UA services (AddNodes, DeleteNodes, ...) is denied for every
// remote session. Method authorization is enforced inside the method handlers so that anonymous
// callers receive BadUserAccessDenied.
//
// The object's address is registered with the plugin: it must outlive the server and must not
// be moved.
class ControlAuthenticator {
 public:
  ControlAuthenticator(ControlCredentials credentials, Logger& logger);
  ControlAuthenticator(const ControlAuthenticator&) = delete;
  ControlAuthenticator& operator=(const ControlAuthenticator&) = delete;

  UA_StatusCode install(UA_ServerConfig* config);

  // Called by the plugin for username/password tokens.
  UA_StatusCode authenticate(std::string_view user, std::string_view password,
                             void** session_context) const;

 private:
  ControlCredentials credentials_;
  Logger& logger_;
};

}  // namespace seatrace::sim::opcua
