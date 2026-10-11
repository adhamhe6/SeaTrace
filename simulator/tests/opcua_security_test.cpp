#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "opcua/access_control.hpp"
#include "opcua_test_support.hpp"

namespace seatrace::sim {
namespace {

using namespace testing;
using namespace std::chrono_literals;

constexpr const char* kTrustedUri = "urn:test:trusted-client";
constexpr const char* kStrangerUri = "urn:test:stranger-client";

// Server + two client identities, generated in-process (RSA 2048, self-signed, DER).
class SecureServerTest : public ::testing::Test {
 protected:
  static void SetUpTestSuite() {
    server_identity =
        new TestCertificate(make_certificate("urn:seatrace:simulator", "SeaTrace test simulator"));
    trusted_identity = new TestCertificate(make_certificate(kTrustedUri, "trusted client"));
    stranger_identity = new TestCertificate(make_certificate(kStrangerUri, "untrusted client"));
    directory = new TempDir();
    server_cert_path = write_file(directory->path() / "server.der", server_identity->certificate);
    server_key_path =
        write_file(directory->path() / "server.key.der", server_identity->private_key);
    trusted_path = write_file(directory->path() / "trusted.der", trusted_identity->certificate);
  }
  static void TearDownTestSuite() {
    delete directory;
    delete server_identity;
    delete trusted_identity;
    delete stranger_identity;
  }

  void SetUp() override {
    SimulatorOptions options;
    options.server.security_mode = SecurityMode::kSecure;
    options.server.server_cert_path = server_cert_path;
    options.server.server_key_path = server_key_path;
    options.server.trusted_client_cert_paths = {trusted_path};
    simulator = std::make_unique<RunningSimulator>(std::move(options));
  }

  UA_StatusCode connect_trusted(Client& client, const char* user = nullptr,
                                const char* password = nullptr) {
    return client.connect_secure(simulator->endpoint(), *trusted_identity, kTrustedUri,
                                 server_identity->certificate, user, password);
  }

