#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <open62541/client.h>
#include <open62541/client_config_default.h>
#include <open62541/client_highlevel.h>
#include <open62541/client_subscriptions.h>
#include <open62541/plugin/create_certificate.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <list>
#include <memory>
#include <optional>
#include <sstream>
#include <streambuf>
#include <string>
#include <thread>
#include <vector>

#include "core/logger.hpp"
#include "core/simulation.hpp"
#include "opcua/runner.hpp"
#include "opcua/server.hpp"
#include "test_support.hpp"

namespace seatrace::sim::testing {

inline constexpr const char* kControlUser = "control";
inline constexpr const char* kControlPassword = "test-password-1";
inline constexpr std::chrono::milliseconds kTick{100};
inline constexpr const char* kBasic256Sha256 =
    "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256";

// ---- ports and files ---------------------------------------------------------------------------

inline std::uint16_t free_port() {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  ::bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof address);
  socklen_t length = sizeof address;
  ::getsockname(fd, reinterpret_cast<sockaddr*>(&address), &length);
  const std::uint16_t port = ntohs(address.sin_port);
  ::close(fd);
  return port;
}

class TempDir {
 public:
  TempDir() {
    path_ = std::filesystem::temp_directory_path() /
            ("seatrace-test-" + std::to_string(::getpid()) + "-" + std::to_string(counter_++));
    std::filesystem::create_directories(path_);
  }
  ~TempDir() { std::filesystem::remove_all(path_); }
  TempDir(const TempDir&) = delete;
  TempDir& operator=(const TempDir&) = delete;
  const std::filesystem::path& path() const { return path_; }

 private:
  static inline std::atomic<int> counter_{0};
  std::filesystem::path path_;
};

// ---- self-signed application certificates (DER) -------------------------------------------------

struct TestCertificate {
  std::vector<unsigned char> certificate;
  std::vector<unsigned char> private_key;
};

inline std::vector<unsigned char> to_vector(const UA_ByteString& bytes) {
  return {bytes.data, bytes.data + bytes.length};
}

inline TestCertificate make_certificate(const std::string& application_uri, const std::string& cn) {
  UA_Logger quiet{};
  const std::string subject_cn = "CN=" + cn;
  const std::string uri = "URI:" + application_uri;
  const UA_String subject[2] = {
      UA_STRING_STATIC("O=SeaTrace tests"),
      {subject_cn.size(), reinterpret_cast<UA_Byte*>(const_cast<char*>(subject_cn.data()))}};
  const UA_String alt[2] = {{uri.size(), reinterpret_cast<UA_Byte*>(const_cast<char*>(uri.data()))},
                            UA_STRING_STATIC("DNS:localhost")};
  UA_KeyValueMap* params = UA_KeyValueMap_new();
  UA_UInt16 bits = 2048;
  UA_KeyValueMap_setScalar(params, UA_QUALIFIEDNAME(0, const_cast<char*>("key-size-bits")), &bits,
                           &UA_TYPES[UA_TYPES_UINT16]);
  UA_ByteString key = UA_BYTESTRING_NULL;
  UA_ByteString cert = UA_BYTESTRING_NULL;
  const UA_StatusCode status = UA_CreateCertificate(&quiet, subject, 2, alt, 2,
                                                    UA_CERTIFICATEFORMAT_DER, params, &key, &cert);
  UA_KeyValueMap_delete(params);
  EXPECT_EQ(status, UA_STATUSCODE_GOOD) << UA_StatusCode_name(status);
  TestCertificate result{to_vector(cert), to_vector(key)};
  UA_ByteString_clear(&key);
  UA_ByteString_clear(&cert);
  return result;
}

inline std::string write_file(const std::filesystem::path& path,
                              const std::vector<unsigned char>& bytes) {
  std::ofstream file(path, std::ios::binary);
  file.write(reinterpret_cast<const char*>(bytes.data()),
             static_cast<std::streamsize>(bytes.size()));
  return path.string();
}

