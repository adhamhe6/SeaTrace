#include "core/settings.hpp"

#include <charconv>
#include <sstream>

namespace seatrace::sim {

namespace {

std::uint64_t parse_unsigned(std::string_view name, std::string_view text, std::uint64_t min,
                             std::uint64_t max) {
  std::uint64_t value = 0;
  const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
  if (text.empty() || error != std::errc() || end != text.data() + text.size() || value < min ||
      value > max) {
    std::ostringstream message;
    message << name << ": expected an integer in [" << min << ", " << max << "], got '" << text
            << "'";
    throw SettingsError(message.str());
  }
  return value;
}

std::vector<std::string> split_list(std::string_view text) {
  std::vector<std::string> items;
  while (!text.empty()) {
    const auto comma = text.find(',');
    const std::string_view item = text.substr(0, comma);
    const auto first = item.find_first_not_of(" \t");
    if (first != std::string_view::npos) {
      const auto last = item.find_last_not_of(" \t");
      items.emplace_back(item.substr(first, last - first + 1));
    }
    if (comma == std::string_view::npos) break;
    text.remove_prefix(comma + 1);
  }
  return items;
}

// A setting that can come from an environment variable or a command-line flag.
struct Option {
  std::string_view env;
  std::string_view flag;  // empty: environment only (e.g. the password)
  void (*apply)(Settings&, std::string_view source, std::string_view value);
};

void set_port(Settings& s, std::string_view source, std::string_view v) {
  s.port = static_cast<std::uint16_t>(parse_unsigned(source, v, 1, 65535));
}
void set_tick(Settings& s, std::string_view source, std::string_view v) {
  s.tick_ms = static_cast<std::uint32_t>(parse_unsigned(source, v, 10, 60000));
}
void set_seed(Settings& s, std::string_view source, std::string_view v) {
  s.seed = static_cast<std::uint32_t>(parse_unsigned(source, v, 0, 4294967295ULL));
}
void set_config(Settings& s, std::string_view, std::string_view v) { s.config_path = v; }
void set_security(Settings& s, std::string_view source, std::string_view v) {
  if (v == "secure") {
    s.security_mode = SecurityMode::kSecure;
  } else if (v == "none") {
    s.security_mode = SecurityMode::kNone;
  } else {
    throw SettingsError(std::string(source) + ": expected 'secure' or 'none', got '" +
                        std::string(v) + "'");
  }
}
void set_user(Settings& s, std::string_view, std::string_view v) { s.control_user = v; }
void set_password(Settings& s, std::string_view, std::string_view v) { s.control_password = v; }
void set_cert(Settings& s, std::string_view, std::string_view v) { s.server_cert_path = v; }
void set_key(Settings& s, std::string_view, std::string_view v) { s.server_key_path = v; }
void set_trusted(Settings& s, std::string_view, std::string_view v) {
  s.trusted_client_cert_paths = split_list(v);
}
void set_log_level(Settings& s, std::string_view source, std::string_view v) {
  const auto level = parse_log_level(v);
  if (!level) {
    throw SettingsError(std::string(source) + ": expected debug, info, warn or error, got '" +
                        std::string(v) + "'");
  }
  s.log_level = *level;
}

constexpr Option kOptions[] = {
    {"SIM_OPCUA_PORT", "--port", set_port},
    {"SIM_TICK_MS", "--tick-ms", set_tick},
    {"SIM_SEED", "--seed", set_seed},
    {"SIM_CONFIG", "--config", set_config},
    {"SIM_SECURITY_MODE", "--security-mode", set_security},
    {"SIM_CONTROL_USER", "--control-user", set_user},
    {"SIM_CONTROL_PASSWORD", "", set_password},
    {"SIM_SERVER_CERT", "--server-cert", set_cert},
    {"SIM_SERVER_KEY", "--server-key", set_key},
    {"SIM_TRUSTED_CLIENT_CERTS", "--trusted-client-certs", set_trusted},
    {"SIM_LOG_LEVEL", "--log-level", set_log_level},
};

void validate(const Settings& s) {
  if (s.control_user.empty()) {
    throw SettingsError("SIM_CONTROL_USER must be set and non-empty (control account)");
  }
  if (s.control_password.empty()) {
    throw SettingsError("SIM_CONTROL_PASSWORD must be set and non-empty (control account)");
  }
  if (s.security_mode == SecurityMode::kSecure) {
    if (s.server_cert_path.empty() || s.server_key_path.empty()) {
      throw SettingsError(
          "SIM_SECURITY_MODE=secure requires SIM_SERVER_CERT and SIM_SERVER_KEY (DER files); "
          "use SIM_SECURITY_MODE=none only for local development");
    }
    if (s.trusted_client_cert_paths.empty()) {
      throw SettingsError(
          "SIM_SECURITY_MODE=secure requires SIM_TRUSTED_CLIENT_CERTS (comma-separated DER files "
          "of the client certificates that may connect)");
    }
  }
}

}  // namespace

Settings parse_settings(const std::vector<std::string>& args, const EnvLookup& env) {
  Settings settings;
  for (const Option& option : kOptions) {
    if (const auto value = env(option.env)) {
      if (!value->empty()) option.apply(settings, option.env, *value);
    }
  }

  for (std::size_t i = 0; i < args.size(); ++i) {
    std::string_view arg = args[i];
    if (arg == "--help" || arg == "-h") {
      settings.show_help = true;
      return settings;
    }
    std::optional<std::string> inline_value;
    if (const auto eq = arg.find('='); arg.starts_with("--") && eq != std::string_view::npos) {
      inline_value = std::string(arg.substr(eq + 1));
      arg = arg.substr(0, eq);
    }
    const Option* match = nullptr;
    for (const Option& option : kOptions) {
      if (!option.flag.empty() && option.flag == arg) match = &option;
    }
    if (match == nullptr)
      throw SettingsError("unknown argument '" + std::string(arg) + "' (see --help)");
    std::string value;
    if (inline_value) {
      value = *inline_value;
    } else if (i + 1 < args.size()) {
      value = args[++i];
    } else {
      throw SettingsError(std::string(arg) + " needs a value");
    }
    match->apply(settings, match->flag, value);
  }
  validate(settings);
  return settings;
}

std::string usage_text() {
  return R"(Usage: seatrace_simulator [options]

SeaTrace vessel simulator and OPC UA server. Every option can also be set through the
environment variable shown in brackets; command-line flags take precedence.

  --port N                    OPC UA TCP port, 1-65535 (default 4840)        [SIM_OPCUA_PORT]
  --tick-ms N                 simulation tick in milliseconds, 10-60000      [SIM_TICK_MS]
                              (default 1000)
  --seed N                    random seed, 0-4294967295 (default 42)         [SIM_SEED]
  --config PATH               fleet configuration (default config/fleet.json) [SIM_CONFIG]
  --security-mode secure|none endpoint security (default secure)             [SIM_SECURITY_MODE]
  --control-user NAME         control account user name (required)           [SIM_CONTROL_USER]
  (password)                  control account password (required)            [SIM_CONTROL_PASSWORD]
                              environment only: command lines are visible in process listings
  --server-cert PATH          server certificate, DER (secure mode)          [SIM_SERVER_CERT]
  --server-key PATH           server private key, DER (secure mode)          [SIM_SERVER_KEY]
  --trusted-client-certs LIST comma-separated client certificates, DER       [SIM_TRUSTED_CLIENT_CERTS]
                              (secure mode)
  --log-level LEVEL           debug|info|warn|error (default info)           [SIM_LOG_LEVEL]
  -h, --help                  show this help
)";
}

nlohmann::ordered_json loggable(const Settings& s) {
  nlohmann::ordered_json fields;
  fields["port"] = s.port;
  fields["tick_ms"] = s.tick_ms;
  fields["seed"] = s.seed;
  fields["config"] = s.config_path;
  fields["security_mode"] = s.security_mode == SecurityMode::kSecure ? "secure" : "none";
  fields["control_user"] = s.control_user;
  fields["server_cert"] = s.server_cert_path;
  fields["trusted_client_certs"] = s.trusted_client_cert_paths;
  fields["log_level"] = to_string(s.log_level);
  return fields;
}

}  // namespace seatrace::sim
