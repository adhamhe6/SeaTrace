#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "core/logger.hpp"

namespace seatrace::sim {

class SettingsError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

enum class SecurityMode { kSecure, kNone };

struct Settings {
  std::uint16_t port = 4840;
  std::uint32_t tick_ms = 1000;
  std::uint32_t seed = 42;
  std::string config_path = "config/fleet.json";
  SecurityMode security_mode = SecurityMode::kSecure;
  std::string control_user;
  std::string control_password;                        // never logged
  std::string server_cert_path;                        // DER
  std::string server_key_path;                         // DER
  std::vector<std::string> trusted_client_cert_paths;  // DER
  LogLevel log_level = LogLevel::kInfo;
  bool show_help = false;
};

using EnvLookup = std::function<std::optional<std::string>(std::string_view)>;

// Builds the settings from environment variables, then applies command-line flags on top
// (flags win). `args` excludes the program name. Throws SettingsError with a clear message.
Settings parse_settings(const std::vector<std::string>& args, const EnvLookup& env);

std::string usage_text();

// Settings as structured log fields, without any secret.
nlohmann::ordered_json loggable(const Settings& settings);

}  // namespace seatrace::sim