// ---- in-process simulator
// ------------------------------------------------------------------------

class NullBuffer : public std::streambuf {
 protected:
  int overflow(int c) override { return c; }
  std::streamsize xsputn(const char*, std::streamsize n) override { return n; }
};

inline opcua::ServerOptions default_server_options() {
  opcua::ServerOptions options;
  options.port = 0;  // pick a free port
  options.security_mode = SecurityMode::kNone;
  options.control = {kControlUser, kControlPassword};
  return options;
}

struct SimulatorOptions {
  std::uint32_t seed = 42;
  opcua::ServerOptions server = default_server_options();
  std::optional<FleetConfig> fleet;
  std::chrono::milliseconds tick = kTick;
};

// Runs Simulation + OpcUaServer + Runner on a background thread. After construction the test
// thread must only talk to it through OPC UA (a client), exactly like production clients.
class RunningSimulator {
 public:
  explicit RunningSimulator(SimulatorOptions options = {})
      : logger_(std::getenv("SEATRACE_TEST_LOG") != nullptr ? std::cerr : null_stream_,
                std::getenv("SEATRACE_TEST_LOG") != nullptr ? LogLevel::kDebug : LogLevel::kError),
        simulation_(options.fleet ? *options.fleet : default_fleet(), options.seed,
                    wall_clock_now()),
        tick_(options.tick) {
    if (options.server.port == 0) options.server.port = free_port();
    port_ = options.server.port;
    server_ = std::make_unique<opcua::OpcUaServer>(simulation_, logger_, std::move(options.server));
    server_->start();
    runner_ = std::make_unique<opcua::Runner>(simulation_, *server_, logger_, tick_);
    thread_ = std::thread([this] { runner_->run(stop_); });
  }
  ~RunningSimulator() { shutdown(); }
  RunningSimulator(const RunningSimulator&) = delete;
  RunningSimulator& operator=(const RunningSimulator&) = delete;

  void shutdown() {
    stop_.store(true);
    if (thread_.joinable()) thread_.join();
  }

  std::uint16_t port() const { return port_; }
  std::string endpoint() const {
    return "opc.tcp://127.0.0.1:" + std::to_string(port_) + "/seatrace/simulator";
  }

 private:
  NullBuffer null_buffer_;
  std::ostream null_stream_{&null_buffer_};
  Logger logger_;
  Simulation simulation_;
  std::chrono::milliseconds tick_;
  std::uint16_t port_ = 0;
  std::unique_ptr<opcua::OpcUaServer> server_;
  std::unique_ptr<opcua::Runner> runner_;
  std::atomic<bool> stop_{false};
  std::thread thread_;
};

// ---- client side --------------------------------------------------------------------------------

class DataValue {
 public:
  UA_StatusCode service_status = UA_STATUSCODE_BAD;  // result of the Read service itself

  DataValue() { UA_DataValue_init(&value_); }
  ~DataValue() { UA_DataValue_clear(&value_); }
  DataValue(DataValue&& other) noexcept
      : service_status(other.service_status), value_(other.value_) {
    UA_DataValue_init(&other.value_);
  }
  DataValue& operator=(DataValue&& other) noexcept {
    if (this != &other) {
      UA_DataValue_clear(&value_);
      value_ = other.value_;
      service_status = other.service_status;
      UA_DataValue_init(&other.value_);
    }
    return *this;
  }
  DataValue(const DataValue&) = delete;
  DataValue& operator=(const DataValue&) = delete;

  UA_DataValue* get() { return &value_; }
  const UA_DataValue& raw() const { return value_; }

