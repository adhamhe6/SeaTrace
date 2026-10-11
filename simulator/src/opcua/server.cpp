#include "opcua/server.hpp"

#include <netinet/in.h>
#include <open62541/plugin/log.h>
#include <open62541/server_config_default.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdarg>
#include <cstdio>
#include <cstring>

namespace seatrace::sim::opcua {

namespace {

// ---- open62541 log output -> structured logger ----------------------------------------------

constexpr const char* kCategoryNames[UA_LOGCATEGORIES] = {
    "network",  "securechannel",  "session",   "server", "client",
    "userland", "securitypolicy", "eventloop", "pubsub", "discovery"};

void ua_log(void* context, UA_LogLevel level, UA_LogCategory category, const char* format,
            va_list args) {
  auto* logger = static_cast<Logger*>(context);
  char buffer[1024];
  std::vsnprintf(buffer, sizeof buffer, format, args);
  const std::string message = buffer;

  LogLevel mapped = LogLevel::kDebug;  // trace, debug and info of the stack are routine chatter
  if (level >= UA_LOGLEVEL_ERROR) {
    mapped = LogLevel::kError;
  } else if (level >= UA_LOGLEVEL_WARNING) {
    mapped = LogLevel::kWarn;
  }
  // The stack's own default plugin warns about permissive defaults; our plugin restricts them.
  if (message.starts_with("AccessControl: Unconfigured AccessControl")) mapped = LogLevel::kDebug;
  // epoll_wait interrupted by SIGINT/SIGTERM while shutting down.
  if (message == "Timeout during poll") mapped = LogLevel::kDebug;

  const auto index = static_cast<std::size_t>(category);
  logger->log(mapped, "open62541: " + message,
              {{"component", index < UA_LOGCATEGORIES ? kCategoryNames[index] : "unknown"}});
}

void ua_log_clear(UA_Logger* logger) { UA_free(logger); }

UA_Logger* make_ua_logger(Logger& logger) {
  auto* ua_logger = static_cast<UA_Logger*>(UA_malloc(sizeof(UA_Logger)));
  if (ua_logger == nullptr) return nullptr;
  ua_logger->log = ua_log;
  ua_logger->context = &logger;
  ua_logger->clear = ua_log_clear;
  return ua_logger;
}

// ---- helpers -----------------------------------------------------------------------------------

// open62541 binds with SO_REUSEPORT, so a second server on the same port would silently share
// it. Probe with a plain bind first to turn "port already in use" into a clear error.
void ensure_port_free(std::uint16_t port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return;  // cannot probe; let the stack report problems
  const int yes = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(port);
  const int result = ::bind(fd, reinterpret_cast<const sockaddr*>(&address), sizeof address);
  const int error = errno;
  ::close(fd);
  if (result != 0) {
    throw ServerError("cannot bind TCP port " + std::to_string(port) + ": " + std::strerror(error));
  }
}

// Owns a UA_ServerConfig until it has been handed to UA_Server_newWithConfig.
class ConfigGuard {
 public:
  explicit ConfigGuard(UA_ServerConfig* config) : config_(config) {}
  ~ConfigGuard() {
    if (config_ != nullptr) UA_ServerConfig_clean(config_);
  }
  ConfigGuard(const ConfigGuard&) = delete;
  ConfigGuard& operator=(const ConfigGuard&) = delete;
  void release() { config_ = nullptr; }