  static inline TestCertificate* server_identity = nullptr;
  static inline TestCertificate* trusted_identity = nullptr;
  static inline TestCertificate* stranger_identity = nullptr;
  static inline TempDir* directory = nullptr;
  static inline std::string server_cert_path;
  static inline std::string server_key_path;
  static inline std::string trusted_path;
  std::unique_ptr<RunningSimulator> simulator;
};

TEST_F(SecureServerTest, TrustedClientConnectsWithSignAndEncryptAndReadsAnonymously) {
  Client client;
  ASSERT_EQ(connect_trusted(client), UA_STATUSCODE_GOOD);
  const DataValue value = client.read("VES-001.ME1.Temperature");
  ASSERT_EQ(value.service_status, UA_STATUSCODE_GOOD);
  EXPECT_EQ(value.status(), UA_STATUSCODE_GOOD);
  EXPECT_TRUE(value.is_double());
}

TEST_F(SecureServerTest, ControlAccountAuthenticatesOverTheEncryptedChannel) {
  Client client;
  ASSERT_EQ(connect_trusted(client, kControlUser, kControlPassword), UA_STATUSCODE_GOOD);
  const CallResult result = client.activate("VES-001", "bilge_flooding", 30);
  EXPECT_EQ(result.status, UA_STATUSCODE_GOOD);
  EXPECT_TRUE(result.accepted) << result.message;
}

TEST_F(SecureServerTest, AnonymousSessionOnTheSecureChannelCannotCallMethods) {
  Client client;
  ASSERT_EQ(connect_trusted(client), UA_STATUSCODE_GOOD);
  EXPECT_EQ(client.activate("VES-001", "bilge_flooding").status, UA_STATUSCODE_BADUSERACCESSDENIED);
}

TEST_F(SecureServerTest, WrongPasswordIsRejectedOnTheSecureChannel) {
  Client client;
  EXPECT_NE(connect_trusted(client, kControlUser, "wrong"), UA_STATUSCODE_GOOD);
}

TEST_F(SecureServerTest, UntrustedClientCertificateIsRejected) {
  Client client;
  EXPECT_NE(client.connect_secure(simulator->endpoint(), *stranger_identity, kStrangerUri,
                                  server_identity->certificate),
            UA_STATUSCODE_GOOD);
  // The trusted client still works afterwards.
  Client trusted;
  EXPECT_EQ(connect_trusted(trusted), UA_STATUSCODE_GOOD);
}

TEST_F(SecureServerTest, UnsecuredConnectionsAreRefused) {
  Client client;
  EXPECT_NE(client.connect(simulator->endpoint()), UA_STATUSCODE_GOOD);
  Client with_password;
  EXPECT_NE(with_password.connect(simulator->endpoint(), kControlUser, kControlPassword),
            UA_STATUSCODE_GOOD);
}

TEST_F(SecureServerTest, OnlyBasic256Sha256SignAndEncryptIsOffered) {
  Client client;
  ASSERT_EQ(client.configure_secure(simulator->endpoint(), *trusted_identity, kTrustedUri,
                                    server_identity->certificate),
            UA_STATUSCODE_GOOD);
  size_t count = 0;
  UA_EndpointDescription* endpoints = nullptr;
  ASSERT_EQ(UA_Client_getEndpoints(client.raw(), simulator->endpoint().c_str(), &count, &endpoints),
            UA_STATUSCODE_GOOD);
  ASSERT_EQ(count, 1U);
  EXPECT_EQ(std::string(reinterpret_cast<char*>(endpoints[0].securityPolicyUri.data),
                        endpoints[0].securityPolicyUri.length),
            "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256");
  EXPECT_EQ(endpoints[0].securityMode, UA_MESSAGESECURITYMODE_SIGNANDENCRYPT);
  bool anonymous_offered = false;
  bool username_offered = false;
  for (size_t i = 0; i < endpoints[0].userIdentityTokensSize; ++i) {
    anonymous_offered |= endpoints[0].userIdentityTokens[i].tokenType == UA_USERTOKENTYPE_ANONYMOUS;
    username_offered |= endpoints[0].userIdentityTokens[i].tokenType == UA_USERTOKENTYPE_USERNAME;
    EXPECT_NE(endpoints[0].userIdentityTokens[i].tokenType, UA_USERTOKENTYPE_CERTIFICATE);
  }
  EXPECT_TRUE(anonymous_offered);
  EXPECT_TRUE(username_offered);
  EXPECT_EQ(std::string(reinterpret_cast<char*>(endpoints[0].server.applicationUri.data),
                        endpoints[0].server.applicationUri.length),
            "urn:seatrace:simulator");
  UA_Array_delete(endpoints, count, &UA_TYPES[UA_TYPES_ENDPOINTDESCRIPTION]);
}

TEST_F(SecureServerTest, ServerCertificateMismatchIsDetectedByTheClient) {
  Client client;
  // The client pins the stranger's certificate as "the server": the real server must be refused.
  EXPECT_NE(client.connect_secure(simulator->endpoint(), *trusted_identity, kTrustedUri,
                                  stranger_identity->certificate),
            UA_STATUSCODE_GOOD);
}

TEST(SecureServerSetup, MissingCertificateFilesAreReportedWithTheirPath) {
  Simulation simulation = make_simulation();
  std::ostringstream sink;
  Logger logger(sink, LogLevel::kError);
  opcua::ServerOptions options = default_server_options();
  options.port = free_port();
  options.security_mode = SecurityMode::kSecure;
  options.server_cert_path = "/nonexistent/cert.der";
  options.server_key_path = "/nonexistent/key.der";
  options.trusted_client_cert_paths = {"/nonexistent/client.der"};
  try {
    opcua::OpcUaServer server(simulation, logger, options);
    FAIL() << "expected ServerError";
  } catch (const opcua::ServerError& error) {
    EXPECT_THAT(std::string(error.what()), ::testing::HasSubstr("/nonexistent/cert.der"));
  }
}

TEST(SecureServerSetup, ACertificateForTheWrongApplicationUriRefusesToStart) {
  const TestCertificate wrong = make_certificate("urn:somebody:else", "wrong uri");
  const TestCertificate client = make_certificate(kTrustedUri, "client");
  TempDir directory;
  Simulation simulation = make_simulation();
  std::ostringstream sink;
  Logger logger(sink, LogLevel::kError);
  opcua::ServerOptions options = default_server_options();
  options.port = free_port();
  options.security_mode = SecurityMode::kSecure;
  options.server_cert_path = write_file(directory.path() / "c.der", wrong.certificate);
  options.server_key_path = write_file(directory.path() / "k.der", wrong.private_key);
  options.trusted_client_cert_paths = {write_file(directory.path() / "t.der", client.certificate)};
  opcua::OpcUaServer server(simulation, logger, options);
  EXPECT_THROW(server.start(), opcua::ServerError);
}

TEST(ServerSetup, PortInUseIsAClearError) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = 0;
  ASSERT_EQ(::bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof address), 0);
  ASSERT_EQ(::listen(fd, 1), 0);
  socklen_t length = sizeof address;
  ::getsockname(fd, reinterpret_cast<sockaddr*>(&address), &length);

  Simulation simulation = make_simulation();
  std::ostringstream sink;
  Logger logger(sink, LogLevel::kError);
  opcua::ServerOptions options = default_server_options();
  options.port = ntohs(address.sin_port);
  opcua::OpcUaServer server(simulation, logger, options);
  try {
    server.start();
    FAIL() << "expected ServerError";
  } catch (const opcua::ServerError& error) {
    EXPECT_THAT(std::string(error.what()), ::testing::HasSubstr("cannot bind TCP port"));
  }
  EXPECT_FALSE(server.listening());
  ::close(fd);
  EXPECT_NO_THROW(server.start()) << "the port is usable again once it is free";
}

TEST(AccessControl, ConstantTimeEqualBehavesLikeEquality) {
  using opcua::constant_time_equal;
  EXPECT_TRUE(constant_time_equal("", ""));
  EXPECT_TRUE(constant_time_equal("secret", "secret"));
  EXPECT_FALSE(constant_time_equal("secret", "secreT"));
  EXPECT_FALSE(constant_time_equal("secret", "secret2"));
  EXPECT_FALSE(constant_time_equal("secret2", "secret"));
  EXPECT_FALSE(constant_time_equal("", "x"));
  EXPECT_FALSE(constant_time_equal(std::string("a\0b", 3), std::string("a\0c", 3)));
}

}  // namespace
}  // namespace seatrace::sim
