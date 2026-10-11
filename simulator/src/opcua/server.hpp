#pragma once

#include <open62541/server.h>

#include <chrono>
#include <memory>
#include <string>
#include <vector>

#include "core/logger.hpp"
#include "core/settings.hpp"
#include "core/simulation.hpp"
#include "opcua/access_control.hpp"
#include "opcua/address_space.hpp"
#include "opcua/security.hpp"

namespace seatrace::sim::opcua {

struct ServerOptions {
  std::uint16_t port = 4840;
  SecurityMode security_mode = SecurityMode::kSecure;
  ControlCredentials control;
  std::string server_cert_path;                        // DER
  std::string server_key_path;                         // DER
  std::vector<std::string> trusted_client_cert_paths;  // DER
};

ServerOptions make_server_options(const Settings& settings);

struct ServerDeleter {
  void operator()(UA_Server* server) const;
};

// One open62541 server with the SeaTrace address space, driven from the caller's thread.
//
// Threading: single threaded by design. iterate(), publish(), start() and stop() must be called
// from the same thread that owns the Simulation; method callbacks run inside iterate().
//
// start()/stop() can be repeated: stop() shuts the listener down (clients lose their connections)
// while the address space and its values stay in memory, start() brings the listener back.
class OpcUaServer {
 public:
  // Builds the server, the address space and the security configuration. The listener is not
  // started yet. Throws ServerError (bad certificates, ...).
  OpcUaServer(Simulation& simulation, Logger& logger, ServerOptions options);
  ~OpcUaServer();
  OpcUaServer(const OpcUaServer&) = delete;
  OpcUaServer& operator=(const OpcUaServer&) = delete;

  // Starts listening. Throws ServerError when the port cannot be bound or startup fails.
  void start();
  void stop();
  bool listening() const { return listening_; }

  // Processes network events and timers for at most `max_wait` (only while listening()).
  void iterate(std::chrono::milliseconds max_wait);

  // Writes the current simulation snapshot into the address space.
  void publish();

  std::uint16_t port() const { return options_.port; }
  UA_UInt16 namespace_index() const { return address_space_->namespace_index(); }
  // Number of open sessions (diagnostics).
  std::size_t session_count() const;

 private:
  Simulation& simulation_;
  Logger& logger_;
  ServerOptions options_;
  SecurityMaterial security_material_;
  // The plugin keeps pointers to these two: they must outlive server_ (destroyed in reverse order).
  ControlAuthenticator authenticator_;
  ControlContext control_;
  std::unique_ptr<UA_Server, ServerDeleter> server_;
  std::unique_ptr<AddressSpace> address_space_;
  bool listening_ = false;
};

}  // namespace seatrace::sim::opcua