  UA_StatusCode status() const { return value_.hasStatus ? value_.status : UA_STATUSCODE_GOOD; }
  bool has_source_timestamp() const { return value_.hasSourceTimestamp; }
  UA_DateTime source_timestamp() const { return value_.sourceTimestamp; }
  bool has_server_timestamp() const { return value_.hasServerTimestamp; }
  bool is_double() const {
    return UA_Variant_hasScalarType(&value_.value, &UA_TYPES[UA_TYPES_DOUBLE]);
  }
  double as_double() const { return *static_cast<const double*>(value_.value.data); }
  std::string as_string() const {
    if (!UA_Variant_hasScalarType(&value_.value, &UA_TYPES[UA_TYPES_STRING]))
      return "<not a string>";
    const auto* s = static_cast<const UA_String*>(value_.value.data);
    return std::string(reinterpret_cast<const char*>(s->data), s->length);
  }
  std::uint64_t as_uint64() const {
    if (UA_Variant_hasScalarType(&value_.value, &UA_TYPES[UA_TYPES_UINT64])) {
      return *static_cast<const UA_UInt64*>(value_.value.data);
    }
    if (UA_Variant_hasScalarType(&value_.value, &UA_TYPES[UA_TYPES_UINT32])) {
      return *static_cast<const UA_UInt32*>(value_.value.data);
    }
    return ~0ULL;
  }

 private:
  UA_DataValue value_;
};

struct Child {
  std::string name;
  std::string id;  // string identifier ("" for non-string NodeIds)
};

struct CallResult {
  UA_StatusCode status = UA_STATUSCODE_BAD;
  bool accepted = false;
  std::string message;
};

struct Notification {
  double value = 0.0;
  UA_StatusCode status = UA_STATUSCODE_GOOD;
  UA_DateTime source_timestamp = 0;
};

inline UA_Logger* make_silent_logger() {
  auto* logger = static_cast<UA_Logger*>(UA_malloc(sizeof(UA_Logger)));
  logger->log = [](void*, UA_LogLevel level, UA_LogCategory, const char* format, va_list args) {
    if (std::getenv("SEATRACE_TEST_LOG") != nullptr && level >= UA_LOGLEVEL_INFO) {
      std::fputs("[client] ", stderr);
      std::vfprintf(stderr, format, args);
      std::fputc('\n', stderr);
    }
  };
  logger->context = nullptr;
  logger->clear = [](UA_Logger* l) { UA_free(l); };
  return logger;
}

class Client {
 public:
  Client() {
    UA_ClientConfig config;
    std::memset(&config, 0, sizeof config);
    config.logging = make_silent_logger();
    UA_ClientConfig_setDefault(&config);
    config.timeout = 5000;
    client_ = UA_Client_newWithConfig(&config);
  }
  ~Client() {
    if (client_ != nullptr) {
      UA_Client_disconnect(client_);
      UA_Client_delete(client_);
    }
  }
  Client(const Client&) = delete;
  Client& operator=(const Client&) = delete;

  UA_Client* raw() { return client_; }

  // Connects without security (anonymous or username/password).
  UA_StatusCode connect(const std::string& url, const char* user = nullptr,
                        const char* password = nullptr) {
    UA_ClientConfig* config = UA_Client_getConfig(client_);
    config->securityMode = UA_MESSAGESECURITYMODE_NONE;
    if (user != nullptr) return UA_Client_connectUsername(client_, url.c_str(), user, password);
    return UA_Client_connect(client_, url.c_str());
  }

  // Basic256Sha256 / SignAndEncrypt with the given client identity; trusts exactly `server_cert`.
  UA_StatusCode connect_secure(const std::string& url, const TestCertificate& identity,
                               const std::string& application_uri,
                               const std::vector<unsigned char>& server_cert,
                               const char* user = nullptr, const char* password = nullptr) {
    UA_StatusCode status = configure_secure(url, identity, application_uri, server_cert);
    if (status != UA_STATUSCODE_GOOD) return status;
    size_t count = 0;
    UA_EndpointDescription* endpoints = nullptr;
    status = UA_Client_getEndpoints(client_, url.c_str(), &count, &endpoints);
    if (status != UA_STATUSCODE_GOOD) return status;
    UA_ClientConfig* config = UA_Client_getConfig(client_);
    for (size_t i = 0; i < count; ++i) {
      if (endpoints[i].securityMode == UA_MESSAGESECURITYMODE_SIGNANDENCRYPT) {
        UA_EndpointDescription_clear(&config->endpoint);
        UA_EndpointDescription_copy(&endpoints[i], &config->endpoint);
        break;
      }
    }
    UA_Array_delete(endpoints, count, &UA_TYPES[UA_TYPES_ENDPOINTDESCRIPTION]);
    if (user != nullptr) return UA_Client_connectUsername(client_, url.c_str(), user, password);
    return UA_Client_connect(client_, url.c_str());
  }

