#include "core/settings.hpp"

#include <gtest/gtest.h>

#include <map>

namespace seatrace::sim {
namespace {

EnvLookup env_of(std::map<std::string, std::string> values) {
  return [values = std::move(values)](std::string_view name) -> std::optional<std::string> {
    const auto it = values.find(std::string(name));
    if (it == values.end()) return std::nullopt;
    return it->second;
  };
}

std::map<std::string, std::string> minimal_none_env() {
  return {{"SIM_SECURITY_MODE", "none"},
          {"SIM_CONTROL_USER", "control"},
          {"SIM_CONTROL_PASSWORD", "hunter2"}};
}

std::string message_of(const std::vector<std::string>& args, const EnvLookup& env) {
  try {
    parse_settings(args, env);
  } catch (const SettingsError& error) {
    return error.what();
  }
  return "";
}

TEST(Settings, DefaultsApplyWhenNothingIsSet) {
  const Settings s = parse_settings({}, env_of(minimal_none_env()));
  EXPECT_EQ(s.port, 4840);
  EXPECT_EQ(s.tick_ms, 1000U);
  EXPECT_EQ(s.seed, 42U);
  EXPECT_EQ(s.config_path, "config/fleet.json");
  EXPECT_EQ(s.log_level, LogLevel::kInfo);
  EXPECT_EQ(s.security_mode, SecurityMode::kNone);
}

TEST(Settings, SecureIsTheDefaultMode) {
  auto env = minimal_none_env();
  env.erase("SIM_SECURITY_MODE");
  EXPECT_NE(message_of({}, env_of(env)).find("SIM_SERVER_CERT"), std::string::npos);
}

TEST(Settings, EnvironmentIsRead) {
  auto env = minimal_none_env();
  env["SIM_OPCUA_PORT"] = "5000";
  env["SIM_TICK_MS"] = "250";
  env["SIM_SEED"] = "7";
  env["SIM_CONFIG"] = "/etc/fleet.json";
  env["SIM_LOG_LEVEL"] = "debug";
  const Settings s = parse_settings({}, env_of(env));
  EXPECT_EQ(s.port, 5000);
  EXPECT_EQ(s.tick_ms, 250U);
  EXPECT_EQ(s.seed, 7U);
  EXPECT_EQ(s.config_path, "/etc/fleet.json");
  EXPECT_EQ(s.log_level, LogLevel::kDebug);
  EXPECT_EQ(s.control_user, "control");
  EXPECT_EQ(s.control_password, "hunter2");
}

TEST(Settings, CommandLineOverridesEnvironment) {
  auto env = minimal_none_env();
  env["SIM_OPCUA_PORT"] = "5000";
  env["SIM_SEED"] = "7";
  const Settings s =
      parse_settings({"--port", "6000", "--seed=9", "--tick-ms", "100"}, env_of(env));
  EXPECT_EQ(s.port, 6000);
  EXPECT_EQ(s.seed, 9U);
  EXPECT_EQ(s.tick_ms, 100U);
}

TEST(Settings, ControlCredentialsAreRequired) {
  auto env = minimal_none_env();
  env.erase("SIM_CONTROL_PASSWORD");
  EXPECT_NE(message_of({}, env_of(env)).find("SIM_CONTROL_PASSWORD"), std::string::npos);
  env["SIM_CONTROL_PASSWORD"] = "";
  EXPECT_NE(message_of({}, env_of(env)).find("SIM_CONTROL_PASSWORD"), std::string::npos);
  env["SIM_CONTROL_PASSWORD"] = "x";
  env.erase("SIM_CONTROL_USER");
  EXPECT_NE(message_of({}, env_of(env)).find("SIM_CONTROL_USER"), std::string::npos);
  EXPECT_NE(message_of({"--control-user", ""}, env_of(minimal_none_env())).find("SIM_CONTROL_USER"),
            std::string::npos);
}

TEST(Settings, PasswordCannotBePassedOnTheCommandLine) {
  EXPECT_NE(
      message_of({"--control-password", "x"}, env_of(minimal_none_env())).find("unknown argument"),
      std::string::npos);
}

TEST(Settings, SecureModeNeedsCertificatesAndATrustList) {
  auto env = minimal_none_env();
  env["SIM_SECURITY_MODE"] = "secure";
  EXPECT_NE(message_of({}, env_of(env)).find("SIM_SERVER_CERT"), std::string::npos);
  env["SIM_SERVER_CERT"] = "/pki/cert.der";
  env["SIM_SERVER_KEY"] = "/pki/key.der";
  EXPECT_NE(message_of({}, env_of(env)).find("SIM_TRUSTED_CLIENT_CERTS"), std::string::npos);
  env["SIM_TRUSTED_CLIENT_CERTS"] = " /pki/a.der , /pki/b.der,";
  const Settings s = parse_settings({}, env_of(env));
  EXPECT_EQ(s.security_mode, SecurityMode::kSecure);
  ASSERT_EQ(s.trusted_client_cert_paths.size(), 2U);
  EXPECT_EQ(s.trusted_client_cert_paths[0], "/pki/a.der");
  EXPECT_EQ(s.trusted_client_cert_paths[1], "/pki/b.der");
}

TEST(Settings, RejectsInvalidValues) {
  const auto env = env_of(minimal_none_env());
  EXPECT_NE(message_of({"--port", "0"}, env), "");
  EXPECT_NE(message_of({"--port", "70000"}, env), "");
  EXPECT_NE(message_of({"--port", "80x"}, env), "");
  EXPECT_NE(message_of({"--tick-ms", "1"}, env), "");
  EXPECT_NE(message_of({"--seed", "-1"}, env), "");
  EXPECT_NE(message_of({"--seed", "4294967296"}, env), "");
  EXPECT_NE(message_of({"--security-mode", "maybe"}, env), "");
  EXPECT_NE(message_of({"--log-level", "chatty"}, env), "");
  EXPECT_NE(message_of({"--bogus"}, env), "");
  EXPECT_NE(message_of({"--port"}, env), "");
  auto bad_env = minimal_none_env();
  bad_env["SIM_OPCUA_PORT"] = "abc";
  EXPECT_NE(message_of({}, env_of(bad_env)).find("SIM_OPCUA_PORT"), std::string::npos);
}

TEST(Settings, HelpShortCircuitsValidation) {
  const Settings s = parse_settings({"--help"}, env_of({}));
  EXPECT_TRUE(s.show_help);
  EXPECT_NE(usage_text().find("SIM_CONTROL_PASSWORD"), std::string::npos);
}

TEST(Settings, LoggableFieldsNeverContainThePassword) {
  const Settings s = parse_settings({}, env_of(minimal_none_env()));
  const std::string dumped = loggable(s).dump();
  EXPECT_EQ(dumped.find("hunter2"), std::string::npos);
  EXPECT_EQ(dumped.find("password"), std::string::npos);
  EXPECT_NE(dumped.find("control"), std::string::npos);
}

}  // namespace
}  // namespace seatrace::sim
