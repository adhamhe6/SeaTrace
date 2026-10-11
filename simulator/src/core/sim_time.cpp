#include "core/sim_time.hpp"

#include <cstdio>

namespace seatrace::sim {

SimTime wall_clock_now() {
  return std::chrono::floor<std::chrono::milliseconds>(std::chrono::system_clock::now());
}

std::string format_iso8601(SimTime t) {
  using namespace std::chrono;
  const auto day = floor<days>(t);
  const year_month_day ymd{day};
  const hh_mm_ss<milliseconds> tod{t - day};
  char buffer[40];
  std::snprintf(buffer, sizeof buffer, "%04d-%02u-%02uT%02d:%02d:%02d.%03dZ",
                static_cast<int>(ymd.year()), static_cast<unsigned>(ymd.month()),
                static_cast<unsigned>(ymd.day()), static_cast<int>(tod.hours().count()),
                static_cast<int>(tod.minutes().count()), static_cast<int>(tod.seconds().count()),
                static_cast<int>(tod.subseconds().count()));
  return buffer;
}

}  // namespace seatrace::sim