  UA_StatusCode configure_secure(const std::string& url, const TestCertificate& identity,
                                 const std::string& application_uri,
                                 const std::vector<unsigned char>& server_cert) {
    UA_ClientConfig* config = UA_Client_getConfig(client_);
    UA_ByteString cert{identity.certificate.size(),
                       const_cast<UA_Byte*>(identity.certificate.data())};
    UA_ByteString key{identity.private_key.size(),
                      const_cast<UA_Byte*>(identity.private_key.data())};
    UA_ByteString trusted{server_cert.size(), const_cast<UA_Byte*>(server_cert.data())};
    UA_StatusCode status =
        UA_ClientConfig_setDefaultEncryption(config, cert, key, &trusted, 1, nullptr, 0);
    if (status != UA_STATUSCODE_GOOD) return status;
    UA_String_clear(&config->clientDescription.applicationUri);
    config->clientDescription.applicationUri = UA_STRING_ALLOC(application_uri.c_str());
    config->securityMode = UA_MESSAGESECURITYMODE_SIGNANDENCRYPT;
    UA_String_clear(&config->securityPolicyUri);
    config->securityPolicyUri = UA_STRING_ALLOC(kBasic256Sha256);
    config->timeout = 5000;

    // The server offers no unsecured endpoint, so the stack's usual GetEndpoints-over-None
    // discovery cannot work: describe the endpoint explicitly (enough to run GetEndpoints over
    // the secure channel; connect_secure then adopts the server's own endpoint description).
    UA_EndpointDescription& endpoint = config->endpoint;
    endpoint.endpointUrl = UA_STRING_ALLOC(url.c_str());
    endpoint.securityMode = UA_MESSAGESECURITYMODE_SIGNANDENCRYPT;
    endpoint.securityPolicyUri = UA_STRING_ALLOC(kBasic256Sha256);
    endpoint.transportProfileUri =
        UA_STRING_ALLOC("http://opcfoundation.org/UA-Profile/Transport/uatcp-uasc-uabinary");
    UA_ByteString_copy(&trusted, &endpoint.serverCertificate);
    return UA_STATUSCODE_GOOD;
  }

  bool session_active() {
    UA_SessionState session = UA_SESSIONSTATE_CLOSED;
    UA_Client_getState(client_, nullptr, &session, nullptr);
    return session == UA_SESSIONSTATE_ACTIVATED;
  }

  UA_UInt16 namespace_index() {
    if (!ns_) {
      UA_UInt16 index = 0;
      const UA_String uri = UA_STRING_STATIC("urn:seatrace:simulator");
      EXPECT_EQ(UA_Client_NamespaceGetIndex(client_, const_cast<UA_String*>(&uri), &index),
                UA_STATUSCODE_GOOD);
      ns_ = index;
    }
    return *ns_;
  }

  UA_NodeId node(const std::string& id) {
    UA_NodeId n;
    UA_NodeId_init(&n);
    n.namespaceIndex = namespace_index();
    n.identifierType = UA_NODEIDTYPE_STRING;
    n.identifier.string =
        UA_String{id.size(), reinterpret_cast<UA_Byte*>(const_cast<char*>(id.data()))};
    return n;
  }

