#include "core/logger.hpp"

#include <ostream>

#include "core/sim_time.hpp"

namespace seatrace::sim {

std::string_view to_string(LogLevel level) {
  switch (level) {
    case LogLevel::kDebug:
      return "debug";
    case LogLevel::kInfo:
      return "info";
    case LogLevel::kWarn:
      return "warn";
    case LogLevel::kError:
      return "error";
  }
  return "info";
}

std::optional<LogLevel> parse_log_level(std::string_view text) {
  for (const auto level : {LogLevel::kDebug, LogLevel::kInfo, LogLevel::kWarn, LogLevel::kError}) {
    if (to_string(level) == text) return level;
  }
  if (text == "warning") return LogLevel::kWarn;
  return std::nullopt;
}

void Logger::log(LogLevel level, std::string_view message, const Fields& fields) {
  if (level < minimum_) return;
  Fields line;
  line["ts"] = format_iso8601(wall_clock_now());
  line["level"] = to_string(level);
  line["msg"] = message;
  if (fields.is_object()) {
    for (const auto& [key, value] : fields.items()) line[key] = value;
  }
  // Invalid UTF-8 (e.g. echoed from a client) must not make logging throw.
  const std::string text = line.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
  const std::lock_guard<std::mutex> lock(mutex_);
  out_ << text << '\n';
  out_.flush();
}

}  // namespace seatrace::sim