 private:
  UA_ServerConfig* config_;
};

void require(UA_StatusCode status, std::string_view what) {
  if (status != UA_STATUSCODE_GOOD) {
    throw ServerError(std::string(what) + ": " + UA_StatusCode_name(status));
  }
}

}  // namespace

void ServerDeleter::operator()(UA_Server* server) const {
  if (server == nullptr) return;
  if (UA_Server_getLifecycleState(server) == UA_LIFECYCLESTATE_STARTED) {
    UA_Server_run_shutdown(server);
  }
  UA_Server_delete(server);
}

ServerOptions make_server_options(const Settings& settings) {
  ServerOptions options;
  options.port = settings.port;
  options.security_mode = settings.security_mode;
  options.control = {settings.control_user, settings.control_password};
  options.server_cert_path = settings.server_cert_path;
  options.server_key_path = settings.server_key_path;
  options.trusted_client_cert_paths = settings.trusted_client_cert_paths;
  return options;
}

OpcUaServer::OpcUaServer(Simulation& simulation, Logger& logger, ServerOptions options)
    : simulation_(simulation),
      logger_(logger),
      options_(std::move(options)),
      authenticator_(options_.control, logger),
      control_{simulation, logger, {}} {
  if (options_.security_mode == SecurityMode::kSecure) {
    security_material_ = load_security_material(options_.server_cert_path, options_.server_key_path,
                                                options_.trusted_client_cert_paths);
  }

  UA_ServerConfig config;
  std::memset(&config, 0, sizeof config);
  ConfigGuard guard(&config);
  config.logging = make_ua_logger(logger);
  if (config.logging == nullptr) throw ServerError("out of memory");

  require(UA_ServerConfig_setBasics_withPort(&config, options_.port), "server configuration");
  UA_LocalizedText_clear(&config.applicationDescription.applicationName);
  config.applicationDescription.applicationName =
      UA_LOCALIZEDTEXT_ALLOC("en", "SeaTrace Vessel Simulator");
  UA_String_clear(&config.applicationDescription.productUri);
  config.applicationDescription.productUri = UA_STRING_ALLOC("urn:seatrace:simulator:product");
  config.tcpReuseAddr = true;  // quick restarts (outage scenario); port conflicts are probed first

  require(apply_security(&config, options_.security_mode, security_material_, logger),
          "security configuration");
  require(authenticator_.install(&config), "access control configuration");

  UA_Server* raw = UA_Server_newWithConfig(&config);
  guard.release();  // newWithConfig takes over (and on failure cleans) the configuration
  if (raw == nullptr) throw ServerError("UA_Server_newWithConfig failed");
  server_.reset(raw);

  address_space_ = std::make_unique<AddressSpace>(raw, simulation_, control_);
  control_.scenarios_changed = [this] {
    if (const auto failures = address_space_->publish_scenarios(simulation_); failures != 0) {
      logger_.error("could not publish ActiveScenarios");
    }
  };
}

OpcUaServer::~OpcUaServer() {
  try {
    stop();
  } catch (...) {  // NOLINT(bugprone-empty-catch): destructors must not throw; the deleter stops
                   // the server anyway
  }
}

void OpcUaServer::start() {
  if (listening_) return;
  ensure_port_free(options_.port);
  require(UA_Server_run_startup(server_.get()), "UA_Server_run_startup");
  listening_ = true;
  logger_.info(
      "OPC UA server listening",
      {{"port", options_.port},
       {"security_mode", options_.security_mode == SecurityMode::kSecure ? "secure" : "none"},
       {"namespace_uri", std::string(kNamespaceUri)},
       {"namespace_index", namespace_index()}});
}

void OpcUaServer::stop() {
  if (!listening_) return;
  listening_ = false;
  const UA_StatusCode status = UA_Server_run_shutdown(server_.get());
  if (status != UA_STATUSCODE_GOOD) {
    logger_.warn("UA_Server_run_shutdown reported an error",
                 {{"status", UA_StatusCode_name(status)}});
  }
  logger_.info("OPC UA listener stopped");
}

void OpcUaServer::iterate(std::chrono::milliseconds max_wait) {
  if (!listening_) return;
  // Equivalent to UA_Server_run_iterate(server, true) but with a caller-chosen wait so that the
  // simulation tick is never delayed by the stack's own 500 ms wait.
  UA_EventLoop* loop = UA_Server_getConfig(server_.get())->eventLoop;
  loop->run(loop, static_cast<UA_UInt32>(max_wait.count()));
}

void OpcUaServer::publish() {
  if (const auto failures = address_space_->publish(simulation_); failures != 0) {
    logger_.error("OPC UA node writes failed", {{"count", failures}});
  }
}

std::size_t OpcUaServer::session_count() const {
  return UA_Server_getStatistics(server_.get()).ss.currentSessionCount;
}

}  // namespace seatrace::sim::opcua