  DataValue read(const std::string& id, UA_UInt32 attribute = UA_ATTRIBUTEID_VALUE) {
    UA_ReadValueId item;
    UA_ReadValueId_init(&item);
    item.nodeId = node(id);
    item.attributeId = attribute;
    UA_ReadRequest request;
    UA_ReadRequest_init(&request);
    request.nodesToRead = &item;
    request.nodesToReadSize = 1;
    request.timestampsToReturn = UA_TIMESTAMPSTORETURN_BOTH;
    UA_ReadResponse response = UA_Client_Service_read(client_, request);
    DataValue result;
    result.service_status = response.responseHeader.serviceResult;
    if (response.resultsSize == 1) {
      UA_DataValue_copy(&response.results[0], result.get());
    } else if (result.service_status == UA_STATUSCODE_GOOD) {
      result.service_status = UA_STATUSCODE_BADUNEXPECTEDERROR;
    }
    UA_ReadResponse_clear(&response);
    return result;
  }

  std::vector<Child> children(const std::string& id) { return children_of(node(id)); }

  std::vector<Child> children_of(UA_NodeId parent) {
    UA_BrowseDescription description;
    UA_BrowseDescription_init(&description);
    description.nodeId = parent;
    description.browseDirection = UA_BROWSEDIRECTION_FORWARD;
    description.referenceTypeId = UA_NODEID_NUMERIC(0, UA_NS0ID_HIERARCHICALREFERENCES);
    description.includeSubtypes = true;
    description.resultMask = UA_BROWSERESULTMASK_ALL;
    UA_BrowseRequest request;
    UA_BrowseRequest_init(&request);
    request.nodesToBrowse = &description;
    request.nodesToBrowseSize = 1;
    UA_BrowseResponse response = UA_Client_Service_browse(client_, request);
    std::vector<Child> result;
    if (response.responseHeader.serviceResult == UA_STATUSCODE_GOOD && response.resultsSize == 1) {
      for (size_t i = 0; i < response.results[0].referencesSize; ++i) {
        const UA_ReferenceDescription& ref = response.results[0].references[i];
        Child child;
        child.name.assign(reinterpret_cast<const char*>(ref.browseName.name.data),
                          ref.browseName.name.length);
        if (ref.nodeId.nodeId.identifierType == UA_NODEIDTYPE_STRING) {
          child.id.assign(reinterpret_cast<const char*>(ref.nodeId.nodeId.identifier.string.data),
                          ref.nodeId.nodeId.identifier.string.length);
        }
        result.push_back(std::move(child));
      }
    }
    UA_BrowseResponse_clear(&response);
    return result;
  }

  CallResult call(const std::string& method, std::vector<UA_Variant> inputs,
                  const std::string& object = "Simulator") {
    UA_Variant* output = nullptr;
    size_t output_size = 0;
    CallResult result;
    result.status = UA_Client_call(client_, node(object), node("Simulator." + method),
                                   inputs.size(), inputs.data(), &output_size, &output);
    if (result.status == UA_STATUSCODE_GOOD && output_size == 2) {
      result.accepted = *static_cast<UA_Boolean*>(output[0].data);
      const auto* message = static_cast<UA_String*>(output[1].data);
      result.message.assign(reinterpret_cast<const char*>(message->data), message->length);
    }
    UA_Array_delete(output, output_size, &UA_TYPES[UA_TYPES_VARIANT]);
    for (UA_Variant& input : inputs) UA_Variant_clear(&input);
    return result;
  }

  static UA_Variant text(const std::string& s) {
    UA_Variant v;
    UA_Variant_init(&v);
    const UA_String str{s.size(), reinterpret_cast<UA_Byte*>(const_cast<char*>(s.data()))};
    UA_Variant_setScalarCopy(&v, &str, &UA_TYPES[UA_TYPES_STRING]);
    return v;
  }
  static UA_Variant uint32(UA_UInt32 value) {
    UA_Variant v;
    UA_Variant_init(&v);
    UA_Variant_setScalarCopy(&v, &value, &UA_TYPES[UA_TYPES_UINT32]);
    return v;
  }
  static UA_Variant int64(UA_Int64 value) {
    UA_Variant v;
    UA_Variant_init(&v);
    UA_Variant_setScalarCopy(&v, &value, &UA_TYPES[UA_TYPES_INT64]);
    return v;
  }

