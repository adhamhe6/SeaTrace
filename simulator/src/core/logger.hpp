#pragma once

#include <iosfwd>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string_view>

namespace seatrace::sim {

enum class LogLevel { kDebug = 0, kInfo = 1, kWarn = 2, kError = 3 };

std::string_view to_string(LogLevel level);
std::optional<LogLevel> parse_log_level(std::string_view text);

// Structured logging: one JSON object per line with "ts", "level" and "msg" plus optional extra
// fields. Passwords and other secrets must never be passed in. The mutex only protects the
// output stream; the simulator itself is single threaded.
class Logger {
 public:
  using Fields = nlohmann::ordered_json;

  Logger(std::ostream& out, LogLevel minimum) : out_(out), minimum_(minimum) {}

  void log(LogLevel level, std::string_view message, const Fields& fields = Fields::object());
  void debug(std::string_view message, const Fields& fields = Fields::object()) {
    log(LogLevel::kDebug, message, fields);
  }
  void info(std::string_view message, const Fields& fields = Fields::object()) {
    log(LogLevel::kInfo, message, fields);
  }
  void warn(std::string_view message, const Fields& fields = Fields::object()) {
    log(LogLevel::kWarn, message, fields);
  }
  void error(std::string_view message, const Fields& fields = Fields::object()) {
    log(LogLevel::kError, message, fields);
  }

  LogLevel minimum() const { return minimum_; }

 private:
  std::ostream& out_;
  LogLevel minimum_;
  std::mutex mutex_;
};

}  // namespace seatrace::sim