  CallResult activate(const std::string& vessel, const std::string& scenario,
                      UA_UInt32 duration = 0) {
    return call("ActivateScenario", {text(vessel), text(scenario), uint32(duration)});
  }
  CallResult clear(const std::string& vessel, const std::string& scenario) {
    return call("ClearScenario", {text(vessel), text(scenario)});
  }
  CallResult reset() { return call("ResetScenarios", {}); }

  // Runs the client's event loop until `done` returns true or the timeout elapses.
  bool pump_until(const std::function<bool()>& done,
                  std::chrono::milliseconds timeout = std::chrono::seconds(10)) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      if (done()) return true;
      UA_Client_run_iterate(client_, 20);
    }
    return done();
  }

  // Creates a subscription with one data-change monitored item (StatusValueTimestamp trigger).
  // The notifications are collected in a vector owned by the client (it must outlive the
  // callbacks, which may still fire while the client disconnects); null when it failed.
  std::vector<Notification>* subscribe(const std::string& id, double interval_ms = 100) {
    auto& sink = sinks_.emplace_back();
    UA_CreateSubscriptionRequest request = UA_CreateSubscriptionRequest_default();
    request.requestedPublishingInterval = interval_ms;
    UA_CreateSubscriptionResponse response =
        UA_Client_Subscriptions_create(client_, request, nullptr, nullptr, nullptr);
    if (response.responseHeader.serviceResult != UA_STATUSCODE_GOOD) return nullptr;

    UA_DataChangeFilter filter;
    UA_DataChangeFilter_init(&filter);
    filter.trigger = UA_DATACHANGETRIGGER_STATUSVALUETIMESTAMP;
    UA_MonitoredItemCreateRequest item = UA_MonitoredItemCreateRequest_default(node(id));
    item.requestedParameters.samplingInterval = interval_ms;
    item.requestedParameters.filter.encoding = UA_EXTENSIONOBJECT_DECODED_NODELETE;
    item.requestedParameters.filter.content.decoded.type = &UA_TYPES[UA_TYPES_DATACHANGEFILTER];
    item.requestedParameters.filter.content.decoded.data = &filter;
    UA_MonitoredItemCreateResult result = UA_Client_MonitoredItems_createDataChange(
        client_, response.subscriptionId, UA_TIMESTAMPSTORETURN_BOTH, item, &sink,
        [](UA_Client*, UA_UInt32, void*, UA_UInt32, void* context, UA_DataValue* value) {
          Notification n;
          if (value->hasValue &&
              UA_Variant_hasScalarType(&value->value, &UA_TYPES[UA_TYPES_DOUBLE])) {
            n.value = *static_cast<double*>(value->value.data);
          }
          n.status = value->hasStatus ? value->status : UA_STATUSCODE_GOOD;
          n.source_timestamp = value->hasSourceTimestamp ? value->sourceTimestamp : 0;
          static_cast<std::vector<Notification>*>(context)->push_back(n);
        },
        nullptr);
    const bool ok = result.statusCode == UA_STATUSCODE_GOOD;
    UA_MonitoredItemCreateResult_clear(&result);
    return ok ? &sink : nullptr;
  }

 private:
  // Outlives the disconnect in the destructor body, which may still deliver notifications.
  std::list<std::vector<Notification>> sinks_;
  UA_Client* client_ = nullptr;
  std::optional<UA_UInt16> ns_;
};

inline bool poll_until(const std::function<bool()>& done,
                       std::chrono::milliseconds timeout = std::chrono::seconds(10),
                       std::chrono::milliseconds interval = std::chrono::milliseconds(20)) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (done()) return true;
    std::this_thread::sleep_for(interval);
  }
  return done();
}

}  // namespace seatrace::sim::testing
